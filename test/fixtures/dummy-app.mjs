/**
 * 测试替身：假装自己是「宿主壳」（DSH 桌面端那个 Electron 主进程）。
 *
 * 结构刻意和被测的真实现场一致：
 *
 *   dummy-app（本文件，gen 0）        ← 会被杀掉的「壳」
 *     └─ dummy-host                   ← 会被杀掉的「host」（helper 的父进程）
 *          └─ helper（分离进程）        ← 必须活下来，并完成重启
 *
 * 它自己把 targetPid 填成自己的 pid —— 真插件也是这么干的（拿父链的顶端）。
 * gen 1 的实例不再拉起 host，避免测试里无限重启。
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const genIndex = args.indexOf('--gen');
const gen = genIndex >= 0 ? Number(args[genIndex + 1]) : 0;
const stateDir = process.env.DSR_STATE ?? '';

if (gen === 0) {
  // 把「目标就是我自己」写进载荷，再交给 host
  const template = process.env.DSR_PAYLOAD_TEMPLATE ?? '';
  const payload = JSON.parse(Buffer.from(template, 'base64').toString('utf8'));
  payload.targetPid = process.pid;
  const payload64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

  const host = spawn(process.execPath, [join(here, 'dummy-host.mjs')], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, DSR_PAYLOAD: payload64 },
  });

  if (stateDir !== '') {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'chain.json'), `${JSON.stringify({
      app: process.pid,
      shell: process.pid,
      host: host.pid,
      helper: null,
      generation: gen,
      startedAt: new Date().toISOString(),
    })}\n`, 'utf8');
  }
}

// 活着，等被杀
setInterval(() => {}, 1000);
