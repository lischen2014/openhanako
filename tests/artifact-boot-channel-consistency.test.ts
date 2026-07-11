/**
 * artifact-boot-channel-consistency.test.ts — regression coverage for the
 * 2026-07-12 beta-channel first-boot crash.
 *
 * Root cause: `desktop/main.cjs`'s `resolvePackagedArtifactBoot()` read
 * the user's channel preference once (`readUpdateChannelPreference()`)
 * and passed it to `prepareArtifactBoot`, but three downstream consumers
 * within the same function still hardcoded `artifactBoot.SEED_CHANNEL`
 * ("stable") instead of reusing that value: `_rendererBootChannel`'s
 * derivation, the server GC call's `channel`, and (transitively, since
 * it inherits from `_rendererBootChannel`) the renderer GC call's
 * `channel`. On a beta-preference machine this meant: activation wrote
 * `beta.*` pointers, but GC read the `stable` ledger to decide what to
 * keep — the just-activated beta version directory wasn't in the stable
 * keep set, so GC deleted it, and the next server spawn ran against an
 * empty directory.
 *
 * `desktop/main.cjs` is an Electron main-process entry (imports
 * `electron`, touches module-level state, calls `app.*`) and cannot be
 * `require()`d directly in a plain vitest/Node environment. Per this
 * repo's established contract-test pattern (see
 * `tests/server-startup-diagnostics-contract.test.ts`'s
 * `extractFunctionSource` + `vm` usage), this file extracts
 * `resolvePackagedArtifactBoot` and `readUpdateChannelPreference`'s
 * *exact* source text out of main.cjs and runs them in a `vm` context
 * with every free variable they close over stubbed out — this is
 * genuine behavioral coverage of the real, shipped source, not a
 * reimplementation that could drift from it.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import vm from "vm";

const root = process.cwd();

// Same technique as tests/server-startup-diagnostics-contract.test.ts's
// helper, but paren-aware: that original version located the function
// body by scanning for the first "{" after the function name, which
// breaks for any function whose parameter list itself destructures an
// object (e.g. `function f({ a, b }) { ... }` — the destructuring "{"
// is not the body). This variant first walks past the balanced "(...)"
// parameter list, then finds the body's opening "{".
function extractFunctionSource(source: string, name: string) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const plainStart = source.indexOf(`function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : plainStart;
  if (start < 0) throw new Error(`missing function ${name}`);
  const parenStart = source.indexOf("(", start);
  if (parenStart < 0) throw new Error(`missing parameter list for function ${name}`);
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < source.length; i++) {
    if (source[i] === "(") parenDepth++;
    if (source[i] === ")") parenDepth--;
    if (parenDepth === 0) { parenEnd = i; break; }
  }
  if (parenEnd < 0) throw new Error(`unterminated parameter list for function ${name}`);
  const bodyStart = source.indexOf("{", parenEnd);
  if (bodyStart < 0) throw new Error(`missing body for function ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

type RunResult = {
  result: { serverRoot: string; train: number; channel: string } | null;
  gcCalls: Array<{ kind: string; channel: string }>;
  prepareArtifactBootChannels: string[];
  rendererBootChannel: string | null;
  artifactBootChannel: string | null;
};

/**
 * Runs the real `resolvePackagedArtifactBoot` (+ `readUpdateChannelPreference`)
 * source extracted from `desktop/main.cjs` inside a `vm` context, with a
 * fake `artifactBoot.prepareArtifactBoot`/`artifactGc.gcArtifactKind` that
 * just record what channel they were called with — exactly the seam the
 * 2026-07-12 incident broke.
 */
