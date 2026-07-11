import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-vite-keyset-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.HANA_SIGN_KEYSET;
  vi.resetModules();
});

async function loadConfig() {
  vi.resetModules();
  const mod = await import("../vite.config.main.js");
  return mod.default as { resolve?: { alias?: Array<{ find: RegExp; replacement: string }> } };
}

describe("vite.config.main.js HANA_SIGN_KEYSET build-time substitution", () => {
  it("adds no keyset alias by default (repo pinned-keyset.json gets inlined)", async () => {
    delete process.env.HANA_SIGN_KEYSET;
    const config = await loadConfig();
    const aliases = config.resolve?.alias ?? [];
    expect(aliases.some((a) => String(a.find).includes("pinned-keyset"))).toBe(false);
  });

  it("aliases the pinned keyset module to the override file when HANA_SIGN_KEYSET is set", async () => {
    const dir = makeTempDir();
    const overridePath = path.join(dir, "override-keyset.json");
    fs.writeFileSync(overridePath, JSON.stringify([{ keyId: "t1", publicKey: "pem" }]));
    process.env.HANA_SIGN_KEYSET = overridePath;

    const config = await loadConfig();
    const aliases = config.resolve?.alias ?? [];
    const entry = aliases.find((a) => "pinned-keyset.json".match(a.find));
    expect(entry).toBeDefined();
    expect(entry!.replacement).toBe(path.resolve(overridePath));
    // The alias must hit the exact relative specifier keyset.cjs uses.
    expect("./pinned-keyset.json".match(entry!.find)).toBeTruthy();
    // ...and must not swallow unrelated modules.
    expect("./manifest.cjs".match(entry!.find)).toBeNull();
  });

  it("hard-errors at config load when HANA_SIGN_KEYSET points at a missing file", async () => {
    process.env.HANA_SIGN_KEYSET = "/nonexistent/override-keyset.json";
    await expect(loadConfig()).rejects.toThrow(/HANA_SIGN_KEYSET/);
  });
});
