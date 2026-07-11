import { generateKeyPairSync, sign as cryptoSign } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import zlib from "zlib";
import { Readable } from "stream";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const ota = require("../desktop/src/shared/artifact-ota.cjs");
const artifactBoot = require("../desktop/src/shared/artifact-boot.cjs");
const devBypass = require("../desktop/src/shared/artifact-ota-dev-bypass.cjs");
const prodStub = require("../desktop/src/shared/artifact-ota-dev-bypass.prod-stub.cjs");
const ustar = require("../shared/artifact-core/ustar.cjs");
const activation = require("../shared/artifact-core/activation.cjs");
const pointerStore = require("../shared/artifact-core/pointer-store.cjs");

const {
  checkAndDownloadOnce,
  fetchWithRedirects,
  fetchBuffer,
  downloadToFile,
  isShellVersionSufficient,
  computeRolloutBucket,
  isInRolloutBucket,
  ensureRolloutId,
  readOtaState,
  writeOtaChannelState,
  channelManifestUrls,
  hasDevOverrideConfigured,
  SEED_CHANNEL,
} = ota;

const PLATFORM_ARCH = "darwin-arm64";
const SHELL_VERSION = "1.0.0";
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
  delete process.env.HANA_ARTIFACT_MANIFEST;
});

function makeKeys(keyId = "ota-test") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    keyset: [{ keyId, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }],
  };
}

/**
 * Builds a complete "next to the manifest" fixture directory: manifest.json
 * + .sig + server/renderer archives — exactly the layout the dev-bypass
 * local-path branch of `checkAndDownloadOnce` expects (mirrors the
 * seed/ layout artifact-boot.test.ts fixtures use).
 */
async function makeOtaFixture(root: string, keys: ReturnType<typeof makeKeys>, opts: {
  version?: string;
  train?: number;
  marker?: string;
  minShell?: string;
  rolloutPercent?: number;
  rolloutSalt?: string;
  omitRenderer?: boolean;
  omitServer?: boolean;
  corruptRendererArchive?: boolean;
} = {}) {
  const version = opts.version ?? "2.0.0";
  const train = opts.train ?? 1;
  const marker = opts.marker ?? `ota-${train}`;
  const fixtureDir = path.join(root, `fixture-${train}-${marker}`);
  await fsp.mkdir(fixtureDir, { recursive: true });

  const serverTreeDir = path.join(root, `server-tree-${train}-${marker}`);
  await fsp.mkdir(path.join(serverTreeDir, "bundle"), { recursive: true });
  await fsp.writeFile(path.join(serverTreeDir, "bundle", "index.js"), `console.log(${JSON.stringify(marker)});\n`);
  const serverArchiveName = `server-${version}-${PLATFORM_ARCH}.tar.gz`;
  const serverArchivePath = path.join(fixtureDir, serverArchiveName);
  await ustar.packTree(serverTreeDir, serverArchivePath);
  const serverSha256 = await activation.sha256File(serverArchivePath);

  const rendererTreeDir = path.join(root, `renderer-tree-${train}-${marker}`);
  await fsp.mkdir(rendererTreeDir, { recursive: true });
  await fsp.writeFile(path.join(rendererTreeDir, "index.html"), `<!doctype html><!-- ${marker} -->\n`);
  const rendererArchiveName = `renderer-${version}.tar.gz`;
  const rendererArchivePath = path.join(fixtureDir, rendererArchiveName);
  if (opts.corruptRendererArchive) {
    // Valid gzip stream, invalid ustar content beneath it: sha256 is
    // computed AFTER writing, so it's self-consistent with the manifest
    // (staging's sha256 check passes) — the failure only surfaces inside
    // activateFromArchive's ustar.extract (bad magic bytes), which is
    // exactly the "activation fails after staging succeeded" case the
    // both-or-neither rollback test needs.
    await fsp.writeFile(rendererArchivePath, zlib.gzipSync(Buffer.from("not a valid ustar archive\n")));
  } else {
    await ustar.packTree(rendererTreeDir, rendererArchivePath);
  }
  const rendererSha256 = await activation.sha256File(rendererArchivePath);

  const manifest: any = {
    schema: 1,
    train,
    channel: "stable",
    releasedAt: "2026-07-11T00:00:00.000Z",
    keyId: keys.keyId,
    minShell: opts.minShell ?? "0.1.0",
    contract: { preload: 1, serverProtocol: 1 },
    urgent: false,
    rollout: { percent: opts.rolloutPercent ?? 100, salt: opts.rolloutSalt ?? "test-salt" },
    artifacts: {},
    mirrors: [],
  };
  if (!opts.omitServer) {
    manifest.artifacts.server = {
      [PLATFORM_ARCH]: { version, sha256: serverSha256, size: fs.statSync(serverArchivePath).size, path: serverArchiveName },
    };
  }
  if (!opts.omitRenderer) {
    manifest.artifacts.renderer = {
      version,
      sha256: rendererSha256,
      size: fs.statSync(rendererArchivePath).size,
      path: rendererArchiveName,
    };
  }
  if (opts.omitRenderer && opts.omitServer) {
    // schema requires at least one known kind present
    manifest.artifacts.server = {
      [PLATFORM_ARCH]: { version, sha256: serverSha256, size: fs.statSync(serverArchivePath).size, path: serverArchiveName },
    };
  }

  const manifestPath = path.join(fixtureDir, "manifest.json");
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fsp.writeFile(manifestPath, manifestBytes);
  await fsp.writeFile(`${manifestPath}.sig`, cryptoSign(null, manifestBytes, keys.privateKey));
  return { fixtureDir, manifestPath, manifest, serverSha256, rendererSha256 };
}

