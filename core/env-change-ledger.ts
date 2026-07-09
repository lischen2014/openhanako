/**
 * Process-local append-only ledger for environment changes that an existing
 * session cannot infer from its frozen prompt and tool snapshot.
 *
 * The Engine owns the only instance. Producers and reminder consumers receive
 * it through dependency injection; this module intentionally has no singleton.
 */

export type EnvChangeEntryType = "toolset_changed" | "memory_facts";

export interface ToolsetChangedPayload {
  pluginId: string;
  action: "loaded" | "unloaded" | "reloaded";
}

export interface MemoryFactsPayload {
  addedLines: string[];
}

export interface EnvChangeEntry {
  readonly seq: number;
  readonly type: EnvChangeEntryType;
  readonly payload: Readonly<ToolsetChangedPayload> | Readonly<MemoryFactsPayload>;
  readonly at: string;
}

type EnvChangeInput = {
  type: EnvChangeEntryType;
  payload: ToolsetChangedPayload | MemoryFactsPayload;
};

function freezePayload(entry: EnvChangeInput): EnvChangeEntry["payload"] {
  if (entry.type === "memory_facts") {
    const payload = entry.payload as MemoryFactsPayload;
    return Object.freeze({ addedLines: Object.freeze([...(payload.addedLines || [])]) }) as Readonly<MemoryFactsPayload>;
  }
  const payload = entry.payload as ToolsetChangedPayload;
  return Object.freeze({ pluginId: payload.pluginId, action: payload.action });
}

export class EnvChangeLedger {
  private _entries: EnvChangeEntry[] = [];
  private _seq = 0;

  append(entry: EnvChangeInput): EnvChangeEntry {
    this._seq += 1;
    const recorded = Object.freeze({
      seq: this._seq,
      type: entry.type,
      payload: freezePayload(entry),
      at: new Date().toISOString(),
    }) as EnvChangeEntry;
    this._entries.push(recorded);
    return recorded;
  }

  /** Entries in (afterSeq, throughSeq], in append order. */
  entriesAfter(afterSeq: number, throughSeq = Number.POSITIVE_INFINITY): EnvChangeEntry[] {
    const cursor = Number.isFinite(afterSeq) ? afterSeq : 0;
    const upperBound = Number.isFinite(throughSeq) ? throughSeq : Number.POSITIVE_INFINITY;
    return this._entries.filter((entry) => entry.seq > cursor && entry.seq <= upperBound);
  }

  maxSeq(): number {
    return this._seq;
  }
}
