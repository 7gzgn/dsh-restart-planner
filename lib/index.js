/**
 * dsh-self-restart — 宿主入口
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
 * @module dsh-self-restart
 */

import { join } from 'node:path';
import {
  ACTIONS,
  DEFAULTS,
  agoText,
  readLastReport,
  readPending,
  renderReport,
  resolveSessionRoot,
  resolveStateDir,
} from './plan.js';
import { collectStatus, scheduleRestart, cancelPending } from './core.js';

/** 插件身份。 */
export const name = 'dsh-self-restart';

/** 需要宿主提供的服务（拿不到就退化，不报错）。 */
export const inject = ['tools', 'systemPrompt'];

const SECTION_ORDER = 204;

/** 刚重启完的「新鲜期」：这段时间内会主动向 agent 提一句。 */
const FRESH_WINDOW_MS = 10 * 60 * 1000;

/** 面向模型的公告（常驻那一段）。 */
export const RESTART_GUIDANCE = [
  '本机已安装 **dsh-self-restart**：提供 `self_restart` 工具，让 agent **自己**安排宿主重启 —— 装/改插件、改了 `.js`、需要重载宿主时用它，不必再让用户手动关开。',
  "`action='schedule'`：排程一次重启。**立刻返回**，真正的停+拉发生在你这一轮回复送达、且会话日志落盘安静之后（默认 T+20s 起、静默 4s、最长等 180s）。可选 `reason`（写进报告）、`delaySeconds`、`dryRun`（只演算不动手）、`relaunchCommand`（特殊启动器才需要）。",
  "`action='status'`：体检 + 最近的报告 —— 当前进程的 pid/运行时长、如果现在重启会结束谁、用什么命令拉回来、上一次重启的结果。",
  "`action='cancel'`：撤掉还没执行的那次排程。",
  '用法要点：**先 schedule，然后把这一轮正常说完**（用户看到你的回复之后才会重启）；重启回来后的第一条消息里用 `status` 确认结果再汇报。它平时不常驻、不占资源、不轮询任何东西。',
].join('\n');

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
  const port = ctx?.webServer?.port;
  if (Number.isFinite(port) && port > 0) return `http://127.0.0.1:${port}`;
  if (typeof process.env.DSH_WEB_URL === 'string' && process.env.DSH_WEB_URL !== '') return process.env.DSH_WEB_URL;
  return undefined;
}

/** 把一次 schedule 的结果压成给模型看的一段话。 */
function renderSchedule(data) {
  const plan = data.plan ?? {};
  const lines = [];
  lines.push(`self_restart schedule：已排程（id ${data.id}${data.dryRun ? '，dry run' : ''}）`);
  lines.push(`  · 动手时机：T+${data.schedule?.delaySeconds}s 起，且会话目录静默 ${data.schedule?.quietSeconds}s（最长等 ${data.schedule?.maxWaitSeconds}s）`);
  lines.push(`  · 目标：${plan.targetName ?? '?'} pid ${plan.targetPid ?? '?'}（含相关进程共 ${Array.isArray(plan.killList) ? plan.killList.length + 1 : '?'} 个）`);
  lines.push(`  · 拉起命令：${plan.relaunchCommand ?? '?'}`);
  if (typeof data.handoff === 'string') {
    const mode = data.handoff === 'explorer'
      ? 'explorer（由资源管理器接管，能活过宿主的 job 回收）'
      : data.handoff === 'direct' ? 'direct（普通子进程 — 留意警告）' : data.handoff;
    lines.push(`  · 交接方式：${mode}`);
  }
  lines.push(`  · 报告：${join(data.stateDir ?? '', 'last.json')}`);
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
    const helper = p.helperAlive === true ? 'helper 在跑' : 'helper 已退出';
    lines.push(`  · 待执行排程：${p.id}${p.canceled ? '（已取消）' : ''}｜${helper}${p.reason ? `｜原因：${p.reason}` : ''}`);
  }
  lines.push(`  · 上次报告：`);
  lines.push(renderReport(data.last).split('\n').map((line) => `      ${line}`).join('\n'));
  if (data.last?.updatedAt) lines.push(`      （${agoText(data.last.updatedAt)}）`);
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
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 * @param {object} [config] 插件配置
 */
export function apply(ctx, config) {
  const cfg = config ?? {};
  if (cfg.enabled === false) return;
  const { stateDir, sessionRoot } = paths(cfg);
  const disposers = [];

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
          description: "One of: schedule, status, cancel. 'status' 与 'cancel' 不需要其它参数。",
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
          return [{ type: 'text', text: `self_restart ${action}：${JSON.stringify(value.data ?? {}).slice(0, 400)}` }];
        },
      },
      async execute(args) {
        const a = args ?? {};
        const action = String(a.action ?? 'status').trim().toLowerCase();
        if (!ACTIONS.includes(action)) {
          return { ok: false, action, error: `unknown action: ${action}（可用：${ACTIONS.join(', ')}）` };
        }

        const common = {
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

        try {
          if (action === 'schedule') {
            const dryRun = a.dryRun === true || cfg.dryRun === true;
            const result = await scheduleRestart({
              ...common,
              schedule: {
                delaySeconds: a.delaySeconds,
                quietSeconds: a.quietSeconds,
                maxWaitSeconds: a.maxWaitSeconds,
                reason: typeof a.reason === 'string' ? a.reason : '',
              },
              dryRun,
              relaunchCommand: typeof a.relaunchCommand === 'string' ? a.relaunchCommand : undefined,
            });
            return { ok: true, action, data: { ...result, stateDir } };
          }

          if (action === 'cancel') {
            const result = await cancelPending({ stateDir });
            if (result.ok !== true) return { ok: false, action, error: String(result.error ?? '取消失败') };
            return { ok: true, action, data: result };
          }

          const data = await collectStatus(common);
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
    }, 'dsh-self-restart: teardown');
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
      banner.push(`⚠ **本进程刚刚由 dsh-self-restart 重启过**（${agoText(last.updatedAt)}，原因：${last.reason || '未说明'}）。用户可能正是在等这个 —— 用 \`self_restart\` 的 \`status\` 确认结果（停机 ${typeof last.downtimeMs === 'number' ? `${(last.downtimeMs / 1000).toFixed(1)} 秒` : '未知'}），然后简短汇报。`);
    }
  }
  if (pending !== null && pending.canceled !== true) {
    banner.push(`⚠ 有一次重启排程还没执行（id ${String(pending.id)}，原因：${pending.reason || '未说明'}）：它会在这轮结束后动手；要撤就用 \`self_restart\` 的 \`cancel\`。`);
  }
  return [...banner, RESTART_GUIDANCE].join('\n');
}
