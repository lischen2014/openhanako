"use strict";

const fs = require("fs");
const path = require("path");
const { atomicWriteJson } = require("./artifact-core/pointer-store.cjs");

/**
 * shared/data-epoch.cjs — the "only-goes-up" data format contract gate.
 *
 * Threat model this closes (轮流开 / alternating-use degradation, distinct
 * from the same-time double-open mutex in shared/server-info-probe.cjs):
 * a user runs a newer kernel that evolves the on-disk data format (a new
 * SQLite column with meaning the old code doesn't know about, a changed
 * session JSONL shape, etc.), then later opens the same HANA_HOME with an
 * older kernel binary — an old desktop build reinstalled, a pinned `hana`
 * CLI version, a downgrade. The old code reads the new data with its old
 * understanding of the shape and silently corrupts it: no crash, no error,
 * just logically wrong state that surfaces as confusing bugs much later.
 * Before this gate there was zero defense against that path.
 *
 * DATA_EPOCH (see shared/contract-versions.cjs) is a small integer that
 * only increments on a breaking data-format change — never on additive
 * schema growth (new table, new optional field). Every kernel build knows
 * its own epoch. This module stamps the *highest* epoch any kernel has
 * ever confirmed against a given HANA_HOME into `data-epoch.json`, and
 * refuses to start a kernel whose own epoch is lower than that stamp
 * unless the operator explicitly opts in.
 *
 * Design choices, and why they differ from the two closest prior-art
 * systems:
 *   - Postgres's postmaster.pid: a raw PID + inode identity file that
 *     requires a human to delete it by hand after a crash, and can
 *     misjudge a recycled PID as still-owning. This module doesn't touch
 *     PID logic at all — that's shared/server-info-probe.cjs's job. This
 *     module is purely a data-format version, and the epoch stamp itself
 *     is corruption-resistant (fail-closed on unparsable JSON, see below)
 *     rather than requiring manual cleanup on the happy path.
 *   - Firefox's compatibility.ini: blocks on *any* version regression,
 *     which is user-hostile for the common case of "I reinstalled an
 *     older build to work around an unrelated regression" — a pure
 *     version rollback that touches no data format at all gets needlessly
 *     blocked. This module deliberately tracks `lastVersion` for
 *     diagnostics only and NEVER gates on it — only the independent
 *     DATA_EPOCH integer gates. An old kernel with an unchanged data
 *     format can always reopen a HANA_HOME a newer build touched.
 *
 * Stamp file shape: `{ epoch: number, lastVersion: string, updatedAt: string }`.
 *
 * assertAndStampDataEpoch() returns a structured decision and performs the
 * stamp write itself (via the single atomicWriteJson source shared with
 * artifact-core) but deliberately never calls process.exit — the caller
 * (server/index.ts, or a test) decides what "not allowed" means for its
 * context, which keeps this module unit-testable without spawning a real
 * process.
 */

/**
 * @param {string} homeDir
 * @returns {string}
 */
function dataEpochStampPath(homeDir) {
  return path.join(homeDir, "data-epoch.json");
}

/**
 * @param {{ homeDir: string, ownEpoch: number, ownVersion: string,
 *            allowDowngrade?: boolean, log?: { warn: (msg: string) => void } }} args
 * @returns {Promise<
 *   | { allowed: true, action: "stamped-new" | "stamped-upgrade" | "downgrade-allowed", epoch: number, stampPath: string }
 *   | { allowed: false, reason: "corrupt-stamp", detail: string, stampPath: string }
 *   | { allowed: false, reason: "epoch-downgrade-blocked", stampEpoch: number, ownEpoch: number, stampLastVersion: string | null, stampPath: string }
 * >}
 */
