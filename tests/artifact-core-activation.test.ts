import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import zlib from "zlib";
import { afterEach, describe, expect, it } from "vitest";

import ustarModule from "../shared/artifact-core/ustar.cjs";
import pointerStoreModule from "../shared/artifact-core/pointer-store.cjs";
import activationModule from "../shared/artifact-core/activation.cjs";

const { packTree } = ustarModule as {
  packTree: (srcDir: string, archivePath: string) => Promise<void>;
};
const { writePointer, readPointer, appendQuarantine, clearPointer, pointerPath } = pointerStoreModule as {
  writePointer: (homeDir: string, channel: string, slot: string, value: any) => Promise<void>;
  readPointer: (homeDir: string, channel: string, slot: string) => Promise<any>;
  appendQuarantine: (homeDir: string, entry: any) => Promise<any[]>;
  clearPointer: (homeDir: string, channel: string, slot: string) => Promise<void>;
  pointerPath: (homeDir: string, channel: string, slot: string) => string;
};
const {
  activateFromArchive,
  resolveBoot,
  writeSentinel,
  clearSentinel,
  consecutiveFailures,
  sha256File,
  renameWithBusyRetry,
} = activationModule as {
  activateFromArchive: (archivePath: string, manifest: any, opts: any) => Promise<any>;
  resolveBoot: (channel: string, homeDir: string) => Promise<{ slot: string; pointer: any } | null>;
  writeSentinel: (homeDir: string, channel: string, train: number) => Promise<any>;
  clearSentinel: (homeDir: string, channel: string) => Promise<void>;
  consecutiveFailures: (homeDir: string, channel: string) => Promise<number>;
  sha256File: (filePath: string) => Promise<string>;
  renameWithBusyRetry: (
    from: string,
    to: string,
    opts?: { rename?: (from: string, to: string) => Promise<void>; sleep?: (ms: number) => Promise<void>; platform?: string },
  ) => Promise<void>;
};

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

async function makeServerArchiveFixture(root: string) {
  const srcDir = path.join(root, "server-src");
  await fsp.mkdir(srcDir, { recursive: true });
  await fsp.writeFile(path.join(srcDir, "hana-server.js"), "console.log('hi');\n");
  const archivePath = path.join(root, "server-1.0.0-darwin-arm64.tar.gz");
  await packTree(srcDir, archivePath);
  return archivePath;
}

function manifestFor(sha256: string, train = 1) {
  // Server artifact version is tied to `train` so distinct activations land
  // in distinct versionDirs (`<version>-<platformArch>`) — collapsing them
  // to the same directory would make one activation's `.verified` receipt
  // clobber another's, which is exactly the kind of bug resolveBoot's
  // fallback chain exists to be tested against.
  const serverVersion = `1.0.${train}`;
  return {
    schema: 1,
    train,
    channel: "stable",
    releasedAt: "2026-08-01T12:00:00Z",
    keyId: "2026a",
    minShell: "1.0.0",
    contract: { preload: 1, serverProtocol: 1 },
    urgent: false,
    rollout: { percent: 100, salt: "x" },
    artifacts: {
      renderer: {
        version: "1.0.0",
        sha256: "c".repeat(64),
        size: 1,
        path: "renderer-1.0.0.tar.gz",
      },
      server: {
        "darwin-arm64": {
          version: serverVersion,
          sha256,
          size: 1,
          path: `server-${serverVersion}-darwin-arm64.tar.gz`,
        },
      },
    },
    mirrors: [],
  };
}

/**
 * Fixture variant for the directory-protection tests below: version is an
 * explicit parameter (not derived from `train`) so multiple activations
 * can be forced to target the exact same versionDir, and the packed
 * file's content carries a marker string so tests can tell "original
 * content survived untouched" apart from "content got replaced".
 */
async function makeServerArchiveFixtureWithMarker(root: string, marker: string, version: string) {
  const srcDir = path.join(root, `server-src-${marker}-${version}`);
  await fsp.mkdir(srcDir, { recursive: true });
  await fsp.writeFile(path.join(srcDir, "hana-server.js"), `console.log(${JSON.stringify(marker)});\n`);
  const archivePath = path.join(root, `server-${version}-${marker}.tar.gz`);
  await packTree(srcDir, archivePath);
  return archivePath;
}

