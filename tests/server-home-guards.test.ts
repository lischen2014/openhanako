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

describe("server/index.ts source-order contract: home guards run before any store is opened", () => {
  const source = fs.readFileSync(path.join(root, "server", "index.ts"), "utf-8");

  it("runs the mutex probe and the data-epoch gate before bindServerTransportOwnership, ensureFirstRun, ensureLocalIdentityRegistries, and HanaEngine construction", () => {
    const probeIndex = source.indexOf("await probeServerInfo({ info: existingServerInfo })");
    const epochIndex = source.indexOf("await assertAndStampDataEpoch(");
    const bindIndex = source.indexOf("await bindServerTransportOwnership");
    const firstRunIndex = source.indexOf("ensureFirstRun(");
    const identityIndex = source.indexOf("ensureLocalIdentityRegistries(");
    const engineIndex = source.indexOf("new HanaEngine(");

    expect(probeIndex).toBeGreaterThan(-1);
    expect(epochIndex).toBeGreaterThan(-1);
    expect(bindIndex).toBeGreaterThan(-1);

    // Mutex gate before epoch gate (task-specified order).
    expect(probeIndex).toBeLessThan(epochIndex);
    // Both gates before anything that opens a port or a store.
    expect(epochIndex).toBeLessThan(bindIndex);
    expect(bindIndex).toBeLessThan(firstRunIndex);
    expect(identityIndex).toBeGreaterThan(firstRunIndex);
    expect(identityIndex).toBeLessThan(engineIndex);
  });

  it("blocks on alive-same-home / alive-unauthorized and self-cleans on not-hana / dead", () => {
    expect(source).toContain("isForeignServerBlocking(probe.status)");
    expect(source).toContain("fs.unlinkSync(serverInfoPath)");
  });

  it("reads the data-epoch override from HANA_ALLOW_DATA_DOWNGRADE and uses the shared DATA_EPOCH constant", () => {
    expect(source).toContain('process.env.HANA_ALLOW_DATA_DOWNGRADE === "1"');
    expect(source).toContain("ownEpoch: DATA_EPOCH");
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

  it("self-cleans a dead server-info.json (nothing listening on the recorded port) and proceeds past the mutex gate", async () => {
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

      // Also seed an epoch stamp far above this build's DATA_EPOCH so the
      // epoch gate fires next and we can observe a fast, deterministic exit
      // — this test is only asserting "the mutex gate did not block and
      // self-cleaned the file", not exercising a full successful boot.
      fs.writeFileSync(path.join(hanaHome, "data-epoch.json"), JSON.stringify({ epoch: 999999, lastVersion: "9.9.9" }), "utf-8");

      const child = spawnServerBootstrap(hanaHome);
      const result = await waitForExit(child);

      // The mutex gate must have deleted the stale server-info.json (self-
      // clean) and NOT printed the foreign-server rejection message; the
      // process still exits 1, but for the epoch gate's reason instead.
      expect(fs.existsSync(path.join(hanaHome, "server-info.json"))).toBe(false);
      expect(result.stderr).not.toContain("要接管请先退出它");
      expect(result.stderr).toContain("epoch=999999");
      expect(result).toMatchObject({ code: 1, signal: null });
    } finally {
      fs.rmSync(hanaHome, { recursive: true, force: true });
    }
  }, 20000);

  it("exits 1 with a bilingual message when the data-epoch stamp is higher than this build's DATA_EPOCH and no override is set", async () => {
    const hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-epoch-guard-test-"));
    try {
      fs.writeFileSync(
        path.join(hanaHome, "data-epoch.json"),
        JSON.stringify({ epoch: 999999, lastVersion: "9.9.9", updatedAt: new Date().toISOString() }),
        "utf-8",
      );

      const child = spawnServerBootstrap(hanaHome);
      const result = await waitForExit(child);

      expect(result).toMatchObject({ code: 1, signal: null });
      expect(result.stderr).toContain("epoch=999999");
      expect(result.stderr).toContain("HANA_ALLOW_DATA_DOWNGRADE=1");
      expect(result.stdout + result.stderr).not.toContain("ensureFirstRun");
      expect(result.stdout + result.stderr).not.toContain("HanaEngine");
    } finally {
      fs.rmSync(hanaHome, { recursive: true, force: true });
    }
  }, 20000);

  it("exits 1 with a fail-closed message when the data-epoch stamp file is corrupt", async () => {
    const hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-epoch-corrupt-test-"));
    try {
      fs.writeFileSync(path.join(hanaHome, "data-epoch.json"), "{ not valid json", "utf-8");

      const child = spawnServerBootstrap(hanaHome);
      const result = await waitForExit(child);

      expect(result).toMatchObject({ code: 1, signal: null });
      expect(result.stderr).toContain("data-epoch");
      expect(result.stderr.toLowerCase()).toContain("corrupt");
    } finally {
      fs.rmSync(hanaHome, { recursive: true, force: true });
    }
  }, 20000);

  it("proceeds past a higher epoch stamp when HANA_ALLOW_DATA_DOWNGRADE=1 is set (does not fail on the epoch gate)", async () => {
    const hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-epoch-override-test-"));
    try {
      fs.writeFileSync(
        path.join(hanaHome, "data-epoch.json"),
        JSON.stringify({ epoch: 999999, lastVersion: "9.9.9", updatedAt: new Date().toISOString() }),
        "utf-8",
      );

      // A free-but-unused port would let the process run past the epoch
      // gate and into a real (slow) boot; instead we assert on the fast
      // negative — the epoch-block message must NOT appear — while letting
      // the process continue in the background and killing it once we've
      // observed enough stdout to know it moved past the gate, or timeout.
      const child = spawnServerBootstrap(hanaHome, { HANA_ALLOW_DATA_DOWNGRADE: "1" });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });

      await Promise.race([
        new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (stdout.includes("ensureFirstRun") || stderr.includes("epoch=999999")) {
              clearInterval(check);
              resolve();
            }
          }, 50);
        }),
        // Generous window: under full-suite parallel load (hundreds of
        // vitest workers contending for CPU), a real child process reaching
        // ensureFirstRun can take noticeably longer than in an isolated
        // run. This only affects how long the test waits before asserting
        // — it does not affect gate latency in production.
        new Promise<void>((resolve) => setTimeout(resolve, 25000)),
      ]);

      child.kill("SIGKILL");
      // The gate must not have blocked: no rejection instructions, and a
      // loud (but non-blocking) warning is expected instead.
      expect(stderr).not.toContain("HANA_ALLOW_DATA_DOWNGRADE=1"); // that's the *rejection* message's remedy text
      expect(stderr).toContain("[data-epoch] WARNING");
      expect(stderr).toContain("警告");
      expect(stdout).toContain("ensureFirstRun");
    } finally {
      fs.rmSync(hanaHome, { recursive: true, force: true });
    }
  }, 35000);
});
