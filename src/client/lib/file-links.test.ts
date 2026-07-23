import { afterEach, describe, expect, it, vi } from "vitest";
import { createHoverPreviewController, findFileLinks } from "./file-links";

describe("findFileLinks", () => {
  it("finds absolute and relative local file paths", () => {
    expect(
      findFileLinks(
        "open file:///tmp/a.png, /tmp/b.png, ./src/main.rs, ../notes.md, ~/photo.jpg, src/App.tsx, `README.md`, or path=.env",
      ).map((match) => match.text),
    ).toEqual([
      "file:///tmp/a.png",
      "/tmp/b.png",
      "./src/main.rs",
      "../notes.md",
      "~/photo.jpg",
      "src/App.tsx",
      "README.md",
      ".env",
    ]);
  });

  it("does not turn web URLs, remote file URIs, versions, or punctuation into file links", () => {
    expect(
      findFileLinks(
        "https://example.com/a.png file://server/share/a.png v1.2.3 origin/main and/or /tmp/image.png, / ./ ../ ~/ //server/share",
      ).map((match) => match.text),
    ).toEqual(["/tmp/image.png"]);
  });

  it("reports the original columns after trimming punctuation", () => {
    expect(findFileLinks("see README.md, then src/main.rs!")).toEqual([
      { text: "README.md", start: 4, end: 13 },
      { text: "src/main.rs", start: 20, end: 31 },
    ]);
  });
});

describe("createHoverPreviewController", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a pending preview when xterm re-enters the same link during rendering", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async ({ key }: { key: string; left: number }) => key);
    const show = vi.fn();
    const controller = createHoverPreviewController({ load, show, hide: vi.fn() });

    controller.hover({ key: "image", left: 10 });
    await vi.advanceTimersByTimeAsync(90);
    controller.leave();
    controller.hover({ key: "image", left: 20 });
    await vi.advanceTimersByTimeAsync(90);

    expect(load).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith("image", { key: "image", left: 20 });
  });

  it("cancels a pending preview after the pointer actually leaves", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async ({ key }: { key: string }) => key);
    const hide = vi.fn();
    const controller = createHoverPreviewController({ load, show: vi.fn(), hide });

    controller.hover({ key: "image" });
    controller.leave();
    await vi.runAllTimersAsync();

    expect(load).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalledOnce();
  });
});
