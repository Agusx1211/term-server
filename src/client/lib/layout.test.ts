import { describe, expect, it } from "vitest";
import {
  arrangeLayout,
  isPaneLayout,
  layoutFromIds,
  paneIds,
  paneRects,
  pruneLayout,
  reconcileMounted,
} from "./layout";

describe("split layouts", () => {
  it("fills all available space for a three-pane Y layout", () => {
    let layout = layoutFromIds(["one", "two"]);
    layout = arrangeLayout(layout, "three", "two", "bottom", 8)!;

    expect(paneIds(layout)).toEqual(["one", "two", "three"]);
    expect(paneRects(layout)).toEqual([
      { id: "one", x: 0, y: 0, width: 0.5, height: 1 },
      { id: "two", x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { id: "three", x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    ]);
    expect(paneRects(layout).reduce((area, rectangle) => area + rectangle.width * rectangle.height, 0)).toBe(1);
  });

  it("moves visible panes through arbitrary nested horizontal and vertical splits", () => {
    let layout = layoutFromIds(["one", "two", "three"]);
    layout = arrangeLayout(layout, "one", "three", "bottom", 8)!;

    expect(paneIds(layout)).toEqual(["three", "one", "two"]);
    expect(paneRects(layout).reduce((area, rectangle) => area + rectangle.width * rectangle.height, 0)).toBe(1);
  });

  it("supports any-length horizontal and vertical split chains", () => {
    let horizontal = layoutFromIds(["one"]);
    horizontal = arrangeLayout(horizontal, "two", "one", "right", 8)!;
    horizontal = arrangeLayout(horizontal, "three", "two", "right", 8)!;
    expect(paneRects(horizontal).every((rectangle) => rectangle.height === 1)).toBe(true);

    let vertical = layoutFromIds(["one"]);
    vertical = arrangeLayout(vertical, "two", "one", "bottom", 8)!;
    vertical = arrangeLayout(vertical, "three", "two", "bottom", 8)!;
    expect(paneRects(vertical).every((rectangle) => rectangle.width === 1)).toBe(true);
  });

  it("swaps visible center drops and replaces with hidden terminals", () => {
    const layout = layoutFromIds(["one", "two"]);
    expect(paneIds(arrangeLayout(layout, "one", "two", "center", 2)!)).toEqual(["two", "one"]);
    expect(paneIds(arrangeLayout(layout, "three", "two", "center", 2)!)).toEqual(["one", "three"]);
    expect(arrangeLayout(layout, "three", "two", "right", 2)).toBeUndefined();
  });

  it("collapses empty branches and validates persisted layouts", () => {
    const layout = layoutFromIds(["one", "two", "three", "four"]);
    const pruned = pruneLayout(layout, new Set(["one", "four"]));
    expect(paneIds(pruned)).toEqual(["one", "four"]);
    expect(isPaneLayout(pruned)).toBe(true);
    expect(isPaneLayout({ type: "split", direction: "horizontal", ratio: 0.5, first: { type: "leaf", id: "one" }, second: { type: "leaf", id: "one" } })).toBe(false);
  });

  it("balances automatic insertion by splitting the largest region", () => {
    const rectangles = paneRects(layoutFromIds(["one", "two", "three", "four"]));
    expect(rectangles.every((rectangle) => rectangle.width === 0.5 && rectangle.height === 0.5)).toBe(true);
  });
});

describe("reconcileMounted", () => {
  it("keeps visible terminals mounted and evicts the oldest inactive view", () => {
    expect(
      reconcileMounted(["old", "one", "two"], ["one", "three"], new Set(["old", "one", "two", "three"]), 3),
    ).toEqual(["two", "one", "three"]);
  });
});