async function runResolvePackagedArtifactBoot(updateChannelPreference: "stable" | "beta"): Promise<RunResult> {
  const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
  const readPrefSource = extractFunctionSource(mainSource, "readUpdateChannelPreference");
  const resolveSource = extractFunctionSource(mainSource, "resolvePackagedArtifactBoot");

  const gcCalls: Array<{ kind: string; channel: string }> = [];
  const prepareArtifactBootChannels: string[] = [];

  const artifactBoot = {
    SEED_CHANNEL: "stable",
    hasSeed: () => true,
    rendererPointerChannel: (channel: string) => `${channel}.renderer`,
    prepareArtifactBoot: async (opts: { channel: string }) => {
      prepareArtifactBootChannels.push(opts.channel);
      return {
        server: {
          train: 3,
          version: "0.446.14",
          slot: "current",
          versionDir: `/artifacts/server/0.446.14-darwin-arm64`,
          activatedSeed: true,
          crashFallback: false,
          quarantinedTrain: null,
        },
        renderer: {
          train: 3,
          version: "0.446.14",
          slot: "current",
          versionDir: `/artifacts/renderer/0.446.14`,
          activatedSeed: true,
          crashFallback: false,
          quarantinedTrain: null,
        },
      };
    },
  };
  const artifactGc = {
    gcArtifactKind: async (opts: { kind: string; channel: string }) => {
      gcCalls.push({ kind: opts.kind, channel: opts.channel });
      return { removed: [] };
    },
  };

  const context = vm.createContext({
    hanakoHome: "/tmp/hana-home-fixture",
    app: { isPackaged: true },
    process: { resourcesPath: "/tmp/resources", platform: "darwin", arch: "arm64" },
    path,
    artifactBoot,
    artifactGc,
    splashWindow: null,
    loadSplashWindowURL: () => {},
    loadPinnedKeyset: () => [],
    redactMainLogText: (msg: string) => msg,
    notifyComponentQuarantined: () => {},
    safeReadJSON: () => ({ update_channel: updateChannelPreference }),
    console,
    _distRenderer: null,
    _rendererBootChannel: null,
    _rendererBootTrain: null,
    _artifactBootChannel: null,
  });

  vm.runInContext(`${readPrefSource}\n${resolveSource}`, context);
  const result = await (context as any).resolvePackagedArtifactBoot();

  return {
    result,
    gcCalls,
    prepareArtifactBootChannels,
    rendererBootChannel: (context as any)._rendererBootChannel,
    artifactBootChannel: (context as any)._artifactBootChannel,
  };
}

describe("artifact-boot channel consistency (2026-07-12 beta-channel crash regression)", () => {
  it("threads the beta channel preference through prepareArtifactBoot, both GC calls, and the returned context — not the stable default", async () => {
    const run = await runResolvePackagedArtifactBoot("beta");

    expect(run.prepareArtifactBootChannels).toEqual(["beta"]);
    expect(run.rendererBootChannel).toBe("beta.renderer");
    expect(run.artifactBootChannel).toBe("beta");
    expect(run.result?.channel).toBe("beta");

    // The accident: GC ran against "stable" while activation ran against
    // "beta" — every GC call this function makes must agree with the
    // channel prepareArtifactBoot activated against.
    expect(run.gcCalls).toEqual([
      { kind: "server", channel: "beta" },
      { kind: "renderer", channel: "beta.renderer" },
    ]);
    for (const call of run.gcCalls) {
      expect(call.channel === "beta" || call.channel === "beta.renderer").toBe(true);
      expect(call.channel === "stable" || call.channel === "stable.renderer").toBe(false);
    }
  });

  it("still resolves the stable channel correctly for stable-preference machines (no regression on the default path)", async () => {
    const run = await runResolvePackagedArtifactBoot("stable");

    expect(run.prepareArtifactBootChannels).toEqual(["stable"]);
    expect(run.rendererBootChannel).toBe("stable.renderer");
    expect(run.artifactBootChannel).toBe("stable");
    expect(run.result?.channel).toBe("stable");
    expect(run.gcCalls).toEqual([
      { kind: "server", channel: "stable" },
      { kind: "renderer", channel: "stable.renderer" },
    ]);
  });
});

describe("artifact-boot channel consistency: crash-sentinel + renderer-retry source contract", () => {
  // `_spawnServerOnce` and `handleRendererArtifactLoadFailure` are too
  // deeply wired into Electron/process/spawn machinery to run in a vm
  // sandbox without a disproportionate amount of stubbing (see this
  // repo's own comment on that tradeoff in
  // server-startup-diagnostics-contract.test.ts). Their piece of this
  // regression — two more call sites that silently defaulted to the
  // "stable" pointer namespace instead of the channel this boot actually
  // resolved — is covered as a source contract instead: the specific
  // hardcoded-constant pattern that caused the incident must not
  // reappear in either function's body.
  const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
  const spawnServerOnceSource = extractFunctionSource(mainSource, "_spawnServerOnce");
  const rendererRetrySource = extractFunctionSource(mainSource, "handleRendererArtifactLoadFailure");

  it("_spawnServerOnce reads the crash-sentinel channel off artifactBootContext, not the stable constant", () => {
    expect(spawnServerOnceSource).toContain("artifactBoot.writeBootSentinel(hanakoHome, artifactBootContext.channel, artifactBootContext.train)");
    expect(spawnServerOnceSource).toContain("channel: artifactBootContext.channel,");
    expect(spawnServerOnceSource).not.toContain("artifactBoot.SEED_CHANNEL");
  });

  it("handleRendererArtifactLoadFailure's renderer-crash retry passes the session's boot channel to prepareArtifactRendererBoot", () => {
    expect(rendererRetrySource).toContain("prepareArtifactRendererBoot({");
    expect(rendererRetrySource).toContain("channel: _artifactBootChannel,");
  });
});
