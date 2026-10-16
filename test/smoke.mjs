/**
 * dsh-self-restart — smoke test
 *
 * 分三层，从便宜到贵：
 *   1. 纯逻辑：参数归一化、id、报告渲染；
 *   2. resolve：对着**本进程**体检一次，验证「往上找到应用顶层」这条链子；
 *   3. 真刀真枪（仅 Windows）：搭一个 dummy 结构
 *        壳(会被杀) → host(会被杀) → helper(必须活着)
 *      让 helper 真的把壳和 host 杀掉、再按给的命令拉起来。
 *      这一步验证的是整个插件的核心风险：**helper 能不能活过它自己杀掉的祖先**。
 *
 * 用法：node test/smoke.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agoText,
  newId,
  normalizeSchedule,
  renderReport,
  resolveSessionRoot,
  resolveStateDir,
} from '../lib/plan.js';
import { isAlive, resolvePlan, runHelper } from '../lib/core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = dirname(HERE);
const FIXTURE_APP = join(HERE, 'fixtures', 'dummy-app.mjs');
const PS_HELPER = join(PROJECT, 'lib', 'helper.ps1');
const isWindows = process.platform === 'win32';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    process.stdout.write(`  ok   ${name}\n`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    process.stdout.write(`  FAIL ${name}\n       ${err.message}\n`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  ok   ${name}\n`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    process.stdout.write(`  FAIL ${name}\n       ${err.message}\n`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等一个条件成立。 */
async function waitFor(label, predicate, timeoutMs = 60000, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(everyMs);
  }
  throw new Error(`等待超时：${label}`);
}

/** 读 JSON 文件（读不到给 null）。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 杀掉一个 pid（测试收尾用，不关心失败）。 */
function tryKill(pid) {
  const value = Number(pid);
  // 关键：pid 为 0 / NaN 时绝不能调用 process.kill —— kill(0) 会把整个进程组干掉
  if (!Number.isFinite(value) || value <= 0) return;
  try {
    process.kill(value);
  } catch {
    /* 已经死了 */
  }
}

/** 起一条 dummy 链（壳 → host → helper）。 */
function spawnChain(stateDir, payload, extraEnv = {}) {
  const payload64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const app = spawn(process.execPath, [FIXTURE_APP, '--gen', '0'], {
    stdio: 'ignore',
    windowsHide: true,
    cwd: PROJECT,
    env: {
      ...process.env,
      DSR_STATE: stateDir,
      DSR_PAYLOAD_TEMPLATE: payload64,
      DSR_HELPER: PS_HELPER,
      DSR_SHELL: 'powershell.exe',
      ...extraEnv,
    },
  });
  return app;
}

process.stdout.write('1) 纯逻辑\n');
check('normalizeSchedule 用默认值兜住空输入', () => {
  const s = normalizeSchedule({});
  assert.equal(s.delaySeconds, 20);
  assert.equal(s.quietSeconds, 4);
  assert.equal(s.maxWaitSeconds, 180);
  assert.equal(s.reason, '');
});
check('normalizeSchedule 夹住越界值', () => {
  const s = normalizeSchedule({ delaySeconds: -5, quietSeconds: 99999, reason: 'x'.repeat(500) });
  assert.equal(s.delaySeconds, 0);
  assert.equal(s.quietSeconds, 600);
  assert.equal(s.reason.length, 400);
});
check('normalizeSchedule 认字符串数字', () => {
  assert.equal(normalizeSchedule({ delaySeconds: '12' }).delaySeconds, 12);
});
check('newId 形如 时间戳-随机', () => {
  assert.match(newId(new Date(2026, 9, 16, 21, 30, 5)), /^20261016-213005-[0-9a-f]{4}$/);
});
check('renderReport 覆盖空值与 ok 两种情况', () => {
  assert.match(renderReport(null), /还没有重启记录/);
  const text = renderReport({ id: 'x', state: 'ok', reason: '装插件', newPid: 42, downtimeMs: 3200 });
  assert.match(text, /重启完成/);
  assert.match(text, /装插件/);
  assert.match(text, /3\.2 秒/);
});
check('agoText 说人话', () => {
  assert.equal(agoText(new Date(Date.now() - 5000)), '5 秒前');
  assert.match(agoText(new Date(Date.now() - 1800_000)), /分钟前/);
  assert.match(agoText(new Date(Date.now() - 7200_000)), /小时前/);
});
check('路径落在 DSH_HOME 下', () => {
  const env = { DSH_HOME: join('C:', 'fake', 'home') };
  assert.equal(resolveStateDir(env), join(env.DSH_HOME, 'dsh-self-restart'));
  assert.equal(resolveSessionRoot(env), join(env.DSH_HOME, 'sessions'));
});

