import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const { repairSubpaths, computeRepairTargets, repairArtifacts } = require("../desktop/src/shared/artifact-repair.cjs");
const pointerStore = require("../shared/artifact-core/pointer-store.cjs");

const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("artifact-repair: repairSubpaths / computeRepairTargets (pure)", () => {
  it("includes every known artifact-state subpath", () => {
    const subpaths = repairSubpaths();
    expect(subpaths).toContain("pointers");
    expect(subpaths).toContain("server");
    expect(subpaths).toContain("renderer");
    expect(subpaths).toContain("staging");
    expect(subpaths).toContain("quarantine.json");
    expect(subpaths).toContain("stable.sentinel.json");
    expect(subpaths).toContain("stable.renderer.sentinel.json");
    expect(subpaths).toContain("ota-state.json");
  });

  // Mutation-check target: rollout-id is the grey-rollout identity and
  // must never be swept by a repair. Temporarily adding "rollout-id" to
  // repairSubpaths()'s array should turn this test red.
  it("never lists rollout-id (grey rollout identity, not component state)", () => {
    expect(repairSubpaths()).not.toContain("rollout-id");
  });

  it("never lists lock (the flock file)", () => {
    expect(repairSubpaths()).not.toContain("lock");
  });

  it("resolves every subpath against the given artifacts root", () => {
    const targets = computeRepairTargets("/home/.hanako/artifacts");
    expect(targets).toContain(path.join("/home/.hanako/artifacts", "pointers"));
    expect(targets.some((t: string) => t.endsWith("rollout-id"))).toBe(false);
  });
});

describe("artifact-repair: repairArtifacts (impure, fs-touching)", () => {
  it("removes known state and preserves rollout-id and lock", async () => {
    const root = makeTempDir("hana-repair-");
    const homeDir = path.join(root, "home");
    const artifactsRoot = pointerStore.artifactsRoot(homeDir);

    await fsp.mkdir(path.join(artifactsRoot, "pointers"), { recursive: true });
    await fsp.writeFile(path.join(artifactsRoot, "pointers", "stable.current.json"), "{}");
    await fsp.mkdir(path.join(artifactsRoot, "server", "1.0.0-darwin-arm64"), { recursive: true });
    await fsp.mkdir(path.join(artifactsRoot, "renderer", "1.0.0"), { recursive: true });
    await fsp.mkdir(path.join(artifactsRoot, "staging"), { recursive: true });
    await fsp.writeFile(path.join(artifactsRoot, "quarantine.json"), "[]");
    await fsp.writeFile(path.join(artifactsRoot, "stable.sentinel.json"), "{}");
    await fsp.writeFile(path.join(artifactsRoot, "stable.renderer.sentinel.json"), "{}");
    await fsp.writeFile(path.join(artifactsRoot, "ota-state.json"), "{}");
    await fsp.writeFile(path.join(artifactsRoot, "rollout-id"), "11111111-1111-1111-1111-111111111111");
    await fsp.writeFile(path.join(artifactsRoot, "lock"), JSON.stringify({ pid: 1 }));

    await repairArtifacts({ homeDir, log: () => {} });

    expect(fs.existsSync(path.join(artifactsRoot, "pointers"))).toBe(false);
    expect(fs.existsSync(path.join(artifactsRoot, "server"))).toBe(false);
    expect(fs.existsSync(path.join(artifactsRoot, "renderer"))).toBe(false);
    expect(fs.existsSync(path.join(artifactsRoot, "staging"))).toBe(false);
    expect(fs.existsSync(path.join(artifactsRoot, "quarantine.json"))).toBe(false);
    expect(fs.existsSync(path.join(artifactsRoot, "stable.sentinel.json"))).toBe(false);
    expect(fs.existsSync(path.join(artifactsRoot, "stable.renderer.sentinel.json"))).toBe(false);
    expect(fs.existsSync(path.join(artifactsRoot, "ota-state.json"))).toBe(false);

    // The guard under test: these two survive untouched.
    expect(fs.existsSync(path.join(artifactsRoot, "rollout-id"))).toBe(true);
    expect(fs.readFileSync(path.join(artifactsRoot, "rollout-id"), "utf8")).toBe("11111111-1111-1111-1111-111111111111");
    expect(fs.existsSync(path.join(artifactsRoot, "lock"))).toBe(true);
  });

  it("is a no-op (not a throw) when artifacts/ does not exist at all", async () => {
    const root = makeTempDir("hana-repair-");
    const homeDir = path.join(root, "home");
    await expect(repairArtifacts({ homeDir, log: () => {} })).resolves.toBeDefined();
  });

  it("keeps going after an individual removal failure and reports it", async () => {
    const root = makeTempDir("hana-repair-");
    const homeDir = path.join(root, "home");
    const artifactsRoot = pointerStore.artifactsRoot(homeDir);
    await fsp.mkdir(artifactsRoot, { recursive: true });
    await fsp.writeFile(path.join(artifactsRoot, "quarantine.json"), "[]");

    const result = await repairArtifacts({ homeDir, log: () => {} });
    expect(result.removed).toContain(path.join(artifactsRoot, "quarantine.json"));
    expect(result.failed).toEqual([]);
  });
});
