import { describe, expect, it } from "vitest";

import {
  classifyMinGitCommandResolution,
  createHermeticMinGitSmokeEnv,
  minGitResolutionToWindowsPath,
  verifyMinGitCommandResolutionOutput,
} from "../scripts/smoke-mingit.mjs";

const identityCanonicalizer = (directory: string) => directory;
const runtimeRoot = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\HanaCore\\git";
const coreutils = "cat ls cp mv rm mkdir grep sed awk find sort uniq head tail wc cut tr xargs echo touch".split(" ");

describe("MinGit release smoke environment", () => {
  it("does not inherit a host Git or arbitrary runner PATH entries", () => {
    const env = createHermeticMinGitSmokeEnv({
      runtimeRoot: "C:\\downloads\\HanaCore\\git",
      workRoot: "C:\\Temp\\hana smoke",
      env: {
        SystemRoot: "C:\\Windows",
        PATH: "C:\\host-git\\cmd;C:\\tools;C:\\Windows\\System32",
        Path: "C:\\second-host-git\\bin",
        GIT_EXEC_PATH: "C:\\host-git\\mingw64\\libexec\\git-core",
        GIT_CONFIG_GLOBAL: "C:\\host\\.gitconfig",
        NODE_OPTIONS: "--require C:\\host\\inject.cjs",
      },
    });

    expect(env.Path).toBe([
      "C:\\downloads\\HanaCore\\git\\cmd",
      "C:\\downloads\\HanaCore\\git\\usr\\bin",
      "C:\\downloads\\HanaCore\\git\\mingw64\\bin",
      "C:\\Windows\\System32",
    ].join(";"));
    expect(env.Path).not.toContain("host-git");
    expect(env).not.toHaveProperty("GIT_EXEC_PATH");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("NUL");
    expect(env.HOME).toBe("C:\\Temp\\hana smoke");
  });
});

describe("MinGit command provenance", () => {
  it.each([
    ["/usr/bin/grep", `${runtimeRoot}\\usr\\bin\\grep`],
    ["/mingw64/bin/cat.exe", `${runtimeRoot}\\mingw64\\bin\\cat.exe`],
    [
      "/c/Users/runneradmin/AppData/Local/Temp/HanaCore/git/usr/bin/sed.exe",
      `${runtimeRoot}\\usr\\bin\\sed.exe`,
    ],
    [
      "C:/Users/runneradmin/AppData/Local/Temp/HanaCore/git/usr/bin/awk.exe",
      `${runtimeRoot}\\usr\\bin\\awk.exe`,
    ],
  ])("normalizes supported command paths: %s", (resolved, expected) => {
    expect(minGitResolutionToWindowsPath(resolved, runtimeRoot)).toBe(expected);
  });

  it.each([
    ["grep", "/usr/bin/grep"],
    ["cat", "/mingw64/bin/cat.exe"],
    ["sed", "/c/Users/runneradmin/AppData/Local/Temp/HanaCore/git/usr/bin/sed.exe"],
    ["awk", "C:/Users/runneradmin/AppData/Local/Temp/HanaCore/git/usr/bin/awk.exe"],
  ])("accepts %s from an allowed canonical parent", (command, resolved) => {
    expect(classifyMinGitCommandResolution({
      command,
      resolved,
      runtimeRoot,
      canonicalizeDirectory: identityCanonicalizer,
    })).toMatchObject({ ok: true, source: "runtime" });
  });

  it("uses canonical directory identity for Windows 8.3 and long-path aliases", () => {
    const canonicalizeDirectory = (directory: string) => directory.replace(
      /C:\\Users\\RUNNER~1/i,
      "C:\\Users\\runneradmin",
    );

    expect(classifyMinGitCommandResolution({
      command: "grep",
      resolved: "/c/Users/RUNNER~1/AppData/Local/Temp/HanaCore/git/usr/bin/grep.exe",
      runtimeRoot,
      canonicalizeDirectory,
    })).toMatchObject({ ok: true, source: "runtime" });
  });

  it("rejects Windows system commands", () => {
    expect(classifyMinGitCommandResolution({
      command: "find",
      resolved: "C:/Windows/System32/find.exe",
      runtimeRoot,
      canonicalizeDirectory: identityCanonicalizer,
    })).toMatchObject({ ok: false, reason: "outside-runtime" });
  });

  it.each([
    "C:/Users/runneradmin/AppData/Local/Temp/HanaCore/git/usr/bin-neighbor/grep.exe",
    "C:/Users/runneradmin/AppData/Local/Temp/HanaCore/git-prefix/usr/bin/grep.exe",
    "C:/Users/runneradmin/AppData/Local/Temp/HanaCore/git/usr/bin/nested/grep.exe",
  ])("rejects sibling, prefix, and nested directory escapes: %s", (resolved) => {
    expect(classifyMinGitCommandResolution({
      command: "grep",
      resolved,
      runtimeRoot,
      canonicalizeDirectory: identityCanonicalizer,
    })).toMatchObject({ ok: false, reason: "outside-runtime" });
  });

  it("allows only the explicit echo builtin exception", () => {
    expect(classifyMinGitCommandResolution({
      command: "echo",
      resolved: "echo",
      runtimeRoot,
      canonicalizeDirectory: identityCanonicalizer,
    })).toMatchObject({ ok: true, source: "builtin" });

    expect(classifyMinGitCommandResolution({
      command: "grep",
      resolved: "grep",
      runtimeRoot,
      canonicalizeDirectory: identityCanonicalizer,
    })).toMatchObject({ ok: false, reason: "non-path" });
  });

  it("rejects missing commands and reports the command with its resolution", () => {
    const resolutions = [
      "cat\t/usr/bin/cat",
      "echo\techo",
    ].join("\n");

    expect(() => verifyMinGitCommandResolutionOutput(
      resolutions,
      runtimeRoot,
      identityCanonicalizer,
    )).toThrow(/MISSING: command=ls resolved=\(empty\)/);
  });

  it("reports an external command together with its resolved path", () => {
    const resolutions = coreutils.map((command) => (
      command === "echo"
        ? "echo\techo"
        : `${command}\t${command === "find" ? "C:/Windows/System32/find.exe" : `/usr/bin/${command}`}`
    )).join("\n");

    expect(() => verifyMinGitCommandResolutionOutput(
      resolutions,
      runtimeRoot,
      identityCanonicalizer,
    )).toThrow("EXTERNAL: command=find resolved=C:/Windows/System32/find.exe reason=outside-runtime");
  });
});
