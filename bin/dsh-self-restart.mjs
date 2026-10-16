#!/usr/bin/env node
/**
 * dsh-self-restart — 命令行入口
 *
 * 两个用途：
 *   1. 没有工具 API 的场合（纯 `dsh web`、CI、别的 agent）也能用同一套能力；
 *   2. 开发和排查时的直通口 —— 工具层跟它调的是同一份 core。
 *
 * 用法：
 *   dsh-self-restart status  [--json]
 *   dsh-self-restart resolve [--json]
 *   dsh-self-restart schedule [--delay 20] [--quiet 4] [--max-wait 180] [--reason "..."] [--dry-run]
 *                             [--relaunch-command "C:\\path\\app.exe --flag"] [--target-pid 1234] [--caller-pid 9500]
 *   dsh-self-restart cancel
 *
 * 从 DSH 自己的终端里跑时，它会顺着父进程找到 DSH 宿主；从无关终端里跑、
 * 或者宿主形态特殊时，用 --caller-pid 指一下宿主 pid（工具调用那条路不需要）。
 *
 * @module dsh-self-restart/cli
 */

import {
  DEFAULTS,
  agoText,
  renderReport,
  resolveSessionRoot,
  resolveStateDir,
} from '../lib/plan.js';
import { cancelPending, collectStatus, resolvePlan, scheduleRestart } from '../lib/core.js';

/** 极简参数解析：--key value / --flag。 */
function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else out._.push(token);
  }
  return out;
}

/** 取数字参数。 */
function num(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 打印一段文本（--json 时打印 JSON）。 */
function output(value, json, text) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${text}\n`);
}

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  const command = argv._[0] ?? 'status';
  const json = argv.json === true;
  const stateDir = typeof argv['state-dir'] === 'string' ? argv['state-dir'] : resolveStateDir();
  const sessionRoot = typeof argv['session-root'] === 'string' ? argv['session-root'] : resolveSessionRoot();
  const callerPid = argv['caller-pid'] === undefined ? undefined : num(argv['caller-pid'], 0);
  const common = { stateDir, sessionRoot, callerPid };

  if (command === 'status' || command === 'resolve') {
    if (command === 'resolve') {
      const plan = await resolvePlan(common);
      output(plan, json, [
        `目标：${plan.targetName} pid ${plan.targetPid}（解析方式 ${plan.resolution}）`,
        `拉起命令：${plan.relaunchCommand}`,
        `工作目录：${plan.workingDirectory}`,
        `会一并结束的相关进程：${Array.isArray(plan.killList) ? plan.killList.length : 0} 个`,
      ].join('\n'));
      return;
    }
    const status = await collectStatus(common);
    output(status, json, [
      `宿主 pid ${status.self.pid}（${status.self.platform}，已运行 ${Math.round(status.self.uptimeSeconds / 60)} 分钟）`,
      status.plan
        ? `可以自己重启：是 —— 结束 ${status.plan.targetName} pid ${status.plan.targetPid}，命令 ${status.plan.relaunchCommand}`
        : `可以自己重启：不确定（${status.planError}）`,
      status.pending
        ? `待执行排程：${status.pending.id}${status.pending.canceled ? '（已取消）' : ''}｜helper ${status.pending.helperAlive ? '在跑' : '已退出'}`
        : '待执行排程：无',
      '上次报告：',
      renderReport(status.last).split('\n').map((line) => `  ${line}`).join('\n'),
      status.last?.updatedAt ? `  （${agoText(status.last.updatedAt)}）` : '',
      `状态目录：${stateDir}`,
    ].filter(Boolean).join('\n'));
    return;
  }

  if (command === 'schedule') {
    const result = await scheduleRestart({
      ...common,
      schedule: {
        delaySeconds: num(argv.delay, DEFAULTS.delaySeconds),
        quietSeconds: num(argv.quiet, DEFAULTS.quietSeconds),
        maxWaitSeconds: num(argv['max-wait'], DEFAULTS.maxWaitSeconds),
        reason: typeof argv.reason === 'string' ? argv.reason : '',
      },
      dryRun: argv['dry-run'] === true,
      targetPid: argv['target-pid'] === undefined ? undefined : num(argv['target-pid'], 0),
      relaunchCommand: typeof argv['relaunch-command'] === 'string' ? argv['relaunch-command'] : undefined,
    });
    output(result, json, [
      `已排程：${result.id}${result.dryRun ? '（dry run）' : ''}`,
      `目标：${result.plan.targetName} pid ${result.plan.targetPid}`,
      `拉起命令：${result.plan.relaunchCommand}`,
      `动手时机：T+${result.schedule.delaySeconds}s 起，会话静默 ${result.schedule.quietSeconds}s 后`,
      `报告：${stateDir}\\last.json`,
    ].join('\n'));
    return;
  }

  if (command === 'cancel') {
    const result = await cancelPending({ stateDir });
    output(result, json, result.ok
      ? `已撤掉排程 ${result.id}${result.helperExited === false ? '（helper 还在退出中，但不会再动手）' : ''}`
      : `取消失败：${result.error}`);
    if (result.ok !== true) process.exitCode = 1;
    return;
  }

  process.stdout.write(`未知命令：${command}\n用法：dsh-self-restart [status|resolve|schedule|cancel]\n`);
  process.exitCode = 1;
}

await main();
