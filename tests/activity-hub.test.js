import { describe, it, expect, vi } from "vitest";
import { ActivityHub } from "../lib/activity-hub.js";

function makeBus() {
  return { emit: vi.fn() };
}

const baseEntry = {
  id: "subagent-1", kind: "subagent", status: "running",
  sessionPath: "/s/a.jsonl", agentId: "a1", agentName: "小花",
  summary: "调研 X", startedAt: 1000,
};

describe("ActivityHub", () => {
  it("upsert 新 entry 后 get/list 能拿到，字段规范化", () => {
    const hub = new ActivityHub();
    hub.upsert(baseEntry);
    expect(hub.get("subagent-1")).toMatchObject({
      id: "subagent-1", kind: "subagent", status: "running",
      sessionPath: "/s/a.jsonl", agentId: "a1", summary: "调研 X", startedAt: 1000,
    });
    expect(hub.list()).toHaveLength(1);
  });

  it("upsert 同 id 合并：running→done 保留 startedAt/sessionPath/summary，补 finishedAt", () => {
    const hub = new ActivityHub();
    hub.upsert(baseEntry);
    hub.upsert({ id: "subagent-1", status: "done", finishedAt: 2000 });
    const e = hub.get("subagent-1");
    expect(e.status).toBe("done");
    expect(e.startedAt).toBe(1000);          // 保留
    expect(e.sessionPath).toBe("/s/a.jsonl"); // 保留
    expect(e.summary).toBe("调研 X");         // 保留
    expect(e.finishedAt).toBe(2000);
  });

  it("listBySession 只返回该 sessionPath 的活动（当前对话过滤）", () => {
    const hub = new ActivityHub();
    hub.upsert({ ...baseEntry, id: "t1", sessionPath: "/s/a.jsonl" });
    hub.upsert({ ...baseEntry, id: "t2", sessionPath: "/s/b.jsonl" });
    hub.upsert({ ...baseEntry, id: "t3", sessionPath: "/s/a.jsonl" });
    expect(hub.listBySession("/s/a.jsonl").map(e => e.id).sort()).toEqual(["t1", "t3"]);
    expect(hub.listBySession("/s/b.jsonl")).toHaveLength(1);
    expect(hub.listBySession(null)).toEqual([]);
  });

  it("upsert 广播 agent_activity（带 sessionPath）+ 通知 onChange", () => {
    const bus = makeBus();
    const hub = new ActivityHub(bus);
    const seen = [];
    hub.onChange(e => seen.push(e.id));
    hub.upsert(baseEntry);
    expect(bus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_activity", entry: expect.objectContaining({ id: "subagent-1" }) }),
      "/s/a.jsonl",
    );
    expect(seen).toEqual(["subagent-1"]);
  });

  it("workflow kind 被接受（subagent/workflow 同一真相源）", () => {
    const hub = new ActivityHub();
    hub.upsert({ id: "workflow-1", kind: "workflow", status: "running", sessionPath: "/s/a.jsonl", summary: "demo" });
    expect(hub.get("workflow-1").kind).toBe("workflow");
  });

  it("非法 kind/status 兜底（新建默认 subagent/running）", () => {
    const hub = new ActivityHub();
    hub.upsert({ id: "x", kind: "bogus", status: "weird", sessionPath: "/s/a.jsonl" });
    const e = hub.get("x");
    expect(e.kind).toBe("subagent");
    expect(e.status).toBe("running");
  });

  it("无 id 的 entry 被忽略（不入库、不广播）", () => {
    const bus = makeBus();
    const hub = new ActivityHub(bus);
    expect(hub.upsert({ kind: "subagent", sessionPath: "/s/a.jsonl" })).toBeNull();
    expect(hub.list()).toHaveLength(0);
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it("clearBySession 清掉该 session 的活动（内存回收）", () => {
    const hub = new ActivityHub();
    hub.upsert({ ...baseEntry, id: "t1", sessionPath: "/s/a.jsonl" });
    hub.upsert({ ...baseEntry, id: "t2", sessionPath: "/s/b.jsonl" });
    hub.clearBySession("/s/a.jsonl");
    expect(hub.get("t1")).toBeNull();
    expect(hub.get("t2")).toBeTruthy();
  });

  it("onChange 返回 unsub，取消后不再收到", () => {
    const hub = new ActivityHub();
    const seen = [];
    const unsub = hub.onChange(e => seen.push(e.id));
    hub.upsert({ ...baseEntry, id: "t1" });
    unsub();
    hub.upsert({ ...baseEntry, id: "t2" });
    expect(seen).toEqual(["t1"]);
  });
});
