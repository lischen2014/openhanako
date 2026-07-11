"use strict";

/**
 * shared/artifact-core/activation.cjs
 *
 * Archive activation + boot resolution + crash-sentinel primitives for
 * signed runtime artifacts.
 *
 * `activateFromArchive` is the sole path by which a downloaded (or seed)
 * archive becomes a bootable version: quarantine short-circuit -> sha256
 * verify -> extract -> `.verified` receipt -> `next` pointer write. Boot
 * itself never re-hashes trees; it trusts the `.verified` receipt plus
 * the pointer's own signed-manifest provenance (`resolveBoot`).
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const ustar = require("./ustar.cjs");
const pointerStore = require("./pointer-store.cjs");

/**
 * @param {string} filePath
 * @returns {Promise<string>} lowercase hex sha256
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function selectArtifactEntry(manifest, kind, platformArch) {
  if (kind === "renderer") return manifest.artifacts && manifest.artifacts.renderer;
  if (kind === "server") {
    return manifest.artifacts && manifest.artifacts.server && manifest.artifacts.server[platformArch];
  }
  return undefined;
}

function versionDirName(kind, artifactEntry, platformArch) {
  return kind === "renderer" ? artifactEntry.version : `${artifactEntry.version}-${platformArch}`;
}

/**
 * Activates a downloaded/seed archive: verifies its sha256 against the
 * manifest's artifact entry, extracts it into a fresh versioned directory
 * under `{homeDir}/artifacts/{kind}/...`, writes a `.verified` receipt,
 * and atomically writes the channel's `next` pointer. Does NOT touch
 * `current`/`previous` — promotion to `current` happens at boot
 * (`pointer-store.promote`), never mid-session: running sessions are not
 * hot-swapped.
 *
 * Short-circuits (throws immediately, no filesystem work) if
 * `manifest.train` is already quarantined on this channel.
 *
 * @param {string} archivePath - downloaded/seed `.tar.gz`
 * @param {object} manifest - already schema+signature-verified manifest
 * @param {{homeDir: string, channel: string, kind: "renderer"|"server", platformArch?: string}} opts
 * @returns {Promise<object>} the pointer value written to `next`
 */
