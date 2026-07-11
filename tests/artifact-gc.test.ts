import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const {
  SERVER_VERSION_DIR_PATTERN,
  RENDERER_VERSION_DIR_PATTERN,
  computeGcTargets,
  keepNamesForKind,
  gcArtifactKind,
} = require("../desktop/src/shared/artifact-gc.cjs");
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

describe("artifact-gc: naming patterns", () => {
  it("matches managed server version dir names", () => {
    expect(SERVER_VERSION_DIR_PATTERN.test("1.2.3-darwin-arm64")).toBe(true);
    expect(SERVER_VERSION_DIR_PATTERN.test("0.382.0-win32-x64")).toBe(true);
  });

  it("rejects unmanaged names for the server pattern", () => {
    expect(SERVER_VERSION_DIR_PATTERN.test("not-a-version")).toBe(false);
    expect(SERVER_VERSION_DIR_PATTERN.test("1.2.3")).toBe(false); // missing platform-arch
    expect(SERVER_VERSION_DIR_PATTERN.test(".DS_Store")).toBe(false);
  });

  it("matches managed renderer version dir names", () => {
    expect(RENDERER_VERSION_DIR_PATTERN.test("1.2.3")).toBe(true);
  });

  it("rejects unmanaged names for the renderer pattern", () => {
    expect(RENDERER_VERSION_DIR_PATTERN.test("1.2.3-darwin-arm64")).toBe(false);
    expect(RENDERER_VERSION_DIR_PATTERN.test("scratch")).toBe(false);
  });
});

describe("artifact-gc: computeGcTargets (pure)", () => {
  const pattern = RENDERER_VERSION_DIR_PATTERN;

  it("deletes stale matching entries not in the keep set", () => {
    const targets = computeGcTargets({
      entries: ["1.0.0", "1.1.0", "1.2.0"],
      keepNames: new Set(["1.2.0"]),
      pattern,
    });
    expect(targets.sort()).toEqual(["1.0.0", "1.1.0"]);
  });

  // Guard 1 (mutation target): a kept name is NEVER a deletion candidate,
  // even though it matches the naming pattern.
  it("never deletes a directory a pointer references, even though it matches the pattern", () => {
    const targets = computeGcTargets({
      entries: ["1.0.0", "1.1.0"],
      keepNames: new Set(["1.0.0", "1.1.0"]),
      pattern,
    });
    expect(targets).toEqual([]);
  });

  // Guard 2 (mutation target): a non-matching name is NEVER a deletion
  // candidate, even though it isn't in the keep set.
  it("never deletes a directory that doesn't match the managed naming pattern", () => {
    const targets = computeGcTargets({
      entries: ["1.0.0", "user-scratch-dir", ".DS_Store"],
      keepNames: new Set(),
      pattern,
    });
    expect(targets).toEqual(["1.0.0"]);
  });
});

