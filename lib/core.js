/**
 * dsh-self-restart — 副作用层
 *
 * 三件事：把 helper 跑起来（同步：resolve）、把 helper 放出去（分离：run）、
 * 以及读写状态目录。所有「会不会把自己弄死」的判断都在 helper 里，
 * 这里只负责把参数整明白、把进程放出去。
 *
 * @module dsh-self-restart/core
 */

import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  DEFAULTS,
  newId,
  normalizeSchedule,
  pendingState,
  readLastReport,
  readPending,
} from './plan.js';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const PS_HELPER = join(LIB_DIR, 'helper.ps1');
const JS_HELPER = join(LIB_DIR, 'helper.mjs');

/** 支持的平台后端。 */
export const isWindows = process.platform === 'win32';

/** 缓存选中的 PowerShell（只有真正要用时才探测，加载插件时一次都不跑）。 */
let shellPromise = null;

/**
 * 挑一个可用的 PowerShell：pwsh 优先（原生 UTF-8），否则退回系统自带的 5.1。
 * @returns {Promise<string>} 可执行文件名
 */
export function pickShell() {
  if (shellPromise === null) {
    shellPromise = (async () => {
      for (const candidate of ['pwsh.exe', 'powershell.exe']) {
        try {
          await new Promise((resolve, reject) => {
            execFile(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
              { timeout: 8000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
          });
          return candidate;
        } catch {
          /* 试下一个 */
        }
      }
      return 'powershell.exe';
    })();
  }
  return shellPromise;
}

/**
 * 组装一次 helper 调用。
 * @param {string} action resolve | arm | run | status
 * @param {object} payload 传给 helper 的 JSON
 * @returns {Promise<{file: string, args: string[]}>} 可执行文件与参数
 */
async function helperCommand(action, payload) {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  if (isWindows) {
    const shell = await pickShell();
    return {
      file: shell,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', PS_HELPER, '-Action', action, '-Payload64', b64],
    };
  }
  const env = { ...process.env };
  if (!/node$/i.test(process.execPath) && !/node\.exe$/i.test(process.execPath)) {
    // Electron 二进制当 node 用
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return { file: process.execPath, args: [JS_HELPER, '--action', action, '--payload64', b64], env: { ...process.env, ...env } };
}

/**
 * 写「授权动进程」标记文件。
 *
 * 为什么是文件而不是环境变量：arm 交接要经过 Explorer + 生成的 .lnk，
 * **那一跳不带调用方的环境**（实测），所以环境里的允许标记传到 helper 时已经没了。
 * 文件写在状态目录里，helper 只看它。
 *
 * 为什么写在这里：`runHelper('arm'|'run')` 是"真的要把 helper 交出去"的那一行 ——
 * 上层 scheduleRestart 和测试/CLI 的直调都会经过它，只在这一处写才不会漏。
 *
 * @param {string} action helper 动作
 * @param {object} payload 载荷（含 stateDir）
 */
function ensureAllowMarker(action, payload) {
  if (action !== 'arm' && action !== 'run') return;
  const stateDir = payload?.stateDir;
  if (typeof stateDir !== 'string' || stateDir === '') return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.allow-real-restart'), `${new Date().toISOString()}\n${String(payload.id ?? '')}\n`, 'utf8');
  } catch {
    /* 写不进去就让 helper 自己拒绝（安全侧） */
  }
}

/**
 * 同步跑一次 helper（只用于 resolve：只读、很快就回）。
 * @param {string} action 动作
 * @param {object} payload 载荷
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<object>} helper 返回的 JSON
 */
/**
 * 测试自己的"根"。
 *
 * 只有测试进程才会设 DSR_TEST_ROOT=1。它让 arm payload 带上 callerPid = 本进程，
 * 于是祖先解析停在**测试运行器自己**身上，而不是继续往上爬到真宿主。
 * 生产路径永远不设这个变量，行为完全不变。
 */
function testRootCaller(action, payload) {
  if (process.env.DSR_TEST_ROOT !== '1') return payload;
  if (action !== 'arm' && action !== 'run') return payload;
  if (payload === null || typeof payload !== 'object') return payload;
  if (Number.isFinite(Number(payload.callerPid)) && Number(payload.callerPid) > 0) return payload;
  if (Number.isFinite(Number(payload.targetPid)) && Number(payload.targetPid) > 0) return payload;
  return { ...payload, callerPid: process.pid };
}

export async function runHelper(action, payload, timeoutMs = 30000) {
  // 授权标记必须在**真正把 helper 交出去之前**写好 —— 而且是在这里写，不是在上层
  // `scheduleRestart` 里：测试/CLI 也可能直接调 runHelper('arm'|'run')，那条路不经过上层。
  // 只对会动进程的动作写；resolve 是只读的，不需要授权。
  const effective = testRootCaller(action, payload);
  ensureAllowMarker(action, effective);
  const { file, args, env } = await helperCommand(action, effective);
  return await new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      // 环境必须显式传：helper 里「测试环境不许真重启」的网关靠环境变量判定
      ...(env === undefined ? {} : { env }),
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const text = String(stdout ?? '').trim();
      const lastLine = text.split(/\r?\n/).filter((line) => line.trim() !== '').pop();
      if (lastLine) {
        try {
          resolve(JSON.parse(lastLine));
          return;
        } catch {
          /* 落到错误分支 */
        }
      }
      if (err) {
        reject(new Error(`${err.message}${stderr ? ` | ${String(stderr).slice(0, 300)}` : ''}`));
        return;
      }
      reject(new Error(`helper 没有返回可解析的 JSON：${text.slice(0, 200)}`));
    });
  });
}

