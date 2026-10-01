import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHoverPreviewController,
  findFileLinks,
  findQuotedFileCandidates,
  findSpacedFileCandidates,
  type SpacedFileLine,
} from "./file-links";

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

  it("reads a backslash-escaped space as part of the name and reports the raw columns", () => {
    expect(findFileLinks("open /home/me/My\\ Videos/clip\\ one.mp4, now")).toEqual([
      { text: "/home/me/My Videos/clip one.mp4", start: 5, end: 38 },
    ]);
    expect(findFileLinks("cp My\\ Clip\\ \\(1\\).mp4 .")).toEqual([
      { text: "My Clip (1).mp4", start: 3, end: 22 },
    ]);
  });
});

const lines = (...texts: string[]): SpacedFileLine[] => texts.map((text) => ({ text }));
const texts = (candidates: Array<{ text: string }>) => candidates.map((candidate) => candidate.text);

describe("findSpacedFileCandidates", () => {
  it("proposes the whole path for an absolute path with spaces", () => {
    const line = "Saved to /home/me/My Videos/clip one.mp4.";
    const candidates = findSpacedFileCandidates(lines(line));

    expect(texts(candidates)).toContain("/home/me/My Videos/clip one.mp4");
    const whole = candidates.find((candidate) => candidate.text === "/home/me/My Videos/clip one.mp4")!;
    expect(whole.start).toEqual({ line: 0, index: line.indexOf("/home") });
    expect(line.slice(whole.start.index, whole.end.index + 1)).toBe("/home/me/My Videos/clip one.mp4");
  });

  it("never reaches back past the start of an explicit path", () => {
    expect(texts(findSpacedFileCandidates(lines("Saved to ./out/my clip.mp4")))).not.toContain(
      "to ./out/my clip.mp4",
    );
  });

  it("proposes every start a bare name could have, nearest first", () => {
    expect(texts(findSpacedFileCandidates(lines("Created Screen Shot 2026-10-01.png")))).toEqual([
      "Shot 2026-10-01.png",
      "Screen Shot 2026-10-01.png",
      "Created Screen Shot 2026-10-01.png",
    ]);
  });

  it("keeps parentheses and apostrophes inside the name and strips wrappers around it", () => {
    expect(texts(findSpacedFileCandidates(lines("see (Don't Stop (1).mp3)")))).toContain("Don't Stop (1).mp3");
  });

  it("stops at a word that ends a phrase or is itself a media path", () => {
    const found = texts(findSpacedFileCandidates(lines("Saved: my clip.mp4")));
    expect(found).toEqual(["my clip.mp4"]);
    expect(texts(findSpacedFileCandidates(lines("a.png b c.png")))).toEqual(["b c.png"]);
  });

  it("ignores text with no previewable extension and single words", () => {
    expect(findSpacedFileCandidates(lines("see my notes.txt and README.md"))).toEqual([]);
    expect(findSpacedFileCandidates(lines("clip.mp4"))).toEqual([]);
  });

  it("joins a path a program wrapped with a real newline, both with and without a space", () => {
    const wrapped: SpacedFileLine[] = [
      { text: "  /home/me/work/very-long-direct", joinsNext: "tight" },
      { text: "  ory/final cut.mp4" },
    ];
    const found = texts(findSpacedFileCandidates(wrapped));

    expect(found).toContain("/home/me/work/very-long-directory/final cut.mp4");
    expect(found).toContain("/home/me/work/very-long-direct ory/final cut.mp4");
  });

  it("joins a loose wrap only at a word boundary", () => {
    const wrapped: SpacedFileLine[] = [
      { text: "/home/me/My Videos/clip", joinsNext: "loose" },
      { text: "one.mp4" },
    ];
    const found = texts(findSpacedFileCandidates(wrapped));

    expect(found).toContain("/home/me/My Videos/clip one.mp4");
    expect(found).not.toContain("/home/me/My Videos/clipone.mp4");
  });

  it("does not join across lines the program did not wrap", () => {
    const found = findSpacedFileCandidates(lines("/home/me/work/very-long-direct", "ory/final cut.mp4"));

    // The second row still reads as a name of its own; nothing reaches the first.
    expect(texts(found)).toEqual(["ory/final cut.mp4"]);
    expect(found.every((candidate) => candidate.start.line === 1)).toBe(true);
  });

  it("reaches past a wrapped row that itself begins with a slash", () => {
    // The break fell exactly on a directory boundary, so the second row looks
    // like the start of an absolute path.
    const wrapped: SpacedFileLine[] = [
      { text: "Saved to /tmp/dddd", joinsNext: "tight" },
      { text: "/eeee/final cut.mp4" },
    ];
    const found = texts(findSpacedFileCandidates(wrapped));

    expect(found).toContain("/tmp/dddd/eeee/final cut.mp4");
    expect(found).toContain("/eeee/final cut.mp4");
    expect(found).not.toContain("to /tmp/dddd/eeee/final cut.mp4");
  });

  it("follows a path over several wrapped rows", () => {
    const wrapped: SpacedFileLine[] = [
      { text: "/home/me/aaaaaaaa", joinsNext: "tight" },
      { text: "bbbbbbbb", joinsNext: "tight" },
      { text: "cccc.mp4" },
    ];

    expect(texts(findSpacedFileCandidates(wrapped))).toContain("/home/me/aaaaaaaabbbbbbbbcccc.mp4");
  });
});

describe("findQuotedFileCandidates", () => {
  it("proposes the contents of quotes that hold a file name with spaces", () => {
    const line = `ffmpeg -i "my clip.mp4" -y 'out put.png' \`/tmp/a b.webm\``;
    const found = findQuotedFileCandidates(lines(line));

    expect(texts(found)).toEqual(["my clip.mp4", "out put.png", "/tmp/a b.webm"]);
    expect(line.slice(found[0]!.start.index, found[0]!.end.index + 1)).toBe("my clip.mp4");
  });

  it("ignores apostrophes, prose in quotes, and names without spaces", () => {
    expect(findQuotedFileCandidates(lines(`it's "hello world" and 'clip.mp4' but don't stop`))).toEqual([]);
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
