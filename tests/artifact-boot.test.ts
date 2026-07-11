import { generateKeyPairSync, sign as cryptoSign } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const {
  hasSeed,
  verifySeedManifest,
  decideBootAction,
  prepareArtifactServerBoot,
  prepareArtifactRendererBoot,
  prepareArtifactBoot,
  writeBootSentinel,
  scheduleHealthySentinelClear,
  rendererPointerChannel,
  isRendererMainFrameLoadCrash,
  isRenderProcessGoneCrash,
  SEED_CHANNEL,
} = require("../desktop/src/shared/artifact-boot.cjs");

const ustar = require("../shared/artifact-core/ustar.cjs");
const activation = require("../shared/artifact-core/activation.cjs");
const pointerStore = require("../shared/artifact-core/pointer-store.cjs");

const PLATFORM_ARCH = "darwin-arm64";
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

function makeKeys(keyId = "boot-test") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    keyset: [{ keyId, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }],
  };
}

/**
 * Builds a complete Resources-like dir carrying a signed server-only seed
 * (the exact layout build-server-artifact.mjs produces under seed/).
 */
async function makeSeedResources(root: string, keys: ReturnType<typeof makeKeys>, opts: { version?: string; marker?: string; train?: number } = {}) {
  const version = opts.version ?? "1.0.0";
  const marker = opts.marker ?? "server-v1";
  const resourcesPath = path.join(root, `resources-${version}-${marker}`);
  const seedDir = path.join(resourcesPath, "seed");
  const treeDir = path.join(root, `tree-${version}-${marker}`);
  await fsp.mkdir(path.join(treeDir, "bundle"), { recursive: true });
  await fsp.writeFile(path.join(treeDir, "bundle", "index.js"), `console.log(${JSON.stringify(marker)});\n`);
  await fsp.writeFile(path.join(treeDir, "hana-server"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const archiveName = `server-${version}-${PLATFORM_ARCH}.tar.gz`;
  await fsp.mkdir(seedDir, { recursive: true });
  const archivePath = path.join(seedDir, archiveName);
  await ustar.packTree(treeDir, archivePath);
  const sha256 = await activation.sha256File(archivePath);

  const manifest = {
    schema: 1,
    train: opts.train ?? 0,
    channel: "stable",
    releasedAt: "2026-07-11T00:00:00.000Z",
    keyId: keys.keyId,
    minShell: version,
    contract: { preload: 1, serverProtocol: 1 },
    urgent: false,
    rollout: { percent: 100, salt: "seed" },
    artifacts: {
      server: { [PLATFORM_ARCH]: { version, sha256, size: fs.statSync(archivePath).size, path: archiveName } },
    },
    mirrors: [],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fsp.writeFile(path.join(seedDir, "seed-train.json"), manifestBytes);
  await fsp.writeFile(path.join(seedDir, "seed-train.json.sig"), cryptoSign(null, manifestBytes, keys.privateKey));
  return { resourcesPath, seedDir, manifest, sha256 };
}

/**
 * Builds a complete Resources-like dir carrying a signed DUAL-kind seed
 * (renderer + server, matching the layout produced by packDualKindSeed).
 * Used to test the renderer resolution path and the combined
 * `prepareArtifactBoot` orchestrator.
 */
async function makeDualKindSeedResources(
  root: string,
  keys: ReturnType<typeof makeKeys>,
  opts: { version?: string; marker?: string; train?: number; omitRenderer?: boolean } = {},
) {
  const version = opts.version ?? "1.0.0";
  const marker = opts.marker ?? "dual-v1";
  const resourcesPath = path.join(root, `resources-${version}-${marker}`);
  const seedDir = path.join(resourcesPath, "seed");
  await fsp.mkdir(seedDir, { recursive: true });

  const serverTreeDir = path.join(root, `server-tree-${version}-${marker}`);
  await fsp.mkdir(path.join(serverTreeDir, "bundle"), { recursive: true });
  await fsp.writeFile(path.join(serverTreeDir, "bundle", "index.js"), `console.log(${JSON.stringify(marker)});\n`);
  await fsp.writeFile(path.join(serverTreeDir, "hana-server"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const serverArchiveName = `server-${version}-${PLATFORM_ARCH}.tar.gz`;
  const serverArchivePath = path.join(seedDir, serverArchiveName);
  await ustar.packTree(serverTreeDir, serverArchivePath);
  const serverSha256 = await activation.sha256File(serverArchivePath);

  const rendererTreeDir = path.join(root, `renderer-tree-${version}-${marker}`);
  await fsp.mkdir(rendererTreeDir, { recursive: true });
  await fsp.writeFile(path.join(rendererTreeDir, "index.html"), `<!doctype html><!-- ${marker} -->\n`);
  const rendererArchiveName = `renderer-${version}.tar.gz`;
  const rendererArchivePath = path.join(seedDir, rendererArchiveName);
  await ustar.packTree(rendererTreeDir, rendererArchivePath);
  const rendererSha256 = await activation.sha256File(rendererArchivePath);

  const artifacts: Record<string, unknown> = {
    server: { [PLATFORM_ARCH]: { version, sha256: serverSha256, size: fs.statSync(serverArchivePath).size, path: serverArchiveName } },
  };
  if (!opts.omitRenderer) {
    artifacts.renderer = { version, sha256: rendererSha256, size: fs.statSync(rendererArchivePath).size, path: rendererArchiveName };
  }

  const manifest = {
    schema: 1,
    train: opts.train ?? 0,
    channel: "stable",
    releasedAt: "2026-07-11T00:00:00.000Z",
    keyId: keys.keyId,
    minShell: version,
    contract: { preload: 1, serverProtocol: 1 },
    urgent: false,
    rollout: { percent: 100, salt: "seed" },
    artifacts,
    mirrors: [],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fsp.writeFile(path.join(seedDir, "seed-train.json"), manifestBytes);
  await fsp.writeFile(path.join(seedDir, "seed-train.json.sig"), cryptoSign(null, manifestBytes, keys.privateKey));
  return { resourcesPath, seedDir, manifest, serverSha256, rendererSha256 };
}

describe("artifact-boot: seed presence and verification", () => {
  it("hasSeed is false when no seed dir exists", () => {
    const root = makeTempDir("hana-boot-");
    expect(hasSeed(path.join(root, "nowhere"))).toBe(false);
  });

  it("hard-errors when the seed manifest lacks a server entry for the running platform", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { seedDir } = await makeSeedResources(root, keys);
    const manifestBytes = fs.readFileSync(path.join(seedDir, "seed-train.json"));
    const sigBytes = fs.readFileSync(path.join(seedDir, "seed-train.json.sig"));
    expect(() =>
      verifySeedManifest({ manifestBytes, sigBytes, keyset: keys.keyset, platformArch: "win32-x64" }),
    ).toThrow(/win32-x64/);
  });

  it("rejects a tampered seed manifest signature", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { resourcesPath, seedDir } = await makeSeedResources(root, keys);
    const sigPath = path.join(seedDir, "seed-train.json.sig");
    const sig = fs.readFileSync(sigPath);
    sig[0] ^= 0xff;
    fs.writeFileSync(sigPath, sig);

    const homeDir = path.join(root, "home");
    await expect(
      prepareArtifactServerBoot({
        homeDir,
        resourcesPath,
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      }),
    ).rejects.toThrow(/signature verification failed/i);
  });
});

describe("artifact-boot: decideBootAction (pure)", () => {
  const seedEntry = { sha256: "a".repeat(64) };

  it("activates the seed when nothing is resolved (first run)", () => {
    expect(decideBootAction({ resolved: null, seedEntry, crashFallback: false })).toBe("activate-seed");
  });

  it("boots the resolved pointer when it matches the bundled seed", () => {
    const resolved = { slot: "current", pointer: { sha256: "a".repeat(64), train: 0 } };
    expect(decideBootAction({ resolved, seedEntry, crashFallback: false })).toBe("boot");
  });

  it("re-activates the seed when a seed-era pointer mismatches the bundled seed (installer updated)", () => {
    const resolved = { slot: "current", pointer: { sha256: "b".repeat(64), train: 0 } };
    expect(decideBootAction({ resolved, seedEntry, crashFallback: false })).toBe("activate-seed");
  });

  it("leaves OTA-activated trains (train > 0) alone even when they mismatch the seed", () => {
    const resolved = { slot: "current", pointer: { sha256: "b".repeat(64), train: 7 } };
    expect(decideBootAction({ resolved, seedEntry, crashFallback: false })).toBe("boot");
  });

  it("never forces the seed over a crash-fallback target", () => {
    const resolved = { slot: "current", pointer: { sha256: "b".repeat(64), train: 0 } };
    expect(decideBootAction({ resolved, seedEntry, crashFallback: true })).toBe("boot");
  });
});

describe("artifact-boot: prepareArtifactServerBoot", () => {
  it("first run extracts the seed, promotes it to current, and returns its versioned dir", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { resourcesPath } = await makeSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    let progressCalls = 0;

    const result = await prepareArtifactServerBoot({
      homeDir,
      resourcesPath,
      platformArch: PLATFORM_ARCH,
      keyset: keys.keyset,
      onProgress: () => {
        progressCalls += 1;
      },
      log: () => {},
    });

    expect(result.activatedSeed).toBe(true);
    expect(progressCalls).toBe(1);
    expect(result.train).toBe(0);
    expect(fs.existsSync(path.join(result.versionDir, "bundle", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(result.versionDir, ".verified"))).toBe(true);
    const current = await pointerStore.readPointer(homeDir, SEED_CHANNEL, "current");
    expect(current.versionDir).toBe(result.versionDir);
  });

  it("second boot skips extraction (pointer hit)", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { resourcesPath } = await makeSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    const boot = (onProgress?: () => void) =>
      prepareArtifactServerBoot({
        homeDir,
        resourcesPath,
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        onProgress,
        log: () => {},
      });

    const first = await boot();
    let progressCalls = 0;
    const second = await boot(() => {
      progressCalls += 1;
    });

    expect(second.activatedSeed).toBe(false);
    expect(progressCalls).toBe(0);
    expect(second.versionDir).toBe(first.versionDir);
  });

  it("re-extracts the seed when the activated tree is corrupted", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { resourcesPath } = await makeSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    const boot = () =>
      prepareArtifactServerBoot({
        homeDir,
        resourcesPath,
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      });

    const first = await boot();
    fs.rmSync(path.join(first.versionDir, ".verified"));

    const second = await boot();
    expect(second.activatedSeed).toBe(true);
    expect(fs.existsSync(path.join(second.versionDir, ".verified"))).toBe(true);
  });

  it("activates the NEW seed after an installer update (same train 0, different content)", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const oldSeed = await makeSeedResources(root, keys, { version: "1.0.0", marker: "old" });
    const newSeed = await makeSeedResources(root, keys, { version: "1.1.0", marker: "new" });
    const homeDir = path.join(root, "home");
    const boot = (resourcesPath: string) =>
      prepareArtifactServerBoot({
        homeDir,
        resourcesPath,
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      });

    await boot(oldSeed.resourcesPath);
    const afterUpdate = await boot(newSeed.resourcesPath);

    expect(afterUpdate.activatedSeed).toBe(true);
    expect(fs.readFileSync(path.join(afterUpdate.versionDir, "bundle", "index.js"), "utf8")).toContain("new");
  });

  it("three consecutive failures on an OTA train quarantine it and fall back to previous", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const seed = await makeSeedResources(root, keys, { version: "1.0.0", marker: "seedgen" });
    const homeDir = path.join(root, "home");
    const boot = () =>
      prepareArtifactServerBoot({
        homeDir,
        resourcesPath: seed.resourcesPath,
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      });

    // Boot once: seed (train 0) becomes current.
    const seedBoot = await boot();

    // Simulate an OTA-activated train 7 landing on top (previous = seed).
    const ota = await makeSeedResources(root, keys, { version: "2.0.0", marker: "ota", train: 7 });
    const otaArchive = path.join(ota.seedDir, `server-2.0.0-${PLATFORM_ARCH}.tar.gz`);
    await activation.activateFromArchive(otaArchive, ota.manifest, {
      homeDir,
      channel: SEED_CHANNEL,
      kind: "server",
      platformArch: PLATFORM_ARCH,
    });
    const otaBoot = await boot();
    expect(otaBoot.train).toBe(7);
    expect(otaBoot.versionDir).not.toBe(seedBoot.versionDir);

    // Three consecutive boot failures on train 7.
    await writeBootSentinel(homeDir, SEED_CHANNEL, 7);
    await writeBootSentinel(homeDir, SEED_CHANNEL, 7);
    await writeBootSentinel(homeDir, SEED_CHANNEL, 7);

    const fallback = await boot();
    expect(fallback.crashFallback).toBe(true);
    expect(fallback.train).toBe(0);
    expect(fallback.versionDir).toBe(seedBoot.versionDir);
    expect(fallback.quarantinedTrain).toBe(7);
    expect(await pointerStore.isQuarantined(homeDir, SEED_CHANNEL, 7)).toBe(true);
  });

  it("three failures on the seed itself never quarantine train 0 (seed stays the terminal fallback)", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const seed = await makeSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    const boot = () =>
      prepareArtifactServerBoot({
        homeDir,
        resourcesPath: seed.resourcesPath,
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      });

    const first = await boot();
    await writeBootSentinel(homeDir, SEED_CHANNEL, 0);
    await writeBootSentinel(homeDir, SEED_CHANNEL, 0);
    await writeBootSentinel(homeDir, SEED_CHANNEL, 0);

    const fallback = await boot();
    expect(fallback.crashFallback).toBe(true);
    expect(fallback.versionDir).toBe(first.versionDir);
    expect(fallback.quarantinedTrain).toBe(null);
    expect(await pointerStore.isQuarantined(homeDir, SEED_CHANNEL, 0)).toBe(false);
    // Fallback resets the sentinel so the fallback target gets a fresh count.
    expect(await activation.consecutiveFailures(homeDir, SEED_CHANNEL)).toBe(0);
  });

  it("hard-errors when packaged resources carry no seed at all (no silent dev fallback)", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    await expect(
      prepareArtifactServerBoot({
        homeDir: path.join(root, "home"),
        resourcesPath: path.join(root, "empty-resources"),
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      }),
    ).rejects.toThrow(/seed/i);
  });
});

