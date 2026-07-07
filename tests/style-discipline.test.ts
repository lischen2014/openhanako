import { describe, expect, it } from "vitest";
import {
  stripCssComments,
  findBareSpacing,
  findHardcodedColors,
  findBareDurations,
} from "../scripts/style-discipline.mjs";

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
