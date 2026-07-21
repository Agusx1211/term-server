import { afterEach, describe, expect, it, vi } from "vitest";
import { createHoverPreviewController, findFileLinks } from "./file-links";

describe("findFileLinks", () => {
  it("finds local file URIs and terminal-style paths", () => {
    expect(findFileLinks("open file:///tmp/a.png or ./src/main.rs and ~/notes.md").map((match) => match.text)).toEqual([
      "file:///tmp/a.png",
      "./src/main.rs",
      "~/notes.md",
    ]);
  });

  it("does not turn web URLs or punctuation into file links", () => {
    expect(findFileLinks("https://example.com/a.png /tmp/image.png, / ../").map((match) => match.text)).toEqual([
      "/tmp/image.png",
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