describe("artifact-boot: verifySeedManifest requiredKinds", () => {
  it("hard-errors when requiredKinds includes renderer but the manifest carries none", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { seedDir } = await makeSeedResources(root, keys); // server-only fixture
    const manifestBytes = fs.readFileSync(path.join(seedDir, "seed-train.json"));
    const sigBytes = fs.readFileSync(path.join(seedDir, "seed-train.json.sig"));
    expect(() =>
      verifySeedManifest({ manifestBytes, sigBytes, keyset: keys.keyset, requiredKinds: ["renderer"] }),
    ).toThrow(/renderer/i);
  });

  it("returns both entries when requiredKinds asks for server and renderer on a dual-kind manifest", async () => {
    const root = makeTempDir("hana-boot-");
    const keys = makeKeys();
    const { seedDir } = await makeDualKindSeedResources(root, keys);
    const manifestBytes = fs.readFileSync(path.join(seedDir, "seed-train.json"));
    const sigBytes = fs.readFileSync(path.join(seedDir, "seed-train.json.sig"));
    const result = verifySeedManifest({
      manifestBytes,
      sigBytes,
      keyset: keys.keyset,
      platformArch: PLATFORM_ARCH,
      requiredKinds: ["server", "renderer"],
    });
    expect(result.serverEntry).toBeDefined();
    expect(result.rendererEntry).toBeDefined();
  });
});

