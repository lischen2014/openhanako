#!/usr/bin/env node
/**
 * Fail-closed verification for the Windows HanaCore standalone release asset.
 * Verification happens after packaging and before CI uploads anything.
 */
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

import { assertRuntimeComplete, MINGIT_VERSION } from "./mingit-runtime.js";
import { createHermeticMinGitSmokeEnv } from "./smoke-mingit.mjs";
import {
  REQUIRED_STANDALONE_SERVER_FILES,
  ROOT,
  STANDALONE_ARCH,
  STANDALONE_LAYOUT_ROOT,
  STANDALONE_PLATFORM,
  readProductVersion,
  standaloneArtifactNames,
  standaloneWrapperContents,
} from "./build-standalone-server-artifact.mjs";

const require = createRequire(import.meta.url);
const ustar = require("../shared/artifact-core/ustar.cjs");
const activation = require("../shared/artifact-core/activation.cjs");
const __filename = fileURLToPath(import.meta.url);

function assertFile(filePath, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`[verify-standalone] ${label} is missing: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`[verify-standalone] ${label} must be a file: ${filePath}`);
  }
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `[verify-standalone] ${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertExtractedLayout(layoutRoot) {
  const expectedRootEntries = ["git", "hana-server.cmd", "hana.cmd", "sandbox", "server"];
  const actualRootEntries = fs.readdirSync(layoutRoot).sort();
  expectEqual(JSON.stringify(actualRootEntries), JSON.stringify(expectedRootEntries), "archive root entries");

  for (const relative of REQUIRED_STANDALONE_SERVER_FILES) {
    assertFile(path.join(layoutRoot, "server", ...relative.split("/")), `packaged server file ${relative}`);
  }
  assertFile(
    path.join(layoutRoot, "sandbox", "windows", "hana-win-sandbox.exe"),
    "Windows sandbox helper",
  );
  try {
    assertRuntimeComplete(path.join(layoutRoot, "git"));
  } catch (error) {
    throw new Error(`[verify-standalone] extracted MinGit runtime is incomplete\n${error.message}`);
  }

  const wrappers = standaloneWrapperContents();
  expectEqual(fs.readFileSync(path.join(layoutRoot, "hana.cmd"), "utf8"), wrappers.hana, "hana.cmd");
  expectEqual(
    fs.readFileSync(path.join(layoutRoot, "hana-server.cmd"), "utf8"),
    wrappers.server,
    "hana-server.cmd",
  );
}

export function standaloneRestrictedTokenSmokeSpec({ layoutRoot, workDir, hanaHome, env = process.env }) {
  const helperPath = path.win32.join(layoutRoot, "sandbox", "windows", "hana-win-sandbox.exe");
  const smokeEnv = createHermeticMinGitSmokeEnv({
    runtimeRoot: path.win32.join(layoutRoot, "git"),
    workRoot: hanaHome,
    env,
  });
  Object.assign(smokeEnv, {
    // The sandbox grants write access to workDir only, so the child's temp
    // dirs must live inside it. Production win32-exec follows the same
    // contract by pointing TEMP at a directory it also grants.
    TEMP: workDir,
    TMP: workDir,
    HANA_HOME: hanaHome,
    HANA_ROOT: path.win32.join(layoutRoot, "server"),
    HANA_SERVER_ENTRY: path.win32.join(layoutRoot, "server", "bundle", "index.js"),
    HANA_WIN32_SANDBOX_HELPER: helperPath,
  });
  const markerFileName = "hana-restricted-token-smoke.txt";
  const blockedDirName = "blocked";
  const deniedFileName = "hana-deny-write-smoke.txt";
  // The child must be a native PE binary: MSYS/Cygwin programs such as
  // usr/bin/sh.exe fail to initialize (STATUS_DLL_INIT_FAILED) under a
  // restricted token, so cmd.exe carries the writable-root and deny-write
  // proof. Sandboxed Git startup is covered by the exec_command smoke below,
  // which reaches it through the production exec chain.
  const shellCommand =
    `echo HANA_RESTRICTED_TOKEN_OK>${markerFileName}`
    + ` && type ${markerFileName}`
    + ` && (echo SHOULD_NOT_WRITE>${blockedDirName}\\${deniedFileName})`
    + " && exit 73"
    + " || echo HANA_DENY_WRITE_OK";
  return {
    helperPath,
    markerPath: path.win32.join(workDir, markerFileName),
    blockedDir: path.win32.join(workDir, blockedDirName),
    deniedMarkerPath: path.win32.join(workDir, blockedDirName, deniedFileName),
    env: smokeEnv,
    args: [
      "--cwd", workDir,
      "--writable-root", workDir,
      "--deny-write", path.win32.join(workDir, blockedDirName),
      "--timeout-ms", "30000",
      "--",
      smokeEnv.ComSpec,
      "/d", "/s", "/c",
      shellCommand,
    ],
  };
}

export function standaloneExecCommandSmokeSpec({ layoutRoot, workDir, hanaHome, env = process.env }) {
  const baseEnv = createHermeticMinGitSmokeEnv({
    runtimeRoot: path.win32.join(layoutRoot, "git"),
    workRoot: hanaHome,
    env,
  });
  const helperPath = path.win32.join(layoutRoot, "sandbox", "windows", "hana-win-sandbox.exe");
  const serverRoot = path.win32.join(layoutRoot, "server");
  return {
    command: baseEnv.ComSpec,
    args: ["/d", "/s", "/c", `call "${path.win32.join(layoutRoot, "hana-server.cmd")}"`],
    env: {
      ...baseEnv,
      HANA_HOME: hanaHome,
      // Poison values prove the extracted wrapper, rather than the verifier,
      // owns the packaged runtime contract before Node imports the probe.
      HANA_ROOT: "Z:\\hana-poison\\server",
      HANA_SERVER_ENTRY: "Z:\\hana-poison\\server\\bundle\\index.js",
      HANA_WIN32_SANDBOX_HELPER: "Z:\\hana-poison\\sandbox\\hana-win-sandbox.exe",
      HANA_INTERNAL_STANDALONE_RUNTIME_SMOKE: "1",
      HANA_STANDALONE_EXEC_WORK: workDir,
      HANA_STANDALONE_EXPECTED_HELPER: helperPath,
      HANA_STANDALONE_EXPECTED_ROOT: serverRoot,
    },
  };
}

function smokeExtractedRuntime({ rootDir, layoutRoot }) {
  if (process.platform !== "win32") {
    throw new Error("[verify-standalone] --smoke is Windows-only because the archive contains Windows executables");
  }

  execFileSync(
    process.execPath,
    [path.join(rootDir, "scripts", "smoke-mingit.mjs"), path.join(layoutRoot, "git")],
    { stdio: "inherit" },
  );

  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-standalone-runtime-"));
  const smokeHome = path.join(smokeRoot, "hana-home");
  const workDir = path.join(smokeRoot, "work");
  fs.mkdirSync(smokeHome, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(smokeHome, "agents", "standalone-smoke"), { recursive: true });
  try {
    const spec = standaloneRestrictedTokenSmokeSpec({ layoutRoot, workDir, hanaHome: smokeHome });
    fs.mkdirSync(spec.blockedDir, { recursive: true });
    const sandboxResult = spawnSync(spec.helperPath, spec.args, {
      cwd: workDir,
      env: spec.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 45_000,
    });
    if (sandboxResult.error || sandboxResult.status !== 0) {
      throw new Error(
        "[verify-standalone] restricted-token sandbox smoke failed"
          + ` (status=${String(sandboxResult.status)}, signal=${String(sandboxResult.signal)})`
          + (sandboxResult.error ? `: ${sandboxResult.error.message}` : "")
          + (sandboxResult.stderr ? `\nstderr: ${sandboxResult.stderr.trim()}` : ""),
      );
    }
    const smokeStdout = String(sandboxResult.stdout || "");
    const smokeStderr = String(sandboxResult.stderr || "");
    if (!smokeStdout.includes("HANA_RESTRICTED_TOKEN_OK")) {
      throw new Error("[verify-standalone] restricted-token sandbox smoke did not emit its success marker");
    }
    if (!smokeStdout.includes("HANA_DENY_WRITE_OK")) {
      throw new Error("[verify-standalone] restricted-token sandbox smoke did not prove deny-write enforcement");
    }
    const terminalRecord = 'hana-win-sandbox: terminal-v1 status="exited" exitCode="0" timeoutMs="30000" win32Error="0"';
    if (!smokeStderr.includes(terminalRecord)) {
      throw new Error(
        `[verify-standalone] restricted-token sandbox smoke emitted no successful terminal record\nstderr: ${smokeStderr.trim()}`,
      );
    }
    expectEqual(
      fs.readFileSync(spec.markerPath, "utf8").trim(),
      "HANA_RESTRICTED_TOKEN_OK",
      "restricted-token writable-root marker",
    );
    if (fs.existsSync(spec.deniedMarkerPath)) {
      throw new Error("[verify-standalone] restricted-token sandbox wrote inside an explicit deny-write path");
    }

    const execSpec = standaloneExecCommandSmokeSpec({
      layoutRoot,
      workDir,
      hanaHome: smokeHome,
    });
    const execResult = spawnSync(execSpec.command, execSpec.args, {
      cwd: layoutRoot,
      env: execSpec.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 90_000,
    });
    if (execResult.error || execResult.status !== 0) {
      throw new Error(
        "[verify-standalone] packaged exec_command smoke failed"
          + ` (status=${String(execResult.status)}, signal=${String(execResult.signal)})`
          + (execResult.error ? `: ${execResult.error.message}` : "")
          + (execResult.stdout ? `\nstdout: ${execResult.stdout.trim()}` : "")
          + (execResult.stderr ? `\nstderr: ${execResult.stderr.trim()}` : ""),
      );
    }
    const receiptPrefix = "HANA_STANDALONE_EXEC_RECEIPT=";
    const receiptLine = String(execResult.stdout || "")
      .split(/\r?\n/)
      .find((line) => line.startsWith(receiptPrefix));
    if (!receiptLine) {
      throw new Error(
        "[verify-standalone] packaged exec_command smoke emitted no receipt"
          + (execResult.stdout ? `\nstdout: ${execResult.stdout.trim()}` : "")
          + (execResult.stderr ? `\nstderr: ${execResult.stderr.trim()}` : ""),
      );
    }
    const execReceipt = JSON.parse(receiptLine.slice(receiptPrefix.length));
    expectEqual(execReceipt.ok, true, "exec_command packaged-runtime smoke status");
  } finally {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

/**
 * @param {{
 *   rootDir?: string,
 *   version?: string,
 *   arch?: string,
 *   artifactOutDir?: string,
 *   smoke?: boolean,
 *   log?: (message: string) => void,
 * }} opts
 */
export async function verifyWindowsStandaloneArtifact(opts = {}) {
  const rootDir = path.resolve(opts.rootDir ?? ROOT);
  const version = opts.version ?? readProductVersion(rootDir);
  const arch = opts.arch ?? STANDALONE_ARCH;
  const artifactOutDir = path.resolve(opts.artifactOutDir ?? path.join(rootDir, "dist-standalone"));
  const names = standaloneArtifactNames(version, arch);
  const archivePath = path.join(artifactOutDir, names.archiveName);
  const manifestPath = path.join(artifactOutDir, names.manifestName);
  const legacySignaturePath = `${manifestPath}.sig`;
  const log = opts.log ?? console.log;

  assertFile(archivePath, "standalone archive");
  assertFile(manifestPath, "standalone manifest");
  if (fs.existsSync(legacySignaturePath)) {
    throw new Error(
      `[verify-standalone] obsolete standalone manifest signature must be removed: ${legacySignaturePath}`,
    );
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  expectEqual(manifest.schema, 1, "manifest schema");
  expectEqual(manifest.kind, "hana-core-standalone", "manifest kind");
  expectEqual(manifest.version, version, "manifest version");
  expectEqual(manifest.platform, STANDALONE_PLATFORM, "manifest platform");
  expectEqual(manifest.arch, arch, "manifest architecture");
  expectEqual(manifest.archive?.path, names.archiveName, "manifest archive path");
  expectEqual(manifest.layout?.root, STANDALONE_LAYOUT_ROOT, "manifest layout root");
  expectEqual(manifest.layout?.server, `${STANDALONE_LAYOUT_ROOT}/server`, "manifest server layout");
  expectEqual(manifest.layout?.git, `${STANDALONE_LAYOUT_ROOT}/git`, "manifest Git layout");
  expectEqual(
    manifest.layout?.sandboxHelper,
    `${STANDALONE_LAYOUT_ROOT}/sandbox/windows/hana-win-sandbox.exe`,
    "manifest sandbox helper layout",
  );
  expectEqual(manifest.runtime?.minGitVersion, MINGIT_VERSION, "manifest MinGit version");

  const actualSha256 = await activation.sha256File(archivePath);
  const actualSize = fs.statSync(archivePath).size;
  expectEqual(manifest.archive?.sha256, actualSha256, "archive sha256");
  expectEqual(manifest.archive?.size, actualSize, "archive size");

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-standalone-verify-"));
  try {
    await ustar.extract(archivePath, extractDir);
    const layoutRoot = path.join(extractDir, STANDALONE_LAYOUT_ROOT);
    const rootStat = fs.statSync(layoutRoot);
    if (!rootStat.isDirectory()) {
      throw new Error(`[verify-standalone] archive layout root must be a directory: ${layoutRoot}`);
    }
    assertExtractedLayout(layoutRoot);
    if (opts.smoke) smokeExtractedRuntime({ rootDir, layoutRoot });
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  log(`[verify-standalone] verified ${names.archiveName}`);
  return { archivePath, manifestPath, manifest };
}

async function main() {
  const args = process.argv.slice(2);
  const arch = args.find((arg) => !arg.startsWith("--")) ?? STANDALONE_ARCH;
  await verifyWindowsStandaloneArtifact({ arch, smoke: args.includes("--smoke") });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
