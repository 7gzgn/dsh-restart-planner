/**
 * dsh-restart-planner — 宿主入口
 *
 * 一句话：**让 agent 自己安排一次宿主重启**。
 *
 * 装完插件要重启才生效、改了 .js 要重启才加载 —— 以前只能干等用户动手。
 * 这个插件把「重启」变成一个工具调用：调用时只排程、立刻返回，等这一轮回复
 * 送达、会话日志落盘安静之后，由一个**脱离了宿主进程树的 helper** 完成
 * 停 + 拉 + 体检 + 写报告。平时它什么都不做。
 *
 * 为什么必须分离进程：重启 = 杀掉正在执行自己的进程，当前这一轮会被打断在
 * 半路。所以交付给一个能在宿主死后继续活的 helper，是这件事唯一可行的姿势。
 *
 * 安全边界（都写在 README 里，也一样是代码的边界）：
 *   - 默认 delaySeconds=20：先把这一轮说完再动手；
 *   - 等会话目录静默 quietSeconds 秒才动手，`maxWaitSeconds` 封顶；
 *   - 应用自己先退出了 → 不重启（尊重用户手动关掉）；
 *   - `cancel` 随时能撤；`dryRun` 只演算不动手。
 *
 * @module dsh-restart-planner
 */

import { join } from 'node:path';
import {
  ACTIONS,
  DEFAULTS,
  agoText,
  confirmQuestion,
  fallbackChoice,
  normalizeConfirm,
  parseConfirmAnswer,
  pendingState,
  readLastReport,
  readPending,
  renderReport,
  resolveSessionRoot,
  resolveStateDir,
} from './plan.js';
import { collectStatus, scheduleRestart, cancelPending, isAlive } from './core.js';
import { DEFAULT_CONTINUE_PROMPT, deliverResume, logResume, readResume, removeResume, writeResume } from './resume.js';

/** 插件身份。 */
export const name = 'dsh-restart-planner';

/** 需要宿主提供的服务（拿不到就退化，不报错）。 */
export const inject = ['tools', 'systemPrompt'];

const SECTION_ORDER = 204;

/** 刚重启完的「新鲜期」：这段时间内会主动向 agent 提一句。 */
const FRESH_WINDOW_MS = 10 * 60 * 1000;

/** 面向模型的公告（常驻那一段）。 */
export const RESTART_GUIDANCE = [
  '本机已安装 **dsh-restart-planner**：提供 `self_restart` 工具，让 agent **自己**安排宿主重启 —— 装/改插件、改了 `.js`、需要重载宿主时用它，不必再让用户手动关开。',
  "`action='schedule'`：排程一次重启。**立刻返回**，真正的停+拉发生在你这一轮回复送达、且会话日志落盘安静之后（默认 T+20s 起、静默 4s、最长等 180s）。可选 `reason`（写进报告）、`delaySeconds`、`dryRun`（只演算不动手）、`relaunchCommand`（特殊启动器才需要）。",
  "`action='status'`：体检 + 最近的报告 —— 当前进程的 pid/运行时长、如果现在重启会结束谁、用什么命令拉回来、上一次重启的结果。",
  "`action='cancel'`：撤掉还没执行的那次排程。",
  "`confirm: true`（可选，v0.2.0 起）：**先问用户「什么时候可以眨一下眼」**（立刻 / 30 秒后 / 60 秒后 / 取消）再排程 —— 用在「重启会打断用户手上正在做的事」的场合。**无人应答时按 `confirmFallback` 兜底（默认再等 30 秒，绝不静默改成立刻）**；无人值守的场景（定时任务、子代理）别开它。",
  '**重启后自动继续（v0.4.0）**：排程时会记下当前会话，新进程起来后用 `sessionController.prompt` 往这个会话投一句「继续」，所以重启后不必等人再催一句。`resume: false` 可只重启不继续；`continuePrompt` 可自定义那句话。**投递成功才清标记**，失败留着下次再试（`status` 里能看到「待恢复的会话」）。',
  '用法要点：**先 schedule，然后把这一轮正常说完**（用户看到你的回复之后才会重启）；重启回来后的第一条消息里用 `status` 确认结果再汇报。它平时不常驻、不占资源、不轮询任何东西。',
].join('\n');

