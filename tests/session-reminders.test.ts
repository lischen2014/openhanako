import { describe, expect, it } from "vitest";
import { EnvChangeLedger } from "../core/env-change-ledger.ts";
import {
  applyReminderConsumption,
  collectReminderBlock,
  noteTimeObservedForSession,
  REMINDER_BLOCK_END,
  REMINDER_BLOCK_PREFIX,
  TIME_STALENESS_MS,
} from "../core/session-reminders.ts";

function freshSessionEntry(overrides: Record<string, unknown> = {}) {
  return {
    reminderEnvCursor: 0,
    reminderEnvStartSeq: 0,
    lastTimeObservedAt: Date.now(),
    reminderCompactionRevision: 0,
    reminderConsumedCompactionRevision: 0,
    ...overrides,
  };
}

function render(entry: any, ledger: EnvChangeLedger, now = Date.now(), isZh = true) {
  return collectReminderBlock({ sessionEntry: entry, ledger, now, isZh, timeZone: "UTC" });
}

describe("EnvChangeLedger", () => {
  it("keeps immutable append order and bounded reads", () => {
    const ledger = new EnvChangeLedger();
    const first = ledger.append({ type: "toolset_changed", payload: { pluginId: "a", action: "loaded" } });
    const second = ledger.append({ type: "memory_facts", payload: { addedLines: ["fact"] } });

    expect([first.seq, second.seq, ledger.maxSeq()]).toEqual([1, 2, 2]);
    expect(ledger.entriesAfter(0, 1)).toEqual([first]);
    expect(ledger.entriesAfter(1)).toEqual([second]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.payload)).toBe(true);
    expect(Object.isFrozen((second.payload as any).addedLines)).toBe(true);
  });
});

describe("collectReminderBlock", () => {
  it("deduplicates plugin transitions by pluginId and renders the final state", () => {
    const ledger = new EnvChangeLedger();
    ledger.append({ type: "toolset_changed", payload: { pluginId: "demo", action: "unloaded" } });
    ledger.append({ type: "toolset_changed", payload: { pluginId: "other", action: "loaded" } });
    ledger.append({ type: "toolset_changed", payload: { pluginId: "demo", action: "reloaded" } });

    const result = render(freshSessionEntry(), ledger);
    expect(result?.block.match(/demo/g)).toHaveLength(1);
    expect(result?.block).toContain("已重新加载");
    expect(result?.block).toContain("other");
  });

  it("renders memory facts, English copy, and a 24-hour timezone timestamp", () => {
    const ledger = new EnvChangeLedger();
    ledger.append({ type: "memory_facts", payload: { addedLines: ["likes tea", "lives in Kyoto"] } });
    const now = new Date("2026-07-05T14:05:00Z").getTime();

    const result = render(freshSessionEntry({ lastTimeObservedAt: null }), ledger, now, false);
    expect(REMINDER_BLOCK_PREFIX).toBe("[hana_reminder");
    expect(REMINDER_BLOCK_END).toBe("[/hana_reminder]");
    expect(result?.block).toBe(
      "[hana_reminder at 2026-07-05 14:05]\n"
      + "- New memory facts recorded: likes tea; lives in Kyoto\n"
      + "- Current time: 2026-07-05 14:05\n"
      + "[/hana_reminder]",
    );
  });

  it("uses strict greater-than for the three-hour time threshold", () => {
    const ledger = new EnvChangeLedger();
    const now = Date.now();
    expect(render(freshSessionEntry({ lastTimeObservedAt: now - TIME_STALENESS_MS }), ledger, now)).toBeNull();
    expect(render(freshSessionEntry({ lastTimeObservedAt: now - TIME_STALENESS_MS - 1 }), ledger, now)?.block)
      .toContain("当前时间");
    expect(render(freshSessionEntry({ lastTimeObservedAt: null }), ledger, now)?.block).toContain("当前时间");
  });

  it("replays environment changes from the session baseline after compaction", () => {
    const ledger = new EnvChangeLedger();
    ledger.append({ type: "toolset_changed", payload: { pluginId: "before", action: "loaded" } });
    const entry = freshSessionEntry({
      reminderEnvCursor: 1,
      reminderEnvStartSeq: 0,
      reminderCompactionRevision: 1,
      lastTimeObservedAt: Date.now(),
    });

    const result = render(entry, ledger);
    expect(result?.block).toContain("上下文已压缩");
    expect(result?.block).toContain("before");
  });

  it("caps the rendered body and returns a frozen receipt", () => {
    const ledger = new EnvChangeLedger();
    for (let index = 0; index < 20; index += 1) {
      ledger.append({
        type: "toolset_changed",
        payload: { pluginId: `plugin-with-a-long-name-${index}`, action: "loaded" },
      });
    }
    const result = render(freshSessionEntry(), ledger, new Date("2026-07-05T14:05:00Z").getTime());
    const header = `${REMINDER_BLOCK_PREFIX} at 2026-07-05 14:05]\n`;
    const body = result!.block.slice(header.length, -(`\n${REMINDER_BLOCK_END}`.length));

    expect(body.endsWith("…")).toBe(true);
    expect(body.length).toBe(300);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result!.receipt)).toBe(true);
  });
});

