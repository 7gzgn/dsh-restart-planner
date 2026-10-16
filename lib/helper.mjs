#!/usr/bin/env node
/**
 * dsh-self-restart — POSIX helper（macOS / Linux）
 *
 * 与 helper.ps1 同职责、同协议：一个 base64 JSON 载荷进来，一行 JSON 出去，
 * 只做 resolve（体检）和 run（延迟→等安静→杀→拉起→健康检查→写报告）。
 *
 * ⚠ 诚实声明：这条路是照着 helper.ps1 一比一写的，**作者没有在 macOS/Linux
 * 上实跑过**（开发机只有 Windows）。README 的兼容性表里标为「未实测」。
 * 它的态度和 Windows 侧一致：能确定就动手，不能确定就报错退出，不乱猜。
 *
 * @module dsh-self-restart/helper-posix
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

/** 命令行参数解析。 */
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--action') out.action = argv[++i];
    else if (argv[i] === '--payload64') out.payload64 = argv[++i];
  }
  return out;
}

/** 解析载荷。 */
function decodePayload(b64) {
  if (!b64) return {};
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

/** 一行 JSON 到 stdout。 */
function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** ps 取一行进程信息。 */
function ps(pid) {
  try {
    const ppid = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return { pid: Number(pid), ppid: Number(ppid), comm };
  } catch {
    return null;
  }
}

/** 读一个进程的 argv（Linux 用 /proc，其他平台退化成整串）。 */
function readArgv(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    const parts = raw.toString('utf8').split('\u0000').filter((s) => s !== '');
    if (parts.length > 0) return parts;
  } catch {
    /* 非 Linux */
  }
  try {
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (args === '') return [];
    return args.split(/\s+/);
  } catch {
    return [];
  }
}

/** 整张进程表。 */
function processTable() {
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] });
  }
  return rows;
}

