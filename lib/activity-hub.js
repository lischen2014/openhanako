/**
 * ActivityHub — 统一 Agent Activity 实时真相源（内存广播层）
 *
 * subagent / workflow / 巡检 等后台活动产生时往这里 upsert（带 sessionPath + agentId + kind），
 * 前端按当前对话 sessionPath 订阅展示。这是「实时可观测视图」，不取代各源自己的持久化
 * （SubagentRunStore audit / desk ActivityStore），只统一把活动广播给 UI。
 *
 * 内存层：session 结束由 clearBySession 回收；进程重启即清空（历史由各源持久化保留）。
 */

const VALID_KINDS = new Set(["subagent", "workflow", "heartbeat", "cron"]);
const VALID_STATUSES = new Set(["running", "done", "failed", "aborted"]);

function pickStr(v, fallback) {
  return typeof v === "string" && v ? v : fallback;
}
function pickNum(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normalizeEntry(entry, existing) {
  return {
    id: entry.id,
    kind: VALID_KINDS.has(entry.kind) ? entry.kind : (existing?.kind || "subagent"),
    status: VALID_STATUSES.has(entry.status) ? entry.status : (existing?.status || "running"),
    sessionPath: pickStr(entry.sessionPath, existing?.sessionPath ?? null),
    agentId: pickStr(entry.agentId, existing?.agentId ?? null),
    agentName: pickStr(entry.agentName, existing?.agentName ?? null),
    summary: pickStr(entry.summary, existing?.summary ?? null),
    childSessionPath: pickStr(entry.childSessionPath, existing?.childSessionPath ?? null),
    // startedAt 取首次（existing 优先），finishedAt 取最新
    startedAt: pickNum(existing?.startedAt, pickNum(entry.startedAt, null)),
    finishedAt: pickNum(entry.finishedAt, existing?.finishedAt ?? null),
  };
}

export class ActivityHub {
  /** @param {{ emit?: (event: object, sessionPath?: string|null) => void }} [bus] */
  constructor(bus = null) {
    this._bus = bus;
    /** @type {Map<string, object>} */
    this._entries = new Map();
    this._cbs = [];
  }

  upsert(entry) {
    if (!entry || typeof entry.id !== "string" || !entry.id) return null;
    const existing = this._entries.get(entry.id) || null;
    const next = normalizeEntry(entry, existing);
    this._entries.set(next.id, next);
    this._emit(next);
    return { ...next };
  }

  get(id) {
    const e = this._entries.get(id);
    return e ? { ...e } : null;
  }

  list() {
    return [...this._entries.values()].map((e) => ({ ...e }));
  }

  /** 当前对话过滤：只返回归属该 sessionPath 的活动 */
  listBySession(sessionPath) {
    if (!sessionPath) return [];
    const out = [];
    for (const e of this._entries.values()) {
      if (e.sessionPath === sessionPath) out.push({ ...e });
    }
    return out;
  }

  /** session 关闭时回收其活动（内存层） */
  clearBySession(sessionPath) {
    if (!sessionPath) return;
    for (const [id, e] of this._entries) {
      if (e.sessionPath === sessionPath) this._entries.delete(id);
    }
  }

  remove(id) {
    return this._entries.delete(id);
  }

  onChange(cb) {
    if (typeof cb !== "function") return () => {};
    this._cbs.push(cb);
    return () => {
      const i = this._cbs.indexOf(cb);
      if (i !== -1) this._cbs.splice(i, 1);
    };
  }

  _emit(entry) {
    const snapshot = { ...entry };
    for (const cb of this._cbs) {
      try { cb(snapshot); } catch { /* best effort */ }
    }
    this._bus?.emit?.({ type: "agent_activity", entry: snapshot }, entry.sessionPath ?? null);
  }
}
