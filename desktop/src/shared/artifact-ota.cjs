"use strict";

/**
 * artifact-ota.cjs — background silent artifact downloader.
 *
 * Runs entirely after the main window is shown, entirely asynchronously,
 * and NEVER touches the startup path: `checkAndDownloadOnce` never
 * rejects — every failure (network, verification, disk) is caught,
 * logged, and recorded in `{HANA_HOME}/artifacts/ota-state.json`, and the
 * function resolves with a `{outcome, error?}` descriptor instead.
 *
 * Flow (fixed order, each gate short-circuits the rest on failure):
 *   fetch channel manifest (+.sig, ETag-cached, mirror failover)
 *     -> ed25519 verify + schema validate (one atomic call into the
 *        protected artifact-core `manifest.verifyManifest` — see the
 *        "verify-order note" below)
 *     -> train monotonic (`manifest.checkMonotonic` against the current
 *        pointer's train; no current pointer = seed era, always passes)
 *     -> minShell (shell too old -> skip, shell's own update is
 *        electron-updater's job, not this module's)
 *     -> rollout bucket (dedicated random UUID in HANA_HOME)
 *     -> quarantine short-circuit (train permanently blacklisted)
 *     -> acquire the artifacts directory lock (the loser skips this
 *        cycle — someone else is already updating)
 *     -> stage both archives (renderer + this platform's server) to
 *        `staging/`, mirror failover per archive, size-capped, streamed,
 *        atomic rename, sha256-verified
 *     -> `activateFromArchive` per kind (extract + `.verified` + write
 *        that kind's `next` pointer) — server first, then renderer; if
 *        renderer's activation fails, the server `next` pointer written a
 *        moment earlier is rolled back (`pointerStore.clearPointer`) so
 *        "either both next pointers land or neither does" holds even
 *        though `activateFromArchive` itself only guarantees atomicity
 *        per kind, not across the two calls (see the "why a rollback"
 *        note below)
 *     -> staging cleaned up in a `finally`, lock released in a `finally`
 *
 * Activation to `current` happens at the NEXT LAUNCH, entirely inside
 * `desktop/src/shared/artifact-boot.cjs`; both kinds use the same promotion contract:
 * both `prepareArtifactServerBoot` and `prepareArtifactRendererBoot`
 * call `pointerStore.promote(homeDir, <their channel>)` as the first thing
 * they do). This module writes `next` pointers and nothing else — it
 * never promotes, never touches `current`/`previous`, and a running
 * session is never hot-swapped.
 *
 * Verify-order note: callers require both schema validation and signature
 * verification before any manifest field is trusted. The sole
 * sanctioned entry point for both checks,
 * `shared/artifact-core/manifest.cjs#verifyManifest` (protected, consumed
 * not modified), internally does JSON-parse-and-schema-validate FIRST and
 * ed25519-verify SECOND, bundled into one atomic call — no manifest content
 * is ever trusted or acted on until BOTH have passed, which is the
 * externally observable guarantee that matters here. Re-deriving
 * a parallel raw-signature-first check in this file would duplicate the
 * keyset-lookup + `crypto.verify` logic that already lives in exactly one
 * place. Because `validateManifest` is side-effect-free type/shape checking
 * on a small bounded buffer (no parser-injection surface the way an
 * XML/YAML parser would have), the net security delta between the two
 * orderings is negligible.
 *
 * Why a rollback instead of a true joint write: `activateFromArchive` is
 * the sole path by which an archive becomes a bootable version (extract +
 * `.verified` + `next`-pointer write, all in one call) and intentionally
 * encapsulates that transaction. It cannot be split into "extract" and "write pointer"
 * phases without forking or modifying that module. Calling it once per
 * kind and rolling back the first kind's pointer if the second kind's
 * call throws reaches the same externally-observable outcome ("either
 * both next pointers exist afterward, or neither does") using only
 * exported, unmodified artifact-core functions.
 *
 * Node built-ins only (https/crypto/fs/path) — zero new dependencies.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const https = require("https");
const path = require("path");
const crypto = require("crypto");

const manifestModule = require("../../../shared/artifact-core/manifest.cjs");
const pointerStore = require("../../../shared/artifact-core/pointer-store.cjs");
const activation = require("../../../shared/artifact-core/activation.cjs");
const artifactBoot = require("./artifact-boot.cjs");
// Static specifier on purpose — see artifact-ota-dev-bypass.cjs's header
// comment; vite.config.main.js's alias keys off this exact literal.
const devBypass = require("./artifact-ota-dev-bypass.cjs");

const SEED_CHANNEL = artifactBoot.SEED_CHANNEL; // "stable"
const STAGING_DIRNAME = "staging";
const OTA_STATE_FILENAME = "ota-state.json";
const ROLLOUT_ID_FILENAME = "rollout-id";

const FIRST_CHECK_DELAY_MS = 30_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const MAX_REDIRECTS = 5;
const MANIFEST_REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_REQUEST_TIMEOUT_MS = 60_000;
const MAX_MANIFEST_BYTES = 256 * 1024; // generous for a schema-1 manifest + mirrors array
const MAX_SIG_BYTES = 4 * 1024; // raw ed25519 sig is 64 bytes; PEM-wrapped is still tiny

// ── channel pointer URLs: clients poll ONLY these static asset
//    URLs, never the GitHub API) ──────────────────────────────────────────
// Source order is fixed: AtomGit is the
// PRIMARY update source, GitHub Releases the fallback — the user base is
// China-heavy and GitHub is the unreliable hop there. Zero security delta:
// sources are untrusted by construction (the manifest signature governs),
// so ordering is purely a latency/availability choice.
const GITHUB_CHANNEL_BASE = "https://github.com/liliMozi/openhanako/releases/download/channels";
// Mirror base URL SHAPE verified against desktop/auto-updater.cjs's
// DEFAULT_ATOMGIT_RELEASE_BASE_URL (same owner/repo/host, same
// /releases/download/<tag>/<asset> layout; scripts/mirror-release-to-atomgit.mjs
// preserves the GitHub tag name verbatim on the AtomGit side). NOT YET
// OPERATIONAL for the `channels` pointer release yet:
// .github/workflows/mirror-release-to-atomgit.yml only mirrors releases
// explicitly selected via --tag/--newest/--stable, and no scheduled job
// runs `--tag channels` yet.
// Until that job exists the AtomGit primary 404s fast and the loop falls
// through to GitHub (the pre-flip behavior); AtomGit-first goes live the
// moment ops starts mirroring the `channels` tag.
// TODO(release-publishing): schedule a `--tag channels` mirror run, then drop this note.
const ATOMGIT_CHANNEL_BASE = "https://gitcode.com/liliMozi/OpenHanako-Releases/releases/download/channels";

function channelManifestUrls(channel) {
  return [`${ATOMGIT_CHANNEL_BASE}/${channel}.json`, `${GITHUB_CHANNEL_BASE}/${channel}.json`];
}

// ── low-level https transport: manual redirect following, injectable for
//    tests (`fetchOnce`) ───────────────────────────────────────────────────

function realFetchOnce(url, { headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = https.request(url, { headers, method: "GET", timeout: timeoutMs }, (res) => {
        resolve({ statusCode: res.statusCode, headers: res.headers, bodyStream: res });
      });
    } catch (err) {
      reject(err);
      return;
    }
    req.on("timeout", () => req.destroy(new Error(`artifact-ota: request timed out for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Follows redirects manually, capped at `maxRedirects` hops, https-only at
 * every hop (a redirect to http:// is refused, not silently downgraded).
 * @param {string} url
 * @param {{headers?: object, maxRedirects?: number, timeoutMs?: number,
 *          fetchOnce?: Function}} [opts]
 * @returns {Promise<{statusCode: number, headers: object, bodyStream: import('stream').Readable, finalUrl: string}>}
 */