/**
 * A valid gzip stream wrapping content that isn't a ustar archive. sha256
 * is computed from this exact file after writing it, so the manifest's
 * sha256 check at the top of `activateFromArchive` passes — the failure
 * only surfaces inside `ustar.extract` once real extraction is attempted,
 * which is exactly the "extraction fails after everything up to that
 * point already succeeded" case the tmp+swap tests need.
 */
async function makeCorruptServerArchive(root: string, version: string) {
  const archivePath = path.join(root, `server-${version}-corrupt.tar.gz`);
  await fsp.writeFile(archivePath, zlib.gzipSync(Buffer.from("not a valid ustar archive\n")));
  return archivePath;
}

function manifestForVersion(sha256: string, train: number, version: string) {
  return {
    schema: 1,
    train,
    channel: "stable",
    releasedAt: "2026-08-01T12:00:00Z",
    keyId: "2026a",
    minShell: "1.0.0",
    contract: { preload: 1, serverProtocol: 1 },
    urgent: false,
    rollout: { percent: 100, salt: "x" },
    artifacts: {
      renderer: {
        version: "1.0.0",
        sha256: "c".repeat(64),
        size: 1,
        path: "renderer-1.0.0.tar.gz",
      },
      server: {
        "darwin-arm64": {
          version,
          sha256,
          size: 1,
          path: `server-${version}-darwin-arm64.tar.gz`,
        },
      },
    },
    mirrors: [],
  };
}

function serverKindRoot(homeDir: string) {
  return path.join(homeDir, "artifacts", "server");
}

describe("activation: activateFromArchive", () => {
  it("verifies sha256, extracts, writes .verified receipt and the next pointer", async () => {
    const root = makeTempDir("hana-activation-");
    const homeDir = path.join(root, "home");
    const archivePath = await makeServerArchiveFixture(root);
    const sha256 = await sha256File(archivePath);
    const manifest = manifestFor(sha256, 7);

    const pointerValue = await activateFromArchive(archivePath, manifest, {
      homeDir,
      channel: "stable",
      kind: "server",
      platformArch: "darwin-arm64",
    });

    expect(pointerValue.train).toBe(7);
    expect(pointerValue.sha256).toBe(sha256);
    expect(fs.existsSync(path.join(pointerValue.versionDir, "hana-server.js"))).toBe(true);
    expect(fs.existsSync(path.join(pointerValue.versionDir, ".verified"))).toBe(true);

    const nextPointer = await readPointer(homeDir, "stable", "next");
    expect(nextPointer).toEqual(pointerValue);
  });

  it("rejects a sha256 mismatch and does not write a next pointer", async () => {
    const root = makeTempDir("hana-activation-badsha-");
    const homeDir = path.join(root, "home");
    const archivePath = await makeServerArchiveFixture(root);
    const manifest = manifestFor("f".repeat(64), 8); // wrong sha256

    await expect(
      activateFromArchive(archivePath, manifest, {
        homeDir,
        channel: "stable",
        kind: "server",
        platformArch: "darwin-arm64",
      }),
    ).rejects.toThrow(/sha256 mismatch/i);

    expect(await readPointer(homeDir, "stable", "next")).toBeNull();
  });

  it("short-circuits on a quarantined train: no extraction, no pointer write", async () => {
    const root = makeTempDir("hana-activation-quarantine-");
    const homeDir = path.join(root, "home");
    const archivePath = await makeServerArchiveFixture(root);
    const sha256 = await sha256File(archivePath);
    const manifest = manifestFor(sha256, 9);

    await appendQuarantine(homeDir, { channel: "stable", train: 9, reason: "test" });

    await expect(
      activateFromArchive(archivePath, manifest, {
        homeDir,
        channel: "stable",
        kind: "server",
        platformArch: "darwin-arm64",
      }),
    ).rejects.toThrow(/quarantined/i);

    expect(await readPointer(homeDir, "stable", "next")).toBeNull();
    const serverRoot = path.join(homeDir, "artifacts", "server");
    expect(fs.existsSync(serverRoot)).toBe(false);
  });
});