describe("artifact-boot: prepareArtifactRendererBoot", () => {
  it("first run extracts the renderer seed and returns its versioned dir", async () => {
    const root = makeTempDir("hana-boot-renderer-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    let progressCalls = 0;

    const result = await prepareArtifactRendererBoot({
      homeDir,
      resourcesPath,
      keyset: keys.keyset,
      onProgress: () => {
        progressCalls += 1;
      },
      log: () => {},
    });

    expect(result.activatedSeed).toBe(true);
    expect(progressCalls).toBe(1);
    expect(result.train).toBe(0);
    expect(fs.existsSync(path.join(result.versionDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(result.versionDir, ".verified"))).toBe(true);
  });

  it("second boot skips extraction (pointer hit)", async () => {
    const root = makeTempDir("hana-boot-renderer-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    const boot = () => prepareArtifactRendererBoot({ homeDir, resourcesPath, keyset: keys.keyset, log: () => {} });

    const first = await boot();
    const second = await boot();
    expect(second.activatedSeed).toBe(false);
    expect(second.versionDir).toBe(first.versionDir);
  });

  it("does not collide with the server pointer namespace under the same channel", async () => {
    const root = makeTempDir("hana-boot-renderer-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");

    const server = await prepareArtifactServerBoot({
      homeDir,
      resourcesPath,
      platformArch: PLATFORM_ARCH,
      keyset: keys.keyset,
      log: () => {},
    });
    const renderer = await prepareArtifactRendererBoot({ homeDir, resourcesPath, keyset: keys.keyset, log: () => {} });

    // Distinct pointer files: server's "stable.current.json" must survive
    // renderer's own promote() untouched.
    const serverCurrent = await pointerStore.readPointer(homeDir, SEED_CHANNEL, "current");
    expect(serverCurrent.kind).toBe("server");
    expect(serverCurrent.versionDir).toBe(server.versionDir);
    expect(renderer.versionDir).not.toBe(server.versionDir);
    expect(fs.existsSync(path.join(renderer.versionDir, "index.html"))).toBe(true);
  });

  it("hard-errors when packaged resources carry no seed at all", async () => {
    const root = makeTempDir("hana-boot-renderer-");
    const keys = makeKeys();
    await expect(
      prepareArtifactRendererBoot({
        homeDir: path.join(root, "home"),
        resourcesPath: path.join(root, "empty-resources"),
        keyset: keys.keyset,
        log: () => {},
      }),
    ).rejects.toThrow(/seed/i);
  });

  // artifact recovery: renderer crash-loop demotion, isomorphic to
  // prepareArtifactServerBoot's (mirrors the two "three consecutive
  // failures" tests above, but against the renderer's own pointer
  // namespace `${channel}.renderer`).
  it("three consecutive failures on an OTA renderer train quarantine it and fall back to previous", async () => {
    const root = makeTempDir("hana-boot-renderer-");
    const keys = makeKeys();
    const seed = await makeDualKindSeedResources(root, keys, { version: "1.0.0", marker: "seedgen" });
    const homeDir = path.join(root, "home");
    const boot = () => prepareArtifactRendererBoot({ homeDir, resourcesPath: seed.resourcesPath, keyset: keys.keyset, log: () => {} });

    const seedBoot = await boot();

    const ota = await makeDualKindSeedResources(root, keys, { version: "2.0.0", marker: "ota", train: 7 });
    const otaArchive = path.join(ota.seedDir, `renderer-2.0.0.tar.gz`);
    const rendererChannel = rendererPointerChannel(SEED_CHANNEL);
    await activation.activateFromArchive(otaArchive, ota.manifest, {
      homeDir,
      channel: rendererChannel,
      kind: "renderer",
    });
    const otaBoot = await boot();
    expect(otaBoot.train).toBe(7);
    expect(otaBoot.versionDir).not.toBe(seedBoot.versionDir);

    await writeBootSentinel(homeDir, rendererChannel, 7);
    await writeBootSentinel(homeDir, rendererChannel, 7);
    await writeBootSentinel(homeDir, rendererChannel, 7);

    const fallback = await boot();
    expect(fallback.crashFallback).toBe(true);
    expect(fallback.train).toBe(0);
    expect(fallback.versionDir).toBe(seedBoot.versionDir);
    expect(fallback.quarantinedTrain).toBe(7);
    expect(await pointerStore.isQuarantined(homeDir, rendererChannel, 7)).toBe(true);
  });

  it("three failures on the renderer seed itself never quarantine train 0", async () => {
    const root = makeTempDir("hana-boot-renderer-");
    const keys = makeKeys();
    const seed = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    const boot = () => prepareArtifactRendererBoot({ homeDir, resourcesPath: seed.resourcesPath, keyset: keys.keyset, log: () => {} });
    const rendererChannel = rendererPointerChannel(SEED_CHANNEL);

    const first = await boot();
    await writeBootSentinel(homeDir, rendererChannel, 0);
    await writeBootSentinel(homeDir, rendererChannel, 0);
    await writeBootSentinel(homeDir, rendererChannel, 0);

    const fallback = await boot();
    expect(fallback.crashFallback).toBe(true);
    expect(fallback.versionDir).toBe(first.versionDir);
    expect(fallback.quarantinedTrain).toBe(null);
    expect(await pointerStore.isQuarantined(homeDir, rendererChannel, 0)).toBe(false);
    expect(await activation.consecutiveFailures(homeDir, rendererChannel)).toBe(0);
  });
});

describe("artifact-boot: renderer load-failure event guards (artifact recovery)", () => {
  it("treats a main-frame did-fail-load as a crash", () => {
    expect(isRendererMainFrameLoadCrash({ errorCode: -6, isMainFrame: true })).toBe(true);
  });

  it("ignores sub-frame did-fail-load events regardless of error code", () => {
    expect(isRendererMainFrameLoadCrash({ errorCode: -6, isMainFrame: false })).toBe(false);
  });

  it("ignores ERR_ABORTED (-3) on the main frame (benign cancelled navigation)", () => {
    expect(isRendererMainFrameLoadCrash({ errorCode: -3, isMainFrame: true })).toBe(false);
  });

  it("treats render-process-gone as a crash unless the reason is clean-exit", () => {
    expect(isRenderProcessGoneCrash({ reason: "crashed" })).toBe(true);
    expect(isRenderProcessGoneCrash({ reason: "oom" })).toBe(true);
    expect(isRenderProcessGoneCrash({ reason: "killed" })).toBe(true);
    expect(isRenderProcessGoneCrash({ reason: "clean-exit" })).toBe(false);
  });
});

describe("artifact-boot: prepareArtifactBoot dual-kind orchestrator", () => {
  it("resolves both server and renderer on first run", async () => {
    const root = makeTempDir("hana-boot-dual-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");

    const result = await prepareArtifactBoot({
      homeDir,
      resourcesPath,
      platformArch: PLATFORM_ARCH,
      keyset: keys.keyset,
      log: () => {},
    });

    expect(result.server.activatedSeed).toBe(true);
    expect(result.renderer.activatedSeed).toBe(true);
    expect(fs.existsSync(path.join(result.server.versionDir, "bundle", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(result.renderer.versionDir, "index.html"))).toBe(true);
  });

  // Mutation-check target: a manifest missing the
  // renderer kind must hard-error the WHOLE boot, not just silently boot
  // server alone. Flip `omitRenderer` to false to see this test go red.
  it("hard-errors the whole boot when the manifest is missing the renderer kind", async () => {
    const root = makeTempDir("hana-boot-dual-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys, { omitRenderer: true });
    const homeDir = path.join(root, "home");

    await expect(
      prepareArtifactBoot({ homeDir, resourcesPath, platformArch: PLATFORM_ARCH, keyset: keys.keyset, log: () => {} }),
    ).rejects.toThrow(/renderer/i);
  });

  it("hard-errors the whole boot when the manifest is missing the server entry for the running platform", async () => {
    const root = makeTempDir("hana-boot-dual-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");

    await expect(
      prepareArtifactBoot({ homeDir, resourcesPath, platformArch: "win32-x64", keyset: keys.keyset, log: () => {} }),
    ).rejects.toThrow(/win32-x64/);
  });

  it("hard-errors when packaged resources carry no seed at all", async () => {
    const root = makeTempDir("hana-boot-dual-");
    const keys = makeKeys();
    await expect(
      prepareArtifactBoot({
        homeDir: path.join(root, "home"),
        resourcesPath: path.join(root, "empty-resources"),
        platformArch: PLATFORM_ARCH,
        keyset: keys.keyset,
        log: () => {},
      }),
    ).rejects.toThrow(/seed/i);
  });

  it("second boot resolves both kinds from pointer hits (no re-extraction)", async () => {
    const root = makeTempDir("hana-boot-dual-");
    const keys = makeKeys();
    const { resourcesPath } = await makeDualKindSeedResources(root, keys);
    const homeDir = path.join(root, "home");
    const boot = () =>
      prepareArtifactBoot({ homeDir, resourcesPath, platformArch: PLATFORM_ARCH, keyset: keys.keyset, log: () => {} });

    const first = await boot();
    const second = await boot();
    expect(second.server.activatedSeed).toBe(false);
    expect(second.renderer.activatedSeed).toBe(false);
    expect(second.server.versionDir).toBe(first.server.versionDir);
    expect(second.renderer.versionDir).toBe(first.renderer.versionDir);
  });
});

describe("artifact-boot: sentinel helpers", () => {
  it("writeBootSentinel counts consecutive attempts and scheduleHealthySentinelClear clears them", async () => {
    const root = makeTempDir("hana-boot-");
    const homeDir = path.join(root, "home");
    await writeBootSentinel(homeDir, SEED_CHANNEL, 3);
    await writeBootSentinel(homeDir, SEED_CHANNEL, 3);
    expect(await activation.consecutiveFailures(homeDir, SEED_CHANNEL)).toBe(2);

    scheduleHealthySentinelClear({ homeDir, channel: SEED_CHANNEL, delayMs: 10, log: () => {} });
    await new Promise((r) => setTimeout(r, 120));
    expect(await activation.consecutiveFailures(homeDir, SEED_CHANNEL)).toBe(0);
  });
});
