import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  copyBundledServerNodeModules,
  assertBundledServerNodeModulesReady,
} = require("../scripts/fix-modules.cjs");

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fix-modules-server-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root, relativePath, content = "") {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeServerRuntimeSentinels(nodeModulesDir) {
  writeFile(nodeModulesDir, "ws/package.json", JSON.stringify({ name: "ws" }));
  writeFile(nodeModulesDir, "qrcode/package.json", JSON.stringify({ name: "qrcode" }));
  writeFile(nodeModulesDir, "better-sqlite3/package.json", JSON.stringify({ name: "better-sqlite3" }));
  writeFile(nodeModulesDir, "better-sqlite3/build/Release/better_sqlite3.node", "native");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("fix-modules bundled server dependencies", () => {
  it("rebuilds packaged server node_modules even when a stale target directory already exists", () => {
    const tmp = makeTempDir();
    const serverDir = path.join(tmp, "resources", "server");
    const serverBuildModules = path.join(tmp, "dist-server", "win-x64", "node_modules");
    const staleModules = path.join(serverDir, "node_modules");

    writeFile(staleModules, "stale-only/package.json", JSON.stringify({ name: "stale-only" }));
    writeServerRuntimeSentinels(serverBuildModules);

    copyBundledServerNodeModules(serverDir, serverBuildModules, { log: () => {} });

    expect(fs.existsSync(path.join(staleModules, "stale-only", "package.json"))).toBe(false);
    expect(fs.existsSync(path.join(staleModules, "ws", "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(staleModules, "qrcode", "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(staleModules, "better-sqlite3", "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(
      staleModules,
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    ))).toBe(true);
  });

  it("removes copied node_modules .bin directories including scoped nested packages", () => {
    const tmp = makeTempDir();
    const serverDir = path.join(tmp, "resources", "server");
    const serverBuildModules = path.join(tmp, "dist-server", "mac-arm64", "node_modules");
    const targetModules = path.join(serverDir, "node_modules");

    fs.mkdirSync(serverDir, { recursive: true });
    writeServerRuntimeSentinels(serverBuildModules);
    writeFile(serverBuildModules, ".bin/root-cli", "root");
    writeFile(
      serverBuildModules,
      "@earendil-works/pi-coding-agent/node_modules/.bin/jiti",
      "nested scoped",
    );
    writeFile(serverBuildModules, "plain-package/node_modules/.bin/plain-cli", "nested plain");
    writeFile(serverBuildModules, "@earendil-works/pi-coding-agent/package.json", JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
    }));
    writeFile(serverBuildModules, "plain-package/package.json", JSON.stringify({
      name: "plain-package",
    }));

    copyBundledServerNodeModules(serverDir, serverBuildModules, { log: () => {} });

    expect(fs.existsSync(path.join(targetModules, ".bin"))).toBe(false);
    expect(fs.existsSync(path.join(
      targetModules,
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      ".bin",
    ))).toBe(false);
    expect(fs.existsSync(path.join(
      targetModules,
      "plain-package",
      "node_modules",
      ".bin",
    ))).toBe(false);
    expect(fs.existsSync(path.join(
      targetModules,
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    ))).toBe(true);
    expect(fs.existsSync(path.join(targetModules, "plain-package", "package.json"))).toBe(true);
  });

  it("fails fast when the packaged server node_modules misses a startup dependency", () => {
    const tmp = makeTempDir();
    const serverNodeModules = path.join(tmp, "resources", "server", "node_modules");

    writeFile(serverNodeModules, "ws/package.json", JSON.stringify({ name: "ws" }));
    writeFile(serverNodeModules, "better-sqlite3/package.json", JSON.stringify({ name: "better-sqlite3" }));

    expect(() => assertBundledServerNodeModulesReady(serverNodeModules)).toThrow(
      /node_modules\/qrcode\/package\.json/,
    );
  });
});