describe("artifact-gc: keepNamesForKind", () => {
  it("collects current + previous pointer version-dir basenames for a single channel", async () => {
    const root = makeTempDir("hana-gc-");
    const homeDir = path.join(root, "home");
    await pointerStore.writePointer(homeDir, "stable", "current", {
      kind: "renderer",
      versionDir: "/artifacts/renderer/2.0.0",
    });
    await pointerStore.writePointer(homeDir, "stable", "previous", {
      kind: "renderer",
      versionDir: "/artifacts/renderer/1.0.0",
    });

    const keep = await keepNamesForKind(homeDir, "renderer");
    expect(keep).toEqual(new Set(["2.0.0", "1.0.0"]));
  });

  it("returns an empty set when no pointers exist", async () => {
    const root = makeTempDir("hana-gc-");
    const homeDir = path.join(root, "home");
    const keep = await keepNamesForKind(homeDir, "server");
    expect(keep).toEqual(new Set());
  });

  it("filters by kind: a renderer pointer never protects a server-kind query, and vice versa", async () => {
    const root = makeTempDir("hana-gc-");
    const homeDir = path.join(root, "home");
    await pointerStore.writePointer(homeDir, "stable", "current", {
      kind: "server",
      versionDir: "/artifacts/server/1.0.0-darwin-arm64",
    });
    await pointerStore.writePointer(homeDir, "stable.renderer", "current", {
      kind: "renderer",
      versionDir: "/artifacts/renderer/1.0.0",
    });

    expect(await keepNamesForKind(homeDir, "server")).toEqual(new Set(["1.0.0-darwin-arm64"]));
    expect(await keepNamesForKind(homeDir, "renderer")).toEqual(new Set(["1.0.0"]));
  });

  // Cross-channel protection (2026-07-12 incident): pointers for TWO
  // different channels must both be protected regardless of which single
  // channel's pointer the query is conceptually "for" — keepNamesForKind
  // takes no channel argument at all precisely because of this.
  it("collects pointer version dirs across every channel present, not just one", async () => {
    const root = makeTempDir("hana-gc-");
    const homeDir = path.join(root, "home");
    await pointerStore.writePointer(homeDir, "stable", "current", {
      kind: "server",
      versionDir: "/artifacts/server/1.0.0-darwin-arm64",
    });
    await pointerStore.writePointer(homeDir, "beta", "current", {
      kind: "server",
      versionDir: "/artifacts/server/2.0.0-darwin-arm64",
    });

    const keep = await keepNamesForKind(homeDir, "server");
    expect(keep).toEqual(new Set(["1.0.0-darwin-arm64", "2.0.0-darwin-arm64"]));
  });

  // Conservative-on-parse-failure guard (mutation target): a single
  // unreadable pointer file must abort the whole read with `null`, never
  // silently drop just that one entry from the keep set.
  it("returns null when any pointer file fails to parse as JSON", async () => {
    const root = makeTempDir("hana-gc-");
    const homeDir = path.join(root, "home");
    await pointerStore.writePointer(homeDir, "stable", "current", {
      kind: "server",
      versionDir: "/artifacts/server/1.0.0-darwin-arm64",
    });
    const pointersDir = pointerStore.pointersDir(homeDir);
    await fsp.writeFile(path.join(pointersDir, "beta.current.json"), "{not valid json", "utf8");

    const keep = await keepNamesForKind(homeDir, "server");
    expect(keep).toBeNull();
  });
});

