import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

const {
  APPLY_NOW_STEPS,
  assertPackagedMode,
  checkStagedPrecondition,
  runApplyNowSequence,
} = require("../desktop/src/shared/train-update-apply.cjs");

describe("train-update-apply: assertPackagedMode (dev rejection)", () => {
  it("throws explicitly when not packaged", () => {
    expect(() => assertPackagedMode(false)).toThrow(/only available in packaged builds/i);
  });

  it("does not throw when packaged", () => {
    expect(() => assertPackagedMode(true)).not.toThrow();
  });
});

describe("train-update-apply: checkStagedPrecondition", () => {
  it("rejects a null/undefined status", () => {
    expect(checkStagedPrecondition(null)).toEqual({ ok: false, reason: "not-staged" });
    expect(checkStagedPrecondition(undefined)).toEqual({ ok: false, reason: "not-staged" });
  });

  it("rejects a status with staged !== true", () => {
    expect(checkStagedPrecondition({ staged: false })).toEqual({ ok: false, reason: "not-staged" });
  });

  it("accepts a staged status", () => {
    expect(checkStagedPrecondition({ staged: true, train: 1, version: "1.0.0" })).toEqual({ ok: true });
  });
});

describe("train-update-apply: runApplyNowSequence (ordering + fail-fast, mutation-check target)", () => {
  function makeSteps(overrides: Record<string, () => void | Promise<void>> = {}) {
    const calls: string[] = [];
    const steps = {
      verifyPackaged: vi.fn(async () => { calls.push("verifyPackaged"); }),
      verifyStaged: vi.fn(async () => { calls.push("verifyStaged"); }),
      shutdownServer: vi.fn(async () => { calls.push("shutdownServer"); }),
      startServer: vi.fn(async () => { calls.push("startServer"); }),
      reloadWindows: vi.fn(async () => { calls.push("reloadWindows"); }),
      ...overrides,
    };
    return { steps, calls };
  }

  it("runs every step in the fixed order on success", async () => {
    const { steps, calls } = makeSteps();
    const result = await runApplyNowSequence(steps);
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["verifyPackaged", "verifyStaged", "shutdownServer", "startServer", "reloadWindows"]);
  });

  it("matches the exported APPLY_NOW_STEPS order 1:1", async () => {
    const { steps, calls } = makeSteps();
    await runApplyNowSequence(steps);
    expect(calls).toEqual([...APPLY_NOW_STEPS].map((name: string) => ({
      "verify-packaged": "verifyPackaged",
      "verify-staged": "verifyStaged",
      "shutdown-server": "shutdownServer",
      "start-server": "startServer",
      "reload-windows": "reloadWindows",
    } as Record<string, string>)[name]));
  });

  it("stops at the first throwing step and never runs later steps (fail-fast)", async () => {
    const { steps, calls } = makeSteps({
      shutdownServer: vi.fn(async () => { calls.push("shutdownServer"); throw new Error("boom"); }),
    });
    const result = await runApplyNowSequence(steps);
    expect(result).toEqual({ ok: false, step: "shutdown-server", error: "boom" });
    expect(calls).toEqual(["verifyPackaged", "verifyStaged", "shutdownServer"]);
    expect(steps.startServer).not.toHaveBeenCalled();
    expect(steps.reloadWindows).not.toHaveBeenCalled();
  });

  it("reports the correct failing step name when verify-staged rejects", async () => {
    const { steps } = makeSteps({
      verifyStaged: vi.fn(async () => { throw new Error("not-staged"); }),
    });
    const result = await runApplyNowSequence(steps);
    expect(result).toEqual({ ok: false, step: "verify-staged", error: "not-staged" });
    expect(steps.shutdownServer).not.toHaveBeenCalled();
  });

  it("never rejects even when a step throws (resolves with an ok:false descriptor)", async () => {
    const { steps } = makeSteps({
      startServer: vi.fn(async () => { throw new Error("spawn failed"); }),
    });
    await expect(runApplyNowSequence(steps)).resolves.toEqual({
      ok: false,
      step: "start-server",
      error: "spawn failed",
    });
  });

  it("throws synchronously (not a soft failure) when a step implementation is missing", async () => {
    const { steps } = makeSteps();
    const incompleteSteps = { ...steps } as Partial<typeof steps>;
    delete incompleteSteps.startServer;
    await expect(runApplyNowSequence(incompleteSteps)).rejects.toThrow(/missing step implementation.*start-server/i);
  });
});
