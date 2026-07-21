import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

import {
  REQUIRED_STANDALONE_SERVER_FILES,
  STANDALONE_LAYOUT_ROOT,
  buildWindowsStandaloneArtifact,
  standaloneArtifactNames,
  standaloneWrapperContents,
} from "../scripts/build-standalone-server-artifact.mjs";
import {
  standaloneExecCommandSmokeSpec,
  standaloneRestrictedTokenSmokeSpec,
  verifyWindowsStandaloneArtifact,
} from "../scripts/verify-standalone-server-artifact.mjs";

const require = createRequire(import.meta.url);
const ustar = require("../shared/artifact-core/ustar.cjs");
const tempRoots: string[] = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-standalone-test-"));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ version: "1.2.3" })}\n`);
  return root;
}

function writeFile(root: string, relative: string, content = relative) {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createInputs(root: string) {
  const serverDir = path.join(root, "dist-server", "win-x64");
  for (const relative of REQUIRED_STANDALONE_SERVER_FILES) writeFile(serverDir, relative);
  writeFile(serverDir, "package.json", '{"version":"1.2.3"}\n');
  writeFile(serverDir, "lib/runtime.json", "server source must remain unchanged\n");

  const gitDir = path.join(root, "vendor", "mingit");
  writeFile(gitDir, "cmd/git.exe", "git cmd");
  writeFile(gitDir, "mingw64/bin/git.exe", "git mingw");
  writeFile(gitDir, "usr/bin/sh.exe", "posix shell");
  writeFile(gitDir, "usr/bin/grep.exe", "coreutils");

  const helperPath = path.join(root, "dist-sandbox", "win-x64", "hana-win-sandbox.exe");
  writeFile(path.dirname(helperPath), path.basename(helperPath), "sandbox helper");

  return {
    serverDir,
    gitDir,
    helperPath,
  };
}

function snapshotTree(root: string) {
  const snapshot: Record<string, string> = {};
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = "directory";
        walk(absolute);
      } else {
        snapshot[relative] = createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
      }
    }
  }
  walk(root);
  return snapshot;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Windows standalone server artifact", () => {
  it("keeps the standalone output outside Electron seed resources and the OTA server namespace", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const commonResources = packageJson.build.extraResources as Array<{ from: string; to: string }>;
    const windowsResources = packageJson.build.win.extraResources as Array<{ from: string; to: string }>;

    expect(commonResources.some((resource) => resource.from.includes("dist-standalone"))).toBe(false);
    expect(commonResources).toContainEqual({ from: "dist-server-artifact/${os}-${arch}/", to: "seed/" });
    expect(windowsResources).toContainEqual({ from: "vendor/mingit", to: "git" });
    expect(windowsResources).toContainEqual({ from: "dist-sandbox/win-${arch}/", to: "sandbox/windows/" });
    expect(standaloneArtifactNames("1.2.3").archiveName).not.toMatch(/^server-/);
    expect(fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8")).toMatch(/^dist-standalone\/$/m);
  });

  it("builds a SHA-256-manifested HanaCore archive without mutating the thin server tree", async () => {
    const root = makeTempRoot();
    const inputs = createInputs(root);
    const before = snapshotTree(inputs.serverDir);

    const result = await buildWindowsStandaloneArtifact({ rootDir: root, log: () => {} });
    const names = standaloneArtifactNames("1.2.3");

    expect(path.basename(result.archivePath)).toBe("HanaCore-1.2.3-Windows-x64.tar.gz");
    expect(path.basename(result.archivePath)).toBe(names.archiveName);
    expect(path.basename(result.archivePath)).not.toMatch(/^server-/);
    expect(result.archivePath).toContain(`${path.sep}dist-standalone${path.sep}`);
    expect(fs.existsSync(path.join(root, "dist-server-artifact"))).toBe(false);
    expect(snapshotTree(inputs.serverDir)).toEqual(before);
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    expect(fs.readdirSync(path.join(root, "dist-standalone")).sort()).toEqual([
      names.manifestName,
      names.archiveName,
    ].sort());
    expect(result).not.toHaveProperty("signaturePath");
    expect(standaloneArtifactNames("1.2.3")).not.toHaveProperty("signatureName");

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      schema: 1,
      kind: "hana-core-standalone",
      version: "1.2.3",
      platform: "win32",
      arch: "x64",
      archive: { path: names.archiveName },
      layout: { root: STANDALONE_LAYOUT_ROOT },
      runtime: { minGitVersion: "2.55.0" },
    });

    const extractDir = path.join(root, "extracted");
    await ustar.extract(result.archivePath, extractDir);
    const layoutRoot = path.join(extractDir, STANDALONE_LAYOUT_ROOT);
    expect(fs.readdirSync(layoutRoot).sort()).toEqual(["git", "hana-server.cmd", "hana.cmd", "sandbox", "server"]);
    expect(fs.readFileSync(path.join(layoutRoot, "server", "lib", "runtime.json"), "utf8"))
      .toBe("server source must remain unchanged\n");
    expect(fs.readFileSync(path.join(layoutRoot, "git", "cmd", "git.exe"), "utf8")).toBe("git cmd");
    expect(fs.readFileSync(path.join(layoutRoot, "sandbox", "windows", "hana-win-sandbox.exe"), "utf8"))
      .toBe("sandbox helper");

    const wrappers = standaloneWrapperContents();
    expect(fs.readFileSync(path.join(layoutRoot, "hana.cmd"), "utf8")).toBe(wrappers.hana);
    expect(wrappers.hana).toContain('set "HANA_ROOT=%~dp0server"');
    expect(wrappers.hana).toContain('set "HANA_SERVER_ENTRY=%~dp0server\\bundle\\index.js"');
    expect(wrappers.hana).toContain(
      'set "HANA_WIN32_SANDBOX_HELPER=%~dp0sandbox\\windows\\hana-win-sandbox.exe"',
    );
    expect(wrappers.hana).toContain(
      'set "PATH=%~dp0git\\cmd;%~dp0git\\usr\\bin;%~dp0git\\mingw64\\bin;%PATH%"',
    );
    expect(wrappers.server).toContain('"%~dp0server\\hana-server.exe" "%~dp0server\\bootstrap.js" %*');

    await expect(
      verifyWindowsStandaloneArtifact({ rootDir: root, log: () => {} }),
    ).resolves.toMatchObject({ archivePath: result.archivePath });
  });

  it("fails closed when the packaged server is missing", async () => {
    const root = makeTempRoot();
    await expect(buildWindowsStandaloneArtifact({ rootDir: root, log: () => {} }))
      .rejects.toThrow(/packaged server directory is missing/);
  });

  it("fails closed when MinGit is incomplete", async () => {
    const root = makeTempRoot();
    const inputs = createInputs(root);
    fs.rmSync(path.join(inputs.gitDir, "usr", "bin", "sh.exe"));
    await expect(buildWindowsStandaloneArtifact({ rootDir: root, log: () => {} }))
      .rejects.toThrow(/MinGit runtime is incomplete/);
  });

  it("fails closed when the sandbox helper is missing", async () => {
    const root = makeTempRoot();
    const inputs = createInputs(root);
    fs.rmSync(inputs.helperPath);
    await expect(buildWindowsStandaloneArtifact({ rootDir: root, log: () => {} }))
      .rejects.toThrow(/Windows sandbox helper is missing/);
  });

  it("does not make standalone packaging depend on release signing credentials", async () => {
    const root = makeTempRoot();
    createInputs(root);
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "scripts", "build-standalone-server-artifact.mjs"),
      "utf8",
    );

    expect(source).not.toContain("HANA_SIGN_KEY");
    expect(source).not.toContain("artifact-sign.mjs");
    await expect(buildWindowsStandaloneArtifact({ rootDir: root, log: () => {} })).resolves.toMatchObject({
      manifest: { kind: "hana-core-standalone" },
    });
  });

  it("refuses the Electron seed directory and unsupported architectures", async () => {
    const root = makeTempRoot();
    createInputs(root);
    await expect(
      buildWindowsStandaloneArtifact({
        rootDir: root,
        artifactOutDir: path.join(root, "dist-server-artifact", "win32-x64"),
        log: () => {},
      }),
    ).rejects.toThrow(/must not enter dist-server-artifact/);
    await expect(
      buildWindowsStandaloneArtifact({
        rootDir: root,
        artifactOutDir: path.join(root, "dist-server"),
        log: () => {},
      }),
    ).rejects.toThrow(/dist-standalone/);
    await expect(buildWindowsStandaloneArtifact({ rootDir: root, arch: "arm64", log: () => {} }))
      .rejects.toThrow(/only x64 is published/);
  });

  it("removes a stale same-version release set before validating a failed rebuild", async () => {
    const root = makeTempRoot();
    const inputs = createInputs(root);
    const first = await buildWindowsStandaloneArtifact({ rootDir: root, log: () => {} });
    const legacySignaturePath = `${first.manifestPath}.sig`;
    fs.writeFileSync(legacySignaturePath, "obsolete standalone signature");
    fs.rmSync(inputs.helperPath);

    await expect(buildWindowsStandaloneArtifact({ rootDir: root, log: () => {} }))
      .rejects.toThrow(/Windows sandbox helper is missing/);
    expect(fs.existsSync(first.archivePath)).toBe(false);
    expect(fs.existsSync(first.manifestPath)).toBe(false);
    expect(fs.existsSync(legacySignaturePath)).toBe(false);
  });

  it("rejects an obsolete standalone signature sidecar", async () => {
    const root = makeTempRoot();
    createInputs(root);
    const result = await buildWindowsStandaloneArtifact({ rootDir: root, log: () => {} });
    fs.writeFileSync(`${result.manifestPath}.sig`, "obsolete standalone signature");

    await expect(verifyWindowsStandaloneArtifact({ rootDir: root, log: () => {} }))
      .rejects.toThrow(/obsolete standalone manifest signature must be removed/);
  });

  it("rejects manifest layout fields that do not describe the archive contract", async () => {
    const root = makeTempRoot();
    createInputs(root);
    const result = await buildWindowsStandaloneArtifact({ rootDir: root, log: () => {} });
    const original = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    const cases = [
      ["root", "WrongRoot"],
      ["server", `${STANDALONE_LAYOUT_ROOT}/wrong-server`],
      ["git", `${STANDALONE_LAYOUT_ROOT}/wrong-git`],
      ["sandboxHelper", `${STANDALONE_LAYOUT_ROOT}/sandbox/windows/wrong-helper.exe`],
    ];

    for (const [field, value] of cases) {
      const changed = structuredClone(original);
      changed.layout[field] = value;
      fs.writeFileSync(result.manifestPath, `${JSON.stringify(changed, null, 2)}\n`);
      await expect(verifyWindowsStandaloneArtifact({ rootDir: root, log: () => {} }))
        .rejects.toThrow(new RegExp(`manifest .*${field === "sandboxHelper" ? "sandbox helper" : field}.* mismatch`, "i"));
    }
  });

  it("builds a restricted-token smoke spec that proves write and deny-write through a native child", () => {
    const spec = standaloneRestrictedTokenSmokeSpec({
      layoutRoot: "C:\\downloads\\HanaCore",
      workDir: "C:\\Temp\\hana smoke",
      hanaHome: "C:\\Temp\\hana home",
      env: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", Path: "stale-duplicate" },
    });

    expect(spec.helperPath).toBe("C:\\downloads\\HanaCore\\sandbox\\windows\\hana-win-sandbox.exe");
    expect(spec.args).toEqual([
      "--cwd", "C:\\Temp\\hana smoke",
      "--writable-root", "C:\\Temp\\hana smoke",
      "--deny-write", "C:\\Temp\\hana smoke\\blocked",
      "--timeout-ms", "30000",
      "--",
      "C:\\Windows\\System32\\cmd.exe",
      "/d", "/s", "/c",
      expect.stringContaining("HANA_RESTRICTED_TOKEN_OK"),
    ]);
    expect(Object.keys(spec.env).filter((key) => key.toLowerCase() === "path")).toEqual(["Path"]);
    expect(spec.env.Path).toBe([
      "C:\\downloads\\HanaCore\\git\\cmd",
      "C:\\downloads\\HanaCore\\git\\usr\\bin",
      "C:\\downloads\\HanaCore\\git\\mingw64\\bin",
      "C:\\Windows\\System32",
    ].join(";"));
    // MSYS/Cygwin binaries cannot initialize under a restricted token, so the
    // child must stay a native PE binary (cmd.exe) and the temp dirs must sit
    // inside the only writable root, matching the production sandbox contract.
    expect(spec.args.at(-1)).toContain("HANA_DENY_WRITE_OK");
    expect(spec.args.at(-1)).toContain("exit 73");
    expect(spec.env.TEMP).toBe("C:\\Temp\\hana smoke");
    expect(spec.env.TMP).toBe("C:\\Temp\\hana smoke");
    expect(spec.deniedMarkerPath).toBe("C:\\Temp\\hana smoke\\blocked\\hana-deny-write-smoke.txt");
    expect(spec.env).toMatchObject({
      SystemRoot: "C:\\Windows",
      HANA_HOME: "C:\\Temp\\hana home",
      HANA_ROOT: "C:\\downloads\\HanaCore\\server",
      HANA_SERVER_ENTRY: "C:\\downloads\\HanaCore\\server\\bundle\\index.js",
      HANA_WIN32_SANDBOX_HELPER: spec.helperPath,
    });
  });

  it("runs the production exec_command chain through the extracted wrapper with a hermetic environment", () => {
    const spec = standaloneExecCommandSmokeSpec({
      layoutRoot: "C:\\downloads\\HanaCore",
      workDir: "C:\\Temp\\hana smoke",
      hanaHome: "C:\\Temp\\hana home",
      env: {
        SystemRoot: "C:\\Windows",
        PATH: "C:\\Program Files\\Git\\cmd;C:\\host-tools",
        NODE_OPTIONS: "--require C:\\host\\inject.cjs",
      },
    });

    expect(spec.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(spec.args.join(" ")).toContain('call "C:\\downloads\\HanaCore\\hana-server.cmd"');
    expect(spec.env.Path).not.toContain("Program Files\\Git");
    expect(spec.env.HANA_ROOT).toBe("Z:\\hana-poison\\server");
    expect(spec.env.HANA_STANDALONE_EXPECTED_ROOT).toBe("C:\\downloads\\HanaCore\\server");
    expect(spec.env.HANA_STANDALONE_EXPECTED_HELPER)
      .toBe("C:\\downloads\\HanaCore\\sandbox\\windows\\hana-win-sandbox.exe");
    expect(spec.env.HANA_INTERNAL_STANDALONE_RUNTIME_SMOKE).toBe("1");
    expect(spec.env).not.toHaveProperty("NODE_OPTIONS");
    expect(spec.env).not.toHaveProperty("HANA_STANDALONE_EXEC_MARKER");
  });

  it("rejects an archive whose bytes no longer match its manifest", async () => {
    const root = makeTempRoot();
    createInputs(root);
    const result = await buildWindowsStandaloneArtifact({ rootDir: root, log: () => {} });
    fs.appendFileSync(result.archivePath, "tampered");
    await expect(verifyWindowsStandaloneArtifact({ rootDir: root, log: () => {} }))
      .rejects.toThrow(/archive sha256 mismatch/);
  });
});