async function fetchWithRedirects(url, opts = {}) {
  const { headers = {}, maxRedirects = MAX_REDIRECTS, timeoutMs = MANIFEST_REQUEST_TIMEOUT_MS, fetchOnce = realFetchOnce } = opts;
  let currentUrl = url;
  for (let hop = 0; ; hop += 1) {
    let parsed;
    try {
      parsed = new URL(currentUrl);
    } catch (err) {
      throw new Error(`artifact-ota: invalid URL ${currentUrl} (${err.message})`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`artifact-ota: refusing non-https URL ${currentUrl}`);
    }
    const { statusCode, headers: resHeaders, bodyStream } = await fetchOnce(currentUrl, { headers, timeoutMs });
    if (statusCode >= 300 && statusCode < 400 && resHeaders && resHeaders.location) {
      if (typeof bodyStream.resume === "function") bodyStream.resume(); // drain, we're not reading this body
      if (hop >= maxRedirects) {
        throw new Error(`artifact-ota: too many redirects (> ${maxRedirects}) for ${url}`);
      }
      currentUrl = new URL(resHeaders.location, currentUrl).toString();
      continue;
    }
    return { statusCode, headers: resHeaders || {}, bodyStream, finalUrl: currentUrl };
  }
}

/**
 * Buffers a small response body (manifest / signature). Enforces
 * `maxBytes` while streaming (aborts before the whole body is buffered).
 */
