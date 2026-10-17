/**
 * dsh-self-restart — 纯逻辑层（无副作用，可单测）
 *
 * 这里只做「算术」：状态目录、id、参数归一化、报告的形状与人话渲染。
 * 真正会动进程的代码在 core.js，插件的工具定义在 index.js。
 *
 * @module dsh-self-restart/plan
 */

import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { readFileSync } from 'node:fs';

/** 排程默认值：都偏保守，宁可多等几秒，也不要在会话落盘前动手。 */
export const DEFAULTS = {
  /** 工具返回后至少等这么久才动手（留出回复送达 + 收尾的时间）。 */
  delaySeconds: 20,
  /** 会话目录里没有比这更新的写入，才认为「安静」。 */
  quietSeconds: 4,
  /** 等安静的最长时限，到点就走。 */
  maxWaitSeconds: 180,
  /** 杀掉壳之后，留给 host 自己优雅收尾的时间。 */
  graceSeconds: 8,
  /** 重启后等端口回来的最长时间。 */
  healthSeconds: 120,
  /** `confirm: true` 时等用户回答的最长时间（无人应答就按 confirmFallback 走）。 */
  confirmTimeoutMs: 90000,
};

/** 工具/CLI 允许的 action。 */
export const ACTIONS = ['schedule', 'status', 'cancel'];

/**
 * 解析状态目录。
 * @param {Record<string, string|undefined>} [env] 环境变量
 * @param {string} [home] 用户主目录
 * @returns {string} 绝对路径
 */
export function resolveStateDir(env = process.env, home = homedir()) {
  const dshHome = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(home, '.dsh');
  return join(dshHome, 'dsh-self-restart');
}

/**
 * 解析会话仓库根目录（用来判断「写完了没有」）。
 * @param {Record<string, string|undefined>} [env] 环境变量
 * @param {string} [home] 用户主目录
 * @returns {string} 绝对路径
 */
export function resolveSessionRoot(env = process.env, home = homedir()) {
  const dshHome = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(home, '.dsh');
  return join(dshHome, 'sessions');
}

/**
 * 生成一次排程的 id：时间戳 + 短随机后缀，可读且不会撞。
 * @param {Date} [now] 当前时间
 * @returns {string} 形如 20261016-2130-ab12
 */