function runWithDevOverride(
  manifestPath: string,
  fn: () => Promise<{ outcome: string; train?: number; error?: string }>,
): Promise<{ outcome: string; train?: number; error?: string }> {
  process.env.HANA_ARTIFACT_MANIFEST = manifestPath;
  return fn().finally(() => {
    delete process.env.HANA_ARTIFACT_MANIFEST;
  });
}

// ── low-level transport: redirect following, injectable fake transport ────

function fakeStreamResponse(statusCode: number, headers: Record<string, string>, chunks: Buffer[] = []) {
  return { statusCode, headers, bodyStream: Readable.from(chunks) };
}

describe("artifact-ota: fetchWithRedirects (fake transport)", () => {
  it("follows a chain of 302 redirects to a final 200", async () => {
    const calls: string[] = [];
    const fetchOnce = async (url: string) => {
      calls.push(url);
      if (calls.length === 1) return fakeStreamResponse(302, { location: "https://mirror.example/b" });
      if (calls.length === 2) return fakeStreamResponse(302, { location: "https://mirror.example/c" });
      return fakeStreamResponse(200, {}, [Buffer.from("ok")]);
    };
    const result = await fetchWithRedirects("https://mirror.example/a", { fetchOnce });
    expect(result.statusCode).toBe(200);
    expect(calls).toEqual([
      "https://mirror.example/a",
      "https://mirror.example/b",
      "https://mirror.example/c",
    ]);
  });

  it("rejects a redirect that downgrades to a non-https URL", async () => {
    const calls: string[] = [];
    const fetchOnce = async (url: string) => {
      calls.push(url);
      return fakeStreamResponse(302, { location: "http://insecure.example/b" });
    };
    await expect(fetchWithRedirects("https://mirror.example/a", { fetchOnce })).rejects.toThrow(/https/i);
    expect(calls.length).toBe(1); // never even tries to follow the downgraded hop
  });

  it("rejects a non-https initial URL without ever calling the transport", async () => {
    let called = false;
    const fetchOnce = async () => {
      called = true;
      return fakeStreamResponse(200, {}, []);
    };
    await expect(fetchWithRedirects("http://insecure.example/a", { fetchOnce })).rejects.toThrow(/https/i);
    expect(called).toBe(false);
  });

  it("rejects after exceeding the redirect hop cap", async () => {
    let calls = 0;
    const fetchOnce = async () => {
      calls += 1;
      return fakeStreamResponse(302, { location: `https://mirror.example/hop-${calls}` });
    };
    await expect(
      fetchWithRedirects("https://mirror.example/a", { fetchOnce, maxRedirects: 3 }),
    ).rejects.toThrow(/too many redirects/i);
    expect(calls).toBe(4); // hops 0,1,2,3 attempted, the 4th response is the one that trips the cap
  });
});