/**
 * 拿到「能问到人的那个服务」。
 *
 * 注意：cordis 对**没有 inject 的服务**是「读一下就抛」，而 `userQuestions`
 * 不是每个宿主/每个会话都有（子代理、无 UI 场景就没有）。所以整段兜住：
 * 问不到人只是退回不询问，绝不该把一次工具调用炸掉。
 *
 * @param {object} ctx 宿主上下文
 * @returns {object|null} 服务或 null
 */
function askerOf(ctx) {
  try {
    const svc = ctx?.userQuestions;
    if (svc === null || svc === undefined) return null;
    if (typeof svc.askTimed === 'function' || typeof svc.ask === 'function') return svc;
  } catch {
    /* 没 inject：当作没有 */
  }
  return null;
}

/**
 * 从一条答案里取出「用户到底选了什么」。
 *
 * **真实形状**（读 user-questions 源码确认，2026-10-16）：`answerSchema = { id, selected: string[], custom?: string }`
 * —— 选项标签在 **`selected` 数组**里，手打的内容在 `custom` 里。
 * 我之前只找 `answer/label/value/text`，结果**永远取不到值**：所有选择都掉进兜底分支，
 * "取消"被当成"没人应答"，于是**测试里的取消变成了真排程**（就是这么排出去两次重启的）。
 * 这里按真实形状优先取，同时保留旧形状的兼容分支。
 *
 * @param {unknown} first 答案批里的第一条
 * @returns {string|null} 用户的选择（选项标签或手打文本）
 */
function pickAnswer(first) {
  if (first === null || first === undefined) return null;
  if (typeof first === 'string') return first;
  if (typeof first !== 'object') return null;
  const custom = typeof first.custom === 'string' && first.custom.trim() !== '' ? first.custom : null;
  if (custom !== null) return custom;
  const selected = Array.isArray(first.selected) ? first.selected : null;
  if (selected !== null && selected.length > 0) return String(selected[0]);
  // 兼容其它实现/旧版本
  return first.answer ?? first.label ?? first.value ?? first.text ?? null;
}

/**
 * 用 `askTimed` 问一次，超时返回 pending —— **绝不能让它无限等**。
 * @param {object} svc 服务
 * @param {object} request 请求
 * @param {string} callId 调用身份
 * @param {number} timeoutMs 等待上限
 * @returns {Promise<{asked:boolean, pending:boolean, answer:unknown, error:string|null}>} 结果
 */
async function askAnswerer(svc, request, callId, timeoutMs) {
  try {
    if (typeof svc.askTimed === 'function') {
      const result = await svc.askTimed(request, callId, timeoutMs);
      if (result !== null && typeof result === 'object' && result.pending === true) {
        return { asked: true, pending: true, answer: null, error: null };
      }
      const answers = result?.answers;
      const first = Array.isArray(answers) && answers.length > 0 ? answers[0] : null;
      return { asked: true, pending: false, answer: pickAnswer(first), error: null };
    }
    if (typeof svc.ask === 'function') {
      const result = await svc.ask(request);
      const answers = result?.answers;
      const first = Array.isArray(answers) && answers.length > 0 ? answers[0] : null;
      return { asked: true, pending: false, answer: pickAnswer(first), error: null };
    }
  } catch (err) {
    return { asked: true, pending: false, answer: null, error: err instanceof Error ? err.message : String(err) };
  }
  return { asked: false, pending: false, answer: null, error: 'no-asker' };
}

/**
 * 询问 → 决定这次排程到底等多久。
 * @param {object} input 工具参数
 * @param {object} cfg 插件配置
 * @param {object} ctx 宿主上下文
 * @returns {Promise<object>} `{confirm:{asked,pending,choice,delaySeconds,timeoutMs,error}}` 或 `{canceled:true, confirm}` 
 */