describe("activation: activateFromArchive — directory protection & atomic swap", () => {
  it("target directory absent: extracts via a tmp dir and leaves no tmp residue behind", async () => {
    const root = makeTempDir("hana-activation-normal-");
    const homeDir = path.join(root, "home");
    const version = "9.0.1";
    const archivePath = await makeServerArchiveFixtureWithMarker(root, "normal", version);
    const sha256 = await sha256File(archivePath);
    const manifest = manifestForVersion(sha256, 21, version);

    const pointerValue = await activateFromArchive(archivePath, manifest, {
      homeDir,
      channel: "stable",
      kind: "server",
      platformArch: "darwin-arm64",
    });

    expect(fs.existsSync(pointerValue.versionDir)).toBe(true);
    expect(fs.readFileSync(path.join(pointerValue.versionDir, "hana-server.js"), "utf8")).toContain("normal");
    expect(fs.readdirSync(serverKindRoot(homeDir))).toEqual([`${version}-darwin-arm64`]);
  });

  it("extraction failure against an existing but unprotected target: final directory is left exactly as it was, no tmp residue", async () => {
    const root = makeTempDir("hana-activation-extractfail-");
    const homeDir = path.join(root, "home");
    const version = "9.0.2";

    const goodArchive = await makeServerArchiveFixtureWithMarker(root, "original", version);
    const goodSha = await sha256File(goodArchive);
    const first = await activateFromArchive(goodArchive, manifestForVersion(goodSha, 30, version), {
      homeDir,
      channel: "stable",
      kind: "server",
      platformArch: "darwin-arm64",
    });
    // Clear the `next` pointer activation just wrote so this directory is
    // no longer referenced by anything — the second call below must take
    // the "existing but unprotected" branch, not the protection check.
    await clearPointer(homeDir, "stable", "next");

    const corruptArchive = await makeCorruptServerArchive(root, version);
    const corruptSha = await sha256File(corruptArchive);

    await expect(
      activateFromArchive(corruptArchive, manifestForVersion(corruptSha, 31, version), {
        homeDir,
        channel: "stable",
        kind: "server",
        platformArch: "darwin-arm64",
      }),
    ).rejects.toThrow(/ustar:/i);

    expect(fs.readFileSync(path.join(first.versionDir, "hana-server.js"), "utf8")).toContain("original");
    expect(fs.readdirSync(serverKindRoot(homeDir))).toEqual([`${version}-darwin-arm64`]);
    expect(await readPointer(homeDir, "stable", "next")).toBeNull();
  });

  it("claims a directory a pointer already references when the incoming sha256 matches: no rm, rename, or re-extraction", async () => {
    const root = makeTempDir("hana-activation-claim-");
    const homeDir = path.join(root, "home");
    const version = "9.0.3";

    const archivePath = await makeServerArchiveFixtureWithMarker(root, "claimed", version);
    const sha256 = await sha256File(archivePath);
    const first = await activateFromArchive(archivePath, manifestForVersion(sha256, 40, version), {
      homeDir,
      channel: "stable",
      kind: "server",
      platformArch: "darwin-arm64",
    });
    // Simulate promotion: this directory is now the live "current" pointer.
    await writePointer(homeDir, "stable", "current", first);

    // A marker file that is NOT part of the packed archive. If the claim
    // path did any rm/rename/re-extraction of the directory, this file
    // could not survive — the whole directory would have been replaced.
    const markerPath = path.join(first.versionDir, "external-marker.txt");
    fs.writeFileSync(markerPath, "should-survive-claim");

    // Same bytes, re-announced under a new train number (the update train
    // got re-broadcast, or a rollback re-announced this exact version).
    const second = await activateFromArchive(archivePath, manifestForVersion(sha256, 41, version), {
      homeDir,
      channel: "stable",
      kind: "server",
      platformArch: "darwin-arm64",
    });

    expect(second.versionDir).toBe(first.versionDir);
    expect(second.train).toBe(41);
    expect(second.sha256).toBe(sha256);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(markerPath, "utf8")).toBe("should-survive-claim");
    expect(fs.readdirSync(serverKindRoot(homeDir))).toEqual([`${version}-darwin-arm64`]); // no tmp/old dirs created

    expect(await readPointer(homeDir, "stable", "next")).toEqual(second);
  });

  it("refuses to replace a directory a pointer references when the incoming sha256 does not match", async () => {
    const root = makeTempDir("hana-activation-reject-");
    const homeDir = path.join(root, "home");
    const version = "9.0.4";

    const firstArchive = await makeServerArchiveFixtureWithMarker(root, "original", version);
    const firstSha = await sha256File(firstArchive);
    const first = await activateFromArchive(firstArchive, manifestForVersion(firstSha, 50, version), {
      homeDir,
      channel: "stable",
      kind: "server",
      platformArch: "darwin-arm64",
    });
    await writePointer(homeDir, "stable", "current", first);

    // Different content, same version string -> same versionedDir, but a
    // different sha256 than what "current" already recorded for it.
    const secondArchive = await makeServerArchiveFixtureWithMarker(root, "different", version);
    const secondSha = await sha256File(secondArchive);

    await expect(
      activateFromArchive(secondArchive, manifestForVersion(secondSha, 51, version), {
        homeDir,
        channel: "stable",
        kind: "server",
        platformArch: "darwin-arm64",
      }),
    ).rejects.toThrow(/refusing to replace/i);

    expect(fs.readFileSync(path.join(first.versionDir, "hana-server.js"), "utf8")).toContain("original");
    expect(fs.readdirSync(serverKindRoot(homeDir))).toEqual([`${version}-darwin-arm64`]); // no tmp residue from the aborted attempt
  });

  it("allowReplaceProtected=true fully replaces a protected directory via tmp+rename, no leftover tmp/old dirs", async () => {
    const root = makeTempDir("hana-activation-allowreplace-");
    const homeDir = path.join(root, "home");
    const version = "9.0.5";

    const firstArchive = await makeServerArchiveFixtureWithMarker(root, "original", version);
    const firstSha = await sha256File(firstArchive);
    const first = await activateFromArchive(firstArchive, manifestForVersion(firstSha, 60, version), {
      homeDir,
      channel: "stable",
      kind: "server",
      platformArch: "darwin-arm64",
    });
    await writePointer(homeDir, "stable", "current", first);
    await writePointer(homeDir, "stable", "previous", first);

    const secondArchive = await makeServerArchiveFixtureWithMarker(root, "replaced", version);
    const secondSha = await sha256File(secondArchive);

    const second = await activateFromArchive(secondArchive, manifestForVersion(secondSha, 61, version), {
      homeDir,
      channel: "stable",
      kind: "server",
      platformArch: "darwin-arm64",
      allowReplaceProtected: true,
    });

    expect(second.versionDir).toBe(first.versionDir);
    expect(second.sha256).toBe(secondSha);
    expect(fs.readFileSync(path.join(second.versionDir, "hana-server.js"), "utf8")).toContain("replaced");
    expect(fs.readdirSync(serverKindRoot(homeDir))).toEqual([`${version}-darwin-arm64`]);
  });

  it("a pointer file that fails to parse is treated conservatively as protected: refuses rather than guessing", async () => {
    const root = makeTempDir("hana-activation-corruptptr-");
    const homeDir = path.join(root, "home");
    const version = "9.0.6";

    const firstArchive = await makeServerArchiveFixtureWithMarker(root, "original", version);
    const firstSha = await sha256File(firstArchive);
    const first = await activateFromArchive(firstArchive, manifestForVersion(firstSha, 70, version), {
      homeDir,
      channel: "stable",
      kind: "server",
      platformArch: "darwin-arm64",
    });
    // No valid pointer references this directory anymore.
    await clearPointer(homeDir, "stable", "next");

    // Corrupt an UNRELATED pointer file (different channel, doesn't
    // reference our target at all). The scan must abort on any unreadable
    // pointer, not just ones that happen to reference our target — an
    // unreadable pointer could be hiding a reference we'd otherwise miss.
    const unrelatedPointerFile = pointerPath(homeDir, "beta", "current");
    await fsp.mkdir(path.dirname(unrelatedPointerFile), { recursive: true });
    await fsp.writeFile(unrelatedPointerFile, "{not valid json");

    const secondArchive = await makeServerArchiveFixtureWithMarker(root, "different", version);
    const secondSha = await sha256File(secondArchive);

    await expect(
      activateFromArchive(secondArchive, manifestForVersion(secondSha, 71, version), {
        homeDir,
        channel: "stable",
        kind: "server",
        platformArch: "darwin-arm64",
      }),
    ).rejects.toThrow(/failed to parse/i);

    expect(fs.readFileSync(path.join(first.versionDir, "hana-server.js"), "utf8")).toContain("original");
  });
});