export function newId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${stamp}-${rand}`;
}

/** 把一个值夹到整数区间里，非法值取默认。 */
function clampInt(value, fallback, min, max) {
  const num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

/**
 * 归一化排程参数。
 * @param {Record<string, unknown>} input 原始参数
 * @param {Record<string, unknown>} [config] 插件配置里的默认值
 * @returns {{delaySeconds:number, quietSeconds:number, maxWaitSeconds:number, graceSeconds:number, healthSeconds:number, reason:string}} 归一化结果
 */
export function normalizeSchedule(input = {}, config = {}) {
  const pick = (key) => (input[key] === undefined ? config[key] : input[key]);
  return {
    delaySeconds: clampInt(pick('delaySeconds'), DEFAULTS.delaySeconds, 0, 3600),
    quietSeconds: clampInt(pick('quietSeconds'), DEFAULTS.quietSeconds, 0, 600),
    maxWaitSeconds: clampInt(pick('maxWaitSeconds'), DEFAULTS.maxWaitSeconds, 0, 3600),
    graceSeconds: clampInt(pick('graceSeconds'), DEFAULTS.graceSeconds, 0, 120),
    healthSeconds: clampInt(pick('healthSeconds'), DEFAULTS.healthSeconds, 0, 900),
    reason: typeof input.reason === 'string' ? input.reason.slice(0, 400) : '',
  };
}

/**
 * 「重启前先问时机」的四个选项。
 *
 * 从 v0.2.0 起，`schedule` 可以带 `confirm: true`：先问用户「什么时候可以眨一下眼」，
 * 再按选择排程。默认**不**询问 —— 无人值守（定时任务、子代理）时没人回答问题，
 * 让工具永远等下去比不问更糟。
 *
 * 关键设计：**每个选项都只改 delaySeconds**，其余参数（quietSeconds 等）不变，
 * 因为「回复先送达 + 会话日志落盘」是硬约束，不能靠选项绕开。
 */
export const CONFIRM_QUESTION = '要现在重启吗？选一个时机，我按你选的来。';

/** 四个选项的 id 与标签（顺序即展示顺序）。 */
export const CONFIRM_OPTIONS = [
  { id: 'now', label: '立刻', description: '先把这一轮回复说完、日志落盘（约 3 秒），然后动手。' },
  { id: '30', label: '30 秒后', description: '留出半分钟，你还能看/点完手上的东西。' },
  { id: '60', label: '60 秒后', description: '留一分钟，适合还有别的收尾在进行。' },
  { id: 'cancel', label: '取消', description: '这次不重启，什么都不做。' },
];

/** 选项 id → 实际 delaySeconds。cancel 不在表里（它不排程）。 */
const CONFIRM_DELAYS = { now: 3, '30': 30, '60': 60 };

/**
 * 无应答（超时 / 没人在线）时的兜底策略。
 * 默认 `ask-later`：**倾向安全** —— 不等满就不动手，按 30 秒走，而不是立刻重启。
 */
export const CONFIRM_FALLBACKS = ['ask-later', 'cancel', 'now'];

/**
 * 组装给 `ctx.userQuestions` 的问题对象。
 * @returns {{id:string, header:string, question:string, options:{label:string,description:string}[]}} 问题
 */
export function confirmQuestion() {
  return {
    id: 'restart_when',
    header: '重启时机',
    question: CONFIRM_QUESTION,
    options: CONFIRM_OPTIONS.map(({ label, description }) => ({ label, description })),
  };
}

/**
 * 把用户的选择（标签或 id）解析成动作。
 *
 * 同时接受选项 id（`now`/`30`/`60`/`cancel`）与界面标签（`立刻`/`30 秒后`/…），
 * 因为答案可能来自按钮、也可能来自用户手打的文本。
 *
 * @param {unknown} answer 用户答案
 * @returns {{kind:'cancel'}|{kind:'schedule', choice:string, delaySeconds:number}} 解析结果
 */
export function parseConfirmAnswer(answer) {
  const text = String(answer ?? '').trim();
  const lower = text.toLowerCase();
  for (const option of CONFIRM_OPTIONS) {
    if (lower === option.id || text === option.label) {
      if (option.id === 'cancel') return { kind: 'cancel' };
      return { kind: 'schedule', choice: option.id, delaySeconds: CONFIRM_DELAYS[option.id] };
    }
  }
  // 兜底：从文本里找数字（"等 45 秒" / "45"）
  const num = /(\d{1,4})\s*(秒|s\b)?/.exec(text);
  if (num !== null && text !== '') {
    const value = Number.parseInt(num[1], 10);
    if (Number.isFinite(value) && value >= 0) {
      return { kind: 'schedule', choice: 'custom', delaySeconds: Math.min(3600, value) };
    }
  }
  // 认不出来 → 当作「不指定」，回到默认档（30 秒），绝不静默改成立刻
  return { kind: 'schedule', choice: 'default', delaySeconds: 30 };
}

/**
 * 归一化「询问」相关配置。
 * @param {object} input 工具参数
 * @param {object} config 插件配置
 * @param {object} [deps] 依赖注入（测试用）
 * @param {(ms:number)=>Promise<{pending?:boolean, answer?:unknown}>} [deps.askFn] 实际询问函数
 * @returns {{enabled:boolean, timeoutMs:number, fallback:'ask-later'|'cancel'|'now', askFn:(ms:number)=>Promise<object>}} 配置
 */
export function normalizeConfirm(input = {}, config = {}, deps = {}) {
  const enabled = input.confirm === true || (input.confirm === undefined && config.confirm === true);
  const pick = (key) => (input[key] === undefined ? config[key] : input[key]);
  const fallbackRaw = String(pick('confirmFallback') ?? 'ask-later');
  const fallback = CONFIRM_FALLBACKS.includes(fallbackRaw) ? fallbackRaw : 'ask-later';
  return {
    enabled,
    timeoutMs: clampInt(pick('confirmTimeoutMs'), DEFAULTS.confirmTimeoutMs, 5000, 600000),
    fallback,
    askFn: typeof deps.askFn === 'function' ? deps.askFn : null,
  };
}

/**
 * 无应答时该按哪个 delay 走。
 * @param {'ask-later'|'cancel'|'now'} fallback 兜底策略
 * @returns {{kind:'cancel'}|{kind:'schedule', choice:string, delaySeconds:number}} 与 parseConfirmAnswer 同形
 */
export function fallbackChoice(fallback) {
  if (fallback === 'cancel') return { kind: 'cancel' };
  if (fallback === 'now') return { kind: 'schedule', choice: 'now', delaySeconds: CONFIRM_DELAYS.now };
  return { kind: 'schedule', choice: 'fallback-30', delaySeconds: 30 };
}

/**
 * 安全读一个 JSON 文件。
 * @param {string} path 文件路径
 * @returns {object|null} 解析结果；读不到或解析失败返回 null
 */
export function readJsonSafe(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * 读最近一次重启报告。
 * @param {string} stateDir 状态目录
 * @returns {object|null} 报告对象
 */
export function readLastReport(stateDir) {
  return readJsonSafe(join(stateDir, 'last.json'));
}

/**
 * 读待执行排程。
 * @param {string} stateDir 状态目录
 * @returns {object|null} pending 对象
 */
export function readPending(stateDir) {
  return readJsonSafe(join(stateDir, 'pending.json'));
}

/**
 * 判断一条待执行排程现在处于什么状态。
 *
 * 关键场景：重启刚完成、新进程起来了，但 `pending.json` 还躺在那里 ——
 * 如果照本宣科地报「有一次排程没执行」，每次重启完都会多一句假警报。
 * 所以：helper 已经不在、而且这次排程自己的报告已经出现 → 它就是「已完成」。
 *
 * @param {object|null} pending 待执行排程
 * @param {object|null} last 最近一次报告
 * @param {(pid:number)=>boolean} isAliveFn 进程存活判断
 * @returns {'none'|'canceled'|'running'|'finished'|'lost'} 状态
 */
export function pendingState(pending, last, isAliveFn) {
  if (pending === null || typeof pending !== 'object') return 'none';
  if (pending.canceled === true) return 'canceled';
  const helperPid = Number(pending.helperPid);
  if (Number.isFinite(helperPid) && helperPid > 0 && typeof isAliveFn === 'function' && isAliveFn(helperPid)) {
    return 'running';
  }
  if (last !== null && typeof last === 'object' && last.id === pending.id) return 'finished';
  return 'lost';
}

/** 报告状态 → 中文短语。 */
const STATE_TEXT = {
  starting: '已接手，准备中',
  waiting: '已排程，等待动手',
  'quiet-reached': '会话已落盘安静',
  'dry-run': '只演算没动手（dry run）',
  canceled: '已取消，什么都没做',
  'exited-early': '应用自己先退出了，未重启',
  stopped: '已停止',
  relaunched: '已拉起新进程',
  ok: '重启完成',
  'started-but-unhealthy': '进程起来了但端口没回来',
  'relaunch-failed': '拉起失败',
  error: '出错',
};

/**
 * 把报告渲染成给模型看的一段话。
 * @param {object|null} report 报告对象
 * @returns {string} 多行文本
 */
export function renderReport(report) {
  if (report === null || typeof report !== 'object') return '（还没有重启记录）';
  const lines = [];
  lines.push(`状态：${STATE_TEXT[report.state] ?? String(report.state)}（${String(report.id ?? '?')}）`);
  if (report.reason) lines.push(`原因：${String(report.reason)}`);
  if (report.requestedAt) lines.push(`排程于：${String(report.requestedAt)}`);
  if (report.targetPid) lines.push(`目标：${String(report.targetName ?? '')} pid ${String(report.targetPid)}`);
  if (report.relaunchCommand) lines.push(`拉起命令：${String(report.relaunchCommand)}`);
  if (report.newPid) lines.push(`新进程 pid：${String(report.newPid)}`);
  if (typeof report.killCount === 'number') lines.push(`结束进程数：${report.killCount}`);
  if (typeof report.idleMs === 'number' && report.idleMs > 0) lines.push(`动手前会话已静默：${Math.round(Number(report.idleMs) / 1000)} 秒`);
  if (typeof report.downtimeMs === 'number') lines.push(`停机时长：${(Number(report.downtimeMs) / 1000).toFixed(1)} 秒（端口已体检）`);
  else if (typeof report.relaunchMs === 'number') lines.push(`拉起耗时：${(Number(report.relaunchMs) / 1000).toFixed(1)} 秒（没给健康检查地址，端口未体检 —— 这个数不等于停机时长）`);
  if (report.error) lines.push(`错误：${String(report.error)}`);
  if (Array.isArray(report.killFailures) && report.killFailures.length > 0) {
    lines.push(`未能结束的进程：${report.killFailures.join('; ')}`);
  }
  if (report.updatedAt) lines.push(`报告时间：${String(report.updatedAt)}`);
  return lines.join('\n');
}

/** 这个可执行文件是不是 node 系（node / electron 的 node 模式）。 */
export function isNodeLike(exe) {
  const base = basename(String(exe ?? '')).toLowerCase();
  return base === 'node.exe' || base === 'node' || base === 'electron.exe' || base === 'electron';
}

/**
 * 相对时间短语。
 * @param {string|number|Date} then 过去的时间
 * @param {Date} [now] 现在
 * @returns {string} 如「3 分钟前」
 */
export function agoText(then, now = new Date()) {
  const t = then instanceof Date ? then : new Date(then);
  const ms = now.getTime() - t.getTime();
  if (!Number.isFinite(ms)) return '未知';
  if (ms < 0) return '刚刚';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} 小时前`;
  return `${(s / 86400).toFixed(1)} 天前`;
}
