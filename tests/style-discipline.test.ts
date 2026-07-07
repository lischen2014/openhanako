import { describe, expect, it } from "vitest";
import {
  stripCssComments,
  findBareSpacing,
  findHardcodedColors,
  findBareDurations,
  scan,
} from "../scripts/style-discipline.mjs";
import baseline from "./style-discipline-baseline.json";

describe("style-discipline matchers", () => {
  it("strips comments before matching", () => {
    expect(findBareSpacing(stripCssComments("/* padding: 7px */ .a { gap: var(--space-8); }"))).toEqual([]);
  });

  it("flags bare px in spacing props, spares 0 / var() / calc-with-var", () => {
    const css = `.a { padding: 8px 0; margin-top: 7px; gap: var(--space-4);
      margin-bottom: calc(var(--r) - 1px); padding-left: 0; }`;
    const hits = findBareSpacing(css);
    expect(hits).toEqual([
      { property: "padding", value: "8px 0" },
      { property: "margin-top", value: "7px" },
    ]);
  });

  it("flags hex and rgb/rgba literals, spares var() fallback usage", () => {
    const css = `.a { color: #3B3D3F; background: rgba(0, 0, 0, 0.05);
      border-color: var(--overlay-medium, rgba(0, 0, 0, 0.16)); box-shadow: 0 1px 0 #fff; }`;
    const hits = findHardcodedColors(css);
    expect(hits.map(h => h.literal)).toEqual(["#3B3D3F", "rgba(0, 0, 0, 0.05)", "#fff"]);
  });

  it("flags literal durations in transition/animation, spares var(--duration-*) and 0s", () => {
    const css = `.a { transition: opacity var(--duration-fast) var(--ease-out), width 0.16s;
      animation: spin 0.8s linear; transition-delay: 0s; }`;
    const hits = findBareDurations(css);
    expect(hits.map(h => h.literal)).toEqual(["0.16s", "0.8s"]);
  });
});

describe("style-discipline ratchet (只减不增)", () => {
  const current = scan();

  it("no file exceeds its baseline count in any dimension", () => {
    const regressions: string[] = [];
    for (const [file, counts] of Object.entries(current)) {
      const base = (baseline as Record<string, Record<string, number>>)[file] ?? {};
      for (const [dim, n] of Object.entries(counts)) {
        const allowed = base[dim] ?? 0;
        if (n > allowed) regressions.push(`${file} ${dim}: ${n} > baseline ${allowed}`);
      }
    }
    expect(
      regressions,
      `新增风格违例（新代码必须走 token；存量收账后跑 --update-baseline 下调基线）：\n  ${regressions.join("\n  ")}`,
    ).toEqual([]);
  });

  it("baseline has no stale entries far above reality (提示收账后下调)", () => {
    // 软契约：基线比现实高说明收过账没更新基线。不红，只在 console 提示。
    const stale: string[] = [];
    for (const [file, base] of Object.entries(baseline as Record<string, Record<string, number>>)) {
      const cur = current[file] ?? {};
      for (const [dim, allowed] of Object.entries(base)) {
        const n = (cur as Record<string, number>)[dim] ?? 0;
        if (n < allowed) stale.push(`${file} ${dim}: ${n} < baseline ${allowed}`);
      }
    }
    if (stale.length) console.warn(`[style-discipline] 基线可下调：\n  ${stale.join("\n  ")}`);
    expect(true).toBe(true);
  });
});