describe("activation: resolveBoot three-level fallback", () => {
  async function activateVersion(root: string, homeDir: string, train: number) {
    const archivePath = await makeServerArchiveFixture(path.join(root, `v${train}`));
    const sha256 = await sha256File(archivePath);
    const manifest = manifestFor(sha256, train);
    return activateFromArchive(archivePath, manifest, {
      homeDir,
      channel: "stable",
      kind: "server",
      platformArch: "darwin-arm64",
    });
  }

  it("resolves via current when current is valid", async () => {
    const root = makeTempDir("hana-boot-current-");
    const homeDir = path.join(root, "home");
    const pointerValue = await activateVersion(root, homeDir, 1);
    await writePointer(homeDir, "stable", "current", pointerValue);

    const result = await resolveBoot("stable", homeDir);
    expect(result?.slot).toBe("current");
    expect(result?.pointer.train).toBe(1);
  });

  it("falls back to previous when current is missing its .verified receipt", async () => {
    const root = makeTempDir("hana-boot-fallback-");
    const homeDir = path.join(root, "home");

    const previousPointer = await activateVersion(root, homeDir, 1);
    await writePointer(homeDir, "stable", "previous", previousPointer);

    const currentPointer = await activateVersion(root, homeDir, 2);
    await writePointer(homeDir, "stable", "current", currentPointer);
    // Corrupt current's activation: delete its .verified receipt.
    await fsp.unlink(path.join(currentPointer.versionDir, ".verified"));

    const result = await resolveBoot("stable", homeDir);
    expect(result?.slot).toBe("previous");
    expect(result?.pointer.train).toBe(1);
  });

  it("falls back to previous when current's versionDir sha256 no longer matches the receipt", async () => {
    const root = makeTempDir("hana-boot-shamismatch-");
    const homeDir = path.join(root, "home");

    const previousPointer = await activateVersion(root, homeDir, 1);
    await writePointer(homeDir, "stable", "previous", previousPointer);

    const currentPointer = await activateVersion(root, homeDir, 2);
    await writePointer(homeDir, "stable", "current", currentPointer);
    // Tamper with the pointer's recorded sha256 so it no longer matches the receipt on disk.
    await writePointer(homeDir, "stable", "current", { ...currentPointer, sha256: "tampered" });

    const result = await resolveBoot("stable", homeDir);
    expect(result?.slot).toBe("previous");
  });

  it("returns null when neither current nor previous is bootable (caller falls to seed)", async () => {
    const root = makeTempDir("hana-boot-null-");
    const homeDir = path.join(root, "home");
    const result = await resolveBoot("stable", homeDir);
    expect(result).toBeNull();
  });

  it("returns null when both current and previous are invalid", async () => {
    const root = makeTempDir("hana-boot-both-invalid-");
    const homeDir = path.join(root, "home");

    const pointerValue = await activateVersion(root, homeDir, 1);
    await writePointer(homeDir, "stable", "current", { ...pointerValue, sha256: "tampered" });
    await writePointer(homeDir, "stable", "previous", { ...pointerValue, sha256: "also-tampered" });

    const result = await resolveBoot("stable", homeDir);
    expect(result).toBeNull();
  });
});

