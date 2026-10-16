/**
 * 测试替身：假装自己是「host」—— 插件就住在这种进程里。
 *
 * 它做一件和真实插件一模一样的事：把 helper **分离**放出去，然后继续活着。
 * helper 需要在它的祖先链被全部杀掉之后仍然活着，这个文件就是那根链条。
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const stateDir = process.env.DSR_STATE ?? '';
const payload = process.env.DSR_PAYLOAD ?? '';
const helper = process.env.DSR_HELPER ?? '';
const shell = process.env.DSR_SHELL ?? 'powershell.exe';

if (helper !== '' && payload !== '') {
  // 和真插件一样：自己不做重启，只把 helper 交给 Explorer 接管（arm）
  const child = spawn(shell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', helper, '-Action', 'arm', '-Payload64', payload,
  ], {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  if (stateDir !== '') {
    try {
      const chain = JSON.parse(readFileSync(join(stateDir, 'chain.json'), 'utf8'));
      chain.helper = child.pid;
      chain.host = process.pid;
      chain.helperSpawnedAt = new Date().toISOString();
      writeFileSync(join(stateDir, 'chain.json'), `${JSON.stringify(chain, null, 2)}\n`, 'utf8');
    } catch {
      /* 壳还没写完就先不管 */
    }
  }
}

setInterval(() => {}, 1000);