/**
 * 把 helper 交出去执行。
 *
 * Windows：交给 **Explorer** 启动（生成一个 .lnk 让 shell 去开）。
 * 为什么不能直接 spawn：桌面壳是 Chromium 起的，进程在那套 job object 里，
 * 普通子进程会跟着壳一起被 job 回收 —— 那就没人把 DSH 拉回来了。
 * Explorer 在 job 之外，由它起的进程才能活过这次重启，并且落在交互会话里
 * （拉起来的窗口用户看得见）。arm 会等 helper 回来「报到」再返回。
 *
 * POSIX：Node 的 detached spawn 在那边是真脱离，直接放出去即可。
 *
 * @param {object} payload 载荷
 * @param {number} [timeoutMs] 握手超时
 * @returns {Promise<{mode: string, helperPid: number|null, warning?: string}>} 交付结果
 */
export async function dispatchHelper(payload, timeoutMs = 45000) {
  // dry run 的语义是「只演算、绝不动手」——那就**连 helper 都不该放出去**。
  // （2026-10-16 实测的 bug：dry run 照样 arm 了一个 helper、返回里还带 helperPid，
  //  于是测试里出现「取消也排了程」的假象。）
  if (payload !== null && typeof payload === 'object' && payload.dryRun === true) {
    return { mode: 'dry-run', helperPid: null };
  }
  if (isWindows) {
    const result = await runHelper('arm', payload, timeoutMs);
    if (result.ok !== true) throw new Error(result.error ?? 'helper 交接失败');
    const out = {
      mode: String(result.mode ?? 'unknown'),
      helperPid: Number.isFinite(Number(result.helperPid)) ? Number(result.helperPid) : null,
    };
    if (typeof result.warning === 'string' && result.warning !== '') out.warning = result.warning;
    return out;
  }
  const { file, args } = await helperCommand('run', payload);
  const env = { ...process.env };
  if (!/node$/i.test(process.execPath)) env.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(file, args, { detached: true, stdio: 'ignore', env });
  child.unref();
  return { mode: 'posix-detached', helperPid: typeof child.pid === 'number' ? child.pid : null };
}

/**
 * 组装 helper 需要的载荷。
 * @param {object} options 选项
 * @param {string} options.id 排程 id
 * @param {string} options.stateDir 状态目录
 * @param {string} options.sessionRoot 会话仓库根
 * @param {string|undefined} options.healthUrl 健康检查地址
 * @param {object} options.schedule 归一化后的时间参数
 * @param {boolean} options.dryRun 只演算不动手
 * @param {number|undefined} options.targetPid 覆盖目标（测试/特殊启动器）
 * @param {string|undefined} options.relaunchCommand 覆盖拉起命令
 * @returns {object} 载荷
 */
