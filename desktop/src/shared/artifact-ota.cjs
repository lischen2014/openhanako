"use strict";

/**
 * artifact-ota.cjs — hot-update train check + download/apply, split into
 * two entry points on purpose:
 *
 *   `checkOnce` — safe to run automatically on a timer. Fetches the channel
 *   manifest, verifies it, runs every gate, and figures out whether a real
 *   update exists. It NEVER writes an archive to disk, NEVER extracts
 *   anything, and NEVER touches a pointer file. The only disk writes are
 *   bookkeeping: `ota-state.json` (what did the last check find) and the
 *   per-install rollout-id file. Every failure is caught, logged, and
 *   recorded in `ota-state.json`; this function never rejects.
 *
 *   `downloadAndApplyArtifacts` — the only function in this module allowed
 *   to write an archive to disk or call `activateFromArchive`. It is only
 *   ever meant to run because a person clicked something: automatic
 *   background code must never call it. It re-fetches the manifest
 *   (bypassing the ETag cache, since the shelf may have moved since the
 *   last check), re-runs every gate (the shelf may have moved), stages both
 *   archives with progress callbacks, then activates server before
 *   renderer.
 *
 * Why the split exists: the previous single `checkAndDownloadOnce` function
 * did "check + download + stage + activate" as one silent background
 * operation on a timer, and a bug in the activation step could corrupt the
 * active installation before it was root-caused and fixed.
 * The fix for that bug is `activateFromArchive`'s current claim/refuse
 * semantics; this split is the second half of the fix — no code path may
 * write bytes to an artifacts directory without a human in the loop.
 *
 * Gate order (both entry points), each short-circuits the rest on failure:
 *   fetch channel manifest (+.sig, ETag-cached for checkOnce, ETag-bypassed
 *   for downloadAndApplyArtifacts, mirror failover)
 *     -> ed25519 verify + schema validate (one atomic call into the
 *        protected artifact-core `manifest.verifyManifest` — see the
 *        "verify-order note" below)
 *     -> train monotonic, SOFTENED for checkOnce: a train that is not
 *        strictly newer than the currently activated train is reported as
 *        "up-to-date", not an error (a background check finding nothing
 *        new is normal, not exceptional). downloadAndApplyArtifacts keeps
 *        this as a hard failure — there is nothing to apply.
 *     -> content reconciliation (checkOnce only): even when the train
 *        number did advance, if this platform's server entry and the
 *        renderer entry both hash to exactly what's already recorded on
 *        the `current` pointer, there is no real update — report
 *        "up-to-date" rather than surfacing a phantom "new version"
 *        because a release got re-cut with the same bytes under a new
 *        train number. The same "up-to-date" outcome is also reported when
 *        the version numbers already match even if the bytes don't — a
 *        version directory is named after the version number, so content
 *        stamped with a version that's already activated can never be
 *        applied anyway, regardless of what its sha256 says (see
 *        `isVersionAlreadyCurrent`'s doc comment).
 *     -> minShell (shell too old -> the update is real but blocked; the
 *        shell's own update is electron-updater's job, not this module's)
 *     -> rollout bucket (dedicated random UUID in HANA_HOME)
 *     -> quarantine short-circuit (train permanently blacklisted)
 *     -> [downloadAndApplyArtifacts only] acquire the artifacts directory
 *        lock (the loser fails this call — someone else is already
 *        updating) -> stage both archives (renderer + this platform's
 *        server) to `staging/`, mirror failover per archive, size-capped,
 *        streamed, atomic rename, sha256-verified, with progress reported
 *        through `onProgress` -> `activateFromArchive` per kind (extract +
 *        `.verified` + write that kind's `next` pointer) — server first,
 *        then renderer; if renderer's activation fails, the server `next`
 *        pointer written a moment earlier is rolled back
 *        (`pointerStore.clearPointer`) so "either both next pointers land
 *        or neither does" holds even though `activateFromArchive` itself
 *        only guarantees atomicity per kind, not across the two calls (see
 *        the "why a rollback" note below) -> staging cleaned up in a
 *        `finally`, lock released in a `finally`
 *
 * Activation to `current` happens at the NEXT LAUNCH, entirely inside
 * `desktop/src/shared/artifact-boot.cjs`; both kinds use the same promotion contract:
 * both `prepareArtifactServerBoot` and `prepareArtifactRendererBoot`
 * call `pointerStore.promote(homeDir, <their channel>)` as the first thing
 * they do). `downloadAndApplyArtifacts` writes `next` pointers and nothing
 * else — it never promotes, never touches `current`/`previous` itself;
 * promotion happens through the existing apply-now sequence
 * (`train-update-apply.cjs`) or at the next ordinary launch. A running
 * session is never hot-swapped by this module.
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
 * partial file is removed. `onProgress(receivedBytes)` — when supplied —
 * is invoked after every chunk so a caller can report download progress;
 * purely observational, never affects control flow.
 */
