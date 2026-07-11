import { describe, expect, it } from "vitest";
import {
  DIGEST_ASSET_NAME,
  DIGEST_HISTORY_ASSET_NAME,
  DIGEST_HISTORY_MAX_ENTRIES,
  RELEASE_DIGEST_JSON_SCHEMA,
  appendDigestToHistory,
  validateReleaseDigest,
  validateReleaseDigestHistory,
} from "../scripts/release-digest-schema.mjs";

function validDigest() {
  return {
    schemaVersion: 1,
    tag: "v0.425.4",
    version: "0.425.4",
    previousTag: "v0.425.3",
    generatedAt: "2026-07-05T00:00:00.000Z",
    noUserFacingChanges: false,
    summary: {
      zh: "更新流程更稳。",
      en: "The update flow is steadier.",
    },
    counts: { feature: 1, fix: 0, improvement: 1, migration: 0 },
    source: {
      owner: "liliMozi",
      repo: "openhanako",
      commitRange: "v0.425.3..v0.425.4",
      releaseUrl: "https://github.com/liliMozi/openhanako/releases/tag/v0.425.4",
      releaseNotes: "",
    },
    items: [
      {
        id: "update-digest",
        kind: "feature",
        importance: "high",
        title: { zh: "更新摘要", en: "Update digest" },
        summary: { zh: "About 页展示更新内容。", en: "The About page shows update details." },
        details: [],
        sources: [{ type: "commit", ref: "abc123", title: "Add update digest" }],
      },
    ],
  };
}

describe("release digest schema", () => {
  it("keeps the public asset name stable", () => {
    expect(DIGEST_ASSET_NAME).toBe("release-digest.v1.json");
    expect(RELEASE_DIGEST_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it("accepts a bilingual digest with cited items", () => {
    expect(validateReleaseDigest(validDigest())).toEqual({ ok: true, errors: [] });
  });

  it("rejects empty user-facing digests unless explicitly marked as non-user-facing", () => {
    const digest = validDigest();
    digest.items = [];
    const result = validateReleaseDigest(digest);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("must not be empty");
  });
});

function digestForVersion(version: string, previous: string) {
  const digest = validDigest();
  digest.tag = `v${version}`;
  digest.version = version;
  digest.previousTag = `v${previous}`;
  return digest;
}

describe("release digest history (v2 rolling anthology)", () => {
  it("keeps the v2 asset name stable", () => {
    expect(DIGEST_HISTORY_ASSET_NAME).toBe("release-digest.v2.json");
    expect(DIGEST_HISTORY_MAX_ENTRIES).toBe(50);
  });

  it("accepts a history whose entries are strictly decreasing by version", () => {
    const history = {
      schema: 2,
      entries: [
        digestForVersion("0.425.4", "0.425.3"),
        digestForVersion("0.425.3", "0.425.2"),
        digestForVersion("0.424.10", "0.424.9"),
      ],
    };
    expect(validateReleaseDigestHistory(history)).toEqual({ ok: true, errors: [] });
  });

  it("rejects a history with a wrong schema marker", () => {
    const history = { schema: 1, entries: [validDigest()] };
    const result = validateReleaseDigestHistory(history);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("history.schema");
  });

  it("rejects an empty entries array", () => {
    const result = validateReleaseDigestHistory({ schema: 2, entries: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("entries");
  });

  it("rejects non-decreasing version order (equal or ascending)", () => {
    const equal = {
      schema: 2,
      entries: [digestForVersion("0.425.4", "0.425.3"), digestForVersion("0.425.4", "0.425.3")],
    };
    expect(validateReleaseDigestHistory(equal).ok).toBe(false);

    const ascending = {
      schema: 2,
      entries: [digestForVersion("0.425.3", "0.425.2"), digestForVersion("0.425.4", "0.425.3")],
    };
    expect(validateReleaseDigestHistory(ascending).ok).toBe(false);
  });

  it("compares versions numerically, not lexicographically (0.380.10 > 0.380.9)", () => {
    const history = {
      schema: 2,
      entries: [digestForVersion("0.380.10", "0.380.9"), digestForVersion("0.380.9", "0.380.8")],
    };
    expect(validateReleaseDigestHistory(history)).toEqual({ ok: true, errors: [] });
  });

  it("rejects more than the max entry count", () => {
    const entries = [];
    for (let i = 60; i > 0; i -= 1) {
      entries.push(digestForVersion(`0.400.${i}`, `0.400.${i - 1}`));
    }
    const result = validateReleaseDigestHistory({ schema: 2, entries });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(`${DIGEST_HISTORY_MAX_ENTRIES}`);
  });

  it("surfaces per-entry digest validation errors with an entry index", () => {
    const broken = digestForVersion("0.425.4", "0.425.3");
    (broken as { summary: unknown }).summary = null; // deliberately corrupting for the test
    const result = validateReleaseDigestHistory({ schema: 2, entries: [broken] });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("entries[0]");
  });
});

describe("appendDigestToHistory (append semantics)", () => {
  it("creates a single-entry history from null (first migration)", () => {
    const digest = digestForVersion("0.425.4", "0.425.3");
    const history = appendDigestToHistory(null, digest);
    expect(history.schema).toBe(2);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].version).toBe("0.425.4");
  });

  it("prepends a newer entry and keeps old entries verbatim", () => {
    const oldEntry = digestForVersion("0.425.3", "0.425.2");
    const base = { schema: 2, entries: [oldEntry] };
    const next = appendDigestToHistory(base, digestForVersion("0.425.4", "0.425.3"));
    expect(next.entries.map((entry: { version: string }) => entry.version)).toEqual(["0.425.4", "0.425.3"]);
    expect(next.entries[1]).toEqual(oldEntry);
  });

  it("replaces the head entry when re-run for the same version (idempotent hand-edit loop)", () => {
    const base = appendDigestToHistory(null, digestForVersion("0.425.4", "0.425.3"));
    const edited = digestForVersion("0.425.4", "0.425.3");
    edited.summary = { zh: "修订后的摘要。", en: "Revised summary." };
    const next = appendDigestToHistory(base, edited);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0].summary.en).toBe("Revised summary.");
  });

  it("rejects appending an entry older than the current head", () => {
    const base = appendDigestToHistory(null, digestForVersion("0.425.4", "0.425.3"));
    expect(() => appendDigestToHistory(base, digestForVersion("0.425.3", "0.425.2")))
      .toThrow(/older|decreasing|head/i);
  });

  it("trims to the max entry count, dropping the oldest", () => {
    let history: { schema: number; entries: Array<{ version: string }> } | null = null;
    for (let i = 1; i <= DIGEST_HISTORY_MAX_ENTRIES + 5; i += 1) {
      history = appendDigestToHistory(history, digestForVersion(`0.400.${i}`, `0.400.${i - 1}`));
    }
    expect(history!.entries).toHaveLength(DIGEST_HISTORY_MAX_ENTRIES);
    expect(history!.entries[0].version).toBe(`0.400.${DIGEST_HISTORY_MAX_ENTRIES + 5}`);
    expect(history!.entries[history!.entries.length - 1].version).toBe("0.400.6");
  });

  it("does not mutate the input history", () => {
    const base = appendDigestToHistory(null, digestForVersion("0.425.3", "0.425.2"));
    const snapshot = JSON.parse(JSON.stringify(base));
    appendDigestToHistory(base, digestForVersion("0.425.4", "0.425.3"));
    expect(base).toEqual(snapshot);
  });
});
