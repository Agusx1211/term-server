import { describe, expect, it } from "vitest";
import { commentCountLabel, locatePassage, parseMarkdownView, placeRailEntries } from "./markdown-review";

describe("locatePassage", () => {
  const text = "Ship this tomorrow. Review it tomorrow.";

  it("keeps the exact offset for comments on the revision on screen", () => {
    expect(locatePassage({ offset: 30, version: "v1", quote: "tomorrow" }, text, "v1", false)).toEqual({ start: 30 });
  });

  it("reports a current-revision offset that no longer matches the preview", () => {
    expect(locatePassage({ offset: 2, version: "v1", quote: "tomorrow" }, text, "v1", false)).toEqual({ problem: "preview" });
  });

  it("matches earlier revisions only by a unique quote", () => {
    expect(locatePassage({ offset: 0, version: "v0", quote: "Ship this" }, text, "v1", false)).toEqual({ start: 0 });
    expect(locatePassage({ offset: 10, version: "v0", quote: "tomorrow" }, text, "v1", false)).toEqual({ problem: "revision" });
    expect(locatePassage({ offset: 0, version: "v0", quote: "Friday" }, text, "v1", false)).toEqual({ problem: "revision" });
  });

  it("does not trust offsets while unsaved edits are previewed", () => {
    expect(locatePassage({ offset: 10, version: "v1", quote: "Review" }, text, "v1", true)).toEqual({ start: 20 });
  });
});

describe("placeRailEntries", () => {
  it("keeps cards beside their passages when there is room", () => {
    const tops = placeRailEntries([
      { key: "a", desired: 10, height: 40 },
      { key: "b", desired: 200, height: 40 },
    ], undefined, 8);
    expect([...tops]).toEqual([["a", 10], ["b", 200]]);
  });

  it("pushes overlapping cards down in passage order", () => {
    const tops = placeRailEntries([
      { key: "late", desired: 30, height: 50 },
      { key: "early", desired: 20, height: 50 },
    ], undefined, 10);
    expect(tops.get("early")).toBe(20);
    expect(tops.get("late")).toBe(80);
  });

  it("pins the focused card to its passage and moves earlier cards up", () => {
    const tops = placeRailEntries([
      { key: "a", desired: 100, height: 60 },
      { key: "b", desired: 110, height: 60 },
      { key: "c", desired: 120, height: 60 },
    ], "b", 10);
    expect(tops.get("b")).toBe(110);
    expect(tops.get("a")).toBe(40);
    expect(tops.get("c")).toBe(180);
  });

  it("never places cards above the rail", () => {
    const tops = placeRailEntries([
      { key: "a", desired: 0, height: 60 },
      { key: "b", desired: 20, height: 60 },
    ], "b", 10);
    expect(tops.get("a")).toBe(0);
    expect(tops.get("b")).toBe(70);
  });
});

describe("labels and preferences", () => {
  it("counts comments", () => {
    expect(commentCountLabel(0)).toBe("No comments");
    expect(commentCountLabel(1)).toBe("1 comment");
    expect(commentCountLabel(4)).toBe("4 comments");
  });

  it("defaults to the review view", () => {
    expect(parseMarkdownView(null)).toBe("review");
    expect(parseMarkdownView("other")).toBe("review");
    expect(parseMarkdownView("read")).toBe("read");
  });
});