async function fetchBuffer(url, opts = {}) {
  const { maxBytes } = opts;
  const { statusCode, headers, bodyStream } = await fetchWithRedirects(url, opts);
  if (statusCode === 304) {
    if (typeof bodyStream.resume === "function") bodyStream.resume();
    return { statusCode, headers, body: null };
  }
  if (statusCode < 200 || statusCode >= 300) {
    if (typeof bodyStream.resume === "function") bodyStream.resume();
    throw new Error(`artifact-ota: HTTP ${statusCode} for ${url}`);
  }
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    bodyStream.on("data", (chunk) => {
      total += chunk.length;
      if (maxBytes && total > maxBytes) {
        if (typeof bodyStream.destroy === "function") bodyStream.destroy();
        reject(new Error(`artifact-ota: response exceeded ${maxBytes} bytes for ${url}`));
        return;
      }
      chunks.push(chunk);
    });
    bodyStream.on("end", resolve);
    bodyStream.on("error", reject);
  });
  return { statusCode, headers, body: Buffer.concat(chunks) };
}

/**
 * Streams a response body directly to `destPath` (large archive
 * downloads). Enforces `maxBytes` while streaming; on any failure the
 * partial file is removed.
 */
async function downloadToFile(url, destPath, opts = {}) {
  const { maxBytes } = opts;
  const { statusCode, headers, bodyStream } = await fetchWithRedirects(url, opts);
  if (statusCode < 200 || statusCode >= 300) {
    if (typeof bodyStream.resume === "function") bodyStream.resume();
    throw new Error(`artifact-ota: HTTP ${statusCode} for ${url}`);
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const writeStream = fs.createWriteStream(destPath);
  let total = 0;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      bodyStream.on("data", (chunk) => {
        total += chunk.length;
        if (maxBytes && total > maxBytes) {
          if (typeof bodyStream.destroy === "function") bodyStream.destroy();
          writeStream.destroy();
          fail(new Error(`artifact-ota: download exceeded ${maxBytes} bytes for ${url}`));
        }
      });
      bodyStream.on("error", fail);
      writeStream.on("error", fail);
      writeStream.on("finish", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      bodyStream.pipe(writeStream);
    });
  } catch (err) {
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw err;
  }
  return { statusCode, headers, bytesWritten: total };
}

// ── channel manifest fetch (ETag-cached, mirror failover, dev bypass) ─────

