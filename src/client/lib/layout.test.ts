import { describe, expect, it } from "vitest";
import {
  arrangeLayout,
  isPaneLayout,
  layoutFromIds,
  paneIds,
  paneRects,
  placeNewTerminal,
  pruneLayout,
  reconcileMounted,
  paneLeaf,
  removePaneAndSelect,
  splitDividers,
  updateSplitRatio,
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

  it("replaces the active pane for new terminals unless tiling is enabled", () => {
    const layout = layoutFromIds(["one", "two"]);

    expect(paneIds(placeNewTerminal(layout, "three", "two", 4))).toEqual(["one", "three"]);
    expect(paneIds(placeNewTerminal(layout, "three", "two", 4, true))).toEqual(["one", "three", "two"]);
    expect(paneIds(placeNewTerminal(layout, "three", "two", 2, true))).toEqual(["one", "three"]);
  });
});

describe("split divider geometry and updates", () => {
  it("reports deterministic normalized bounds and paths for nested dividers", () => {
    const layout = {
      type: "split" as const,
      direction: "horizontal" as const,
      ratio: 0.4,
      first: paneLeaf("one"),
      second: {
        type: "split" as const,
        direction: "vertical" as const,
        ratio: 0.25,
        first: paneLeaf("two"),
        second: paneLeaf("three"),
      },
    };

    expect(splitDividers(layout)).toEqual([
      {
        path: [],
        direction: "horizontal",
        ratio: 0.4,
        bounds: { x: 0.4, y: 0, width: 0, height: 1 },
        parentBounds: { x: 0, y: 0, width: 1, height: 1 },
      },
      {
        path: ["second"],
        direction: "vertical",
        ratio: 0.25,
        bounds: { x: 0.4, y: 0.25, width: 0.6, height: 0 },
        parentBounds: { x: 0.4, y: 0, width: 0.6, height: 1 },
      },
    ]);
  });

  it("clamps resize ratios and preserves unrelated subtrees immutably", () => {
    const layout = layoutFromIds(["one", "two", "three"])!;
    const next = updateSplitRatio(layout, [], 2)!;
    const nested = updateSplitRatio(next, ["first"], -1)!;

    expect(next).not.toBe(layout);
    expect(next.type).toBe("split");
    if (next.type !== "split" || nested.type !== "split" || nested.first.type !== "split" || next.first.type !== "split") {
      throw new Error("expected nested split layout");
    }
    expect(next.ratio).toBe(0.85);
    expect(nested.first.ratio).toBe(0.15);
    expect(nested.second).toBe(next.second);
    expect(nested.first).not.toBe(next.first);
    expect(nested.first.first).toBe(next.first.first);
    expect(nested.first.second).toBe(next.first.second);
  });
});

describe("pane removal selection", () => {
  it("selects the next sibling when the active pane is closed", () => {
    const result = removePaneAndSelect(layoutFromIds(["one", "two", "three"]), "two", "two");

    expect(paneIds(result.layout)).toEqual(["one", "three"]);
    expect(result.activeId).toBe("three");
  });

  it("falls back to the previous sibling when the active pane is last", () => {
    const result = removePaneAndSelect(layoutFromIds(["one", "two", "three"]), "three", "three");

    expect(paneIds(result.layout)).toEqual(["one", "two"]);
    expect(result.activeId).toBe("two");
  });

  it("preserves the active pane when a background pane is closed", () => {
    const result = removePaneAndSelect(layoutFromIds(["one", "two", "three"]), "one", "three");

    expect(paneIds(result.layout)).toEqual(["three", "two"]);
    expect(result.activeId).toBe("three");
  });
});

describe("reconcileMounted", () => {
  it("keeps visible terminals mounted and evicts the oldest inactive view", () => {
    expect(
      reconcileMounted(["old", "one", "two"], ["one", "three"], new Set(["old", "one", "two", "three"]), 3),
    ).toEqual(["two", "one", "three"]);
  });

  it("keeps visible terminals even when the configured cache is smaller", () => {
    expect(
      reconcileMounted(["old", "one"], ["one", "two"], new Set(["old", "one", "two"]), 0),
    ).toEqual(["one", "two"]);
  });
});