async function resolveConfirm(input, cfg, ctx, dryRun = false) {
  const confirmCfg = normalizeConfirm(input, cfg);
  if (confirmCfg.enabled !== true) {
    return { confirm: { enabled: false, asked: false, pending: false, choice: null, delaySeconds: null, timeoutMs: confirmCfg.timeoutMs, error: null } };
  }

  const label = confirmCfg.fallback === 'cancel' ? 'cancel' : (confirmCfg.fallback === 'now' ? 'now' : '30');

  // dry run 本来就不动手，所以**不打扰用户**；但仍然如实报告「真跑会问什么、兜底是什么」。
  // 注意 delaySeconds 给 null：dry run 不排程，不该让这次询问去改调用方给的 delay。
  if (dryRun === true) {
    return {
      killedNothing: true,
      confirm: {
        enabled: true,
        asked: false,
        pending: false,
        wouldAsk: { options: confirmQuestion().options.map((o) => o.label), timeoutMs: confirmCfg.timeoutMs, fallback: confirmCfg.fallback },
        choice: null,
        delaySeconds: null,
        timeoutMs: confirmCfg.timeoutMs,
        error: null,
      },
    };
  }

  const svc = askerOf(ctx);
  if (svc === null) {
    const decided = fallbackChoice(confirmCfg.fallback);
    return {
      ...(decided.kind === 'cancel' ? { canceled: true } : {}),
      confirm: {
        enabled: true,
        asked: false,
        pending: false,
        choice: decided.kind === 'cancel' ? null : decided.choice,
        delaySeconds: decided.kind === 'cancel' ? null : decided.delaySeconds,
        timeoutMs: confirmCfg.timeoutMs,
        error: 'no-asker',
        fallback: label,
      },
    };
  }

  const callId = `self-restart-confirm-${Date.now().toString(36)}`;
  const request = { questions: [confirmQuestion()] };
  const res = await askAnswerer(svc, request, callId, confirmCfg.timeoutMs);
  let decided;
  if (res.pending === true || res.answer === null || res.answer === undefined || res.answer === '') {
    decided = fallbackChoice(confirmCfg.fallback);
  } else {
    decided = parseConfirmAnswer(res.answer);
  }
  return {
    ...(decided.kind === 'cancel' ? { canceled: true } : {}),
    confirm: {
      enabled: true,
      asked: true,
      pending: res.pending === true,
      choice: decided.kind === 'cancel' ? null : decided.choice,
      delaySeconds: decided.kind === 'cancel' ? null : decided.delaySeconds,
      timeoutMs: confirmCfg.timeoutMs,
      error: res.error,
      fallback: (res.pending === true || res.error !== null) ? label : null,
    },
  };
}

/**
 * 算出生效中的状态目录与相关路径。
 * @param {object} config 插件配置
 * @returns {{stateDir: string, sessionRoot: string}} 路径
 */
function paths(config) {
  return {
    stateDir: typeof config.stateDir === 'string' && config.stateDir !== ''
      ? config.stateDir
      : resolveStateDir(),
    sessionRoot: typeof config.sessionRoot === 'string' && config.sessionRoot !== ''
      ? config.sessionRoot
      : resolveSessionRoot(),
  };
}

/**
 * 健康检查地址：优先插件配置，其次宿主自己的 web 端口。
 * @param {object} config 插件配置
 * @param {object} ctx 宿主上下文
 * @returns {string|undefined} 形如 http://127.0.0.1:19387
 */
function healthUrlOf(config, ctx) {
  if (typeof config.healthUrl === 'string' && config.healthUrl !== '') return config.healthUrl;
  // cordis 对**没有 inject 的服务**是「读一下就抛」（实测：cannot get property
  // "webServer" without inject）。所以整段兜住：少一项端口体检可以接受，
  // 因为读一个属性就把工具调用炸了不行。
  try {
    const port = ctx?.webServer?.port;
    if (Number.isFinite(port) && port > 0) return `http://127.0.0.1:${port}`;
  } catch {
    /* 没 inject webServer：跳过端口体检 */
  }
  const fromEnv = process.env.DSH_WEB_URL;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  return undefined;
}