function fetchDevOverrideManifest(devOverride, log) {
  if (/^https?:\/\//i.test(devOverride)) {
    return (async () => {
      const manifestRes = await fetchBuffer(devOverride, { maxBytes: MAX_MANIFEST_BYTES, timeoutMs: MANIFEST_REQUEST_TIMEOUT_MS });
      const sigRes = await fetchBuffer(`${devOverride}.sig`, { maxBytes: MAX_SIG_BYTES, timeoutMs: MANIFEST_REQUEST_TIMEOUT_MS });
      return { manifestBytes: manifestRes.body, sigBytes: sigRes.body, etag: null, sourceUrl: devOverride, localDir: null };
    })();
  }
  // Deliberately does NOT spell out the override env var's name here — this
  // file is bundled verbatim into every production main.bundle.cjs (unlike
  // artifact-ota-dev-bypass.cjs, which gets alias-swapped away); a literal
  // string reference here would defeat the "grep finds nothing" guarantee
  // even though this branch only ever executes when devBypass.hasDevOverride()
  // was already true (dev mode only).
  log(`[ota] dev manifest override active: reading local manifest from ${devOverride}`);
  const manifestBytes = fs.readFileSync(devOverride);
  const sigBytes = fs.readFileSync(`${devOverride}.sig`);
  return { manifestBytes, sigBytes, etag: null, sourceUrl: devOverride, localDir: path.dirname(devOverride) };
}

/**
 * @returns {Promise<{notModified: true} | {manifestBytes: Buffer, sigBytes: Buffer,
 *   etag: string|null, sourceUrl: string, localDir: string|null}>}
 */
async function fetchChannelManifest({ channel, cachedEtag, cachedUrl, log = () => {} }) {
  if (devBypass.hasDevOverride()) {
    return fetchDevOverrideManifest(devBypass.resolveDevManifestOverride(), log);
  }
  const urls = channelManifestUrls(channel);
  let lastErr;
  for (const url of urls) {
    try {
      const headers = cachedEtag && cachedUrl === url ? { "If-None-Match": cachedEtag } : {};
      const manifestRes = await fetchBuffer(url, { headers, maxBytes: MAX_MANIFEST_BYTES, timeoutMs: MANIFEST_REQUEST_TIMEOUT_MS });
      if (manifestRes.statusCode === 304) return { notModified: true };
      const sigRes = await fetchBuffer(`${url}.sig`, { maxBytes: MAX_SIG_BYTES, timeoutMs: MANIFEST_REQUEST_TIMEOUT_MS });
      return {
        manifestBytes: manifestRes.body,
        sigBytes: sigRes.body,
        etag: (manifestRes.headers && manifestRes.headers.etag) || null,
        sourceUrl: url,
        localDir: null,
      };
    } catch (err) {
      lastErr = err;
      log(`[ota] channel manifest fetch failed from ${url}: ${err.message}`);
    }
  }
  throw new Error(`all channel manifest sources failed: ${lastErr ? lastErr.message : "unknown"}`);
}

// ── minShell comparison (major.minor.patch only; no new semver dep) ───────

function parseVersionTriplet(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || "").trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Conservative by construction: an unparseable version on EITHER side
 * blocks the update (returns false) rather than guessing — we never want
 * to silently proceed past a check we can't actually evaluate.
 */
function isShellVersionSufficient(currentShellVersion, minShellVersion) {
  const current = parseVersionTriplet(currentShellVersion);
  const min = parseVersionTriplet(minShellVersion);
  if (!current || !min) return false;
  for (let i = 0; i < 3; i += 1) {
    if (current[i] !== min[i]) return current[i] > min[i];
  }
  return true;
}

// ── rollout bucketing: dedicated random UUID, zero linkage to
//    any real device identity) ─────────────────────────────────────────────

function computeRolloutBucket(rolloutId, salt) {
  const digest = crypto.createHash("sha256").update(`${rolloutId}${salt}`).digest("hex");
  return parseInt(digest.slice(0, 8), 16) % 100;
}

function isInRolloutBucket({ rolloutId, salt, percent }) {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  return computeRolloutBucket(rolloutId, salt) < percent;
}

function rolloutIdPath(homeDir) {
  return path.join(pointerStore.artifactsRoot(homeDir), ROLLOUT_ID_FILENAME);
}

async function atomicWriteText(filePath, text) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  await fsp.writeFile(tmpPath, text, "utf8");
  await fsp.rename(tmpPath, filePath);
}

/**
 * Reads the dedicated rollout UUID, generating and persisting one on first
 * use. Never derived from any real device/machine identity.
 * @param {string} homeDir
 * @returns {Promise<string>}
 */