describe("artifact-ota: fetchBuffer", () => {
  it("surfaces a 304 as a null-body result", async () => {
    const fetchOnce = async () => fakeStreamResponse(304, {});
    const result = await fetchBuffer("https://mirror.example/manifest.json", { fetchOnce });
    expect(result.statusCode).toBe(304);
    expect(result.body).toBeNull();
  });

  it("rejects a non-2xx/304 status", async () => {
    const fetchOnce = async () => fakeStreamResponse(404, {});
    await expect(fetchBuffer("https://mirror.example/manifest.json", { fetchOnce })).rejects.toThrow(/404/);
  });

  it("returns the buffered body on 200", async () => {
    const fetchOnce = async () => fakeStreamResponse(200, { etag: '"abc"' }, [Buffer.from("hello "), Buffer.from("world")]);
    const result = await fetchBuffer("https://mirror.example/manifest.json", { fetchOnce });
    expect(result.body?.toString("utf8")).toBe("hello world");
    expect(result.headers.etag).toBe('"abc"');
  });

  it("enforces maxBytes and aborts before buffering the whole body", async () => {
    const fetchOnce = async () => fakeStreamResponse(200, {}, [Buffer.alloc(1000, 1)]);
    await expect(fetchBuffer("https://mirror.example/manifest.json", { fetchOnce, maxBytes: 100 })).rejects.toThrow(
      /exceeded 100 bytes/,
    );
  });
});

