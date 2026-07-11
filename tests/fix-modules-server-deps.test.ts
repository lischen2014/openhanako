import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { assertSeedResourcesReady, removeNodeModulesBinDirs } = require("../scripts/fix-modules.cjs");

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fix-modules-seed-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relativePath: string, content = "") {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeSeedFixture(
  resourcesDir: string,
  opts: { serverArchiveName?: string; rendererArchiveName?: string; includeRenderer?: boolean } = {},
) {
  const serverArchiveName = opts.serverArchiveName ?? "server-0.381.0-darwin-arm64.tar.gz";
  const rendererArchiveName = opts.rendererArchiveName ?? "renderer-0.381.0.tar.gz";
  const includeRenderer = opts.includeRenderer ?? true;

  const manifest = {
    schema: 1,
    train: 0,
    channel: "stable",
    artifacts: {
      ...(includeRenderer
        ? { renderer: { version: "0.381.0", sha256: "b".repeat(64), size: 1, path: rendererArchiveName } }
        : {}),
      server: {
        "darwin-arm64": { version: "0.381.0", sha256: "a".repeat(64), size: 1, path: serverArchiveName },
      },
    },
  };
  writeFile(resourcesDir, "seed/seed-train.json", JSON.stringify(manifest));
  writeFile(resourcesDir, "seed/seed-train.json.sig", "sig-bytes");
  writeFile(resourcesDir, `seed/${serverArchiveName}`, "archive-bytes");
  if (includeRenderer) {
    writeFile(resourcesDir, `seed/${rendererArchiveName}`, "archive-bytes");
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("fix-modules dual-kind seed resources assertion", () => {
  it("passes when seed/ carries manifest + sig + both archives the manifest references", () => {
    const resourcesDir = makeTempDir();
    writeSeedFixture(resourcesDir);
    expect(() => assertSeedResourcesReady(resourcesDir)).not.toThrow();
  });

  it("fails when the seed manifest is missing", () => {
    const resourcesDir = makeTempDir();
    writeSeedFixture(resourcesDir);
    fs.rmSync(path.join(resourcesDir, "seed", "seed-train.json"));
    expect(() => assertSeedResourcesReady(resourcesDir)).toThrow(/seed-train\.json/);
  });

  it("fails when the detached signature is missing", () => {
    const resourcesDir = makeTempDir();
    writeSeedFixture(resourcesDir);
    fs.rmSync(path.join(resourcesDir, "seed", "seed-train.json.sig"));
    expect(() => assertSeedResourcesReady(resourcesDir)).toThrow(/\.sig/);
  });

  it("fails when the server archive referenced by the manifest is missing", () => {
    const resourcesDir = makeTempDir();
    writeSeedFixture(resourcesDir);
    fs.rmSync(path.join(resourcesDir, "seed", "server-0.381.0-darwin-arm64.tar.gz"));
    expect(() => assertSeedResourcesReady(resourcesDir)).toThrow(/server-0\.381\.0-darwin-arm64\.tar\.gz/);
  });

  it("fails when the renderer archive referenced by the manifest is missing", () => {
    const resourcesDir = makeTempDir();
    writeSeedFixture(resourcesDir);
    fs.rmSync(path.join(resourcesDir, "seed", "renderer-0.381.0.tar.gz"));
    expect(() => assertSeedResourcesReady(resourcesDir)).toThrow(/renderer-0\.381\.0\.tar\.gz/);
  });

  it("fails when the manifest carries no server artifact entries at all", () => {
    const resourcesDir = makeTempDir();
    writeFile(
      resourcesDir,
      "seed/seed-train.json",
      JSON.stringify({ schema: 1, train: 0, channel: "stable", artifacts: {} }),
    );
    writeFile(resourcesDir, "seed/seed-train.json.sig", "sig-bytes");
    expect(() => assertSeedResourcesReady(resourcesDir)).toThrow(/server/i);
  });

  it("fails when the manifest carries no renderer artifact entry (mutation-check target: dual-kind census)", () => {
    const resourcesDir = makeTempDir();
    writeSeedFixture(resourcesDir, { includeRenderer: false });
    expect(() => assertSeedResourcesReady(resourcesDir)).toThrow(/renderer/i);
  });
});

describe("fix-modules node_modules .bin cleanup (app asar deps)", () => {
  it("removes nested .bin directories and keeps package files", () => {
    const tmp = makeTempDir();
    const nm = path.join(tmp, "node_modules");
    writeFile(nm, ".bin/tool", "#!/bin/sh\n");
    writeFile(nm, "pkg/node_modules/.bin/tool2", "#!/bin/sh\n");
    writeFile(nm, "pkg/package.json", "{}");
    writeFile(nm, "@scope/pkg2/node_modules/.bin/tool3", "#!/bin/sh\n");
    const removed = removeNodeModulesBinDirs(nm);
    expect(removed).toBe(3);
    expect(fs.existsSync(path.join(nm, ".bin"))).toBe(false);
    expect(fs.existsSync(path.join(nm, "pkg", "node_modules", ".bin"))).toBe(false);
    expect(fs.existsSync(path.join(nm, "@scope", "pkg2", "node_modules", ".bin"))).toBe(false);
    expect(fs.existsSync(path.join(nm, "pkg", "package.json"))).toBe(true);
  });
});