async function activateFromArchive(archivePath, manifest, opts) {
  const { homeDir, channel, kind } = opts || {};
  if (!homeDir) throw new Error("activateFromArchive: opts.homeDir is required");
  if (!channel) throw new Error("activateFromArchive: opts.channel is required");
  if (kind !== "renderer" && kind !== "server") {
    throw new Error(`activateFromArchive: unsupported kind ${JSON.stringify(kind)}`);
  }
  if (kind === "server" && !opts.platformArch) {
    throw new Error("activateFromArchive: opts.platformArch is required for kind 'server'");
  }

  if (await pointerStore.isQuarantined(homeDir, channel, manifest.train)) {
    throw new Error(
      `activateFromArchive: train ${manifest.train} on channel ${JSON.stringify(channel)} is quarantined; refusing to activate`,
    );
  }

  const artifactEntry = selectArtifactEntry(manifest, kind, opts.platformArch);
  if (!artifactEntry) {
    throw new Error(
      `activateFromArchive: manifest has no ${kind} artifact entry${opts.platformArch ? ` for ${opts.platformArch}` : ""}`,
    );
  }

  const actualSha256 = await sha256File(archivePath);
  if (actualSha256 !== artifactEntry.sha256) {
    throw new Error(
      `activateFromArchive: sha256 mismatch for ${kind} artifact (expected ${artifactEntry.sha256}, got ${actualSha256})`,
    );
  }

  const dirName = versionDirName(kind, artifactEntry, opts.platformArch);
  const kindRoot = path.join(pointerStore.artifactsRoot(homeDir), kind);
  const versionedDir = path.join(kindRoot, dirName);

  // Clean slate: never let a stale/partial prior attempt masquerade as
  // this activation. On failure below, remove what we started so a
  // half-extracted tree can never be mistaken for a valid version.
  await fsp.rm(versionedDir, { recursive: true, force: true });
  try {
    await ustar.extract(archivePath, versionedDir);
  } catch (err) {
    await fsp.rm(versionedDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const activatedAt = new Date().toISOString();
  const receipt = {
    sha256: actualSha256,
    train: manifest.train,
    version: artifactEntry.version,
    activatedAt,
  };
  await pointerStore.atomicWriteJson(path.join(versionedDir, ".verified"), receipt);

  const pointerValue = {
    train: manifest.train,
    channel,
    kind,
    version: artifactEntry.version,
    platformArch: opts.platformArch || null,
    versionDir: versionedDir,
    sha256: actualSha256,
    activatedAt,
  };
  await pointerStore.writePointer(homeDir, channel, "next", pointerValue);

  return pointerValue;
}

async function isPointerActivationValid(pointer) {
  if (!pointer || !pointer.versionDir) return false;
  let receipt;
  try {
    receipt = JSON.parse(await fsp.readFile(path.join(pointer.versionDir, ".verified"), "utf8"));
  } catch {
    return false;
  }
  if (receipt.sha256 !== pointer.sha256) return false;
  try {
    const stat = await fsp.stat(pointer.versionDir);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Boot-time resolution: `current` -> `previous` -> `null`. A slot
 * is valid only if its `.verified` receipt exists and its recorded
 * sha256 matches the pointer's own sha256, and the versioned directory
 * still exists. Returns `null` when no slot is bootable, at which point
 * the caller falls back to first-run seed extraction.
 * @param {string} channel
 * @param {string} homeDir
 * @returns {Promise<{slot: "current"|"previous", pointer: object}|null>}
 */
async function resolveBoot(channel, homeDir) {
  for (const slot of ["current", "previous"]) {
    const pointer = await pointerStore.readPointer(homeDir, channel, slot);
    if (!pointer) continue;
    if (await isPointerActivationValid(pointer)) {
      return { slot, pointer };
    }
  }
  return null;
}

// ---- crash sentinel --------------------------------------------------------

function sentinelPath(homeDir, channel) {
  return path.join(pointerStore.artifactsRoot(homeDir), `${channel}.sentinel.json`);
}

/**
 * Boot writes a sentinel for the train it's about to run. Consecutive
 * writes for the SAME train increment a counter; a boot for a different
 * train (or a fresh channel) resets it to 1. Pair with `clearSentinel`
 * once the boot is confirmed healthy; a healthy 60-second window clears it.
 * @param {string} homeDir
 * @param {string} channel
 * @param {number} train
 * @returns {Promise<{train: number, counter: number, writtenAt: string}>}
 */
async function writeSentinel(homeDir, channel, train) {
  const filePath = sentinelPath(homeDir, channel);
  let counter = 0;
  try {
    const existing = JSON.parse(await fsp.readFile(filePath, "utf8"));
    if (existing.train === train) counter = existing.counter || 0;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const value = { train, counter: counter + 1, writtenAt: new Date().toISOString() };
  await pointerStore.atomicWriteJson(filePath, value);
  return value;
}

/**
 * @param {string} homeDir
 * @param {string} channel
 */
async function clearSentinel(homeDir, channel) {
  try {
    await fsp.unlink(sentinelPath(homeDir, channel));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

/**
 * @param {string} homeDir
 * @param {string} channel
 * @returns {Promise<number>} 0 if no sentinel is on disk
 */
async function consecutiveFailures(homeDir, channel) {
  try {
    const value = JSON.parse(await fsp.readFile(sentinelPath(homeDir, channel), "utf8"));
    return value.counter || 0;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

module.exports = {
  sha256File,
  activateFromArchive,
  resolveBoot,
  writeSentinel,
  clearSentinel,
  consecutiveFailures,
};
