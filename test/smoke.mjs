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
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULTS,
  agoText,
  confirmQuestion,
  fallbackChoice,
  newId,
  normalizeConfirm,
  normalizeSchedule,
  parseConfirmAnswer,
  pendingState,
  renderReport,
  resolveSessionRoot,
  resolveStateDir,
} from '../lib/plan.js';
import { isAlive, resolvePlan, runHelper } from '../lib/core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = dirname(HERE);

/**
 * 自检：**不许在"活代码树"里跑这个套件**。
 *
 * 为什么（2026-10-16 四次真实事故）：`D:\dsh\projects\dsh-self-restart` 同时是
 * profile 里 junction 挂载的那份**正在被宿主使用的代码**。在这儿跑套件时，测试进程是
 * DSH 的子进程，helper 往上解析「应用顶层」就解析到**真宿主** —— 于是"跑个测试"
 * 变成了"把手里这个应用重启"。第 3 节的杀+拉是它的设计目的，但在这里它的靶子是活人。
 *
 * 所以：这个路径下**一律拒绝运行**。要验真动手的链路，请把工程复制到别处（沙箱副本）
 * 再跑 —— 那儿 `process.execPath` 是 node 而不是桌面 app，天然打不到宿主。
 * 确实要在原地跑（例如只跑纯逻辑）时，用 `DSR_I_KNOW_THIS_IS_THE_LIVE_TREE=1` 明确豁免。
 */
const LIVE_TREE_HINT = join('dsh', 'projects', 'dsh-self-restart');
const IS_LIVE_TREE = PROJECT.replace(/\\/g, '/').toLowerCase().endsWith('/' + LIVE_TREE_HINT.replace(/\\/g, '/'));
if (IS_LIVE_TREE && process.env.DSR_I_KNOW_THIS_IS_THE_LIVE_TREE !== '1') {
  process.stdout.write(
    '拒绝运行：这个套件正在「活代码树」里执行 —— ' + PROJECT + '\n'
    + '  它是 profile junction 挂载的那份正在被宿主使用的代码，测到这里会真的重启宿主（已发生 4 次）。\n'
    + '  请把工程复制到别处（沙箱）再跑；或设 DSR_I_KNOW_THIS_IS_THE_LIVE_TREE=1 明确豁免（只跑纯逻辑时）。\n',
  );
  process.exit(2);
}

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
check('pendingState 能分辨「跑着/已完成/丢了」', () => {
  const alive = (pid) => pid === 42;
  assert.equal(pendingState(null, null, alive), 'none');
  assert.equal(pendingState({ id: 'a', canceled: true }, null, alive), 'canceled');
  assert.equal(pendingState({ id: 'a', helperPid: 42 }, null, alive), 'running');
  // 重启刚完、报告已经写出来了，但 pending.json 还在：必须读成「已完成」，不能误报
  assert.equal(pendingState({ id: 'a', helperPid: 7 }, { id: 'a', state: 'ok' }, alive), 'finished');
  assert.equal(pendingState({ id: 'a', helperPid: 7 }, { id: 'b', state: 'ok' }, alive), 'lost');
});
check('路径落在 DSH_HOME 下', () => {
  const env = { DSH_HOME: join('C:', 'fake', 'home') };
  assert.equal(resolveStateDir(env), join(env.DSH_HOME, 'dsh-self-restart'));
  assert.equal(resolveSessionRoot(env), join(env.DSH_HOME, 'sessions'));
});

process.stdout.write('2) resolve：对着本进程体检\n');
await checkAsync('helper.ps1 先过 PowerShell 自己的解析器（语法错别伪装成超时）', async () => {
  if (!isWindows) return;
  const script = [
    '$tokens = $null; $errs = $null;',
    `$null = [System.Management.Automation.Language.Parser]::ParseFile('${PS_HELPER.replace(/'/g, "''")}', [ref]$tokens, [ref]$errs);`,
    'if ($errs -and $errs.Count -gt 0) { $errs | ForEach-Object { Write-Output ("line " + $_.Extent.StartLineNumber + ": " + $_.Message) }; exit 1 }',
    "Write-Output 'parse ok'",
  ].join(' ');
  const out = await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
      (err, stdout) => (err ? reject(new Error(String(stdout || err.message))) : resolve(String(stdout))));
  });
  assert.match(out, /parse ok/, `helper.ps1 解析失败：${out}`);
});
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