export function buildPayload(options) {
  const schedule = normalizeSchedule(options.schedule ?? {}, options.config ?? {});
  const payload = {
    id: options.id,
    stateDir: options.stateDir,
    sessionRoot: options.sessionRoot,
    requestedAt: new Date().toISOString(),
    callerPid: Number.isFinite(Number(options.callerPid)) && Number(options.callerPid) > 0
      ? Number(options.callerPid)
      : process.pid,
    selfExe: process.execPath,
    cwdHint: process.cwd(),
    delaySeconds: schedule.delaySeconds,
    quietSeconds: schedule.quietSeconds,
    maxWaitSeconds: schedule.maxWaitSeconds,
    graceSeconds: schedule.graceSeconds,
    healthSeconds: schedule.healthSeconds,
    reason: schedule.reason,
    dryRun: options.dryRun === true,
  };
  if (typeof options.healthUrl === 'string' && options.healthUrl !== '') {
    payload.healthUrl = options.healthUrl;
  }
  if (typeof options.targetPid === 'number' && Number.isFinite(options.targetPid)) {
    payload.targetPid = options.targetPid;
  }
  if (typeof options.relaunchCommand === 'string' && options.relaunchCommand !== '') {
    payload.relaunchCommand = options.relaunchCommand;
  }
  return payload;
}

/**
 * 体检：算出「如果现在重启，会杀掉谁、用什么命令拉回来」。
 * @param {object} options 与 buildPayload 同
 * @returns {Promise<object>} plan 对象
 */
export async function resolvePlan(options) {
  const payload = buildPayload(options);
  const result = await runHelper('resolve', payload);
  if (result.ok !== true || result.plan === undefined) {
    throw new Error(result.error ?? 'helper 没有给出重启计划');
  }
  return result.plan;
}

/**
 * 这看起来像不像一个"测试用的临时状态目录"？
 *
 * 为什么需要这道闸（v0.2.0 加的，代价是一次真实事故）：测试如果拿着
 * `join(tmpdir(), 'dsr-xxx')` 去调**真的** `scheduleRestart()`，helper 会照常
 * 解析出**真实宿主**当目标、并把 killList 全部armed 起来 —— 那就不再是测试，
 * 而是「对着活人排了一颗定时炸弹」。所以凡是状态目录落在临时目录下的排程，
 * 一律拒绝：**测试想真动手，必须先把临时目录这条路径绕开（或显式 force）**。
 *
 * @param {string} stateDir 状态目录
 * @returns {boolean} 是否像测试目录
 */
export function looksLikeTestStateDir(stateDir) {
  if (typeof stateDir !== 'string' || stateDir.trim() === '') return false;
  const normalized = stateDir.replace(/\\/g, '/').toLowerCase();
  const tmp = tmpdir().replace(/\\/g, '/').toLowerCase();
  if (tmp !== '' && normalized.startsWith(tmp)) return true;
  if (normalized.includes('/temp/')) return true;
  if (normalized.includes('/appdata/local/temp')) return true;
  if (normalized.startsWith('/tmp')) return true;
  return false;
}

/**
 * 排程一次重启：先体检（失败就不排），再放 helper，最后落 pending。
 * @param {object} options 选项
 * @returns {Promise<object>} { id, helperPid, plan, schedule, dryRun }
 */
