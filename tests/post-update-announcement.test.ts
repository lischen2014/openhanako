/**
 * 测试升级后首启公告的触发决策（resolvePostUpdateAnnouncement 纯函数）。
 *
 * 契约：lastSeenVersion 记录在 {HANA_HOME}/user/last-seen-version.json；
 * 全新安装静默播种（seedVersion），永不为"从无到有"弹公告；已完成
 * onboarding 却无记录 = 从没有此功能的老版本升级而来，视为升级后首启；
 * 非打包环境不弹也不写。
 */
import { describe, it, expect } from "vitest";
import {
  resolvePostUpdateAnnouncement,
  compareProductVersions,
  coerceDigestHistory,
  sliceDigestHistory,
} from "../desktop/src/shared/post-update-announcement.cjs";

describe("resolvePostUpdateAnnouncement", () => {
  it("dev 环境：不打扰也不写文件", () => {
    expect(resolvePostUpdateAnnouncement({ currentVersion: "1.2.0", lastSeenVersion: null, isPackagedLike: false, setupComplete: true }))
      .toEqual({ pending: false, seedVersion: null });
  });

  it("版本不可知：防御性不弹不写", () => {
    expect(resolvePostUpdateAnnouncement({ currentVersion: "", lastSeenVersion: "1.1.0", isPackagedLike: true, setupComplete: true }))
      .toEqual({ pending: false, seedVersion: null });
  });

  it("已看过当前版本：不再弹", () => {
    expect(resolvePostUpdateAnnouncement({ currentVersion: "1.2.0", lastSeenVersion: "1.2.0", isPackagedLike: true, setupComplete: true }))
      .toEqual({ pending: false, seedVersion: null });
  });

  it("全新安装（未完成 onboarding 且无记录）：静默播种，不弹", () => {
    expect(resolvePostUpdateAnnouncement({ currentVersion: "1.2.0", lastSeenVersion: null, isPackagedLike: true, setupComplete: false }))
      .toEqual({ pending: false, seedVersion: "1.2.0" });
  });

  it("老用户升到首个带此功能的版本（已完成 onboarding 但无记录）：要弹", () => {
    expect(resolvePostUpdateAnnouncement({ currentVersion: "1.2.0", lastSeenVersion: null, isPackagedLike: true, setupComplete: true }))
      .toEqual({ pending: true, seedVersion: null });
  });

  it("常规升级（记录版本与当前版本不同）：要弹", () => {
    expect(resolvePostUpdateAnnouncement({ currentVersion: "1.2.0", lastSeenVersion: "1.1.0", isPackagedLike: true, setupComplete: true }))
      .toEqual({ pending: true, seedVersion: null });
  });
});

