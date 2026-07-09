/**
 * Renders internal reminder blocks for changes hidden by a session's frozen
 * prompt/tool snapshot. The block remains in model JSONL and is hidden only by
 * desktop/src/react/utils/message-parser.ts.
 *
 * The renderer is pure with respect to session state. It returns an immutable
 * receipt, and callers apply that receipt only after the prompt/steer operation
 * has accepted the rendered message.
 */

import type {
  EnvChangeEntry,
  EnvChangeLedger,
  MemoryFactsPayload,
  ToolsetChangedPayload,
} from "./env-change-ledger.ts";

export const REMINDER_BLOCK_PREFIX = "[hana_reminder";
export const REMINDER_BLOCK_END = "[/hana_reminder]";
export const TIME_STALENESS_MS = 3 * 60 * 60 * 1000;

const BLOCK_BODY_CHAR_LIMIT = 300;

export interface ReminderSessionEntry {
  reminderEnvCursor: number;
  reminderEnvStartSeq: number;
  lastTimeObservedAt: number | null;
  reminderCompactionRevision: number;
  reminderConsumedCompactionRevision: number;
}

export interface SessionReminderReceipt {
  readonly observedAt: number;
  readonly throughSeq: number;
  readonly compactionRevision: number;
}

export interface RenderedSessionReminderBlock {
  readonly block: string;
  readonly receipt: SessionReminderReceipt;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** Same plugin may transition repeatedly; only its final rendered state matters. */
function dedupeToolsetEntries(entries: EnvChangeEntry[]): EnvChangeEntry[] {
  const latestByPlugin = new Map<string, EnvChangeEntry>();
  const order: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "toolset_changed") continue;
    const pluginId = (entry.payload as Readonly<ToolsetChangedPayload>).pluginId;
    if (!latestByPlugin.has(pluginId)) order.push(pluginId);
    latestByPlugin.set(pluginId, entry);
  }
  return order.map((pluginId) => latestByPlugin.get(pluginId)!);
}

function memoryFactsEntries(entries: EnvChangeEntry[]): EnvChangeEntry[] {
  return entries.filter((entry) => entry.type === "memory_facts");
}

function formatToolsetLine(payload: Readonly<ToolsetChangedPayload>, isZh: boolean): string {
  const actionZh = payload.action === "loaded" ? "已加载" : payload.action === "unloaded" ? "已卸载" : "已重新加载";
  const actionEn = payload.action === "loaded" ? "loaded" : payload.action === "unloaded" ? "unloaded" : "reloaded";
  return isZh
    ? `插件「${payload.pluginId}」${actionZh}（工具清单变更在新会话中生效）`
    : `Plugin "${payload.pluginId}" ${actionEn} (toolset change takes effect in new sessions)`;
}

function formatMemoryFactsLine(payload: Readonly<MemoryFactsPayload>, isZh: boolean): string {
  const lines = payload.addedLines.join(isZh ? "；" : "; ");
  return isZh ? `记忆新增事实：${lines}` : `New memory facts recorded: ${lines}`;
}

function formatCompactionLine(isZh: boolean): string {
  return isZh
    ? "上下文已压缩，早期对话已被总结"
    : "Context has been compacted; earlier turns were summarized";
}

function formatTimeLine(now: number, timeZone: string | undefined, isZh: boolean): string {
  const stamp = formatTimestamp(now, timeZone);
  return isZh ? `当前时间：${stamp}` : `Current time: ${stamp}`;
}

function formatTimestamp(now: number, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const values: Record<string, string> = {};
  for (const part of parts) values[part.type] = part.value;
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

export function collectReminderBlock({
  sessionEntry,
  ledger,
  now,
  isZh,
  timeZone,
}: {
  sessionEntry: ReminderSessionEntry;
  ledger: EnvChangeLedger;
  now: number;
  isZh: boolean;
  timeZone?: string;
}): RenderedSessionReminderBlock | null {
  const throughSeq = ledger.maxSeq();
  const compactionRevision = nonNegativeInteger(sessionEntry.reminderCompactionRevision);
  const consumedCompactionRevision = nonNegativeInteger(sessionEntry.reminderConsumedCompactionRevision);
  const hasPendingCompaction = compactionRevision > consumedCompactionRevision;
  const envCursor = hasPendingCompaction
    ? nonNegativeInteger(sessionEntry.reminderEnvStartSeq)
    : nonNegativeInteger(sessionEntry.reminderEnvCursor);
  const entries = ledger.entriesAfter(envCursor, throughSeq);
  const lines: string[] = [];

  if (hasPendingCompaction) lines.push(`- ${formatCompactionLine(isZh)}`);
  for (const entry of dedupeToolsetEntries(entries)) {
    lines.push(`- ${formatToolsetLine(entry.payload as Readonly<ToolsetChangedPayload>, isZh)}`);
  }
  for (const entry of memoryFactsEntries(entries)) {
    lines.push(`- ${formatMemoryFactsLine(entry.payload as Readonly<MemoryFactsPayload>, isZh)}`);
  }

  const lastTimeObservedAt = sessionEntry.lastTimeObservedAt;
  const isTimeStale = lastTimeObservedAt == null || (now - lastTimeObservedAt) > TIME_STALENESS_MS;
  if (isTimeStale) lines.push(`- ${formatTimeLine(now, timeZone, isZh)}`);
  if (lines.length === 0) return null;

  let body = lines.join("\n");
  if (body.length > BLOCK_BODY_CHAR_LIMIT) {
    body = `${body.slice(0, BLOCK_BODY_CHAR_LIMIT - 1)}…`;
  }

  const receipt = Object.freeze({
    observedAt: now,
    throughSeq,
    compactionRevision,
  });
  return Object.freeze({
    block: `${REMINDER_BLOCK_PREFIX} at ${formatTimestamp(now, timeZone)}]\n${body}\n${REMINDER_BLOCK_END}`,
    receipt,
  });
}

/** Applies only the state range represented by a previously rendered receipt. */
export function applyReminderConsumption({
  sessionEntry,
  receipt,
}: {
  sessionEntry: ReminderSessionEntry;
  receipt: SessionReminderReceipt;
}): void {
  if (
    !receipt
    || !Number.isFinite(receipt.observedAt)
    || !Number.isFinite(receipt.throughSeq)
    || !Number.isFinite(receipt.compactionRevision)
  ) {
    throw new TypeError("applyReminderConsumption requires a valid reminder receipt");
  }

  sessionEntry.reminderEnvCursor = Math.max(
    nonNegativeInteger(sessionEntry.reminderEnvCursor),
    nonNegativeInteger(receipt.throughSeq),
  );
  const currentRevision = nonNegativeInteger(sessionEntry.reminderCompactionRevision);
  sessionEntry.reminderConsumedCompactionRevision = Math.max(
    nonNegativeInteger(sessionEntry.reminderConsumedCompactionRevision),
    Math.min(nonNegativeInteger(receipt.compactionRevision), currentRevision),
  );
  noteTimeObservedForSession(sessionEntry, receipt.observedAt);
}

/** Pure session-state helper used by reminder consumption and current_status(time). */
export function noteTimeObservedForSession(sessionEntry: ReminderSessionEntry, observedAt: number): void {
  if (!Number.isFinite(observedAt)) {
    throw new TypeError("noteTimeObservedForSession requires a finite observedAt");
  }
  const current = sessionEntry.lastTimeObservedAt;
  sessionEntry.lastTimeObservedAt = current == null ? observedAt : Math.max(current, observedAt);
}