/** 某进程的全部后代（不含自身）。 */
function subtree(table, rootPid) {
  const byParent = new Map();
  for (const row of table) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const out = [];
  const queue = [rootPid];
  const seen = new Set([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** 体检：算出目标与拉起命令。 */
function resolvePlan(payload) {
  const overridePid = Number(payload.targetPid ?? 0);
  const callerPid = Number(payload.callerPid ?? 0) > 0 ? Number(payload.callerPid) : process.pid;
  let target;
  let resolution;

  if (overridePid > 0) {
    target = ps(overridePid);
    if (target === null) throw new Error(`target process ${overridePid} is not running`);
    resolution = 'explicit-target';
  } else {
    let current = ps(callerPid);
    if (current === null) throw new Error(`caller process ${callerPid} is not running`);
    const exe = current.comm;
    let top = current;
    for (let i = 0; i < 16; i += 1) {
      const parent = ps(top.ppid);
      if (parent === null || parent.comm !== exe) break;
      top = parent;
    }
    target = top;
    resolution = 'ancestor-walk';
  }

  const argv = readArgv(target.pid);
  const targetExe = argv.length > 0 ? argv[0] : target.comm;
  const targetArgs = argv.slice(1);
  const override = typeof payload.relaunchCommand === 'string' && payload.relaunchCommand !== ''
    ? payload.relaunchCommand
    : null;

  const table = processTable();
  const selfTree = subtree(table, process.pid);
  const excluded = new Set([process.pid, ...selfTree.map((row) => row.pid)]);
  const killList = subtree(table, target.pid).filter((row) => !excluded.has(row.pid));

  return {
    platform: process.platform,
    callerPid,
    targetPid: target.pid,
    targetName: basename(targetExe),
    targetExe,
    targetArgs: targetArgs.join(' '),
    relaunchCommand: override ?? [targetExe, ...targetArgs].join(' '),
    workingDirectory: payload.cwdHint || (dirname(targetExe) === '.' ? process.cwd() : dirname(targetExe)),
    resolution,
    treeSize: killList.length + 1,
    killList,
    relaunchArgv: override === null ? [targetExe, ...targetArgs] : null,
    warnings: excluded.size > 1
      ? [`helper subtree excluded from the kill list (${excluded.size} process(es), helper pid ${process.pid})`]
      : [],
  };
}

/** 端口通不通。 */
async function portOpen(host, port, timeoutMs) {
  const net = await import('node:net');
  return await new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

/** 会话仓库最近一次写入时间。 */
function newestSessionWrite(sessionRoot) {
  try {
    if (!sessionRoot || !existsSync(sessionRoot)) return null;
    let newest = 0;
    for (const workspace of readdirSync(sessionRoot)) {
      const wsPath = join(sessionRoot, workspace);
      let sessions;
      try {
        sessions = readdirSync(wsPath);
      } catch {
        continue;
      }
      for (const session of sessions) {
        const dir = join(wsPath, session);
        let files;
        try {
          files = readdirSync(dir);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!/^session.*\.(zstd|jsonl)$/.test(file)) continue;
          try {
            const mtime = statSync(join(dir, file)).mtimeMs;
            if (mtime > newest) newest = mtime;
          } catch {
            /* 忽略 */
          }
        }
      }
    }
    return newest === 0 ? null : new Date(newest);
  } catch {
    return null;
  }
}

/** 睡一会儿。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 跑一次完整重启。 */
async function runRestart(payload) {
  const stateDir = String(payload.stateDir ?? '');
  if (stateDir === '') throw new Error('stateDir is required');
  const reportsDir = join(stateDir, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const id = String(payload.id ?? `posix-${Date.now()}`);
  const logPath = join(stateDir, 'helper.log');
  const report = {
    id,
    state: 'starting',
    reason: String(payload.reason ?? ''),
    requestedAt: String(payload.requestedAt ?? ''),
    startedAt: new Date().toISOString(),
    helperPid: process.pid,
    platform: process.platform,
  };

  const writeReport = (state, extra = {}) => {
    report.state = state;
    report.updatedAt = new Date().toISOString();
    Object.assign(report, extra);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(join(reportsDir, `${id}.json`), json, 'utf8');
    writeFileSync(join(stateDir, 'last.json'), json, 'utf8');
  };
  const log = (message) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} [${id}] ${message}\n`, 'utf8');
    } catch {
      /* 日志写不进去也不该影响重启 */
    }
  };

  const cancelFile = join(stateDir, `cancel-${id}`);
  const canceled = () => existsSync(cancelFile);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const plan = resolvePlan(payload);
  writeReport('waiting', {
    targetPid: plan.targetPid,
    targetName: plan.targetName,
    targetExe: plan.targetExe,
    relaunchCommand: plan.relaunchCommand,
    workingDirectory: plan.workingDirectory,
    resolution: plan.resolution,
    killList: plan.killList,
  });
  log(`plan: target=${plan.targetPid} relaunch=${plan.relaunchCommand}`);

  const delayMs = Math.max(0, Number(payload.delaySeconds ?? 0)) * 1000;
  const delayDeadline = Date.now() + delayMs;
  while (Date.now() < delayDeadline) {
    if (canceled()) {
      writeReport('canceled', {});
      log('canceled during delay');
      return;
    }
    await sleep(400);
  }

  const quietMs = Math.max(0, Number(payload.quietSeconds ?? 0)) * 1000;
  const maxWaitMs = Math.max(0, Number(payload.maxWaitSeconds ?? 180)) * 1000;
  const capAt = Date.now() + maxWaitMs;
  let idleMs = null;
  while (Date.now() < capAt) {
    if (canceled()) {
      writeReport('canceled', {});
      log('canceled while waiting for quiet');
      return;
    }
    if (!alive(plan.targetPid)) {
      writeReport('exited-early', { note: 'the application exited on its own; relaunch skipped' });
      log('target exited before we killed it');
      return;
    }
    const newest = newestSessionWrite(String(payload.sessionRoot ?? ''));
    if (newest === null) break;
    const idle = Date.now() - newest.getTime();
    if (idle >= quietMs) {
      idleMs = idle;
      break;
    }
    await sleep(500);
  }
  writeReport('quiet-reached', { idleMs });

  if (payload.dryRun === true) {
    writeReport('dry-run', { note: 'dry run: nothing was stopped' });
    log('dry run: exiting');
    return;
  }

  const killedAt = new Date();
  const failures = [];
  try {
    process.kill(plan.targetPid, 'SIGTERM');
  } catch (err) {
    failures.push(`target ${plan.targetPid}: ${err.message}`);
  }
  const graceMs = Math.max(0, Number(payload.graceSeconds ?? 8)) * 1000;
  const graceDeadline = Date.now() + graceMs;
  while (Date.now() < graceDeadline) {
    if (plan.killList.every((row) => !alive(row.pid))) break;
    await sleep(300);
  }
  for (const row of plan.killList) {
    if (!alive(row.pid)) continue;
    try {
      process.kill(row.pid, 'SIGKILL');
    } catch (err) {
      failures.push(`pid ${row.pid}: ${err.message}`);
    }
  }
  writeReport('stopped', {
    killedAt: killedAt.toISOString(),
    killFailures: failures,
    killCount: plan.killList.length + 1,
  });
  log(`stopped; failures=${failures.length}`);

  let port = 0;
  let healthHost = '127.0.0.1';
  const healthUrl = String(payload.healthUrl ?? '');
  if (healthUrl !== '') {
    try {
      const url = new URL(healthUrl);
      healthHost = url.hostname;
      port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    } catch {
      port = 0;
    }
  }

  const argv = plan.relaunchArgv ?? [plan.targetExe];
  log(`relaunching ${argv.join(' ')}`);
  let newPid = null;
  try {
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      cwd: plan.workingDirectory,
      env: (() => {
        const env = { ...process.env };
        delete env.DSH_SESSION_ID;
        delete env.DSH_WEB_URL;
        delete env.DSH_SHELL;
        return env;
      })(),
    });
    child.unref();
    newPid = child.pid ?? null;
  } catch (err) {
    writeReport('relaunch-failed', { error: err.message, relaunchCommand: plan.relaunchCommand });
    log(`relaunch failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  writeReport('relaunched', { relaunchedAt: new Date().toISOString(), newPid });

  let healthy = false;
  if (port > 0) {
    const healthMs = Math.max(0, Number(payload.healthSeconds ?? 120)) * 1000;
    const healthDeadline = Date.now() + healthMs;
    while (Date.now() < healthDeadline) {
      if (await portOpen(healthHost, port, 800)) {
        healthy = true;
        break;
      }
      await sleep(500);
    }
  }
  const readyAt = new Date();
  const state = port > 0 && !healthy ? 'started-but-unhealthy' : 'ok';
  writeReport(state, {
    readyAt: readyAt.toISOString(),
    healthy,
    downtimeMs: readyAt.getTime() - killedAt.getTime(),
  });
  log(`done: state=${state} newPid=${newPid} healthy=${healthy}`);
}

/** 入口。 */
async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (!args.action) {
    emit({ ok: false, error: 'missing --action' });
    process.exitCode = 1;
    return;
  }
  try {
    const payload = decodePayload(args.payload64);
    if (args.action === 'resolve') {
      emit({ ok: true, action: 'resolve', plan: resolvePlan(payload) });
      return;
    }
    if (args.action === 'run') {
      await runRestart(payload);
      return;
    }
    emit({ ok: false, error: `unknown action: ${args.action}` });
    process.exitCode = 1;
  } catch (err) {
    let stateDir = '';
    try {
      stateDir = String(decodePayload(args.payload64).stateDir ?? '');
    } catch {
      /* 载荷本身就坏了 */
    }
    if (stateDir !== '' && existsSync(stateDir)) {
      try {
        const id = String(decodePayload(args.payload64).id ?? 'unknown');
        const json = `${JSON.stringify({ id, state: 'error', error: err.message, updatedAt: new Date().toISOString() }, null, 2)}\n`;
        mkdirSync(join(stateDir, 'reports'), { recursive: true });
        writeFileSync(join(stateDir, 'reports', `${id}.json`), json, 'utf8');
        writeFileSync(join(stateDir, 'last.json'), json, 'utf8');
      } catch {
        /* 报告写不进就算了 */
      }
    }
    emit({ ok: false, error: err.message });
    process.exitCode = 1;
  }
}

await main();