export async function scheduleRestart(options) {
  const { stateDir, sessionRoot } = options;
  const id = options.id ?? newId();
  const schedule = normalizeSchedule(options.schedule ?? {}, options.config ?? {});

  // 闸门一：测试临时目录一律不许真排程（见上面那段注释）。
  if (options.force !== true && looksLikeTestStateDir(stateDir)) {
    throw new Error(`状态目录看起来是测试用的临时目录（${stateDir}），已拒绝排程 —— `
      + '测试不该对着真实宿主排重启。要真动手请显式传 force: true，或换一个非临时目录。');
  }

  // 闸门二：授权标记文件。
  // helper 里那道「没人明确允许就不许动进程」的网关读的是**文件**而不是环境变量 ——
  // 因为 arm 交接要经过 Explorer + .lnk，那一跳不带调用方的环境。
  // 所以这里（调用方还活着的时候）把标记写进状态目录，helper 只认它。
  // 只有「过闸门一 + 不是 dry run」才写：被拒的调用不该留下任何授权痕迹。
  if (options.dryRun !== true) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.allow-real-restart'), `${new Date().toISOString()}\n${id}\n`, 'utf8');
  }

  const common = {
    id,
    stateDir,
    sessionRoot,
    healthUrl: options.healthUrl,
    schedule,
    dryRun: options.dryRun === true,
    targetPid: options.targetPid,
    relaunchCommand: options.relaunchCommand,
    callerPid: options.callerPid,
  };

  const plan = await resolvePlan(common);
  if (Number(plan.targetPid) === process.pid && options.targetPid === undefined) {
    throw new Error('解析出来的重启目标就是当前进程本身，已拒绝排程（那会变成无限重启）。'
      + '请用 callerPid / --caller-pid 指出真正的宿主进程，或用 --target-pid 明确指定。');
  }

  mkdirSync(stateDir, { recursive: true });
  const dispatched = await dispatchHelper(buildPayload(common));

  const pending = {
    id,
    helperPid: dispatched.helperPid,
    handoff: dispatched.mode,
    requestedAt: new Date().toISOString(),
    reason: schedule.reason,
    dryRun: common.dryRun,
    delaySeconds: schedule.delaySeconds,
    quietSeconds: schedule.quietSeconds,
    maxWaitSeconds: schedule.maxWaitSeconds,
    plan: {
      targetPid: plan.targetPid,
      targetName: plan.targetName,
      targetExe: plan.targetExe,
      relaunchCommand: plan.relaunchCommand,
      workingDirectory: plan.workingDirectory,
      killCount: Array.isArray(plan.killList) ? plan.killList.length + 1 : null,
    },
  };
  if (dispatched.warning !== undefined) pending.warning = dispatched.warning;
  writeFileSync(join(stateDir, 'pending.json'), `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
  return {
    id,
    helperPid: dispatched.helperPid,
    handoff: dispatched.mode,
    plan,
    schedule,
    dryRun: common.dryRun,
  };
}

/**
 * 取消待执行的排程：写一个 cancel-<id> 标记，helper 会在 400ms 内看到并退出。
 * @param {object} options 选项
 * @param {string} options.stateDir 状态目录
 * @param {number} [options.waitMs] 等 helper 退出的时间
 * @returns {Promise<object>} { id, helperPid, helperExited }
 */
export async function cancelPending(options) {
  const { stateDir, waitMs = 5000 } = options;
  const pending = readPending(stateDir);
  if (pending === null || typeof pending.id !== 'string') {
    return { ok: false, error: '没有待执行的重启排程' };
  }
  mkdirSync(stateDir, { recursive: true });
  const cancelFile = join(stateDir, `cancel-${pending.id}`);
  writeFileSync(cancelFile, `${new Date().toISOString()}\n`, 'utf8');

  const helperPid = Number.isFinite(Number(pending.helperPid)) ? Number(pending.helperPid) : null;
  let helperExited = false;
  if (helperPid !== null) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!isAlive(helperPid)) {
        helperExited = true;
        break;
      }
    }
  }
  writeFileSync(join(stateDir, 'pending.json'),
    `${JSON.stringify({ ...pending, canceled: true, canceledAt: new Date().toISOString(), helperExited }, null, 2)}\n`,
    'utf8');
  try {
    rmSync(cancelFile, { force: true });
  } catch {
    /* 标记删不掉不影响结果 */
  }
  return { ok: true, id: pending.id, helperPid, helperExited };
}

/**
 * 进程还活着吗（不发送信号，只探测）。
 * @param {number} pid 进程号
 * @returns {boolean} 是否存活
 */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err !== null && typeof err === 'object' && err.code === 'EPERM';
  }
}

/**
 * 汇总当前状态：上次报告 + 待执行排程 + 体检结果。
 * @param {object} options 选项
 * @returns {Promise<object>} 状态对象
 */
export async function collectStatus(options) {
  const { stateDir } = options;
  const last = readLastReport(stateDir);
  const pending = readPending(stateDir);
  const pendingAlive = pending !== null && Number.isFinite(Number(pending.helperPid))
    ? isAlive(Number(pending.helperPid))
    : null;

  let plan = null;
  let plannedError = null;
  try {
    plan = await resolvePlan(options);
  } catch (err) {
    plannedError = err instanceof Error ? err.message : String(err);
  }

  const status = {
    self: {
      pid: process.pid,
      execPath: process.execPath,
      cwd: process.cwd(),
      platform: process.platform,
      uptimeSeconds: Math.round(process.uptime()),
    },
    last,
    pending: pending === null
      ? null
      : { ...pending, helperAlive: pendingAlive, state: pendingState(pending, last, isAlive) },
    plan,
    stateDir,
    helperPresent: isWindows ? existsSync(PS_HELPER) : existsSync(JS_HELPER),
  };
  if (plannedError !== null) status.planError = plannedError;
  return status;
}

export { DEFAULTS };
