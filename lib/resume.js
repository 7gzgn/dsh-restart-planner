/**
 * dsh-restart-planner · resume —— 「重启后自动继续」的标记与投递。
 *
 * 机制（借鉴 anweat/dsh-restart 的思路，但 API 换成 0.2.x 现成的）：
 *   1. 排程重启时把一个标记写进状态目录：哪个会话、恢复时给它什么提示词；
 *   2. 重启后插件加载时读标记，用 `ctx.sessionController.prompt` 往那个会话投一条 prompt
 *      （它会先按需恢复会话，所以冷会话也能接上）；
 *   3. **投递成功才删掉那一条**，失败就留着 —— 下次启动还能再试，不会被一次抖动吞掉。
 *
 * 为什么不用 `agent.followup`：那是 dsh-restart 在 0.1.x 上的入口，0.2.x 的 Agent 只剩
 * `{ id }`，没有 followup。现成且语义正确的入口是 sessionController.prompt
 * （`{ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }`）。
 *
 * @module dsh-restart-planner/resume
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** 标记文件名。 */
export const RESUME_FILE = 'resume.json';

/** 默认的「继续」提示词（可被工具参数 / 插件配置覆盖）。 */
export const DEFAULT_CONTINUE_PROMPT = '（自动继续）宿主刚刚重启完成，请接着刚才没做完的事继续；先看一下 self_restart 的 status 报告，再决定下一步。';

/**
 * 标记文件路径。
 * @param {string} stateDir 状态目录
 * @returns {string} 绝对路径
 */
export function resumePath(stateDir) {
  return join(stateDir, RESUME_FILE);
}

/**
 * 读标记（不存在/坏掉都当没有，绝不因为一个坏文件把插件加载炸掉）。
 * @param {string} stateDir 状态目录
 * @returns {{sessions: Array<{sessionId:string, prompt:string, createdAt:string}>}|null} 标记
 */
export function readResume(stateDir) {
  const file = resumePath(stateDir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const sessions = Array.isArray(raw?.sessions) ? raw.sessions : [];
    const clean = sessions
      .filter((entry) => entry && typeof entry.sessionId === 'string' && entry.sessionId !== '')
      .map((entry) => ({
        sessionId: entry.sessionId,
        prompt: typeof entry.prompt === 'string' && entry.prompt !== '' ? entry.prompt : DEFAULT_CONTINUE_PROMPT,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
      }));
    return clean.length > 0 ? { sessions: clean } : null;
  } catch {
    return null;
  }
}

/**
 * 写（或合并）一条恢复标记。
 * @param {string} stateDir 状态目录
 * @param {{sessionId:string, prompt?:string}} entry 要恢复的会话
 * @returns {{ok:boolean, sessions:number, file:string, error?:string}} 结果
 */
export function writeResume(stateDir, entry) {
  if (typeof entry?.sessionId !== 'string' || entry.sessionId === '') {
    return { ok: false, sessions: 0, file: resumePath(stateDir), error: 'sessionId 为空，没法写恢复标记' };
  }
  const file = resumePath(stateDir);
  const current = readResume(stateDir)?.sessions ?? [];
  const prompt = typeof entry.prompt === 'string' && entry.prompt !== '' ? entry.prompt : DEFAULT_CONTINUE_PROMPT;
  const next = current.filter((item) => item.sessionId !== entry.sessionId);
  next.push({ sessionId: entry.sessionId, prompt, createdAt: new Date().toISOString() });
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ sessions: next }, null, 2)}\n`, 'utf8');
    return { ok: true, sessions: next.length, file };
  } catch (err) {
    return { ok: false, sessions: current.length, file, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 删掉某一条（投递成功后调用）；空了就把文件删掉。
 * @param {string} stateDir 状态目录
 * @param {string} sessionId 会话
 * @returns {void}
 */
export function removeResume(stateDir, sessionId) {
  const current = readResume(stateDir)?.sessions ?? [];
  const next = current.filter((item) => item.sessionId !== sessionId);
  const file = resumePath(stateDir);
  if (next.length === 0) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* 删不掉也无所谓：下次读出来是空 */
    }
    return;
  }
  try {
    writeFileSync(file, `${JSON.stringify({ sessions: next }, null, 2)}\n`, 'utf8');
  } catch {
    /* 写不回去就留着旧文件，下次还会重试 */
  }
}

/**
 * 把标记里的会话逐个投递一次「继续」。
 *
 * 依赖注入（`promptFor`），所以能在沙箱里用假实现跑测试。
 *
 * @param {object} options 参数
 * @param {string} options.stateDir 状态目录
 * @param {(sessionId:string, prompt:string) => Promise<unknown>} options.promptFor 投递实现
 * @param {number} [options.retries] 每条最多试几次（默认 2）
 * @param {number} [options.retryDelayMs] 重试间隔（默认 2000）
 * @param {(line:string) => void} [options.log] 日志
 * @returns {Promise<{delivered:string[], kept:string[], errors:object[]}>} 结果
 */
export async function deliverResume(options) {
  const { stateDir, promptFor } = options;
  const retries = Number.isFinite(options.retries) ? options.retries : 2;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 2000;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const marker = readResume(stateDir);
  const delivered = [];
  const kept = [];
  const errors = [];
  if (marker === null) return { delivered, kept, errors };

  for (const entry of marker.sessions) {
    let ok = false;
    for (let attempt = 1; attempt <= retries && !ok; attempt += 1) {
      try {
        await promptFor(entry.sessionId, entry.prompt);
        ok = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ sessionId: entry.sessionId, attempt, error: message });
        log(`resume: 第 ${attempt} 次投递失败（${entry.sessionId}）：${message}`);
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    if (ok) {
      delivered.push(entry.sessionId);
      removeResume(stateDir, entry.sessionId);
      log(`resume: 已投递「继续」→ ${entry.sessionId}`);
    } else {
      kept.push(entry.sessionId);
    }
  }
  return { delivered, kept, errors };
}