async function assertAndStampDataEpoch({ homeDir, ownEpoch, ownVersion, allowDowngrade = false, log = console } = {}) {
  const stampPath = dataEpochStampPath(homeDir);

  let raw = null;
  try {
    raw = fs.readFileSync(stampPath, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      // Unexpected filesystem error (permissions, etc.) — treat the same as
      // a corrupt stamp: we cannot establish what epoch this home is at,
      // so fail closed rather than guess.
      return { allowed: false, reason: "corrupt-stamp", detail: err.message, stampPath };
    }
  }

  if (raw === null) {
    // Never-stamped home directory — either brand new, or an existing user
    // directory from before this gate shipped. Both cases are safe to
    // adopt at this kernel's own epoch: an unstamped directory has no
    // record of ever having been touched by a higher epoch.
    await atomicWriteJson(stampPath, { epoch: ownEpoch, lastVersion: ownVersion, updatedAt: new Date().toISOString() });
    return { allowed: true, action: "stamped-new", epoch: ownEpoch, stampPath };
  }

  let stamp;
  try {
    stamp = JSON.parse(raw);
  } catch (err) {
    // Fail-closed: a stamp file that exists but cannot be parsed is an
    // unknown state, not an absent one. Guessing here (e.g. treating it
    // like "stamped-new") could silently let a downgraded kernel back in
    // after a partial write or external corruption. Refuse and tell the
    // operator exactly which file to look at.
    return { allowed: false, reason: "corrupt-stamp", detail: err.message, stampPath };
  }

  if (!stamp || typeof stamp.epoch !== "number" || !Number.isInteger(stamp.epoch)) {
    return { allowed: false, reason: "corrupt-stamp", detail: "stamp file is missing a valid integer `epoch` field", stampPath };
  }

  if (stamp.epoch > ownEpoch) {
    if (!allowDowngrade) {
      return {
        allowed: false,
        reason: "epoch-downgrade-blocked",
        stampEpoch: stamp.epoch,
        ownEpoch,
        stampLastVersion: typeof stamp.lastVersion === "string" ? stamp.lastVersion : null,
        stampPath,
      };
    }
    // Operator explicitly accepted the risk. The stamp is intentionally
    // NOT rewritten here — "only goes up" means a downgraded kernel run
    // must never lower the recorded epoch, so the next upgrade back to a
    // newer kernel still sees the true high-water mark.
    log.warn(
      `[data-epoch] WARNING: opening a data directory last touched by a newer data format `
      + `(stamp epoch=${stamp.epoch}, this kernel epoch=${ownEpoch}). Proceeding because an explicit `
      + `downgrade override was set. This kernel may not understand newer data and could corrupt it. `
      + `警告：正在以旧内核（epoch=${ownEpoch}）打开被更高数据格式（epoch=${stamp.epoch}）触碰过的数据目录，`
      + `已按显式覆盖设置放行，但本内核可能无法正确理解较新的数据，存在损坏风险。`
    );
    return { allowed: true, action: "downgrade-allowed", epoch: stamp.epoch, stampPath };
  }

  // stamp.epoch <= ownEpoch: this kernel is at least as new as anything
  // that has touched this home before. Bump the stamp to this kernel's own
  // epoch (a no-op write when already equal) and refresh lastVersion —
  // lastVersion is diagnostic only, see the module doc comment for why it
  // must never gate.
  await atomicWriteJson(stampPath, { epoch: ownEpoch, lastVersion: ownVersion, updatedAt: new Date().toISOString() });
  return { allowed: true, action: "stamped-upgrade", epoch: ownEpoch, stampPath };
}

/**
 * Pure formatter for the bilingual rejection message, kept separate from
 * assertAndStampDataEpoch's I/O so its exact wording is unit-testable.
 * @param {{ stampEpoch: number, ownEpoch: number, stampLastVersion: string | null }} args
 */
function describeDataEpochBlock({ stampEpoch, ownEpoch, stampLastVersion }) {
  const lastVersionNote = stampLastVersion ? ` (last opened by version ${stampLastVersion})` : "";
  return (
    `此数据目录已被更高数据格式版本的内核使用过${lastVersionNote}（数据 epoch=${stampEpoch}，本内核 epoch=${ownEpoch}）。`
    + `继续使用旧内核可能静默损坏数据。请升级到较新版本，或如果你清楚风险，`
    + `设置环境变量 HANA_ALLOW_DATA_DOWNGRADE=1（或对 hana serve 传 --allow-data-downgrade）显式接受数据损坏风险后重试。\n`
    + `This data directory has been used by a kernel with a newer data format${lastVersionNote} `
    + `(data epoch=${stampEpoch}, this kernel epoch=${ownEpoch}). Continuing with an older kernel risks `
    + `silently corrupting data. Upgrade to a newer version, or if you understand the risk, set `
    + `HANA_ALLOW_DATA_DOWNGRADE=1 (or pass --allow-data-downgrade to hana serve) to proceed anyway.`
  );
}

module.exports = {
  dataEpochStampPath,
  assertAndStampDataEpoch,
  describeDataEpochBlock,
};