describe("reminder receipt consumption", () => {
  it("does not consume a ledger event appended after render", () => {
    const ledger = new EnvChangeLedger();
    ledger.append({ type: "toolset_changed", payload: { pluginId: "rendered", action: "loaded" } });
    const now = Date.now();
    const entry = freshSessionEntry({ lastTimeObservedAt: now });
    const rendered = render(entry, ledger, now)!;

    ledger.append({ type: "toolset_changed", payload: { pluginId: "later", action: "loaded" } });
    applyReminderConsumption({ sessionEntry: entry, receipt: rendered.receipt });

    const next = render(entry, ledger, now + 1);
    expect(next?.block).not.toContain("rendered");
    expect(next?.block).toContain("later");
  });

  it("does not clear a compaction revision created after render", () => {
    const ledger = new EnvChangeLedger();
    const now = Date.now();
    const entry = freshSessionEntry({
      reminderCompactionRevision: 1,
      lastTimeObservedAt: now,
    });
    const rendered = render(entry, ledger, now)!;

    entry.reminderCompactionRevision = 2;
    applyReminderConsumption({ sessionEntry: entry, receipt: rendered.receipt });

    expect(entry.reminderConsumedCompactionRevision).toBe(1);
    expect(render(entry, ledger, now + 1)?.block).toContain("上下文已压缩");
  });

  it("does not move a current_status observation backwards when consuming an old receipt", () => {
    const ledger = new EnvChangeLedger();
    const renderedAt = Date.now();
    const observedLater = renderedAt + 10_000;
    const entry = freshSessionEntry({ lastTimeObservedAt: null });
    const rendered = render(entry, ledger, renderedAt)!;

    noteTimeObservedForSession(entry, observedLater);
    applyReminderConsumption({ sessionEntry: entry, receipt: rendered.receipt });

    expect(entry.lastTimeObservedAt).toBe(observedLater);
  });

  it("advances all represented state monotonically", () => {
    const ledger = new EnvChangeLedger();
    ledger.append({ type: "toolset_changed", payload: { pluginId: "demo", action: "loaded" } });
    const now = Date.now();
    const entry = freshSessionEntry({
      lastTimeObservedAt: null,
      reminderCompactionRevision: 2,
      reminderConsumedCompactionRevision: 1,
    });
    const rendered = render(entry, ledger, now)!;
    applyReminderConsumption({ sessionEntry: entry, receipt: rendered.receipt });

    expect(entry).toMatchObject({
      reminderEnvCursor: 1,
      lastTimeObservedAt: now,
      reminderCompactionRevision: 2,
      reminderConsumedCompactionRevision: 2,
    });
    expect(render(entry, ledger, now + 1)).toBeNull();
  });
});