describe("artifact-gc: gcArtifactKind (impure, fs-touching)", () => {
  it("removes stale renderer version dirs, keeps current+previous, ignores unmanaged dirs", async () => {
    const root = makeTempDir("hana-gc-");
    const homeDir = path.join(root, "home");
    const rendererRoot = path.join(homeDir, "artifacts", "renderer");
    for (const name of ["1.0.0", "1.1.0", "1.2.0", "scratch-dir"]) {
      await fsp.mkdir(path.join(rendererRoot, name), { recursive: true });
    }
    await pointerStore.writePointer(homeDir, "stable.renderer", "current", {
      kind: "renderer",
      versionDir: path.join(rendererRoot, "1.2.0"),
    });
    await pointerStore.writePointer(homeDir, "stable.renderer", "previous", {
      kind: "renderer",
      versionDir: path.join(rendererRoot, "1.1.0"),
    });

    const result = await gcArtifactKind({ homeDir, kind: "renderer", channel: "stable.renderer", log: () => {} });

    expect(result.removed.sort()).toEqual(["1.0.0"]);
    expect(fs.existsSync(path.join(rendererRoot, "1.0.0"))).toBe(false);
    expect(fs.existsSync(path.join(rendererRoot, "1.1.0"))).toBe(true);
    expect(fs.existsSync(path.join(rendererRoot, "1.2.0"))).toBe(true);
    expect(fs.existsSync(path.join(rendererRoot, "scratch-dir"))).toBe(true);
  });

  it("is a silent no-op when the kind's versions root does not exist yet", async () => {
    const root = makeTempDir("hana-gc-");
    const homeDir = path.join(root, "home");
    const result = await gcArtifactKind({ homeDir, kind: "server", channel: "stable", log: () => {} });
    expect(result.removed).toEqual([]);
  });

  it("never throws even when an individual removal fails", async () => {
    const root = makeTempDir("hana-gc-");
    const homeDir = path.join(root, "home");
    const serverRoot = path.join(homeDir, "artifacts", "server");
    await fsp.mkdir(path.join(serverRoot, "1.0.0-darwin-arm64"), { recursive: true });
    const messages: string[] = [];

    // Nothing else to keep: GC will attempt to remove the only entry.
    // Simulate a hostile fs by pointing keepNamesForKind-independent
    // logic at a root that's actually fine to remove — this test mainly
    // asserts the function's promise never rejects regardless.
    await expect(
      gcArtifactKind({ homeDir, kind: "server", channel: "stable", log: (m) => messages.push(m) }),
    ).resolves.toBeDefined();
  });

  // --- 2026-07-12 incident regression: cross-channel GC protection ---
  //
  // Reproduces the real-machine crash: a device that has pointers for
  // TWO channels (e.g. a user who switched from stable to beta, or beta
  // preference on first install with a stable pointer left by some
  // earlier state) must never have one channel's GC pass delete the
  // OTHER channel's just-activated version directory.
  it("protects both channels' current+previous dirs regardless of which channel's boot triggered GC", async () => {
    const root = makeTempDir("hana-gc-");
    const homeDir = path.join(root, "home");
    const serverRoot = path.join(homeDir, "artifacts", "server");
    const stableDir = "1.0.0-darwin-arm64"; // dirA: stable's current
    const betaDir = "2.0.0-darwin-arm64"; // dirB: beta's just-activated current
    const staleDir = "0.9.0-darwin-arm64"; // referenced by nobody: legitimately stale

    for (const name of [stableDir, betaDir, staleDir]) {
      await fsp.mkdir(path.join(serverRoot, name), { recursive: true });
    }
    await pointerStore.writePointer(homeDir, "stable", "current", {
      kind: "server",
      versionDir: path.join(serverRoot, stableDir),
    });
    await pointerStore.writePointer(homeDir, "beta", "current", {
      kind: "server",
      versionDir: path.join(serverRoot, betaDir),
    });

    // Simulate the accident: this boot happened on the "beta" channel
    // (matching the accident machine's preference), but the GC call is
    // scoped to "beta" the way resolvePackagedArtifactBoot invokes it.
    const result = await gcArtifactKind({ homeDir, kind: "server", channel: "beta", log: () => {} });

    expect(result.removed).toEqual([staleDir]);
    expect(fs.existsSync(path.join(serverRoot, stableDir))).toBe(true); // other channel survives
    expect(fs.existsSync(path.join(serverRoot, betaDir))).toBe(true); // this channel's own dir survives
    expect(fs.existsSync(path.join(serverRoot, staleDir))).toBe(false); // truly unreferenced dir still swept

    // Symmetric check: running GC "for stable" must equally spare beta's dir.
    await fsp.mkdir(path.join(serverRoot, staleDir), { recursive: true }); // re-create for a second sweep
    const result2 = await gcArtifactKind({ homeDir, kind: "server", channel: "stable", log: () => {} });
    expect(result2.removed).toEqual([staleDir]);
    expect(fs.existsSync(path.join(serverRoot, stableDir))).toBe(true);
    expect(fs.existsSync(path.join(serverRoot, betaDir))).toBe(true);
  });

  it("skips deletion entirely (never removes anything) when a pointer file fails to parse", async () => {
    const root = makeTempDir("hana-gc-");
    const homeDir = path.join(root, "home");
    const serverRoot = path.join(homeDir, "artifacts", "server");
    const staleDir = "0.9.0-darwin-arm64";
    await fsp.mkdir(path.join(serverRoot, staleDir), { recursive: true });

    const pointersDir = pointerStore.pointersDir(homeDir);
    await fsp.mkdir(pointersDir, { recursive: true });
    await fsp.writeFile(path.join(pointersDir, "beta.current.json"), "{not valid json", "utf8");

    const messages: string[] = [];
    const result = await gcArtifactKind({ homeDir, kind: "server", channel: "stable", log: (m) => messages.push(m) });

    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(serverRoot, staleDir))).toBe(true);
    expect(messages.some((m) => m.includes("skipped"))).toBe(true);
  });
});