describe("compareProductVersions（语义化版本比较）", () => {
  it("数值比较各段，不做字典序（0.380.10 > 0.380.9）", () => {
    expect(compareProductVersions("0.380.10", "0.380.9")).toBeGreaterThan(0);
    expect(compareProductVersions("0.380.9", "0.380.10")).toBeLessThan(0);
    expect(compareProductVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("容忍前缀 v", () => {
    expect(compareProductVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareProductVersions("v1.3.0", "v1.2.9")).toBeGreaterThan(0);
  });

  it("不可解析的版本返回 null（调用方自行防御）", () => {
    expect(compareProductVersions("not-a-version", "1.0.0")).toBe(null);
    expect(compareProductVersions("1.0.0", "")).toBe(null);
  });
});

function historyEntry(version: string) {
  return {
    schemaVersion: 1,
    tag: `v${version}`,
    version,
    summary: { zh: `摘要 ${version}`, en: `Summary ${version}` },
    items: [],
    noUserFacingChanges: true,
  };
}

describe("coerceDigestHistory（read-time compat：v2 优先，v1 兜底为单条史册）", () => {
  it("有合法 v2 时返回其 entries", () => {
    const v2 = { schema: 2, entries: [historyEntry("1.2.0"), historyEntry("1.1.0")] };
    expect(coerceDigestHistory(v2, historyEntry("1.0.0")).map((e: { version: string }) => e.version))
      .toEqual(["1.2.0", "1.1.0"]);
  });

  it("无 v2 时把 v1 单版摘要当作单条史册", () => {
    expect(coerceDigestHistory(null, historyEntry("1.2.0")).map((e: { version: string }) => e.version))
      .toEqual(["1.2.0"]);
  });

  it("v2 结构损坏（schema 不对或 entries 缺失）时回落 v1", () => {
    expect(coerceDigestHistory({ schema: 1, entries: [historyEntry("9.9.9")] }, historyEntry("1.2.0"))
      .map((e: { version: string }) => e.version)).toEqual(["1.2.0"]);
    expect(coerceDigestHistory({ schema: 2 }, historyEntry("1.2.0"))
      .map((e: { version: string }) => e.version)).toEqual(["1.2.0"]);
  });

  it("两者皆无时返回空数组", () => {
    expect(coerceDigestHistory(null, null)).toEqual([]);
    expect(coerceDigestHistory(undefined, undefined)).toEqual([]);
  });
});

describe("sliceDigestHistory（书签区间切片 (marker, current]，新→旧）", () => {
  const entries = [
    historyEntry("1.4.0"),
    historyEntry("1.3.0"),
    historyEntry("1.2.0"),
    historyEntry("1.1.0"),
  ];

  it("常规跨版升级：取 (书签, 当前] 全部条目，新→旧", () => {
    const result = sliceDigestHistory({ entries, lastSeenVersion: "1.1.0", currentVersion: "1.4.0" });
    expect(result.map((e: { version: string }) => e.version)).toEqual(["1.4.0", "1.3.0", "1.2.0"]);
  });

  it("单版升级：只取当前一节", () => {
    const result = sliceDigestHistory({ entries, lastSeenVersion: "1.3.0", currentVersion: "1.4.0" });
    expect(result.map((e: { version: string }) => e.version)).toEqual(["1.4.0"]);
  });

  it("书签版本不在史册里（比史册最老条目还老）：取全部 ≤ 当前的条目", () => {
    const result = sliceDigestHistory({ entries, lastSeenVersion: "0.9.0", currentVersion: "1.4.0" });
    expect(result.map((e: { version: string }) => e.version)).toEqual(["1.4.0", "1.3.0", "1.2.0", "1.1.0"]);
  });

  it("无书签（老用户首次遇到本机制）：只展示当前版本一节，不追溯轰炸", () => {
    const result = sliceDigestHistory({ entries, lastSeenVersion: null, currentVersion: "1.4.0" });
    expect(result.map((e: { version: string }) => e.version)).toEqual(["1.4.0"]);
  });

  it("书签不可解析：按无书签处理，只展示当前版本一节", () => {
    const result = sliceDigestHistory({ entries, lastSeenVersion: "garbage", currentVersion: "1.4.0" });
    expect(result.map((e: { version: string }) => e.version)).toEqual(["1.4.0"]);
  });

  it("比当前版本更新的条目（史册超前于本地安装）被排除", () => {
    const withNewer = [historyEntry("2.0.0"), ...entries];
    const result = sliceDigestHistory({ entries: withNewer, lastSeenVersion: "1.2.0", currentVersion: "1.4.0" });
    expect(result.map((e: { version: string }) => e.version)).toEqual(["1.4.0", "1.3.0"]);
  });

  it("输入乱序时输出仍按版本新→旧排序", () => {
    const shuffled = [entries[2], entries[0], entries[3], entries[1]];
    const result = sliceDigestHistory({ entries: shuffled, lastSeenVersion: "1.1.0", currentVersion: "1.4.0" });
    expect(result.map((e: { version: string }) => e.version)).toEqual(["1.4.0", "1.3.0", "1.2.0"]);
  });

  it("无版本或版本不可解析的条目被丢弃", () => {
    const dirty = [historyEntry("1.4.0"), { ...historyEntry("1.3.0"), version: "junk" }, { summary: {} }];
    const result = sliceDigestHistory({ entries: dirty, lastSeenVersion: "1.0.0", currentVersion: "1.4.0" });
    expect(result.map((e: { version: string }) => e.version)).toEqual(["1.4.0"]);
  });

  it("书签等于当前版本：空结果（上游本不应触发）", () => {
    const result = sliceDigestHistory({ entries, lastSeenVersion: "1.4.0", currentVersion: "1.4.0" });
    expect(result).toEqual([]);
  });
});