describe("activation: crash sentinel helpers", () => {
  it("counts consecutive writes for the same train", async () => {
    const homeDir = makeTempDir("hana-sentinel-");
    expect(await consecutiveFailures(homeDir, "stable")).toBe(0);

    await writeSentinel(homeDir, "stable", 5);
    expect(await consecutiveFailures(homeDir, "stable")).toBe(1);

    await writeSentinel(homeDir, "stable", 5);
    await writeSentinel(homeDir, "stable", 5);
    expect(await consecutiveFailures(homeDir, "stable")).toBe(3);
  });

  it("resets the counter when the train changes", async () => {
    const homeDir = makeTempDir("hana-sentinel-reset-");
    await writeSentinel(homeDir, "stable", 5);
    await writeSentinel(homeDir, "stable", 5);
    expect(await consecutiveFailures(homeDir, "stable")).toBe(2);

    await writeSentinel(homeDir, "stable", 6); // new train, healthy boot after an update
    expect(await consecutiveFailures(homeDir, "stable")).toBe(1);
  });

  it("clearSentinel resets the counter to 0", async () => {
    const homeDir = makeTempDir("hana-sentinel-clear-");
    await writeSentinel(homeDir, "stable", 5);
    await clearSentinel(homeDir, "stable");
    expect(await consecutiveFailures(homeDir, "stable")).toBe(0);
  });

  it("sentinels for different channels are independent", async () => {
    const homeDir = makeTempDir("hana-sentinel-channels-");
    await writeSentinel(homeDir, "stable", 5);
    await writeSentinel(homeDir, "beta", 9);
    expect(await consecutiveFailures(homeDir, "stable")).toBe(1);
    expect(await consecutiveFailures(homeDir, "beta")).toBe(1);
    await clearSentinel(homeDir, "beta");
    expect(await consecutiveFailures(homeDir, "stable")).toBe(1);
    expect(await consecutiveFailures(homeDir, "beta")).toBe(0);
  });
});