describe("artifact-ota: downloadToFile", () => {
  it("streams the body to disk", async () => {
    const root = makeTempDir("hana-ota-dl-");
    const destPath = path.join(root, "out", "archive.tar.gz");
    const fetchOnce = async () => fakeStreamResponse(200, {}, [Buffer.from("payload-bytes")]);
    const result = await downloadToFile("https://mirror.example/archive.tar.gz", destPath, { fetchOnce });
    expect(result.statusCode).toBe(200);
    expect(fs.readFileSync(destPath, "utf8")).toBe("payload-bytes");
  });

  it("enforces maxBytes and removes the partial file on overflow", async () => {
    const root = makeTempDir("hana-ota-dl-");
    const destPath = path.join(root, "archive.tar.gz");
    const fetchOnce = async () => fakeStreamResponse(200, {}, [Buffer.alloc(1000, 7)]);
    await expect(
      downloadToFile("https://mirror.example/archive.tar.gz", destPath, { fetchOnce, maxBytes: 100 }),
    ).rejects.toThrow(/exceeded 100 bytes/);
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("rejects a non-2xx status without writing a file", async () => {
    const root = makeTempDir("hana-ota-dl-");
    const destPath = path.join(root, "archive.tar.gz");
    const fetchOnce = async () => fakeStreamResponse(500, {});
    await expect(downloadToFile("https://mirror.example/archive.tar.gz", destPath, { fetchOnce })).rejects.toThrow(/500/);
    expect(fs.existsSync(destPath)).toBe(false);
  });
});

describe("artifact-ota: channelManifestUrls", () => {
  it("returns the AtomGit primary and GitHub fallback in the fixed source order", () => {
    const urls = channelManifestUrls("stable");
    expect(urls[0]).toBe("https://gitcode.com/liliMozi/OpenHanako-Releases/releases/download/channels/stable.json");
    expect(urls[1]).toBe("https://github.com/liliMozi/openhanako/releases/download/channels/stable.json");
  });
});

describe("artifact-ota: isShellVersionSufficient (minShell gate)", () => {
  it("passes when the shell version equals minShell", () => {
    expect(isShellVersionSufficient("1.2.3", "1.2.3")).toBe(true);
  });
  it("passes when the shell version exceeds minShell", () => {
    expect(isShellVersionSufficient("2.0.0", "1.2.3")).toBe(true);
    expect(isShellVersionSufficient("1.3.0", "1.2.9")).toBe(true);
  });
  it("blocks when the shell version is below minShell", () => {
    expect(isShellVersionSufficient("1.2.2", "1.2.3")).toBe(false);
    expect(isShellVersionSufficient("0.9.9", "1.0.0")).toBe(false);
  });
  it("blocks (conservative default) when either version is unparseable", () => {
    expect(isShellVersionSufficient("not-a-version", "1.0.0")).toBe(false);
    expect(isShellVersionSufficient("1.0.0", "not-a-version")).toBe(false);
  });
});

describe("artifact-ota: rollout bucketing", () => {
  it("is deterministic for a fixed rolloutId + salt", () => {
    const a = computeRolloutBucket("fixed-uuid", "salt-1");
    const b = computeRolloutBucket("fixed-uuid", "salt-1");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });
  it("changes with a different salt (not a constant)", () => {
    const a = computeRolloutBucket("fixed-uuid", "salt-1");
    const b = computeRolloutBucket("fixed-uuid", "salt-2");
    // Not strictly guaranteed to differ for every pair, but true for this
    // fixed pair — pinning the exact expectation catches accidental
    // algorithm changes.
    expect(a === b).toBe(false);
  });
  it("percent=100 always includes, percent=0 always excludes, regardless of bucket", () => {
    expect(isInRolloutBucket({ rolloutId: "any", salt: "s", percent: 100 })).toBe(true);
    expect(isInRolloutBucket({ rolloutId: "any", salt: "s", percent: 0 })).toBe(false);
  });
});

describe("artifact-ota: ensureRolloutId", () => {
  it("generates and persists a UUID on first use, returns the same one afterward", async () => {
    const root = makeTempDir("hana-ota-rollout-");
    const homeDir = path.join(root, "home");
    const first = await ensureRolloutId(homeDir);
    const second = await ensureRolloutId(homeDir);
    expect(first).toBe(second);
    expect(fs.existsSync(path.join(homeDir, "artifacts", "rollout-id"))).toBe(true);
  });
});

describe("artifact-ota: ota-state.json bookkeeping", () => {
  it("round-trips a channel state patch and merges subsequent patches", async () => {
    const root = makeTempDir("hana-ota-state-");
    const homeDir = path.join(root, "home");
    expect(await readOtaState(homeDir)).toEqual({});
    await writeOtaChannelState(homeDir, "stable", { etag: "abc", lastError: null });
    await writeOtaChannelState(homeDir, "stable", { lastCheckedAt: "2026-07-11T00:00:00.000Z" });
    const state = await readOtaState(homeDir);
    expect(state.stable).toEqual({ etag: "abc", lastError: null, lastCheckedAt: "2026-07-11T00:00:00.000Z" });
  });
});

describe("artifact-ota: dev-bypass module (real + prod stub)", () => {
  afterEach(() => {
    delete process.env.HANA_ARTIFACT_MANIFEST;
  });
  it("real module reads HANA_ARTIFACT_MANIFEST", () => {
    expect(devBypass.hasDevOverride()).toBe(false);
    process.env.HANA_ARTIFACT_MANIFEST = "/tmp/whatever.json";
    expect(devBypass.hasDevOverride()).toBe(true);
    expect(devBypass.resolveDevManifestOverride()).toBe("/tmp/whatever.json");
  });
  it("production stub always returns null/false, ignoring the env var", () => {
    process.env.HANA_ARTIFACT_MANIFEST = "/tmp/whatever.json";
    expect(prodStub.hasDevOverride()).toBe(false);
    expect(prodStub.resolveDevManifestOverride()).toBeNull();
  });
  it("hasDevOverrideConfigured (as re-exported by artifact-ota.cjs) tracks the real module", () => {
    expect(hasDevOverrideConfigured()).toBe(false);
    process.env.HANA_ARTIFACT_MANIFEST = "/tmp/whatever.json";
    expect(hasDevOverrideConfigured()).toBe(true);
  });
});

// ── full-chain integration: fetch(dev-bypass local fixture) -> verify ->
//    stage -> activate -> next pointers ────────────────────────────────────

describe("artifact-ota: checkAndDownloadOnce (local fixture, full chain)", () => {
  it("stages both archives and writes both next pointers on a clean first run", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath, manifest } = await makeOtaFixture(root, keys, { train: 1 });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkAndDownloadOnce({
        homeDir,
        keyset: keys.keyset,
        currentShellVersion: SHELL_VERSION,
        platformArch: PLATFORM_ARCH,
        log: () => {},
      }),
    );

    expect(result.outcome).toBe("staged");
    expect(result.train).toBe(1);

    const serverNext = await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next");
    expect(serverNext).not.toBeNull();
    expect(serverNext.train).toBe(1);
    expect(serverNext.kind).toBe("server");
    expect(fs.existsSync(path.join(serverNext.versionDir, "bundle", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(serverNext.versionDir, ".verified"))).toBe(true);

    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    const rendererNext = await pointerStore.readPointer(homeDir, rendererChannel, "next");
    expect(rendererNext).not.toBeNull();
    expect(rendererNext.train).toBe(1);
    expect(rendererNext.kind).toBe("renderer");
    expect(fs.existsSync(path.join(rendererNext.versionDir, "index.html"))).toBe(true);

    // Staging is cleaned up after a successful cycle.
    const stagingDir = path.join(homeDir, "artifacts", "staging");
    const leftovers = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : [];
    expect(leftovers).toEqual([]);

    void manifest; // fixture manifest inspected via the assertions above
  });

  it("rejects a non-monotonic train and writes no next pointers (mutation-check target)", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 3 });
    const homeDir = path.join(root, "home");
    // Pre-seed a `current` pointer at train 5 — the fixture's train 3 must
    // be rejected as stale by the anti-rollback check.
    await pointerStore.writePointer(homeDir, SEED_CHANNEL, "current", { train: 5, kind: "server" });

    const result = await runWithDevOverride(manifestPath, () =>
      checkAndDownloadOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/train/i);
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
  });

  it("skips (does not download) when the shell is below minShell", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, minShell: "99.0.0" });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkAndDownloadOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("minshell-blocked");
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    const stagingDir = path.join(homeDir, "artifacts", "staging");
    expect(fs.existsSync(stagingDir)).toBe(false);
  });

  it("excludes via rollout percent 0", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, rolloutPercent: 0 });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkAndDownloadOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("rollout-excluded");
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
  });

  it("short-circuits a quarantined train", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 7 });
    const homeDir = path.join(root, "home");
    await pointerStore.appendQuarantine(homeDir, { channel: SEED_CHANNEL, train: 7, reason: "test" });

    const result = await runWithDevOverride(manifestPath, () =>
      checkAndDownloadOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("quarantined");
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
  });

  it("skips the whole cycle when another instance holds the artifacts lock", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1 });
    const homeDir = path.join(root, "home");
    const lock = await pointerStore.acquireLock(homeDir);
    expect(lock).not.toBeNull();

    try {
      const result = await runWithDevOverride(manifestPath, () =>
        checkAndDownloadOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
      );
      expect(result.outcome).toBe("locked");
      expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    } finally {
      await lock!.release();
    }
  });

  it("hard-errors when the manifest is missing the renderer kind", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, omitRenderer: true });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkAndDownloadOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/renderer/i);
  });

  it("rejects a tampered manifest signature", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1 });
    const sig = fs.readFileSync(`${manifestPath}.sig`);
    sig[0] ^= 0xff;
    fs.writeFileSync(`${manifestPath}.sig`, sig);
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkAndDownloadOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/signature/i);
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
  });

  it("both-or-neither: rolls back the server next pointer when renderer activation fails after staging succeeded", async () => {
    const root = makeTempDir("hana-ota-e2e-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, corruptRendererArchive: true });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkAndDownloadOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );

    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/renderer activation failed/i);
    // The critical assertion: server's next pointer must NOT survive a
    // renderer activation failure, even though activateFromArchive(server)
    // itself succeeded and wrote it moments earlier.
    expect(await pointerStore.readPointer(homeDir, SEED_CHANNEL, "next")).toBeNull();
    const rendererChannel = artifactBoot.rendererPointerChannel(SEED_CHANNEL);
    expect(await pointerStore.readPointer(homeDir, rendererChannel, "next")).toBeNull();
  });
});