/** 把一次 schedule 的结果压成给模型看的一段话。 */
function renderSchedule(data) {
  const plan = data.plan ?? {};
  const lines = [];
  if (data.canceled === true) {
    lines.push('self_restart schedule：**已取消** —— 用户选了「取消」，这次什么都不做（没有排程、没有 helper）。');
    if (data.confirm?.asked === true) lines.push('  · 他是从选项里选的取消，直接按这个结果走，别自己改主意再排一次。');
    return lines.join('\n');
  }
  lines.push(`self_restart schedule：已排程（id ${data.id}${data.dryRun ? '，dry run' : ''}）`);
  lines.push(`  · 动手时机：T+${data.schedule?.delaySeconds}s 起，且会话目录静默 ${data.schedule?.quietSeconds}s（最长等 ${data.schedule?.maxWaitSeconds}s）`);
  const cf = data.confirm;
  if (cf !== null && cf !== undefined && cf.wouldAsk !== undefined && cf.wouldAsk !== null) {
    lines.push(`  · 重启时机（dry run，只是演算）：真跑的话会问「${(cf.wouldAsk.options ?? []).join(' / ')}」，没人应答按 ${cf.wouldAsk.fallback} 兜底`);
  } else if (cf !== null && cf !== undefined && cf.asked === true) {
    const picked = cf.pending === true
      ? `**没人应答**（等了 ${Math.round((cf.timeoutMs ?? 0) / 1000)} 秒）→ 按兜底策略走了 ${data.schedule?.delaySeconds}s`
      : `用户选了「${cf.choice}」→ ${data.schedule?.delaySeconds}s`;
    lines.push(`  · 重启时机：${picked}`);
  } else if (cf !== null && cf !== undefined && cf.asked === false && cf.error === 'no-asker') {
    lines.push(`  · 重启时机：想问他，但这个会话问不到人（无 UI / 子代理）→ 按兜底策略走了 ${data.schedule?.delaySeconds}s`);
  }
  lines.push(`  · 目标：${plan.targetName ?? '?'} pid ${plan.targetPid ?? '?'}（含相关进程共 ${Array.isArray(plan.killList) ? plan.killList.length + 1 : '?'} 个）`);
  lines.push(`  · 拉起命令：${plan.relaunchCommand ?? '?'}`);
  if (typeof data.handoff === 'string') {
    const mode = data.handoff === 'explorer'
      ? 'explorer（由资源管理器接管，能活过宿主的 job 回收）'
      : data.handoff === 'direct' ? 'direct（普通子进程 — 留意警告）' : data.handoff;
    lines.push(`  · 交接方式：${mode}`);
  }
  lines.push(`  · 报告：${join(data.stateDir ?? '', 'last.json')}`);
  if (data.resume === null || data.resume === undefined) {
    lines.push('  · 重启后自动继续：**没开**（resume=false，或这次是 dry run）');
  } else if (data.resume.ok === true) {
    lines.push(`  · 重启后自动继续：已记下会话 ${data.resume.sessions} 条 —— 宿主起来后会用 sessionController.prompt 投一条「继续」进去`);
  } else {
    lines.push(`  · 重启后自动继续：**没记上**（${data.resume.error ?? '未知'}）—— 这次重启后需要你手动说一声`);
  }
  lines.push('  · 现在把这一轮正常说完就行；重启后回来用 action=\'status\' 看结果。');
  return lines.join('\n');
}

/** 把 status 的结果压成给模型看的一段话。 */
function renderStatus(data) {
  const lines = [];
  const self = data.self ?? {};
  lines.push(`self_restart status：当前宿主 pid ${self.pid}（${self.platform}），已运行 ${Math.round((self.uptimeSeconds ?? 0) / 60)} 分钟`);
  if (data.plan) {
    const plan = data.plan;
    lines.push(`  · 可以自己重启：是 —— 会结束 ${plan.targetName} pid ${plan.targetPid}`
      + `（连带 ${Array.isArray(plan.killList) ? plan.killList.length : 0} 个相关进程，helper 自己不在其中）`);
    lines.push(`  · 拉起命令：${plan.relaunchCommand}`);
  } else if (data.planError) {
    lines.push(`  · 可以自己重启：**不确定**（体检失败：${data.planError}）`);
  }
  if (data.pending) {
    const p = data.pending;
    const stateText = {
      running: 'helper 在跑，到点就会动手',
      finished: '已完成（就是下面那条报告）',
      canceled: '已取消',
      lost: 'helper 不见了 —— 没等到报告，值得看一眼 helper.log',
      none: '无',
    }[p.state] ?? '未知';
    lines.push(`  · 待执行排程：${p.id}${p.reason ? `｜原因：${p.reason}` : ''}｜${stateText}`);
  }
  lines.push(`  · 上次报告：`);
  lines.push(renderReport(data.last).split('\n').map((line) => `      ${line}`).join('\n'));
  if (data.last?.updatedAt) lines.push(`      （${agoText(data.last.updatedAt)}）`);
  if (Number.isFinite(data.resumePending) && data.resumePending > 0) {
    lines.push(`  · 待恢复的会话：${data.resumePending} 条 —— 投递失败留着的，下次启动会再试；投不进去就自己接着干。`);
  }
  return lines.join('\n');
}

