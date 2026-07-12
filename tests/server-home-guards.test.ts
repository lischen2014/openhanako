import { describe, expect, it } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { spawn } from "child_process";

const root = process.cwd();

function spawnServerBootstrap(hanaHome: string, extraEnv: Record<string, string> = {}) {
  return spawn(process.execPath, ["server/bootstrap.ts"], {
    cwd: root,
    env: {
      ...process.env,
      HANA_HOME: hanaHome,
      HANA_PORT: "0",
      HANA_ROOT: root,
      HANA_SERVER_ENTRY: path.join(root, "server", "index.ts"),
      HANA_CREATE_STARTUP_SESSION: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 15000) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });

  const result: any = await Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), timeoutMs)),
  ]);
  if (result.timeout) {
    child.kill("SIGKILL");
  }
  return { ...result, stdout, stderr };
}

function listenFakeSameHomeServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve({ server, port: address.port });
      else reject(new Error("no port"));
    });
  });
}

describe("server/index.ts source-order contract: the mutex gate runs before any store is opened", () => {
  const source = fs.readFileSync(path.join(root, "server", "index.ts"), "utf-8");

  it("runs the mutex probe before bindServerTransportOwnership, ensureFirstRun, ensureLocalIdentityRegistries, and HanaEngine construction", () => {
    const probeIndex = source.indexOf("await probeServerInfo({ info: existingServerInfo })");
    const bindIndex = source.indexOf("await bindServerTransportOwnership");
    const firstRunIndex = source.indexOf("ensureFirstRun(");
    const identityIndex = source.indexOf("ensureLocalIdentityRegistries(");
    const engineIndex = source.indexOf("new HanaEngine(");

    expect(probeIndex).toBeGreaterThan(-1);
    expect(bindIndex).toBeGreaterThan(-1);

    expect(probeIndex).toBeLessThan(bindIndex);
    expect(bindIndex).toBeLessThan(firstRunIndex);
    expect(identityIndex).toBeGreaterThan(firstRunIndex);
    expect(identityIndex).toBeLessThan(engineIndex);
  });

  it("blocks on alive-same-home / alive-unauthorized and self-cleans on not-hana / dead", () => {
    expect(source).toContain("isForeignServerBlocking(probe.status)");
    expect(source).toContain("fs.unlinkSync(serverInfoPath)");
  });
});

describe("server home guards — real spawn behavior (fast failure paths, before engine init)", () => {
  it("exits 1 and never reaches ensureFirstRun when server-info.json points at a live, token-authenticating same-home server", async () => {
    const hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mutex-guard-test-"));
    const { server: fakeServer, port: fakePort } = await listenFakeSameHomeServer((req, res) => {
      if (req.url === "/api/server/identity") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ serverId: "server_fake_same_home", studioId: "studio_fake" }));
        return;
      }
      res.writeHead(404).end();
    });

    try {
      fs.writeFileSync(
        path.join(hanaHome, "server-info.json"),
        JSON.stringify({
          pid: process.pid,
          port: fakePort,
          token: "fake-token",
          version: "0.1.0",
          ownerKind: "standalone",
        }),
        "utf-8",
      );

      const child = spawnServerBootstrap(hanaHome);
      const result = await waitForExit(child);

      expect(result).toMatchObject({ code: 1, signal: null });
      expect(result.stderr).toContain("要接管请先退出它");
      expect(result.stdout + result.stderr).not.toContain("ensureFirstRun");
      expect(result.stdout + result.stderr).not.toContain("HanaEngine");
    } finally {
      await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
      fs.rmSync(hanaHome, { recursive: true, force: true });
    }
  }, 20000);

  it("self-cleans a dead server-info.json (nothing listening on the recorded port) and proceeds past the mutex gate to a full boot", async () => {
    const hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mutex-guard-dead-test-"));
    // Bind and release a port synchronously to get one that's very likely
    // free, then record it as "the last known server" with nothing home.
    const { server: probe, port: deadPort } = await listenFakeSameHomeServer((_req, res) => res.end());
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    try {
      fs.writeFileSync(
        path.join(hanaHome, "server-info.json"),
        JSON.stringify({ pid: 999999999, port: deadPort, token: "stale-token", version: "0.1.0", ownerKind: "standalone" }),
        "utf-8",
      );

      const child = spawnServerBootstrap(hanaHome);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });

      // The mutex gate must self-clean (delete the stale file) and not
      // block; there's nothing else gating startup yet in this commit, so
      // wait for real progress into ensureFirstRun as proof it proceeded.
      await Promise.race([
        new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (stdout.includes("ensureFirstRun")) {
              clearInterval(check);
              resolve();
            }
          }, 50);
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 10000)),
      ]);
      child.kill("SIGKILL");

      expect(fs.existsSync(path.join(hanaHome, "server-info.json"))).toBe(false);
      expect(stderr).not.toContain("要接管请先退出它");
      expect(stdout).toContain("ensureFirstRun");
    } finally {
      fs.rmSync(hanaHome, { recursive: true, force: true });
    }
  }, 20000);
});