async function downloadToFile(url, destPath, opts = {}) {
  const { maxBytes, onProgress } = opts;
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
          return;
        }
        if (typeof onProgress === "function") onProgress(total);
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
async function fetchChannelManifest({ channel, cachedEtag, cachedUrl, log = () => {}, fetchOnce }) {
  if (devBypass.hasDevOverride()) {
    return fetchDevOverrideManifest(devBypass.resolveDevManifestOverride(), log);
  }
  const urls = channelManifestUrls(channel);
  let lastErr;
  for (const url of urls) {
    try {
      const headers = cachedEtag && cachedUrl === url ? { "If-None-Match": cachedEtag } : {};
      const manifestRes = await fetchBuffer(url, { headers, maxBytes: MAX_MANIFEST_BYTES, timeoutMs: MANIFEST_REQUEST_TIMEOUT_MS, fetchOnce });
      if (manifestRes.statusCode === 304) return { notModified: true };
      const sigRes = await fetchBuffer(`${url}.sig`, { maxBytes: MAX_SIG_BYTES, timeoutMs: MANIFEST_REQUEST_TIMEOUT_MS, fetchOnce });
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

// ── ota-state.json (ETag + last-check + last-known-available bookkeeping,
//    keyed by channel) ──────────────────────────────────────────────────────

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
 * `onProgress(receivedBytes)` is forwarded to the network download only
 * (a local dev-override copy is effectively instant and reports nothing).
 */
async function stageArtifact({ finalPath, entry, mirrors, localDir, log, label, onProgress }) {
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
        await downloadToFile(url, partPath, { maxBytes, timeoutMs: DOWNLOAD_REQUEST_TIMEOUT_MS, onProgress });
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

// ── shared manifest-entry derivation (both entry points need this) ────────

/**
 * Pulls this platform's server entry and the renderer entry out of a
 * verified manifest. Throws if either kind is missing, or if the two
 * entries disagree on `version` (release publishing guarantees one train
 * ships server+renderer stamped with the same product version — a
 * mismatch means the manifest itself is broken, not that either side is
 * individually invalid).
 * @param {object} manifest
 * @param {string} platformArch
 * @returns {{serverEntry: object, rendererEntry: object, version: string}}
 */
function deriveArtifactEntries(manifest, platformArch) {
  const rendererEntry = manifest.artifacts.renderer;
  const serverEntry = manifest.artifacts.server && manifest.artifacts.server[platformArch];
  if (!rendererEntry || !serverEntry) {
    const missing = [!serverEntry ? `server(${platformArch})` : null, !rendererEntry ? "renderer" : null]
      .filter(Boolean)
      .join("+");
    throw new Error(`manifest missing needed kind(s) for OTA: ${missing}`);
  }
  if (serverEntry.version !== rendererEntry.version) {
    throw new Error(
      `manifest server/renderer version mismatch (server ${serverEntry.version}, renderer ${rendererEntry.version})`,
    );
  }
  return { serverEntry, rendererEntry, version: serverEntry.version };
}

/**
 * Content reconciliation rule: even when the train number advanced, if the
 * actual bytes this platform would receive are identical to what's
 * already recorded on the `current` pointer for both kinds, there is
 * nothing to update — a re-cut release announcing the same content under
 * a new train number must not be surfaced as "a new version is available".
 * @returns {boolean}
 */
function isContentAlreadyCurrent({ currentServerPointer, currentRendererPointer, serverEntry, rendererEntry }) {
  return Boolean(
    currentServerPointer
      && currentServerPointer.sha256 === serverEntry.sha256
      && currentRendererPointer
      && currentRendererPointer.sha256 === rendererEntry.sha256,
  );
}

/**
 * Version reconciliation rule: a version directory is named after the
 * version number itself, so content stamped with the same version as what's
 * already activated can never be applied even if its bytes differ (the
 * activation layer's protected-directory + sha256 check refuses it). This
 * happens in practice because CI packs the renderer archive on three
 * separate platform runners and tar embeds each build's mtime, so the same
 * source tree produces three different byte streams for the same version —
 * if only one of those boxes ends up on the shelf, every other platform's
 * freshly-installed sha256 seed can never match it. Treating "same version"
 * as "already current" (regardless of sha256) avoids advertising an update
 * that would always fail to apply.
 * A pointer written before this field existed has no `version` — in that
 * case this check simply doesn't fire and behavior falls back to the
 * sha256-only comparison above, which is the correct read-time-compatible
 * behavior for old data.
 * @returns {boolean}
 */
function isVersionAlreadyCurrent({ currentServerPointer, currentRendererPointer, serverEntry, rendererEntry }) {
  return Boolean(
    currentServerPointer
      && typeof currentServerPointer.version === "string"
      && currentServerPointer.version.length > 0
      && currentServerPointer.version === serverEntry.version
      && currentRendererPointer
      && typeof currentRendererPointer.version === "string"
      && currentRendererPointer.version.length > 0
      && currentRendererPointer.version === rendererEntry.version,
  );
}

function buildAvailableDescriptor({ manifest, serverEntry, rendererEntry, version }) {
  return {
    train: manifest.train,
    version,
    serverSha256: serverEntry.sha256,
    rendererSha256: rendererEntry.sha256,
    sizes: { server: serverEntry.size, renderer: rendererEntry.size },
    recordedAt: nowIso(),
  };
}

// ── checkOnce: the only entry point safe to run on a timer ────────────────

/**
 * Runs exactly one OTA check cycle. NEVER writes an archive to disk, NEVER
 * extracts anything, NEVER writes a pointer — the only disk writes are
 * `ota-state.json` bookkeeping and (on first run) the rollout-id file.
 * NEVER rejects — every failure is caught, logged, recorded in
 * ota-state.json, and reflected in the returned `outcome`.
 *
 * Outcomes: "not-modified" (304 — state otherwise untouched), "up-to-date"
 * (train not newer, content byte-identical to `current`, or version
 * already identical to `current` even with different bytes), "available"
 * (a real update exists and passed every gate; nothing downloaded yet),
 * "minshell-blocked" (a real update exists but this shell is too old to
 * receive it), "rollout-excluded", "quarantined", "error".
 *
 * @param {{homeDir: string, keyset: Array<{keyId:string, publicKey:string}>,
 *   currentShellVersion: string, platformArch: string, channel?: string,
 *   log?: (msg: string) => void, fetchOnce?: Function}} opts
 *   `fetchOnce` is a test-only low-level transport override (see
 *   `fetchWithRedirects`); production callers never pass it.
 * @returns {Promise<{outcome: string, train?: number, version?: string,
 *   minShellBlocked?: boolean, error?: string}>}
 */
async function checkOnce(opts) {
  const { homeDir, keyset, currentShellVersion, platformArch, channel = SEED_CHANNEL, log = () => {}, fetchOnce } = opts || {};
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
      fetchOnce,
    });
    if (fetched.notModified) {
      // The shelf hasn't moved since the last check. That is NOT the same
      // thing as "you are up to date" — whatever the last check found
      // (an available update, an error) is still true and must not be
      // silently erased just because this poll came back empty-handed.
      await writeOtaChannelState(homeDir, channel, { lastCheckedAt: nowIso() });
      return { outcome: "not-modified" };
    }
    const { manifestBytes, sigBytes, etag, sourceUrl, localDir } = fetched;

    // Signature + schema, atomically (see verify-order note in the file
    // header — the sole sanctioned entry point bundles both checks; no
    // manifest content is trusted before both pass).
    const manifest = manifestModule.verifyManifest(manifestBytes, sigBytes, keyset);

    const rendererChannel = artifactBoot.rendererPointerChannel(channel);
    const currentServerPointer = await pointerStore.readPointer(homeDir, channel, "current");
    const currentRendererPointer = await pointerStore.readPointer(homeDir, rendererChannel, "current");
    const currentTrain = currentServerPointer && Number.isInteger(currentServerPointer.train) ? currentServerPointer.train : null;

    // Monotonic gate, softened: a train that isn't strictly newer than
    // what's already activated is normal ("you're already caught up"),
    // not an error — only downloadAndApplyArtifacts treats this as fatal.
    if (currentTrain !== null && manifest.train <= currentTrain) {
      await writeOtaChannelState(homeDir, channel, {
        etag,
        lastManifestUrl: sourceUrl,
        lastCheckedAt: nowIso(),
        lastError: null,
        available: null,
        minShellBlocked: false,
      });
      return { outcome: "up-to-date", train: manifest.train };
    }

    const { serverEntry, rendererEntry, version } = deriveArtifactEntries(manifest, platformArch);

    // Content reconciliation short-circuit — see `isContentAlreadyCurrent`'s
    // and `isVersionAlreadyCurrent`'s doc comments.
    const contentAlreadyCurrent = isContentAlreadyCurrent({ currentServerPointer, currentRendererPointer, serverEntry, rendererEntry });
    const versionAlreadyCurrent = !contentAlreadyCurrent
      && isVersionAlreadyCurrent({ currentServerPointer, currentRendererPointer, serverEntry, rendererEntry });
    if (contentAlreadyCurrent || versionAlreadyCurrent) {
      if (versionAlreadyCurrent) {
        log(
          `[ota] train ${manifest.train} (${version}) matches the currently activated version but has different bytes; `
            + "treating as already up-to-date (this usually means the installer seed and the shelf box came from different builds)",
        );
      }
      await writeOtaChannelState(homeDir, channel, {
        etag,
        lastManifestUrl: sourceUrl,
        lastCheckedAt: nowIso(),
        lastError: null,
        available: null,
        minShellBlocked: false,
      });
      return { outcome: "up-to-date", train: manifest.train };
    }

    const available = buildAvailableDescriptor({ manifest, serverEntry, rendererEntry, version });

    if (!isShellVersionSufficient(currentShellVersion, manifest.minShell)) {
      await writeOtaChannelState(homeDir, channel, {
        etag,
        lastManifestUrl: sourceUrl,
        lastCheckedAt: nowIso(),
        lastError: null,
        available,
        minShellBlocked: true,
      });
      return { outcome: "minshell-blocked", train: manifest.train, version, minShellBlocked: true };
    }

    const rolloutId = await ensureRolloutId(homeDir);
    if (!isInRolloutBucket({ rolloutId, salt: manifest.rollout.salt, percent: manifest.rollout.percent })) {
      await writeOtaChannelState(homeDir, channel, {
        etag,
        lastManifestUrl: sourceUrl,
        lastCheckedAt: nowIso(),
        lastError: null,
        available: null,
        minShellBlocked: false,
      });
      return { outcome: "rollout-excluded", train: manifest.train };
    }

    if (await pointerStore.isQuarantined(homeDir, channel, manifest.train)) {
      await writeOtaChannelState(homeDir, channel, {
        etag,
        lastManifestUrl: sourceUrl,
        lastCheckedAt: nowIso(),
        lastError: null,
        available: null,
        minShellBlocked: false,
      });
      return { outcome: "quarantined", train: manifest.train };
    }

    await writeOtaChannelState(homeDir, channel, {
      etag,
      lastManifestUrl: sourceUrl,
      lastCheckedAt: nowIso(),
      lastError: null,
      available,
      minShellBlocked: false,
    });
    log(`[ota] train ${manifest.train} (${version}) available; waiting for the user to trigger download`);
    return { outcome: "available", train: manifest.train, version, minShellBlocked: false };
  } catch (err) {
    log(`[ota] check failed: ${err.message}`);
    // lastError is written on every failed check and is only ever cleared
    // by a check or apply that completes successfully — a "not-modified"
    // reply must never be mistaken for "the previous failure is resolved".
    await writeOtaChannelState(homeDir, channel, { lastCheckedAt: nowIso(), lastError: err.message }).catch(() => {});
    return { outcome: "error", error: err.message };
  }
}

/**
 * Schedules the recurring background CHECK-ONLY loop (deliberately fixed
 * cadence: first check ~30s after the main window is shown, then every
 * 6h). Never downloads or writes an archive — see `checkOnce`'s doc
 * comment. Timers are unref'd so they never keep the process alive. Never
 * throws synchronously and the scheduled work never rejects upward.
 * `onAvailable(result)` — optional — fires whenever a cycle's outcome is
 * "available" or "minshell-blocked", i.e. whenever there's something a UI
 * layer might want to announce; kept as an injected callback so this
 * module stays Electron-free (desktop/main.cjs wires it to a window
 * broadcast).
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
    onAvailable,
  } = opts || {};

  const runOnce = () => {
    checkOnce({ homeDir, keyset, currentShellVersion, platformArch, channel, log })
      .then((result) => {
        log(`[ota] cycle: ${result.outcome}${result.error ? ` (${result.error})` : ""}`);
        if ((result.outcome === "available" || result.outcome === "minshell-blocked") && typeof onAvailable === "function") {
          onAvailable(result);
        }
      })
      .catch((err) => {
        // checkOnce is designed to never reject; this is a
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

// ── downloadAndApplyArtifacts: the only function allowed to write bytes ───

/**
 * Downloads and activates one train. Only ever call this because a user
 * clicked something — see the file header for why this is a hard rule.
 * Re-fetches the manifest bypassing the ETag cache and re-runs every gate
 * (the shelf may have moved since the last `checkOnce`), then stages both
 * archives and activates them (server first, then renderer, with the same
 * "roll back the server pointer if renderer fails" rollback `checkOnce`'s
 * predecessor used — see the file header's "why a rollback" note).
 *
 * Does NOT promote `next` to `current` and does NOT restart anything —
 * that's the existing apply-now sequence's job
 * (`train-update-apply.cjs`, orchestrated by desktop/main.cjs), which
 * runs immediately afterward on success in the real IPC handler.
 *
 * @param {{homeDir: string, keyset: Array<{keyId:string, publicKey:string}>,
 *   currentShellVersion: string, platformArch: string, channel?: string,
 *   onProgress?: (event: {phase: "downloading"|"verifying"|"activating",
 *     kind: "server"|"renderer", receivedBytes: number, totalBytes: number}) => void,
 *   log?: (msg: string) => void, fetchOnce?: Function}} opts
 * @returns {Promise<{ok: true, train: number, version: string} | {ok: false, error: string}>}
 */
async function downloadAndApplyArtifacts(opts) {
  const {
    homeDir,
    keyset,
    currentShellVersion,
    platformArch,
    channel = SEED_CHANNEL,
    onProgress = () => {},
    log = () => {},
    fetchOnce,
  } = opts || {};
  if (!homeDir) throw new Error("artifact-ota: homeDir is required");
  if (!Array.isArray(keyset) || keyset.length === 0) throw new Error("artifact-ota: keyset is required");
  if (!currentShellVersion) throw new Error("artifact-ota: currentShellVersion is required");
  if (!platformArch) throw new Error("artifact-ota: platformArch is required");

  try {
    // Bypass the ETag cache on purpose: the point of a click-triggered
    // download is to get the latest shelf state, not whatever checkOnce
    // last cached.
    const fetched = await fetchChannelManifest({ channel, cachedEtag: null, cachedUrl: null, log, fetchOnce });
    if (fetched.notModified) {
      // Can't happen with no cachedEtag, but guard explicitly rather than
      // silently proceeding with undefined manifest bytes.
      throw new Error("artifact-ota: unexpected 304 with no cache token sent");
    }
    const { manifestBytes, sigBytes, etag, sourceUrl, localDir } = fetched;
    const manifest = manifestModule.verifyManifest(manifestBytes, sigBytes, keyset);

    const currentPointer = await pointerStore.readPointer(homeDir, channel, "current");
    const currentTrain = currentPointer && Number.isInteger(currentPointer.train) ? currentPointer.train : null;
    if (currentTrain !== null && manifest.train <= currentTrain) {
      throw new Error(`train ${manifest.train} is not newer than the current train ${currentTrain}; nothing to apply`);
    }

    if (!isShellVersionSufficient(currentShellVersion, manifest.minShell)) {
      throw new Error(`minShell ${manifest.minShell} > shell ${currentShellVersion}`);
    }

    const rolloutId = await ensureRolloutId(homeDir);
    if (!isInRolloutBucket({ rolloutId, salt: manifest.rollout.salt, percent: manifest.rollout.percent })) {
      throw new Error(`train ${manifest.train} is rollout-excluded for this install`);
    }

    if (await pointerStore.isQuarantined(homeDir, channel, manifest.train)) {
      throw new Error(`train ${manifest.train} is quarantined`);
    }

    const { serverEntry, rendererEntry, version } = deriveArtifactEntries(manifest, platformArch);

    // Same version reconciliation gate checkOnce applies (see
    // `isVersionAlreadyCurrent`'s doc comment) — a version directory is
    // named after the version number, so content stamped with a version
    // that's already activated can never be applied regardless of its
    // sha256. Checked before acquiring the lock or staging anything so a
    // same-version train never triggers a doomed multi-hundred-MB download.
    const rendererChannel = artifactBoot.rendererPointerChannel(channel);
    const currentRendererPointer = await pointerStore.readPointer(homeDir, rendererChannel, "current");
    if (isVersionAlreadyCurrent({ currentServerPointer: currentPointer, currentRendererPointer, serverEntry, rendererEntry })) {
      throw new Error(
        `train ${manifest.train} (${version}) matches the currently activated version ${currentPointer.version}; `
          + "content with the same version can never be applied, even though its bytes differ",
      );
    }

    const lock = await pointerStore.acquireLock(homeDir);
    if (!lock) {
      throw new Error("artifacts lock held by another instance; try again in a moment");
    }

    const stagingDir = path.join(pointerStore.artifactsRoot(homeDir), STAGING_DIRNAME);
    const serverStagedPath = path.join(stagingDir, `server-${serverEntry.version}-${platformArch}.tar.gz`);
    const rendererStagedPath = path.join(stagingDir, `renderer-${rendererEntry.version}.tar.gz`);
    try {
      await fsp.mkdir(stagingDir, { recursive: true });

      onProgress({ phase: "downloading", kind: "server", receivedBytes: 0, totalBytes: serverEntry.size });
      await stageArtifact({
        finalPath: serverStagedPath,
        entry: serverEntry,
        mirrors: manifest.mirrors,
        localDir,
        log,
        label: `server-${serverEntry.version}-${platformArch}`,
        onProgress: (receivedBytes) => onProgress({ phase: "downloading", kind: "server", receivedBytes, totalBytes: serverEntry.size }),
      });
      onProgress({ phase: "verifying", kind: "server", receivedBytes: serverEntry.size, totalBytes: serverEntry.size });

      onProgress({ phase: "downloading", kind: "renderer", receivedBytes: 0, totalBytes: rendererEntry.size });
      await stageArtifact({
        finalPath: rendererStagedPath,
        entry: rendererEntry,
        mirrors: manifest.mirrors,
        localDir,
        log,
        label: `renderer-${rendererEntry.version}`,
        onProgress: (receivedBytes) => onProgress({ phase: "downloading", kind: "renderer", receivedBytes, totalBytes: rendererEntry.size }),
      });
      onProgress({ phase: "verifying", kind: "renderer", receivedBytes: rendererEntry.size, totalBytes: rendererEntry.size });

      // Both boxes staged and sha256-verified. Activate server first, then
      // renderer; roll the server `next` pointer back if renderer's
      // activation fails (see "why a rollback" note in the file header).
      onProgress({ phase: "activating", kind: "server", receivedBytes: serverEntry.size, totalBytes: serverEntry.size });
      await activation.activateFromArchive(serverStagedPath, manifest, {
        homeDir,
        channel,
        kind: "server",
        platformArch,
      });
      onProgress({ phase: "activating", kind: "renderer", receivedBytes: rendererEntry.size, totalBytes: rendererEntry.size });
      try {
        await activation.activateFromArchive(rendererStagedPath, manifest, {
          homeDir,
          channel: rendererChannel,
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
        available: null,
        minShellBlocked: false,
        lastStagedTrain: manifest.train,
      });
      log(`[ota] train ${manifest.train} staged and activated (server ${serverEntry.version}, renderer ${rendererEntry.version})`);
      return { ok: true, train: manifest.train, version };
    } finally {
      await fsp.rm(serverStagedPath, { force: true }).catch(() => {});
      await fsp.rm(rendererStagedPath, { force: true }).catch(() => {});
      await fsp.rm(`${serverStagedPath}.part`, { force: true }).catch(() => {});
      await fsp.rm(`${rendererStagedPath}.part`, { force: true }).catch(() => {});
      await lock.release();
    }
  } catch (err) {
    log(`[ota] download/apply failed: ${err.message}`);
    await writeOtaChannelState(homeDir, channel, { lastCheckedAt: nowIso(), lastError: err.message }).catch(() => {});
    return { ok: false, error: err.message };
  }
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
 * both next pointers land or neither does" invariant `downloadAndApplyArtifacts`
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
 * @returns {Promise<{staged: boolean, train: number|null, version: string|null,
 *   minShellBlocked: boolean, available: object|null, lastError: string|null,
 *   lastCheckedAt: string|null}>}
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
  const channelState = (otaState && otaState[channel]) || {};
  // Read-time compat: a shell built before this field existed only ever
  // wrote the legacy `lastSkipReason` string; a shell built after it
  // writes the boolean directly. Both are honored so an old ota-state.json
  // never crashes or silently reports the wrong thing after an upgrade.
  const minShellBlocked = typeof channelState.minShellBlocked === "boolean"
    ? channelState.minShellBlocked
    : typeof channelState.lastSkipReason === "string" && channelState.lastSkipReason.startsWith("minShell ");
  const available = channelState.available && typeof channelState.available === "object" ? channelState.available : null;
  return {
    ...status,
    minShellBlocked,
    available,
    lastError: typeof channelState.lastError === "string" ? channelState.lastError : null,
    lastCheckedAt: typeof channelState.lastCheckedAt === "string" ? channelState.lastCheckedAt : null,
  };
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
  checkOnce,
  downloadAndApplyArtifacts,
  scheduleBackgroundOtaChecks,
  hasDevOverrideConfigured,
  bothNextPointersReady,
  resolveStagedTrainStatus,
  readStagedTrainStatus,
};