/** 动态取 defineTool：宿主里有就用真的，单测/CLI 场景退化成恒等。 */
let defineTool = (def) => def;
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool;
} catch {
  /* 宿主外运行 */
}

/**
 * 取「发起这次工具调用的会话」的 id。
 *
 * 0.2.x 的 Agent 只剩 `{ id }`（没有 followup），所以自动继续要记的是这个 id，
 * 重启后交给 `sessionController.prompt` 去恢复并投递。
 *
 * @param {object} ctx 宿主上下文
 * @returns {string|null} 会话 id
 */
export function initiatorSessionId(ctx) {
  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined;
    if (agents === null || agents === undefined) return null;
    const current = typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined;
    const id = current?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

/**
 * 重启后把「继续」投递进那个会话。
 *
 * 用 `sessionController.prompt`（0.2.x 的现成入口）而不是 dsh-restart 的
 * `agent.followup`（那个 API 在 0.2.x 已经不存在）。**投递成功才删标记**，
 * 失败保留，下次启动还能再试。
 *
 * @param {object} ctx 宿主上下文
 * @param {string} stateDir 状态目录
 * @param {object} cfg 插件配置
 * @returns {() => void} 取消函数
 */
function startResumeDelivery(ctx, stateDir, cfg) {
  if (cfg.resumeAfterRestart === false) return () => {};
  if (readResume(stateDir) === null) return () => {};
  const pauseMs = Number.isFinite(cfg.resumeDelayMs) ? Math.max(0, cfg.resumeDelayMs) : 8000;
  const timer = setTimeout(() => {
    logResume(stateDir, 'startup: 发现恢复标记，开始投递');
    const promptFor = async (sessionId, prompt) => {
      const svc = typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined;
      if (svc === null || svc === undefined || typeof svc.prompt !== 'function') {
        throw new Error(`sessionController 不可用（typeof prompt=${typeof svc?.prompt}）`);
      }
      // 第二个参数是**必需的 AbortSignal**：不传就会在服务内部 `signal.throwIfAborted()` 上炸
      // （2026-10-17 实测错误：Cannot read properties of undefined (reading 'throwIfAborted')）。
      const controller = new AbortController();
      const kill = setTimeout(() => controller.abort(), 30000);
      kill.unref?.();
      try {
        const result = await svc.prompt({
          requestId: `resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        }, controller.signal);
        if (result !== null && typeof result === 'object' && result.accepted === false) {
          throw new Error(`prompt 未被接受：${JSON.stringify(result).slice(0, 160)}`);
        }
      } finally {
        clearTimeout(kill);
      }
    };
    const log = (line) => {
      logResume(stateDir, line);
      if (cfg.quiet !== true) console.error(`[dsh-restart-planner] ${line}`);
    };
    deliverResume({
      stateDir,
      promptFor,
      retries: Number.isFinite(cfg.resumeRetries) ? cfg.resumeRetries : 6,
      retryDelayMs: Number.isFinite(cfg.resumeRetryDelayMs) ? cfg.resumeRetryDelayMs : 3000,
      log,
    }).catch((err) => log(`resume: 投递过程出错：${err instanceof Error ? err.message : String(err)}`));
  }, pauseMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 * @param {object} [config] 插件配置
 */
export function apply(ctx, config) {
  const cfg = config ?? {};
  if (cfg.enabled === false) return;
  const { stateDir, sessionRoot } = paths(cfg);
  const disposers = [];

  // 重启后自动继续：本进程起来时如果还有恢复标记，等宿主安顿一下就把「继续」投进去。
  try {
    disposers.push(startResumeDelivery(ctx, stateDir, cfg));
  } catch {
    /* 投递只该是加分项，绝不该拖垮插件加载 */
  }

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    disposers.push(ctx.tools.register(defineTool({
      name: 'self_restart',
      description: [
        '让 agent 自己安排一次宿主（DSH）重启：装/改插件、改了 .js、需要重载宿主时用，不必再让用户手动关开。',
        "action='schedule'：排程重启。**调用后立刻返回**，真正的「停 + 拉」发生在你这一轮回复送达、且会话日志落盘安静之后（默认 T+20s 起、静默 4s、最长等 180s）。之后把这一轮正常说完即可。",
        "  可选参数：reason（写进报告的动机）、delaySeconds（至少等多久）、quietSeconds、maxWaitSeconds、dryRun（只演算不动手）、relaunchCommand（特殊启动器/包装脚本才需要）。",
        "action='status'：体检 + 报告 —— 当前 pid 与运行时长、现在重启会结束哪些进程、用什么命令拉回来、上一次重启的结果（重启回来后的第一条消息应该先看它）。",
        "action='cancel'：撤掉还没执行的那次排程。",
        '典型用法：装完插件/改完代码 → schedule(reason) → 说完这一轮 → 重启后 status 汇报结果。',
        '它平时完全静默：不常驻、不轮询、不占资源，只在你真的调用时才动。',
      ].join('\n'),
      timeoutMs: 60000,
      parameters: {
        action: {
          type: 'string',
          description: "One of: schedule, status, cancel, resume. 'status'/'cancel'/'resume' 不需要其它参数；resume = 手动把「重启后继续」那条 prompt 再投一次（启动时没投成时用）。",
        },
        reason: {
          type: 'string',
          description: "schedule 用：为什么重启（写进报告，重启后能看见）。",
        },
        delaySeconds: {
          type: 'number',
          description: `schedule 用：至少等多少秒再动手（默认 ${DEFAULTS.delaySeconds}）。给 0 = 一回就动手（不推荐：会打断本轮的回复投递）。`,
        },
        quietSeconds: {
          type: 'number',
          description: `schedule 用：会话目录要静默多少秒才认为「写完了」（默认 ${DEFAULTS.quietSeconds}）。`,
        },
        maxWaitSeconds: {
          type: 'number',
          description: `schedule 用：等安静的最长时限（默认 ${DEFAULTS.maxWaitSeconds}）。`,
        },
        dryRun: {
          type: 'boolean',
          description: 'schedule 用：true = 只演算计划、写一份 dry-run 报告，不杀不拉。想先给用户看看要动什么时用。',
        },
        relaunchCommand: {
          type: 'string',
          description: 'schedule 用（少见）：覆盖拉起命令。只有当宿主是被包装脚本启动、自动识别的命令不对时才需要。',
        },
        confirm: {
          type: 'boolean',
          description: `schedule 用（v0.2.0 起）：true = **先问用户什么时候可以重启**（立刻 / 30 秒后 / 60 秒后 / 取消）再排程。默认 false（静默排程）—— 无人值守的场景（定时任务、子代理）别开。`,
        },
        confirmFallback: {
          type: 'string',
          description: `confirm 用：没人应答时怎么办 —— 'ask-later'（默认，再等 30 秒）/ 'cancel'（这次不重启）/ 'now'（立刻）。`,
        },
        confirmTimeoutMs: {
          type: 'number',
          description: `confirm 用：等回答的上限毫秒数（默认 ${DEFAULTS.confirmTimeoutMs}）。超时按 confirmFallback 走，不会无限等。`,
        },
        resume: {
          type: 'boolean',
          description: 'schedule 用（v0.4.0 起）：true = 重启后自动往这个会话投一条「继续」（默认 true）。给 false 就只重启、不自动继续。',
        },
        continuePrompt: {
          type: 'string',
          description: 'schedule 用：重启后注入给 agent 的「继续」提示词（默认是一句「接着刚才没做完的事继续」）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            data: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok === false) {
            return [{ type: 'text', text: `self_restart ${String(value.action)} 失败：${String(value.error ?? '未知错误')}` }];
          }
          const action = String(value.action);
          if (action === 'schedule') return [{ type: 'text', text: renderSchedule(value.data ?? {}) }];
          if (action === 'status') return [{ type: 'text', text: renderStatus(value.data ?? {}) }];
          if (action === 'cancel') {
            const d = value.data ?? {};
            return [{
              type: 'text',
              text: `self_restart cancel：已撤掉排程 ${d.id}${d.helperExited === false ? '（helper 还在退出中，但不会再动手了）' : ''}`,
            }];
          }
          if (action === 'resume') {
            const d = value.data ?? {};
            const rows = Array.isArray(d.results) ? d.results : [];
            if (rows.length === 0) return [{ type: 'text', text: 'self_restart resume：**没有待恢复的会话**（标记是空的）。' }];
            const okRows = rows.filter((r) => r.ok === true);
            const badRows = rows.filter((r) => r.ok !== true);
            const lines = [`self_restart resume：投递 ${rows.length} 条，成功 ${okRows.length} 条`];
            for (const row of badRows) lines.push(`  · ❌ ${row.sessionId}：${row.error}`);
            for (const row of okRows) lines.push(`  · ✅ ${row.sessionId}：已投递（会话里应该马上开始一轮）`);
            return [{ type: 'text', text: lines.join('\n') }];
          }
          return [{ type: 'text', text: `self_restart ${action}：${JSON.stringify(value.data ?? {}).slice(0, 400)}` }];
        },
      },
      async execute(args) {
        const a = args ?? {};
        const action = String(a.action ?? 'status').trim().toLowerCase();
        if (!ACTIONS.includes(action)) {
          return { ok: false, action, error: `unknown action: ${action}（可用：${ACTIONS.join(', ')}）` };
        }

        // 环境探测也放进 try：任何一项出问题都只该变成一次失败的工具调用，
        // 而不是把异常抛进宿主
        let common;
        try {
          common = {
            stateDir,
            sessionRoot,
            healthUrl: healthUrlOf(cfg, ctx),
            config: {
              delaySeconds: cfg.delaySeconds,
              quietSeconds: cfg.quietSeconds,
              maxWaitSeconds: cfg.maxWaitSeconds,
              graceSeconds: cfg.graceSeconds,
              healthSeconds: cfg.healthSeconds,
            },
          };
        } catch (err) {
          return { ok: false, action, error: `准备环境信息失败：${err instanceof Error ? err.message : String(err)}` };
        }

        try {
          if (action === 'schedule') {
            const dryRun = a.dryRun === true || cfg.dryRun === true;
            const asked = await resolveConfirm(a, cfg, ctx, dryRun);
            if (asked.canceled === true) {
              return { ok: true, action, data: { canceled: true, reason: 'user-canceled', confirm: asked.confirm, stateDir } };
            }
            const forcedDelay = asked.confirm?.delaySeconds ?? null;
            const result = await scheduleRestart({
              ...common,
              schedule: {
                delaySeconds: forcedDelay === null ? a.delaySeconds : forcedDelay,
                quietSeconds: a.quietSeconds,
                maxWaitSeconds: a.maxWaitSeconds,
                reason: typeof a.reason === 'string' ? a.reason : '',
              },
              dryRun,
              relaunchCommand: typeof a.relaunchCommand === 'string' ? a.relaunchCommand : undefined,
              // 「临时目录也能真排程」这个口子默认关着 —— 只有调用方显式要、或插件配置里写了 force
              // 才放行。留给「确实要真动手的集成测试」，避免测试把炸弹排到真宿主头上。
              force: a.force === true || cfg.force === true,
            });
            // 重启后自动继续：记下「哪个会话 + 继续时说什么」。dry run 不记（没真重启）。
            let resume = null;
            if (!dryRun && (a.resume !== false) && cfg.resumeAfterRestart !== false) {
              const sessionId = initiatorSessionId(ctx);
              if (sessionId === null) {
                resume = { ok: false, sessions: 0, error: '拿不到当前会话 id（不在 agent 调用链里？）' };
              } else {
                const prompt = typeof a.continuePrompt === 'string' && a.continuePrompt !== ''
                  ? a.continuePrompt
                  : (typeof cfg.continuePrompt === 'string' && cfg.continuePrompt !== '' ? cfg.continuePrompt : DEFAULT_CONTINUE_PROMPT);
                resume = writeResume(stateDir, { sessionId, prompt });
              }
            }
            return { ok: true, action, data: { ...result, confirm: asked.confirm ?? null, resume, stateDir } };
          }

          if (action === 'cancel') {
            const result = await cancelPending({ stateDir });
            if (result.ok !== true) return { ok: false, action, error: String(result.error ?? '取消失败') };
            return { ok: true, action, data: result };
          }

          if (action === 'resume') {
            // 手动补投递：启动时那条链路如果没成（标记还在），用这个当场再试一次并看到真实错误。
            const marker = readResume(stateDir);
            if (marker === null) return { ok: true, action, data: { sessions: 0, results: [] } };
            const results = [];
            for (const entry of marker.sessions) {
              try {
                const svc = typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined;
                if (svc === null || svc === undefined || typeof svc.prompt !== 'function') {
                  throw new Error(`sessionController 不可用（typeof prompt=${typeof svc?.prompt}）`);
                }
                await (async () => {
                  // 同 startResumeDelivery：第二个参数是必需的 AbortSignal，不传就会在
                  // 服务内部 throwIfAborted() 上炸（实测错误原文）。
                  const controller = new AbortController();
                  const kill = setTimeout(() => controller.abort(), 30000);
                  kill.unref?.();
                  try {
                    await svc.prompt({
                      requestId: `resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                      sessionId: entry.sessionId,
                      mode: 'queue',
                      content: [{ type: 'text', text: entry.prompt }],
                    }, controller.signal);
                  } finally {
                    clearTimeout(kill);
                  }
                })();
                removeResume(stateDir, entry.sessionId);
                logResume(stateDir, `manual delivered ${entry.sessionId}`);
                results.push({ sessionId: entry.sessionId, ok: true });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logResume(stateDir, `manual failed ${entry.sessionId}: ${message}`);
                results.push({ sessionId: entry.sessionId, ok: false, error: message });
              }
            }
            return { ok: true, action, data: { sessions: marker.sessions.length, results } };
          }

          const data = await collectStatus(common);
          const pendingResume = readResume(stateDir);
          data.resumePending = pendingResume === null ? 0 : pendingResume.sessions.length;
          return { ok: true, action, data };
        } catch (err) {
          return { ok: false, action, error: err instanceof Error ? err.message : String(err) };
        }
      },
    })));
  }

  if (cfg.announceToAgent !== false && ctx.systemPrompt !== undefined
    && typeof ctx.systemPrompt.section === 'function') {
    disposers.push(ctx.systemPrompt.section({
      name: 'plugin:self-restart',
      order: SECTION_ORDER,
      text: guidanceText(stateDir),
    }));
  }

  if (typeof ctx.effect === 'function' && disposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          /* 卸载失败不阻断其它清理 */
        }
      }
    }, 'dsh-restart-planner: teardown');
  }
}