describe("activation: renameWithBusyRetry", () => {
  function fakeSleep() {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    return { sleep, delays };
  }

  function failNTimesThenSucceed(n: number, code: string) {
    let calls = 0;
    const rename = async (_from: string, _to: string) => {
      calls += 1;
      if (calls <= n) {
        const err: any = new Error(`simulated ${code} on rename attempt ${calls}`);
        err.code = code;
        throw err;
      }
    };
    return { rename, callCount: () => calls };
  }

  it("matrix #1 — non-win32: single call, original error rethrown as-is, zero retries and zero delay", async () => {
    const { sleep, delays } = fakeSleep();
    const { rename, callCount } = failNTimesThenSucceed(Infinity, "EPERM");

    await expect(
      renameWithBusyRetry("/from", "/to", { rename, sleep, platform: "darwin" }),
    ).rejects.toThrow(/simulated EPERM on rename attempt 1/);

    expect(callCount()).toBe(1);
    expect(delays).toEqual([]);
  });

  it("matrix #2 — win32 + retryable code (EBUSY): retries with the default backoff sequence until it succeeds", async () => {
    const { sleep, delays } = fakeSleep();
    const { rename, callCount } = failNTimesThenSucceed(3, "EBUSY");

    await expect(
      renameWithBusyRetry("/from", "/to", { rename, sleep, platform: "win32" }),
    ).resolves.toBeUndefined();

    expect(callCount()).toBe(4); // 3 failures + 1 success
    expect(delays).toEqual([100, 250, 500]);
  });

  it("matrix #3 — win32 but non-retryable code (ENOENT): rethrows immediately, no retry consumed", async () => {
    const { sleep, delays } = fakeSleep();
    const { rename, callCount } = failNTimesThenSucceed(Infinity, "ENOENT");

    await expect(
      renameWithBusyRetry("/from", "/to", { rename, sleep, platform: "win32" }),
    ).rejects.toThrow(/simulated ENOENT on rename attempt 1/);

    expect(callCount()).toBe(1);
    expect(delays).toEqual([]);
  });

  it("matrix #4 — win32, retry budget exhausted: rethrows the last error unmodified after 8 attempts / ~15.9s of backoff", async () => {
    const { sleep, delays } = fakeSleep();
    const { rename, callCount } = failNTimesThenSucceed(Infinity, "EPERM");

    await expect(
      renameWithBusyRetry("/from", "/to", { rename, sleep, platform: "win32" }),
    ).rejects.toThrow(/simulated EPERM on rename attempt 8/);

    expect(callCount()).toBe(8);
    expect(delays).toEqual([100, 250, 500, 1000, 2000, 4000, 8000]);
    expect(delays.reduce((a, b) => a + b, 0)).toBe(15850);
  });

  it("matrix #5 — no module-level mutable state: two independent calls do not share retry/backoff progress", async () => {
    const first = failNTimesThenSucceed(2, "EACCES");
    const second = failNTimesThenSucceed(2, "EACCES");
    const firstSleep = fakeSleep();
    const secondSleep = fakeSleep();

    // Run two retrying activations "concurrently" — if attempt count or
    // backoff position lived on the module instead of in each call's own
    // closure, interleaving would corrupt one or both sequences.
    await Promise.all([
      renameWithBusyRetry("/from-1", "/to-1", { rename: first.rename, sleep: firstSleep.sleep, platform: "win32" }),
      renameWithBusyRetry("/from-2", "/to-2", { rename: second.rename, sleep: secondSleep.sleep, platform: "win32" }),
    ]);

    expect(first.callCount()).toBe(3);
    expect(second.callCount()).toBe(3);
    expect(firstSleep.delays).toEqual([100, 250]);
    expect(secondSleep.delays).toEqual([100, 250]);

    // A prior call's failures must not leak into a fresh call's attempt
    // counter: a brand-new call still gets the full default budget.
    const third = failNTimesThenSucceed(Infinity, "EPERM");
    const thirdSleep = fakeSleep();
    await expect(
      renameWithBusyRetry("/from-3", "/to-3", { rename: third.rename, sleep: thirdSleep.sleep, platform: "win32" }),
    ).rejects.toThrow(/simulated EPERM on rename attempt 8/);
    expect(third.callCount()).toBe(8);
  });
});