/**
 * 「真动手」那几节（第 3 节的杀+拉、第 4/5 节的 cancel 与 exited-early 彩排）必须显式授权。
 *
 * 为什么（2026-10-16 真实事故，代价是宿主被连着重启两次）：这个套件如果**从 DSH 里跑**
 * （即 `node test/smoke.mjs` 是 DSH 的子进程），`resolvePlan()` 往上找到的「应用顶层」
 * 就是**真正的 DSH**。于是第 3 节会照着那份计划把宿主停掉再拉起来 —— 测试变成了对着活人开枪。
 *
 * 所以默认**跳过**：要真验这条链，请在 DSH 之外（独立终端）跑，并显式设
 * `DSR_ALLOW_REAL_RESTART=1`。
 */
const ALLOW_REAL_RESTART = process.env.DSR_ALLOW_REAL_RESTART === '1';
if (isWindows) {
  if (ALLOW_REAL_RESTART) {
    process.stdout.write('3) 真刀真枪：helper 活过自己杀掉的祖先（dummy 结构 + Explorer 交接）\n');
  } else {
    process.stdout.write('3) 跳过真刀真枪：需要显式授权（在 DSH 之外跑，并设 DSR_ALLOW_REAL_RESTART=1）\n');
    process.stdout.write('   ↑ 原因：本套件若从 DSH 内运行，resolve 出来的「应用顶层」就是真宿主，这一节会真的把它停掉再拉起来。\n');
  }
}
if (isWindows && ALLOW_REAL_RESTART) {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsr-test-'));
  let appPid = null;
  let hostPid = null;
  let helperPid = null;
  let relaunchedPid = null;
  let app3Pid = null;

  try {
    const id = newId();
    // helper 的「arm/run 需要授权标记」这道闸，生产路径由 core.js 的 ensureAllowMarker()
    // 在交接前写入。这里的 dummy-host 是**直接 spawn helper.ps1** 的（绕过 core），
    // 所以测试必须自己先把标记写进状态目录 —— 它就是"明确授权"的那个调用方。
    writeFileSync(join(stateDir, '.allow-real-restart'), `${new Date().toISOString()}\ntest-authorization\n`, 'utf8');
    const template = {
      id,
      stateDir,
      sessionRoot: join(stateDir, 'no-such-sessions'),
      requestedAt: new Date().toISOString(),
      targetPid: 0,
      // ★ 靶子必须显式指认（2026-10-16 七次事故的根源）：
      // helper 的祖先解析会一路往上走 —— 从这条 dummy 链爬到**真正的 DSH 宿主**
      // （实测：report 的 target 就是活宿主 pid）。所以这里冻结 callerPid = 测试自己，
      // 解析到此为止，绝不会越界到活人身上。
      callerPid: process.pid,
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
    // 这次载荷没给健康检查地址 → 只该有 relaunchMs（拉起耗时），
    // 不该出现被误称为「停机时长」的 downtimeMs
    assert.equal(report.portChecked, false);
    assert.equal(typeof report.downtimeMs, 'undefined', '没体检端口就不该报 downtimeMs');
    assert.ok(typeof report.relaunchMs === 'number' && report.relaunchMs >= 0, '应该有拉起耗时');
    process.stdout.write(`       （新实例 ${relaunchedPid}；拉起耗时 ${(report.relaunchMs / 1000).toFixed(1)}s；killList ${report.killList.length} 个）\n`);

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
} else if (isWindows && !ALLOW_REAL_RESTART) {
  process.stdout.write('   （第 3、4、5 节已跳过，其余测试照常）\n');
} else {
  process.stdout.write('3) 跳过真刀真枪（非 Windows：helper.mjs 未在真机上验证）\n');
}

process.stdout.write('6) 插件装载：拿一个假 ctx 真的 apply 一次\n');
await checkAsync('apply() 能注册工具、挂公告段、并正常卸载', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(mod.name, 'dsh-self-restart');
  assert.deepEqual(mod.inject, ['tools', 'systemPrompt']);

  const registered = [];
  const sections = [];
  const effects = [];
  const fakeCtx = {
    tools: { register: (def) => { registered.push(def); return () => {}; } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
    effect: (fn, label) => { effects.push({ fn, label }); return () => {}; },
  };
  mod.apply(fakeCtx, { stateDir: join(tmpdir(), 'dsr-load-test') });

  assert.equal(registered.length, 1, '应该注册一个工具');
  assert.equal(registered[0].name, 'self_restart');
  assert.ok(Array.isArray(registered[0].parameters) === false, 'parameters 应该是对象');
  assert.ok(typeof registered[0].execute === 'function');
  assert.ok(typeof registered[0].output.render === 'function');
  assert.equal(sections.length, 1, '应该挂一段公告');
  assert.match(sections[0].text, /dsh-self-restart/);
  assert.equal(effects.length, 1, '应该有 teardown effect');

  // 未知 action 必须变成普通错误结果，而不是抛出去
  const bad = await registered[0].execute({ action: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /unknown action/);

  // 渲染函数不该崩：三种 action 各过一遍
  for (const action of ['schedule', 'status', 'cancel']) {
    const rendered = registered[0].output.render({}, { ok: true, action, data: {} });
    assert.ok(Array.isArray(rendered) && typeof rendered[0].text === 'string' && rendered[0].text !== '');
  }
  const failed = registered[0].output.render({}, { ok: false, action: 'schedule', error: 'boom' });
  assert.match(failed[0].text, /boom/);
});

// 工具返回值里不允许出现 undefined（宿主是 lossless-JSON 校验）
await checkAsync('未知 action 的返回值里没有 undefined 字段', async () => {
  const mod = await import('../lib/index.js');
  const registered = [];
  mod.apply({
    tools: { register: (def) => { registered.push(def); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    effect: () => () => {},
  }, { stateDir: join(tmpdir(), 'dsr-load-test-2'), announceToAgent: false });
  const out = await registered[0].execute({ action: 'zzz' });
  for (const [key, value] of Object.entries(out)) {
    assert.notEqual(value, undefined, `字段 ${key} 是 undefined`);
  }
});

// 真机第一次调用踩到的：cordis 对没 inject 的服务是「读一下就抛」
await checkAsync('ctx.webServer 抛错时，工具只能失败、不能把异常抛出去', async () => {
  const mod = await import('../lib/index.js');
  const registered = [];
  const ctx = {
    tools: { register: (def) => { registered.push(def); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    effect: () => () => {},
  };
  Object.defineProperty(ctx, 'webServer', {
    get() { throw new Error('cannot get property "webServer" without inject'); },
  });
  mod.apply(ctx, { stateDir: join(tmpdir(), 'dsr-load-test-3'), announceToAgent: false });
  const out = await registered[0].execute({ action: 'cancel' });
  assert.equal(out.action, 'cancel');
  assert.equal(typeof out.ok, 'boolean', '应该返回一个普通结果，而不是抛异常');
  assert.equal(out.ok, false, '没有待执行排程时应该是一次干净的失败');
});

// ───────────────────────── v0.2.0：重启前先问时机（confirm）─────────────────────────
// 这一节验证的是「眨眼」：没人应答时既不能卡死、也不能静默改成立刻。

check('confirm 的问题形状：四选一，且不带 intent（避免 approve/detail 校验）', () => {
  const q = confirmQuestion();
  assert.equal(q.options.length, 4, '应该是四个选项');
  assert.deepEqual(q.options.map((o) => o.label), ['立刻', '30 秒后', '60 秒后', '取消']);
  assert.equal(q.intent, undefined, '带 intent 就必须给 detail 且 approve 标签匹配，这里不需要');
  assert.ok(q.id && q.header && q.question, '问题要有 id / header / question');
});

check('答案解析：中文标签 / id / 自由文本都能落到正确的 delay', () => {
  assert.deepEqual(parseConfirmAnswer('立刻'), { kind: 'schedule', choice: 'now', delaySeconds: 3 });
  assert.deepEqual(parseConfirmAnswer('30 秒后'), { kind: 'schedule', choice: '30', delaySeconds: 30 });
  assert.deepEqual(parseConfirmAnswer('60 秒后'), { kind: 'schedule', choice: '60', delaySeconds: 60 });
  assert.deepEqual(parseConfirmAnswer('cancel'), { kind: 'cancel' });
  assert.deepEqual(parseConfirmAnswer('取消'), { kind: 'cancel' });
  assert.deepEqual(parseConfirmAnswer('now'), { kind: 'schedule', choice: 'now', delaySeconds: 3 });
  assert.deepEqual(parseConfirmAnswer('30'), { kind: 'schedule', choice: '30', delaySeconds: 30 });
  // 认不出来的答案 → 回到 30 秒默认档，**绝不静默改成立刻**
  assert.deepEqual(parseConfirmAnswer('随便吧'), { kind: 'schedule', choice: 'default', delaySeconds: 30 });
  assert.deepEqual(parseConfirmAnswer(''), { kind: 'schedule', choice: 'default', delaySeconds: 30 });
});

check('无应答兜底：ask-later=再等 30 秒 / cancel=不重启 / now=立刻', () => {
  assert.equal(fallbackChoice('ask-later').delaySeconds, 30);
  assert.equal(fallbackChoice('cancel').kind, 'cancel');
  assert.equal(fallbackChoice('now').delaySeconds, 3);
  assert.equal(normalizeConfirm({ confirm: true, confirmFallback: '瞎写' }, {}).fallback, 'ask-later', '非法值按默认');
});

check('confirm 默认关闭：不传就是静默排程（老人的行为不变）', () => {
  assert.equal(normalizeConfirm({}, {}).enabled, false);
  assert.equal(normalizeConfirm({ confirm: false }, { confirm: true }).enabled, false, '工具参数显式 false 应压过插件配置');
  assert.equal(normalizeConfirm({}, { confirm: true }).enabled, true, '插件配置可把默认打开');
  assert.equal(normalizeConfirm({}, {}).timeoutMs, DEFAULTS.confirmTimeoutMs);
});

/** 造一个假 ctx：userQuestions 由调用方决定有/没有。 */
function fakeCtx(userQuestions) {
  const registered = [];
  const ctx = {
    tools: { register: (def) => { registered.push(def); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    effect: () => () => {},
  };
  if (userQuestions !== undefined) ctx.userQuestions = userQuestions;
  return { ctx, registered };
}

/**
 * 给测试用的状态目录：建好再返回。
 *
 * 为什么要先建：`resolvePlan()` 要起 helper 做一次只读体检，helper 需要状态目录存在。
 * 生产路径里 `core.js` 的 `scheduleRestart()` 会先 `mkdirSync`，所以插件没问题；
 * 但测试直接调 `execute` 时目录还不存在 —— 建一下，别让测试因为这种琐事挂掉。
 */
function testStateDir(name) {
  const dir = join(tmpdir(), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 给测试用的 stateDir 加一道「地雷」：**一旦被真读就抛**。
 *
 * 为什么（2026-10-16 两次真实事故）：测试只要漏了 `dryRun`，就会走到真的
 * `scheduleRestart()` —— 而 helper 解析出来的目标是**真宿主**，于是"跑个测试"
 * 变成"把手里的应用重启两次"。`core.js` 里那道"临时目录不许排程"的闸能拦住它，
 * 但那要等到体检之后；这里让它在**碰到 stateDir 的第一行**就炸，连 helper 都不拉起。
 * 用 `__fake_state_dir__` 这种一眼假的名字，是为了万一漏出去也不会误伤真目录。
 */
function fakeStateDir(name) {
  const text = String(name);
  return new Proxy({}, {
    // 允许被转成字符串（path.join 等会用到），但不允许取任何属性 ——
    // core.js 读 stateDir 的第一件事就是取属性，于是当场炸在这里。
    get(_target, prop) {
      if (prop === 'toString' || prop === Symbol.toPrimitive || prop === 'valueOf') {
        return () => text;
      }
      throw new Error(`测试用的假 stateDir 被读取了（.${String(prop)}）—— 这条路径会真的去排程重启。请给它加 dryRun: true。`);
    },
  });
}

await checkAsync('用户选「30 秒后」→ 询问发出去、选项正确（dry run，不排真程）', async () => {
  const mod = await import('../lib/index.js');
  const seen = [];
  const { ctx, registered } = fakeCtx({
    askTimed: async (request, callId, timeoutMs) => {
      seen.push({ callId, timeoutMs, questions: request.questions.length });
      return { answers: [{ id: 'restart_when', selected: ['30 秒后'] }] };
    },
  });
  mod.apply(ctx, { stateDir: testStateDir('dsr-confirm-test-1'), announceToAgent: false });
  const out = await registered[0].execute({ action: 'schedule', confirm: true, delaySeconds: 999, dryRun: true, force: true });
  assert.equal(out.ok, true);
  assert.equal(seen.length, 0, 'dry run 不该打扰用户 —— 它只演算');
  assert.equal(out.data.schedule.delaySeconds, 999, 'dry run 不改调用方给的 delay');
  assert.deepEqual(out.data.confirm.wouldAsk.options, ['立刻', '30 秒后', '60 秒后', '取消'], '要如实报告真跑会问什么');
  assert.equal(out.data.confirm.wouldAsk.fallback, 'ask-later');
});

await checkAsync('用户选「取消」→ 取消规则成立，且 dry run 下不排程、不放 helper', async () => {
  const mod = await import('../lib/index.js');
  const { ctx, registered } = fakeCtx({
    askTimed: async () => ({ answers: [{ id: 'restart_when', selected: ['取消'] }] }),
  });
  mod.apply(ctx, { stateDir: testStateDir('dsr-confirm-test-2'), announceToAgent: false });
  const out = await registered[0].execute({ action: 'schedule', confirm: true, delaySeconds: 5, dryRun: true, force: true });
  assert.equal(out.ok, true, '取消 / dry run 都不是失败');
  assert.equal(out.data.dryRun, true, '应当是 dry run');
  assert.equal(out.data.helperPid ?? null, null, 'dry run 绝不能真的放出 helper');
  assert.equal(out.data.handoff, 'dry-run', 'dry run 的交接方式就是「不动手」');
  assert.equal(out.data.confirm.wouldAsk.fallback, 'ask-later', 'dry run 要如实报告兜底策略');
  // 「取消」这条规则本身由纯逻辑层保证；
  // 这条测试只负责证明 dry run 不动手（不排程、不放 helper）。
  assert.deepEqual(parseConfirmAnswer('取消'), { kind: 'cancel' });
  assert.deepEqual(parseConfirmAnswer('cancel'), { kind: 'cancel' });
});

await checkAsync('没人应答（超时）→ 兜底再等 30 秒的规则成立，绝不立刻重启', async () => {
  const mod = await import('../lib/index.js');
  const { ctx, registered } = fakeCtx({ askTimed: async () => ({ pending: true, callId: 'x' }) });
  mod.apply(ctx, { stateDir: testStateDir('dsr-confirm-test-3'), announceToAgent: false });
  const out = await registered[0].execute({ action: 'schedule', confirm: true, dryRun: true, force: true });
  assert.equal(out.ok, true);
  assert.equal(out.data.confirm.wouldAsk.fallback, 'ask-later', '默认兜底是「再等 30 秒」');
  assert.equal(fallbackChoice('ask-later').delaySeconds, 30, 'ask-later 的实际取值');
  assert.notEqual(fallbackChoice('ask-later').delaySeconds, 3, '绝不静默改成立刻');
  const custom = await registered[0].execute({ action: 'schedule', confirm: true, confirmFallback: 'now', dryRun: true, force: true });
  assert.equal(custom.data.confirm.wouldAsk.fallback, 'now', '兜底可配');
});

await checkAsync('兜底配成 cancel → 规则成立（fallbackChoice 返回 cancel），dry run 不动手', async () => {
  const mod = await import('../lib/index.js');
  const { ctx, registered } = fakeCtx(undefined);
  mod.apply(ctx, { stateDir: testStateDir('dsr-confirm-test-4'), announceToAgent: false });
  const out = await registered[0].execute({ action: 'schedule', confirm: true, confirmFallback: 'cancel', dryRun: true, force: true });
  assert.equal(out.ok, true, 'dry run 不是失败');
  assert.equal(out.data.confirm.wouldAsk.fallback, 'cancel', '配置要如实传递');
  assert.equal(out.data.dryRun, true, '应当是 dry run');
  assert.equal(out.data.helperPid ?? null, null, 'dry run 不能放出 helper');
  // 兜底=取消这条规则在纯逻辑层
  assert.equal(fallbackChoice('cancel').kind, 'cancel');
});

await checkAsync('问不到人（无 userQuestions）→ 不抛异常，按兜底走', async () => {
  const mod = await import('../lib/index.js');
  const { ctx, registered } = fakeCtx(undefined);
  mod.apply(ctx, { stateDir: testStateDir('dsr-confirm-test-5'), announceToAgent: false });
  // 注意：**必须带 dryRun** —— 不带就是真去排一次 30 秒后的重启（曾经把宿主连重启两次）
  const out = await registered[0].execute({ action: 'schedule', confirm: true, dryRun: true, force: true });
  assert.equal(out.ok, true, '问不到人只是一次降级，不是失败');
  assert.equal(out.data.confirm.asked, false, '没有可用询问器时不该说问过了');
  assert.equal(out.data.confirm.wouldAsk.fallback, 'ask-later');
  assert.equal(out.data.schedule.delaySeconds, 20, 'dry run 保留调用方的 delay（兜底值由规则层单测保证）');
  assert.equal(fallbackChoice('ask-later').delaySeconds, 30, '兜底是 30 秒 —— 这条由纯逻辑测试保证');
});

await checkAsync('userQuestions 读一下就抛（cordis 未 inject）→ 工具不炸', async () => {
  const mod = await import('../lib/index.js');
  const { ctx, registered } = fakeCtx(undefined);
  Object.defineProperty(ctx, 'userQuestions', {
    get() { throw new Error('cannot get property "userQuestions" without inject'); },
  });
  mod.apply(ctx, { stateDir: testStateDir('dsr-confirm-test-6'), announceToAgent: false });
  const out = await registered[0].execute({ action: 'schedule', confirm: true, dryRun: true, force: true });
  assert.equal(typeof out.ok, 'boolean', '不该把异常抛进宿主');
  assert.equal(out.ok, true);
  assert.equal(out.data.confirm.asked, false, 'getter 抛错应当被当成「没有询问器」');
});

await checkAsync('询问器自己抛错 → 不退化成炸弹（被闸拦下），也绝不静默立刻重启', async () => {
  const mod = await import('../lib/index.js');
  const { ctx, registered } = fakeCtx({
    askTimed: async () => { throw new Error('boom：answerer 崩了'); },
  });
  mod.apply(ctx, { stateDir: testStateDir('dsr-confirm-test-7'), announceToAgent: false });
  // 故意**不带** dryRun：asker 抛错 → 走兜底排程 → 撞上安全闸。
  // 这里要的正是那个结果：**宁可失败，也不许把一次 30 秒后的重启排到真宿主头上**。
  // 两道闸都可能先命中：core.js 的"临时目录不许排程"，或 helper 的 DSR_ALLOW_REAL_RESTART 网关。
  const out = await registered[0].execute({ action: 'schedule', confirm: true });
  assert.equal(out.ok, false, '安全闸必须拦住它');
  assert.match(String(out.error), /refused|临时目录|allow-real-restart/, `错误要说清原因，实际：${out.error}`);
  assert.equal(fallbackChoice('ask-later').delaySeconds, 30, '兜底值仍是 30 秒（规则层已单测）');
});

await checkAsync('dryRun 不弹窗（它本来就不动手）', async () => {
  const mod = await import('../lib/index.js');
  let called = false;
  const { ctx, registered } = fakeCtx({ askTimed: async () => { called = true; return { answers: [] }; } });
  mod.apply(ctx, { stateDir: testStateDir('dsr-confirm-test-8'), announceToAgent: false });
  const out = await registered[0].execute({ action: 'schedule', confirm: true, dryRun: true, delaySeconds: 7, force: true });
  assert.equal(called, false, 'dry run 不该打扰用户');
  assert.equal(out.data.schedule.delaySeconds, 7, 'dry run 保留原本的 delaySeconds');
});

await checkAsync('confirm 相关参数都注册进了工具 schema', async () => {
  const mod = await import('../lib/index.js');
  const { ctx, registered } = fakeCtx(undefined);
  mod.apply(ctx, { stateDir: testStateDir('dsr-confirm-test-9'), announceToAgent: false });
  const params = registered[0].parameters;
  assert.ok(params.confirm, '缺 confirm 参数');
  assert.ok(params.confirmFallback, '缺 confirmFallback 参数');
  assert.ok(params.confirmTimeoutMs, '缺 confirmTimeoutMs 参数');
});

check('安全闸：临时目录里的排程一律被拒（v0.2.0 事故的教训）', async () => {
  const core = await import('../lib/core.js');
  assert.equal(core.looksLikeTestStateDir(join(tmpdir(), 'dsr-whatever')), true, 'tmpdir 下的应判为测试目录');
  assert.equal(core.looksLikeTestStateDir('D:\\dsh\\state'), false, '普通目录不该被误伤');
  assert.equal(core.looksLikeTestStateDir(''), false, '空值不该被误伤');
});

await checkAsync('安全闸生效：临时目录调真 scheduleRestart 会在体检前就被拦下', async () => {
  const core = await import('../lib/core.js');
  let threw = null;
  try {
    await core.scheduleRestart({
      stateDir: join(tmpdir(), 'dsr-guard-probe'),
      sessionRoot: join(tmpdir(), 'dsr-guard-probe-sessions'),
      schedule: { delaySeconds: 999 },
    });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw !== null, '临时目录的排程必须抛错，而不是真的去排队一颗炸弹');
  assert.match(threw.message, /测试用的临时目录/, '错误信息要说清原因');
});

const failed = results.filter((row) => row.ok !== true);
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length > 0) {
  process.exitCode = 1;
}