/**
 * 公告正文：平时是常驻的那段；如果本进程刚被这个插件重启过，前面加一句。
 * @param {string} stateDir 状态目录
 * @returns {string} 公告文本
 */
export function guidanceText(stateDir) {
  const last = readLastReport(stateDir);
  const pending = readPending(stateDir);
  const banner = [];
  if (last !== null && typeof last.updatedAt === 'string' && last.state === 'ok') {
    const age = Date.now() - Date.parse(last.updatedAt);
    if (Number.isFinite(age) && age >= 0 && age < FRESH_WINDOW_MS) {
      banner.push(`⚠ **本进程刚刚由 dsh-restart-planner 重启过**（${agoText(last.updatedAt)}，原因：${last.reason || '未说明'}）。用户可能正是在等这个 —— 用 \`self_restart\` 的 \`status\` 确认结果再简短汇报；**别凭这一行报数**（停机时长/新 pid 都以 status 读到的报告为准）。`);
    }
  }
  if (pending !== null && pending.canceled !== true
    && pendingState(pending, last, isAlive) === 'running') {
    banner.push(`⚠ 有一次重启排程还没执行（id ${String(pending.id)}，原因：${pending.reason || '未说明'}）：它会在这轮结束后动手；要撤就用 \`self_restart\` 的 \`cancel\`。`);
  }
  return [...banner, RESTART_GUIDANCE].join('\n');
}
