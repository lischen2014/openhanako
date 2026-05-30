// lib/tools/workflow-tool.js
import os from "node:os";
import { Type } from "../pi-sdk/index.js";
import { runWorkflowScript } from "../workflow/sandbox.js";
import { extractMeta } from "../workflow/meta.js";
import { createHostApi } from "../workflow/host-api.js";
import { createLimiter } from "../workflow/concurrency.js";
import { getToolSessionPath, getToolSessionCwd } from "./tool-session.js";
import { toolOk, toolError } from "./tool-result.js";

const WORKFLOW_DEADLINE_MS = 5 * 60 * 1000;
// 后台兜底超时：略大于内部 deadline，防 runWorkflowScript 在 deadline 之外卡死。
const WORKFLOW_TIMEOUT_BACKSTOP_MS = WORKFLOW_DEADLINE_MS + 30 * 1000;
const AGENT_TOTAL_BACKSTOP = 1000;

const WORKFLOW_DESCRIPTION = [
  "用一段确定性 JS 脚本编排多个子 agent（agent/parallel/pipeline）。",
  "适合：受控 fan-out、要保证不漏不偷懒、要把多个子 agent 的结果合成的任务。",
  "脚本必须以 `export const meta = { name, description }` 开头（纯字面量）。",
  "可用全局：agent(prompt, {model?, schema?, agentType?}) 同步返回结果（带 schema 返回校验对象）；",
  "parallel(thunks) 并发等齐（thunk 抛错落 null）；pipeline(items, ...stages) 每项独立穿过各 stage；log/phase/budget/args。",
  "脚本拿不到 require/process/fs/net；禁用 Math.random/Date.now。",
  "工具立即返回任务 id 后在后台执行（不阻塞当前轮），脚本 return 值即该后台任务的最终结果，完成后自动回到对话。",
].join("\n");

const PARAMETERS = Type.Object({
  script: Type.String({ description: "编排脚本，以 export const meta = {...} 开头" }),
  // 若本项目 typebox 封装无 Type.Any，用 Type.Unknown()。
  args: Type.Optional(Type.Any({ description: "传给脚本 args 全局的参数" })),
});

function makeLimiter() {
  const maxConcurrent = Math.max(1, Math.min(16, os.cpus().length - 2));
  return createLimiter({ maxConcurrent, maxTotal: AGENT_TOTAL_BACKSTOP });
}

/**
 * @param {{
 *   executeIsolated: (prompt: string, isoOpts: object) => Promise<object>,
 *   getSessionPath?: () => string|null,
 *   getParentCwd?: () => string|null,
 *   getAgentId?: () => string|undefined,
 *   emitEvent?: (event: object, sessionPath: string|null) => void,
 *   resolveAgentId?: (agentType?: string) => string|undefined,
 *   getDeferredStore?: () => import("../deferred-result-store.js").DeferredResultStore|null,
 *   getSubagentRunStore?: () => import("../subagent-run-store.js").SubagentRunStore|null,
 * }} deps
 */
export function createWorkflowTool(deps) {
  return {
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_DESCRIPTION,
    parameters: PARAMETERS,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const parentSessionPath = getToolSessionPath(ctx) || deps.getSessionPath?.() || null;
      const cwd = getToolSessionCwd(ctx) || deps.getParentCwd?.() || null;
      const agentId = deps.getAgentId?.() || undefined;

      // 先静态校验脚本头：非法脚本同步报错，不派后台任务
      // （禁止非用户预期 fallback：不把非法输入伪装成"已派出"）。
      let meta;
      try {
        ({ meta } = extractMeta(params.script));
      } catch (err) {
        return toolError(`workflow 脚本非法: ${err.message}`);
      }

      const store = deps.getDeferredStore?.();
      const runStore = deps.getSubagentRunStore?.();

      // deferred 基础设施不可用（或无 parent session）→ 同步兜底执行，调用方直接拿结果。
      // 与 subagent 一致：这是基础设施缺失时的等价行为，不是静默降级。
      if (!store || !parentSessionPath) {
        return _syncRun(deps, params, meta, { agentId, cwd, parentSessionPath });
      }

      const taskId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const summary = meta.name;
      const hub = deps.getActivityHub?.();
      const startedAt = Date.now();

      store.defer(taskId, parentSessionPath, { type: "workflow", summary });
      runStore?.register?.(taskId, { parentSessionPath, summary });
      hub?.upsert({ id: taskId, kind: "workflow", status: "running", sessionPath: parentSessionPath, agentId, summary, startedAt });

      // 后台任务独立生命周期：execute 的 signal 在返回后即失效，用自己的 AbortController；
      // 再加一道超时兜底（正常由 runWorkflowScript 内部 deadline 先触发）。
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), WORKFLOW_TIMEOUT_BACKSTOP_MS);
      if (timeoutTimer.unref) timeoutTimer.unref();

      const limiter = makeLimiter();
      const hostApi = createHostApi({
        executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
        baseIsoOpts: { agentId, cwd, parentSessionPath, subagentContext: true, subagentTaskId: taskId, emitEvents: true },
        limiter,
        signal: controller.signal,
        onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress", taskId }, parentSessionPath),
        budget: { total: null, spent: () => 0, remaining: () => Infinity }, // 二期接真 usage 计量
        args: params.args,
        resolveAgentId: deps.resolveAgentId,
      });

      // fire-and-forget：不 await。后台跑完 resolve/fail 写入 deferred store，
      // DeferredResultCoordinator 监听后以 <hana-background-result type="workflow"> steer 回灌主对话。
      runWorkflowScript(params.script, hostApi, { signal: controller.signal, deadlineMs: WORKFLOW_DEADLINE_MS })
        .then(({ result }) => {
          const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          store.resolve(taskId, text);
          runStore?.resolve?.(taskId, text);
          hub?.upsert({ id: taskId, status: "done", finishedAt: Date.now() });
        })
        .catch((err) => {
          const reason = err?.message || String(err);
          store.fail(taskId, reason);
          runStore?.fail?.(taskId, reason);
          hub?.upsert({ id: taskId, status: "failed", finishedAt: Date.now() });
        })
        .finally(() => clearTimeout(timeoutTimer));

      return toolOk(
        `workflow "${summary}" 已派出后台执行（任务 ${taskId}），完成后结果会自动回到对话。`,
        { taskId, workflow: summary, streamStatus: "running" },
      );
    },
  };
}

/** deferred 基础设施不可用时同步执行，保留原同步语义（调用方直接拿合成结果）。 */
async function _syncRun(deps, params, meta, { agentId, cwd, parentSessionPath }) {
  const limiter = makeLimiter();
  const hostApi = createHostApi({
    executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
    baseIsoOpts: { agentId, cwd, parentSessionPath, subagentContext: true, emitEvents: true },
    limiter,
    signal: undefined,
    onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress" }, parentSessionPath),
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    args: params.args,
    resolveAgentId: deps.resolveAgentId,
  });
  try {
    const { result } = await runWorkflowScript(params.script, hostApi, { deadlineMs: WORKFLOW_DEADLINE_MS });
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return toolOk(
      `workflow "${meta.name}" 完成，派出 ${limiter.totalSpawned} 个 agent。\n\n结果:\n${text}`,
      { workflow: meta.name, agentsSpawned: limiter.totalSpawned, result },
    );
  } catch (err) {
    return toolError(`workflow 执行失败: ${err.message}`, { agentsSpawned: limiter.totalSpawned });
  }
}