async function ensureRolloutId(homeDir) {
  const filePath = rolloutIdPath(homeDir);
  try {
    const existing = (await fsp.readFile(filePath, "utf8")).trim();
    if (existing) return existing;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const id = crypto.randomUUID();
  await atomicWriteText(filePath, id);
  return id;
}

// ── ota-state.json (ETag + last-check bookkeeping, keyed by channel) ──────

function otaStatePath(homeDir) {
  return path.join(pointerStore.artifactsRoot(homeDir), OTA_STATE_FILENAME);
}

async function readOtaState(homeDir) {
  try {
    const raw = await fsp.readFile(otaStatePath(homeDir), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    // A corrupt/missing state file must never block the update path itself
    // — it's bookkeeping, not a trust boundary.
    return {};
  }
}

async function writeOtaChannelState(homeDir, channel, patch) {
  const state = await readOtaState(homeDir);
  state[channel] = { ...(state[channel] || {}), ...patch };
  await pointerStore.atomicWriteJson(otaStatePath(homeDir), state);
  return state[channel];
}

function nowIso() {
  return new Date().toISOString();
}

// ── staging (download/copy + sha256 verify) ────────────────────────────────

/**
 * Stages one artifact entry into `finalPath`: either copies it from a
 * local dev-override directory, or downloads it from the manifest's
 * `mirrors`, trying each in order until one succeeds. Always ends with an
 * explicit sha256 check against the manifest entry (in addition to the
 * one `activateFromArchive` performs) so a corrupt/wrong download fails
 * fast with an attributable message before extraction is attempted.
 */
async function stageArtifact({ finalPath, entry, mirrors, localDir, log, label }) {
  const maxBytes = entry.size + Math.max(Math.round(entry.size * 0.05), 5 * 1024 * 1024);
  const partPath = `${finalPath}.part`;

  if (localDir) {
    const sourcePath = path.join(localDir, entry.path);
    await fsp.rm(partPath, { force: true }).catch(() => {});
    await fsp.copyFile(sourcePath, partPath);
    await fsp.rename(partPath, finalPath);
  } else {
    if (!Array.isArray(mirrors) || mirrors.length === 0) {
      throw new Error(`no mirrors declared for ${label}`);
    }
    let lastErr;
    let staged = false;
    for (const mirrorBase of mirrors) {
      const url = `${String(mirrorBase).replace(/\/+$/, "")}/${entry.path}`;
      try {
        await fsp.rm(partPath, { force: true }).catch(() => {});
        await downloadToFile(url, partPath, { maxBytes, timeoutMs: DOWNLOAD_REQUEST_TIMEOUT_MS });
        await fsp.rename(partPath, finalPath);
        staged = true;
        break;
      } catch (err) {
        lastErr = err;
        log(`[ota] mirror failed for ${label}: ${url} (${err.message})`);
        await fsp.rm(partPath, { force: true }).catch(() => {});
      }
    }
    if (!staged) {
      throw new Error(`all mirrors failed for ${label}: ${lastErr ? lastErr.message : "unknown"}`);
    }
  }

  const actualSha256 = await activation.sha256File(finalPath);
  if (actualSha256 !== entry.sha256) {
    await fsp.rm(finalPath, { force: true }).catch(() => {});
    throw new Error(`sha256 mismatch staging ${label} (expected ${entry.sha256}, got ${actualSha256})`);
  }
  return finalPath;
}

// ── the orchestrator ───────────────────────────────────────────────────────

/**
 * Runs exactly one OTA check-and-download cycle. NEVER rejects — every
 * failure is caught, logged, recorded in ota-state.json, and reflected in
 * the returned `outcome`.
 * @param {{homeDir: string, keyset: Array<{keyId:string, publicKey:string}>,
 *   currentShellVersion: string, platformArch: string, channel?: string,
 *   log?: (msg: string) => void}} opts
 * @returns {Promise<{outcome: string, train?: number, error?: string}>}
 */
async function checkAndDownloadOnce(opts) {
  const { homeDir, keyset, currentShellVersion, platformArch, channel = SEED_CHANNEL, log = () => {} } = opts || {};
  if (!homeDir) throw new Error("artifact-ota: homeDir is required");
  if (!Array.isArray(keyset) || keyset.length === 0) throw new Error("artifact-ota: keyset is required");
  if (!currentShellVersion) throw new Error("artifact-ota: currentShellVersion is required");
  if (!platformArch) throw new Error("artifact-ota: platformArch is required");

  const priorChannelState = (await readOtaState(homeDir))[channel] || {};

  try {
    const fetched = await fetchChannelManifest({
      channel,
      cachedEtag: priorChannelState.etag,
      cachedUrl: priorChannelState.lastManifestUrl,
      log,
    });
    if (fetched.notModified) {
      await writeOtaChannelState(homeDir, channel, { lastCheckedAt: nowIso(), lastError: null });
      return { outcome: "not-modified" };
    }
    const { manifestBytes, sigBytes, etag, sourceUrl, localDir } = fetched;

    // Signature + schema, atomically (see verify-order note in the file
    // header — the sole sanctioned entry point bundles both checks; no
    // manifest content is trusted before both pass).
    const manifest = manifestModule.verifyManifest(manifestBytes, sigBytes, keyset);

    const currentPointer = await pointerStore.readPointer(homeDir, channel, "current");
    const currentTrain = currentPointer && Number.isInteger(currentPointer.train) ? currentPointer.train : null;
    manifestModule.checkMonotonic(manifest, currentTrain); // throws if not strictly newer

    if (!isShellVersionSufficient(currentShellVersion, manifest.minShell)) {
      await writeOtaChannelState(homeDir, channel, {
        etag,
        lastManifestUrl: sourceUrl,
        lastCheckedAt: nowIso(),
        lastError: null,
        lastSkipReason: `minShell ${manifest.minShell} > shell ${currentShellVersion}`,
      });
      return { outcome: "minshell-blocked", train: manifest.train };
    }

    const rolloutId = await ensureRolloutId(homeDir);
    if (!isInRolloutBucket({ rolloutId, salt: manifest.rollout.salt, percent: manifest.rollout.percent })) {
      await writeOtaChannelState(homeDir, channel, {
        etag,
        lastManifestUrl: sourceUrl,
        lastCheckedAt: nowIso(),
        lastError: null,
        lastSkipReason: "rollout-excluded",
      });
      return { outcome: "rollout-excluded", train: manifest.train };
    }

    if (await pointerStore.isQuarantined(homeDir, channel, manifest.train)) {
      await writeOtaChannelState(homeDir, channel, {
        etag,
        lastManifestUrl: sourceUrl,
        lastCheckedAt: nowIso(),
        lastError: null,
        lastSkipReason: `train ${manifest.train} quarantined`,
      });
      return { outcome: "quarantined", train: manifest.train };
    }

    const rendererEntry = manifest.artifacts.renderer;
    const serverEntry = manifest.artifacts.server && manifest.artifacts.server[platformArch];
    if (!rendererEntry || !serverEntry) {
      const missing = [!serverEntry ? `server(${platformArch})` : null, !rendererEntry ? "renderer" : null]
        .filter(Boolean)
        .join("+");
      throw new Error(`manifest missing needed kind(s) for OTA: ${missing}`);
    }

    const lock = await pointerStore.acquireLock(homeDir);
    if (!lock) {
      log("[ota] artifacts lock held by another instance; skipping this cycle");
      return { outcome: "locked", train: manifest.train };
    }

    const stagingDir = path.join(pointerStore.artifactsRoot(homeDir), STAGING_DIRNAME);
    const serverStagedPath = path.join(stagingDir, `server-${serverEntry.version}-${platformArch}.tar.gz`);
    const rendererStagedPath = path.join(stagingDir, `renderer-${rendererEntry.version}.tar.gz`);
    try {
      await fsp.mkdir(stagingDir, { recursive: true });
      await stageArtifact({
        finalPath: serverStagedPath,
        entry: serverEntry,
        mirrors: manifest.mirrors,
        localDir,
        log,
        label: `server-${serverEntry.version}-${platformArch}`,
      });
      await stageArtifact({
        finalPath: rendererStagedPath,
        entry: rendererEntry,
        mirrors: manifest.mirrors,
        localDir,
        log,
        label: `renderer-${rendererEntry.version}`,
      });

      // Both boxes staged and sha256-verified. Activate server first, then
      // renderer; roll the server `next` pointer back if renderer's
      // activation fails (see "why a rollback" note in the file header).
      await activation.activateFromArchive(serverStagedPath, manifest, {
        homeDir,
        channel,
        kind: "server",
        platformArch,
      });
      try {
        await activation.activateFromArchive(rendererStagedPath, manifest, {
          homeDir,
          channel: artifactBoot.rendererPointerChannel(channel),
          kind: "renderer",
        });
      } catch (err) {
        await pointerStore.clearPointer(homeDir, channel, "next").catch(() => {});
        throw new Error(`renderer activation failed, server next pointer rolled back: ${err.message}`);
      }

      await writeOtaChannelState(homeDir, channel, {
        etag,
        lastManifestUrl: sourceUrl,
        lastCheckedAt: nowIso(),
        lastError: null,
        lastSkipReason: null,
        lastStagedTrain: manifest.train,
      });
      log(
        `[ota] train ${manifest.train} staged (server ${serverEntry.version}, renderer ${rendererEntry.version}); activates on next launch`,
      );
      return { outcome: "staged", train: manifest.train };
    } finally {
      await fsp.rm(serverStagedPath, { force: true }).catch(() => {});
      await fsp.rm(rendererStagedPath, { force: true }).catch(() => {});
      await fsp.rm(`${serverStagedPath}.part`, { force: true }).catch(() => {});
      await fsp.rm(`${rendererStagedPath}.part`, { force: true }).catch(() => {});
      await lock.release();
    }
  } catch (err) {
    log(`[ota] check failed: ${err.message}`);
    await writeOtaChannelState(homeDir, channel, { lastCheckedAt: nowIso(), lastError: err.message }).catch(() => {});
    return { outcome: "error", error: err.message };
  }
}

/**
 * Schedules the recurring background checker (deliberately fixed cadence: first
 * check ~30s after the main window is shown, then every 6h). Timers are
 * unref'd so they never keep the process alive. Never throws synchronously
 * and the scheduled work never rejects upward (see `checkAndDownloadOnce`).
 * @returns {NodeJS.Timeout} the initial delay timer (exposed for tests only)
 */
function scheduleBackgroundOtaChecks(opts) {
  const {
    homeDir,
    keyset,
    currentShellVersion,
    platformArch,
    channel = SEED_CHANNEL,
    firstDelayMs = FIRST_CHECK_DELAY_MS,
    intervalMs = RECHECK_INTERVAL_MS,
    log = () => {},
  } = opts || {};

  const runOnce = () => {
    checkAndDownloadOnce({ homeDir, keyset, currentShellVersion, platformArch, channel, log })
      .then((result) => {
        log(`[ota] cycle: ${result.outcome}${result.error ? ` (${result.error})` : ""}`);
      })
      .catch((err) => {
        // checkAndDownloadOnce is designed to never reject; this is a
        // belt-and-suspenders net so a scheduler bug can never crash or
        // block anything upstream.
        log(`[ota] cycle threw unexpectedly (this should never happen): ${err.message}`);
      });
  };

  const firstTimer = setTimeout(() => {
    runOnce();
    const intervalTimer = setInterval(runOnce, intervalMs);
    if (typeof intervalTimer.unref === "function") intervalTimer.unref();
  }, firstDelayMs);
  if (typeof firstTimer.unref === "function") firstTimer.unref();
  return firstTimer;
}

/** Re-exported so callers (main.cjs) never need to reference the dev-only env var name directly. */
function hasDevOverrideConfigured() {
  return devBypass.hasDevOverride();
}

// ── staged-train read-only query (train update UI) ───────────────
//
// Minimal surface for the settings-page/sticker UI and the apply-now IPC
// handler (desktop/main.cjs) to ask "is a train fully staged and ready to
// promote right now" without reaching into pointer-store directly. This is
// a pure READ — it never writes a pointer, never downloads, never touches
// `current`/`previous`. The actual promote step still only ever happens
// through the existing artifact-boot chain (prepareArtifactServerBoot /
// prepareArtifactRendererBoot), exactly as at ordinary boot.

/**
 * The apply-now precondition guard, exported standalone so it's a direct
 * mutation-test target: promote() must only ever be attempted when BOTH
 * kinds' `next` pointers exist and agree on the same train number. A
 * partially-staged train (one kind downloaded, the other not yet, or a
 * torn write) must never be treated as ready — this mirrors the "either
 * both next pointers land or neither does" invariant `checkAndDownloadOnce`
 * itself already enforces via the server-next rollback (see the "why a
 * rollback" note in this file's header).
 * @param {{serverNext: {train?: number}|null, rendererNext: {train?: number}|null}} pointers
 * @returns {boolean}
 */
function bothNextPointersReady({ serverNext, rendererNext }) {
  if (!serverNext || !rendererNext) return false;
  if (!Number.isInteger(serverNext.train) || !Number.isInteger(rendererNext.train)) return false;
  return serverNext.train === rendererNext.train;
}

/**
 * Pure projection from the two raw next-pointers to the status shape the
 * UI/IPC layer actually wants. Split out from `readStagedTrainStatus` so
 * the projection logic is testable without touching the filesystem.
 * @param {{serverNext: object|null, rendererNext: object|null}} pointers
 * @returns {{staged: boolean, train: number|null, version: string|null}}
 */
function resolveStagedTrainStatus({ serverNext, rendererNext }) {
  if (!bothNextPointersReady({ serverNext, rendererNext })) {
    return { staged: false, train: null, version: null };
  }
  return {
    staged: true,
    train: serverNext.train,
    // Product version display: renderer and server are stamped
    // with the same product version at build time; renderer wins the tie
    // arbitrarily (both must agree in practice).
    version: rendererNext.version || serverNext.version || null,
  };
}

/**
 * @param {string} homeDir
 * @param {{channel?: string}} [opts]
 * @returns {Promise<{staged: boolean, train: number|null, version: string|null, minShellBlocked: boolean}>}
 */
async function readStagedTrainStatus(homeDir, opts = {}) {
  const { channel = SEED_CHANNEL } = opts;
  const rendererChannel = artifactBoot.rendererPointerChannel(channel);
  const [serverNext, rendererNext, otaState] = await Promise.all([
    pointerStore.readPointer(homeDir, channel, "next"),
    pointerStore.readPointer(homeDir, rendererChannel, "next"),
    readOtaState(homeDir),
  ]);
  const status = resolveStagedTrainStatus({ serverNext, rendererNext });
  // Two-tier copy: the last OTA cycle's skip reason is the only
  // record of "a newer train exists but this shell is too old to receive
  // it" — checkAndDownloadOnce already persists this to ota-state.json on
  // the minshell-blocked outcome; surfaced here so the UI can escalate its
  // copy without a second IPC round-trip or re-deriving the check itself.
  const channelState = (otaState && otaState[channel]) || {};
  const minShellBlocked = typeof channelState.lastSkipReason === "string"
    && channelState.lastSkipReason.startsWith("minShell ");
  return { ...status, minShellBlocked };
}

module.exports = {
  SEED_CHANNEL,
  FIRST_CHECK_DELAY_MS,
  RECHECK_INTERVAL_MS,
  channelManifestUrls,
  isShellVersionSufficient,
  computeRolloutBucket,
  isInRolloutBucket,
  ensureRolloutId,
  readOtaState,
  writeOtaChannelState,
  fetchWithRedirects,
  fetchBuffer,
  downloadToFile,
  checkAndDownloadOnce,
  scheduleBackgroundOtaChecks,
  hasDevOverrideConfigured,
  bothNextPointersReady,
  resolveStagedTrainStatus,
  readStagedTrainStatus,
};
