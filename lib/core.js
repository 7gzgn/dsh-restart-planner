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
  return { file: process.execPath, args: [JS_HELPER, '--action', action, '--payload64', b64] };
}

/**
 * 同步跑一次 helper（只用于 resolve：只读、很快就回）。
 * @param {string} action 动作
 * @param {object} payload 载荷
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<object>} helper 返回的 JSON
 */
export async function runHelper(action, payload, timeoutMs = 30000) {
  const { file, args } = await helperCommand(action, payload);
  return await new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
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
 * 排程一次重启：先体检（失败就不排），再放 helper，最后落 pending。
 * @param {object} options 选项
 * @returns {Promise<object>} { id, helperPid, plan, schedule, dryRun }
 */
export async function scheduleRestart(options) {
  const { stateDir, sessionRoot } = options;
  const id = options.id ?? newId();
  const schedule = normalizeSchedule(options.schedule ?? {}, options.config ?? {});
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