describe("artifact-ota: bothNextPointersReady (apply-now precondition guard, mutation-check target)", () => {
  const { bothNextPointersReady } = ota;

  it("is false when either pointer is missing", () => {
    expect(bothNextPointersReady({ serverNext: null, rendererNext: { train: 1 } })).toBe(false);
    expect(bothNextPointersReady({ serverNext: { train: 1 }, rendererNext: null })).toBe(false);
    expect(bothNextPointersReady({ serverNext: null, rendererNext: null })).toBe(false);
  });

  it("is false when either train is not an integer", () => {
    expect(bothNextPointersReady({ serverNext: { train: "1" }, rendererNext: { train: 1 } })).toBe(false);
    expect(bothNextPointersReady({ serverNext: { train: 1 }, rendererNext: { train: undefined } })).toBe(false);
    expect(bothNextPointersReady({ serverNext: { train: NaN }, rendererNext: { train: 1 } })).toBe(false);
  });

  it("is false when the two trains disagree (partial/torn staging)", () => {
    expect(bothNextPointersReady({ serverNext: { train: 2 }, rendererNext: { train: 1 } })).toBe(false);
  });

  it("is true only when both pointers exist and agree on the same train", () => {
    expect(bothNextPointersReady({ serverNext: { train: 5 }, rendererNext: { train: 5 } })).toBe(true);
  });
});

