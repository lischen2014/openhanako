import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAndStampDataEpoch,
  dataEpochStampPath,
  describeDataEpochBlock,
} from "../shared/data-epoch.cjs";

const tempDirs: string[] = [];

function makeHomeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-data-epoch-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readStampBytes(homeDir: string) {
  return fs.readFileSync(dataEpochStampPath(homeDir), "utf-8");
}

describe("assertAndStampDataEpoch — six branches", () => {
  it("1. missing stamp -> writes a new stamp at ownEpoch and allows", async () => {
    const homeDir = makeHomeDir();

    const result = await assertAndStampDataEpoch({ homeDir, ownEpoch: 3, ownVersion: "1.0.0" });

    expect(result).toEqual({ allowed: true, action: "stamped-new", epoch: 3, stampPath: dataEpochStampPath(homeDir) });
    const onDisk = JSON.parse(readStampBytes(homeDir));
    expect(onDisk.epoch).toBe(3);
    expect(onDisk.lastVersion).toBe("1.0.0");
    expect(typeof onDisk.updatedAt).toBe("string");
  });

  it("2. corrupt stamp (invalid JSON) -> fail-closed, refuses to start", async () => {
    const homeDir = makeHomeDir();
    fs.writeFileSync(dataEpochStampPath(homeDir), "{ not valid json", "utf-8");

    const result: any = await assertAndStampDataEpoch({ homeDir, ownEpoch: 3, ownVersion: "1.0.0" });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("corrupt-stamp");
    expect(result.stampPath).toBe(dataEpochStampPath(homeDir));
    // Fail-closed must not touch the corrupt file.
    expect(readStampBytes(homeDir)).toBe("{ not valid json");
  });

  it("2b. stamp missing a valid integer epoch field -> also corrupt-stamp", async () => {
    const homeDir = makeHomeDir();
    fs.writeFileSync(dataEpochStampPath(homeDir), JSON.stringify({ lastVersion: "1.0.0" }), "utf-8");

    const result: any = await assertAndStampDataEpoch({ homeDir, ownEpoch: 3, ownVersion: "1.0.0" });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("corrupt-stamp");
  });

  it("3. stamp.epoch > ownEpoch, no override -> blocked", async () => {
    const homeDir = makeHomeDir();
    fs.writeFileSync(
      dataEpochStampPath(homeDir),
      JSON.stringify({ epoch: 5, lastVersion: "2.0.0", updatedAt: "2026-01-01T00:00:00.000Z" }),
      "utf-8",
    );

    const result: any = await assertAndStampDataEpoch({ homeDir, ownEpoch: 3, ownVersion: "1.0.0" });

    expect(result).toEqual({
      allowed: false,
      reason: "epoch-downgrade-blocked",
      stampEpoch: 5,
      ownEpoch: 3,
      stampLastVersion: "2.0.0",
      stampPath: dataEpochStampPath(homeDir),
    });
    // Blocked path must not touch the stamp file.
    const onDisk = JSON.parse(readStampBytes(homeDir));
    expect(onDisk.epoch).toBe(5);
  });

  it("4. stamp.epoch > ownEpoch, allowDowngrade true -> allowed, loud warning, stamp NOT rewritten (only-up rule)", async () => {
    const homeDir = makeHomeDir();
    fs.writeFileSync(
      dataEpochStampPath(homeDir),
      JSON.stringify({ epoch: 5, lastVersion: "2.0.0", updatedAt: "2026-01-01T00:00:00.000Z" }),
      "utf-8",
    );
    const warn = vi.fn();

    const result: any = await assertAndStampDataEpoch({
      homeDir,
      ownEpoch: 3,
      ownVersion: "1.0.0",
      allowDowngrade: true,
      log: { warn },
    });

    expect(result).toEqual({ allowed: true, action: "downgrade-allowed", epoch: 5, stampPath: dataEpochStampPath(homeDir) });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("WARNING");
    expect(warn.mock.calls[0][0]).toContain("警告");
    // Stamp on disk must be untouched — epoch never goes down.
    const onDisk = JSON.parse(readStampBytes(homeDir));
    expect(onDisk.epoch).toBe(5);
    expect(onDisk.lastVersion).toBe("2.0.0");
  });

  it("5. stamp.epoch === ownEpoch -> allowed, stamp rewritten (lastVersion refreshed)", async () => {
    const homeDir = makeHomeDir();
    fs.writeFileSync(
      dataEpochStampPath(homeDir),
      JSON.stringify({ epoch: 3, lastVersion: "0.9.0", updatedAt: "2026-01-01T00:00:00.000Z" }),
      "utf-8",
    );

    const result: any = await assertAndStampDataEpoch({ homeDir, ownEpoch: 3, ownVersion: "1.0.0" });

    expect(result).toEqual({ allowed: true, action: "stamped-upgrade", epoch: 3, stampPath: dataEpochStampPath(homeDir) });
    const onDisk = JSON.parse(readStampBytes(homeDir));
    expect(onDisk.epoch).toBe(3);
    expect(onDisk.lastVersion).toBe("1.0.0");
  });

  it("6. stamp.epoch < ownEpoch -> allowed, stamp bumped up to ownEpoch", async () => {
    const homeDir = makeHomeDir();
    fs.writeFileSync(
      dataEpochStampPath(homeDir),
      JSON.stringify({ epoch: 1, lastVersion: "0.5.0", updatedAt: "2026-01-01T00:00:00.000Z" }),
      "utf-8",
    );

    const result: any = await assertAndStampDataEpoch({ homeDir, ownEpoch: 4, ownVersion: "2.0.0" });

    expect(result).toEqual({ allowed: true, action: "stamped-upgrade", epoch: 4, stampPath: dataEpochStampPath(homeDir) });
    const onDisk = JSON.parse(readStampBytes(homeDir));
    expect(onDisk.epoch).toBe(4);
    expect(onDisk.lastVersion).toBe("2.0.0");
  });
});

describe("assertAndStampDataEpoch — stamp bytes are re-readable", () => {
  it("the JSON written to disk can be parsed back with the exact same fields", async () => {
    const homeDir = makeHomeDir();
    await assertAndStampDataEpoch({ homeDir, ownEpoch: 7, ownVersion: "3.1.4" });

    const raw = readStampBytes(homeDir);
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ epoch: 7, lastVersion: "3.1.4", updatedAt: parsed.updatedAt });
    expect(() => new Date(parsed.updatedAt).toISOString()).not.toThrow();
  });
});

describe("describeDataEpochBlock", () => {
  it("includes both epochs and the last-touching version in a bilingual message", () => {
    const message = describeDataEpochBlock({ stampEpoch: 5, ownEpoch: 3, stampLastVersion: "2.0.0" });
    expect(message).toContain("epoch=5");
    expect(message).toContain("epoch=3");
    expect(message).toContain("2.0.0");
    expect(message).toContain("HANA_ALLOW_DATA_DOWNGRADE=1");
    expect(message).toContain("--allow-data-downgrade");
  });

  it("omits the last-version parenthetical when stampLastVersion is null", () => {
    const message = describeDataEpochBlock({ stampEpoch: 5, ownEpoch: 3, stampLastVersion: null });
    expect(message).not.toContain("last opened by version");
  });
});
