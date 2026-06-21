import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFsProvider } from "../lib/resource-io/providers/local-fs-provider.ts";

describe("LocalFsProvider", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function makeProvider(check = vi.fn(() => ({ allowed: true }))) {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resource-local-fs-"));
    const cwd = path.join(tempRoot, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    return {
      cwd,
      check,
      provider: new LocalFsProvider({ cwd, guard: { check } }),
    };
  }

  it("writes and stats a local file through PathGuard", async () => {
    const { cwd, check, provider } = makeProvider();
    const result = await provider.write({ kind: "local-file", path: "notes/a.md" }, "hello");

    const target = path.join(cwd, "notes", "a.md");
    expect(fs.readFileSync(target, "utf-8")).toBe("hello");
    expect(check).toHaveBeenCalledWith(target, "write");
    expect(result).toMatchObject({
      changeType: "created",
      resourceKey: `local_fs:${target.replace(/\\/g, "/")}`,
      resource: { kind: "local-file", path: target, filePath: target, provider: "local_fs" },
      version: { size: 5 },
    });

    await provider.write({ kind: "local-file", path: "notes/a.md" }, "hello again");
    const stat = await provider.stat({ kind: "local-file", path: "notes/a.md" });
    expect(stat).toMatchObject({ exists: true, isDirectory: false, version: { size: 11 } });
  });

  it("denies writes outside the guard", async () => {
    const { provider } = makeProvider(vi.fn(() => ({ allowed: false, reason: "denied by test" })));

    await expect(provider.write({ kind: "local-file", path: "blocked.md" }, "x"))
      .rejects.toMatchObject({
        code: "resource_access_denied",
        status: 403,
        operation: "write",
        message: "denied by test",
      });
  });

  it("reads, lists, searches, copies, deletes, and materializes local files", async () => {
    const { cwd, provider } = makeProvider();
    await provider.write({ kind: "local-file", path: "a.md" }, "alpha");
    await provider.mkdir({ kind: "local-file", path: "nested" });
    await provider.write({ kind: "local-file", path: "nested/b.md" }, "beta alpha");

    const read = await provider.read({ kind: "local-file", path: "a.md" });
    expect(read.content.toString("utf-8")).toBe("alpha");

    const list = await provider.list({ kind: "local-file", path: "." });
    expect(list.items.map((item) => item.name)).toEqual(expect.arrayContaining(["a.md", "nested"]));

    const search = await provider.search({ kind: "local-file", path: "." }, { query: "alpha" });
    expect(search.matches.map((match) => path.relative(cwd, match.filePath).replace(/\\/g, "/"))).toEqual([
      "a.md",
      "nested/b.md",
    ]);

    const copy = await provider.copy(
      { kind: "local-file", path: "a.md" },
      { kind: "local-file", path: "copy.md" },
    );
    expect(copy.changeType).toBe("created");
    expect(fs.readFileSync(path.join(cwd, "copy.md"), "utf-8")).toBe("alpha");

    const materialized = await provider.materialize({ kind: "local-file", path: "copy.md" });
    expect(materialized.filePath).toBe(path.join(cwd, "copy.md"));

    const deleted = await provider.delete({ kind: "local-file", path: "copy.md" });
    expect(deleted.resourceKey).toBe(`local_fs:${path.join(cwd, "copy.md").replace(/\\/g, "/")}`);
    expect(fs.existsSync(path.join(cwd, "copy.md"))).toBe(false);
  });

  it("maps relative file watch names back to the watched file", async () => {
    const { cwd, provider } = makeProvider();
    const filePath = path.join(cwd, "notes", "a.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "alpha");

    const target = provider.watchTarget({ kind: "local-file", path: "notes/a.md" });
    const snapshot = target.toResource("a.md");

    expect(snapshot).toMatchObject({
      resourceKey: `local_fs:${filePath.replace(/\\/g, "/")}`,
      resource: {
        kind: "local-file",
        provider: "local_fs",
        path: filePath,
        filePath,
      },
      filePath,
    });
  });
});