describe("artifact-ota: resolveStagedTrainStatus", () => {
  const { resolveStagedTrainStatus } = ota;

  it("reports not-staged with null fields when pointers disagree", () => {
    expect(resolveStagedTrainStatus({ serverNext: null, rendererNext: null })).toEqual({
      staged: false,
      train: null,
      version: null,
    });
  });

  it("reports staged with the train number and renderer's product version", () => {
    expect(resolveStagedTrainStatus({
      serverNext: { train: 3, version: "0.400.0" },
      rendererNext: { train: 3, version: "0.400.0" },
    })).toEqual({ staged: true, train: 3, version: "0.400.0" });
  });

  it("falls back to the server version if the renderer pointer somehow lacks one", () => {
    expect(resolveStagedTrainStatus({
      serverNext: { train: 3, version: "0.400.0" },
      rendererNext: { train: 3 },
    })).toEqual({ staged: true, train: 3, version: "0.400.0" });
  });
});

describe("artifact-ota: readStagedTrainStatus (filesystem integration)", () => {
  const { readStagedTrainStatus } = ota;

  it("reports not staged when no next pointers exist", async () => {
    const root = makeTempDir("hana-ota-staged-status-");
    const homeDir = path.join(root, "home");
    const status = await readStagedTrainStatus(homeDir, { channel: SEED_CHANNEL });
    expect(status).toEqual({ staged: false, train: null, version: null, minShellBlocked: false });
  });

  it("reports staged after checkAndDownloadOnce writes both next pointers", async () => {
    const root = makeTempDir("hana-ota-staged-status-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 7, version: "0.500.0" });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkAndDownloadOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );
    expect(result.outcome).toBe("staged");

    const status = await readStagedTrainStatus(homeDir, { channel: SEED_CHANNEL });
    expect(status).toEqual({ staged: true, train: 7, version: "0.500.0", minShellBlocked: false });
  });

  it("reports minShellBlocked after a minShell-gated cycle, without staging anything", async () => {
    const root = makeTempDir("hana-ota-staged-status-");
    const keys = makeKeys();
    const { manifestPath } = await makeOtaFixture(root, keys, { train: 1, minShell: "99.0.0" });
    const homeDir = path.join(root, "home");

    const result = await runWithDevOverride(manifestPath, () =>
      checkAndDownloadOnce({ homeDir, keyset: keys.keyset, currentShellVersion: SHELL_VERSION, platformArch: PLATFORM_ARCH, log: () => {} }),
    );
    expect(result.outcome).toBe("minshell-blocked");

    const status = await readStagedTrainStatus(homeDir, { channel: SEED_CHANNEL });
    expect(status.staged).toBe(false);
    expect(status.minShellBlocked).toBe(true);
  });
});