process.stdout.write('2) resolve：对着本进程体检\n');
await checkAsync('能找到「要杀谁」和「用什么命令拉回来」', async () => {
  const plan = await resolvePlan({
    stateDir: join(tmpdir(), 'dsr-probe'),
    sessionRoot: join(tmpdir(), 'dsr-probe-sessions'),
  });
  assert.ok(Number.isFinite(plan.targetPid) && plan.targetPid > 0, '应该有 targetPid');
  assert.ok(typeof plan.targetExe === 'string' && plan.targetExe !== '', '应该有 targetExe');
  assert.ok(typeof plan.relaunchCommand === 'string' && plan.relaunchCommand !== '', '应该有 relaunchCommand');
  assert.ok(typeof plan.workingDirectory === 'string' && plan.workingDirectory !== '', '应该有工作目录');
  assert.ok(Array.isArray(plan.killList), 'killList 应该是数组');
  assert.ok(typeof plan.platform === 'string' && plan.platform !== '', '应该有 platform');
});

if (isWindows) {
  process.stdout.write('3) 真刀真枪：helper 活过自己杀掉的祖先（dummy 结构 + Explorer 交接）\n');
  const stateDir = mkdtempSync(join(tmpdir(), 'dsr-test-'));
  let appPid = null;
  let hostPid = null;
  let helperPid = null;
  let relaunchedPid = null;
  let app3Pid = null;

  try {
    const id = newId();
    const template = {
      id,
      stateDir,
      sessionRoot: join(stateDir, 'no-such-sessions'),
      requestedAt: new Date().toISOString(),
      targetPid: 0,
      relaunchCommand: `"${process.execPath}" "${FIXTURE_APP}" --gen 1`,
      cwdHint: PROJECT,
      delaySeconds: 1,
      quietSeconds: 0,
      maxWaitSeconds: 6,
      graceSeconds: 3,
      healthSeconds: 0,
      reason: 'smoke test',
      dryRun: false,
    };

    const app = spawnChain(stateDir, template);
    appPid = app.pid;
    const chain = await waitFor('壳与 host 都登记了 pid', () => {
      const value = readJson(join(stateDir, 'chain.json'));
      return value !== null && Number.isFinite(value.app) && Number.isFinite(value.host) && Number.isFinite(value.helper) ? value : null;
    });
    appPid = chain.app;
    hostPid = chain.host;
    const armPid = chain.helper;
    process.stdout.write(`       （壳 ${appPid} / host ${hostPid} / arm ${armPid}）\n`);

    const boot = await waitFor('helper 报到（boot 文件）', () => {
      const value = readJson(join(stateDir, `boot-${id}.json`));
      return value !== null && Number.isFinite(value.pid) ? value : null;
    }, 60000);
    helperPid = boot.pid;
    process.stdout.write(`       （run helper ${helperPid}，父进程 ${boot.parent}）\n`);

    const report = await waitFor('重启报告出现', () => {
      const value = readJson(join(stateDir, 'last.json'));
      return value !== null && value.id === id && ['ok', 'error', 'relaunch-failed', 'started-but-unhealthy', 'exited-early'].includes(value.state)
        ? value
        : null;
    }, 90000);

    assert.equal(report.state, 'ok', `报告状态应该是 ok，实际 ${report.state}（${report.error ?? ''}）`);
    assert.equal(report.helperPid, helperPid, '报告里的 helper pid 应该就是报到的那个 helper');
    assert.notEqual(boot.parent, hostPid, 'helper 的父进程不该是那条会被杀掉的链（说明它确实被交接出去了）');
    assert.notEqual(boot.parent, appPid, 'helper 的父进程不该是那个壳');
    assert.equal(report.targetPid, appPid, '报告里的目标应该就是那个「壳」');
    assert.ok(!isAlive(appPid), '「壳」应该已经死了');
    assert.ok(!isAlive(hostPid), '「host」应该已经死了');
    assert.ok(report.killList.some((row) => Number(row.pid) === hostPid), 'host 应该在 killList 里');
    assert.ok(!report.killList.some((row) => Number(row.pid) === helperPid), 'helper 绝不能出现在 killList 里');

    relaunchedPid = report.newPid;
    assert.ok(Number.isFinite(relaunchedPid) && relaunchedPid > 0, '应该记录了新进程 pid');
    await waitFor('新实例真的活着', () => isAlive(relaunchedPid), 15000);
    assert.ok(typeof report.downtimeMs === 'number' && report.downtimeMs >= 0, '应该有停机时长');
    process.stdout.write(`       （新实例 ${relaunchedPid}；停机 ${(report.downtimeMs / 1000).toFixed(1)}s；killList ${report.killList.length} 个）\n`);

    process.stdout.write('4) cancel：撤销还没执行的排程\n');
    const app3 = spawn(process.execPath, [FIXTURE_APP, '--gen', '1'], {
      stdio: 'ignore', windowsHide: true, cwd: PROJECT,
    });
    app3Pid = app3.pid;
    const cancelId = newId();
    const cancelPayload = { ...template, id: cancelId, targetPid: app3Pid, delaySeconds: 10 };
    const armed = await runHelper('arm', cancelPayload, 45000);
    assert.equal(armed.ok, true, `交接应该成功：${JSON.stringify(armed)}`);
    assert.ok(['explorer', 'direct'].includes(armed.mode), `交接方式应该明确：${armed.mode}`);
    process.stdout.write(`       （交接方式 ${armed.mode}，helper pid ${armed.helperPid}）\n`);
    await sleep(2000);
    writeFileSync(join(stateDir, `cancel-${cancelId}`), 'canceled by test\n', 'utf8');
    const canceled = await waitFor('helper 认了取消标记', () => {
      const value = readJson(join(stateDir, 'last.json'));
      return value !== null && value.id === cancelId && value.state === 'canceled' ? value : null;
    }, 30000);
    assert.equal(canceled.state, 'canceled');
    await sleep(10000);
    assert.ok(isAlive(app3Pid), '被取消的目标必须还活着');
    process.stdout.write('       （目标没被动过）\n');
    tryKill(armed.helperPid);

    process.stdout.write('5) exited-early：应用自己先退出时不重启\n');
    const shortLived = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], {
      stdio: 'ignore', windowsHide: true,
    });
    const earlyId = newId();
    const earlyResult = await runHelper('run', {
      id: earlyId,
      stateDir,
      sessionRoot: join(stateDir, 'no-such-sessions'),
      requestedAt: new Date().toISOString(),
      targetPid: shortLived.pid,
      relaunchCommand: `"${process.execPath}" "-e" "setTimeout(() => {}, 60000)"`,
      delaySeconds: 3,
      quietSeconds: 0,
      maxWaitSeconds: 30,
      graceSeconds: 3,
      healthSeconds: 0,
      reason: 'exited-early test',
      dryRun: false,
    }, 60000);
    assert.equal(earlyResult.ok, true, `helper 应该正常返回：${JSON.stringify(earlyResult)}`);
    const earlyReport = readJson(join(stateDir, 'reports', `${earlyId}.json`));
    assert.equal(earlyReport?.state, 'exited-early', `应该是 exited-early，实际 ${earlyReport?.state}`);
    process.stdout.write('       （没有多余的重启）\n');
  } finally {
    tryKill(relaunchedPid);
    tryKill(appPid);
    tryKill(hostPid);
    tryKill(helperPid);
    tryKill(app3Pid);
    await sleep(300);
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不致命 */
    }
  }
} else {
  process.stdout.write('3) 跳过真刀真枪（非 Windows：helper.mjs 未在真机上验证）\n');
}

const failed = results.filter((row) => row.ok !== true);
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length > 0) {
  process.exitCode = 1;
}
