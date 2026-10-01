import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../../shared/types";
import {
  createFileProbe,
  mergeFileLinks,
  planFileLinks,
  readLinkWindow,
  verifyFileLinks,
  type LinkBuffer,
} from "./terminal-file-links";

const isWide = (char: string) => /[ᄀ-ᅟ⺀-꓏가-힣＀-｠]/.test(char);

/** A buffer of `rows`, each padded to `cols`; `wrapped` lists rows xterm soft-wrapped. */
function fakeBuffer(rows: string[], cols: number, wrapped: number[] = []): LinkBuffer {
  return {
    getLine(y) {
      const text = rows[y];
      if (text === undefined) return undefined;
      const cells: Array<{ chars: string; width: number }> = [];
      for (const char of text) {
        cells.push({ chars: char, width: isWide(char) ? 2 : 1 });
        if (isWide(char)) cells.push({ chars: "", width: 0 });
      }
      while (cells.length < cols) cells.push({ chars: "", width: 1 });
      return {
        isWrapped: wrapped.includes(y),
        length: cols,
        getCell: (x) => {
          const cell = cells[x];
          return cell && { getChars: () => cell.chars, getWidth: () => cell.width };
        },
      };
    },
  };
}

const plan = (rows: string[], cols: number, hovered: number, wrapped: number[] = []) => {
  const window = readLinkWindow(fakeBuffer(rows, cols, wrapped), cols, hovered);
  return { window, ...planFileLinks(window, hovered + 1) };
};

const file = (overrides: Partial<FileEntry> = {}): FileEntry => ({
  path: "/x",
  name: "x",
  kind: "file",
  size: 1,
  modifiedAt: 1,
  mime: "video/mp4",
  image: false,
  pdf: false,
  audio: false,
  video: true,
  editable: false,
  ...overrides,
});

describe("readLinkWindow and planFileLinks", () => {
  it("maps a path the terminal soft-wrapped across rows back onto the screen", () => {
    const rows = ["/tmp/very/lo", "ng/path/clip", ".png"];
    const { certain } = plan(rows, 12, 1, [1, 2]);

    expect(certain).toEqual([{
      path: "/tmp/very/long/path/clip.png",
      range: { start: { x: 1, y: 1 }, end: { x: 4, y: 3 } },
    }]);
  });

  it("only reports links that touch the hovered row", () => {
    const rows = ["a.png b.png", "c.png"];

    expect(plan(rows, 20, 0).certain.map((link) => link.path)).toEqual(["a.png", "b.png"]);
    expect(plan(rows, 20, 1).certain.map((link) => link.path)).toEqual(["c.png"]);
  });

  it("counts a double-width character as two columns", () => {
    const { certain } = plan(["日本 clip.png"], 30, 0);

    expect(certain).toEqual([{
      path: "clip.png",
      range: { start: { x: 6, y: 1 }, end: { x: 13, y: 1 } },
    }]);
  });

  it("offers a path a program wrapped with a newline from either of its rows", () => {
    const rows = ["see /home/me/proj/ab", "  cd/final cut.mp4"];
    for (const hovered of [0, 1]) {
      const { pending } = plan(rows, 20, hovered);
      const whole = pending.find((item) => item.candidate.text === "/home/me/proj/abcd/final cut.mp4");

      expect(whole, `hovering row ${hovered}`).toBeDefined();
      expect(whole!.range).toEqual({ start: { x: 5, y: 1 }, end: { x: 18, y: 2 } });
    }
  });

  it("joins a wrapped path with a space when the second row begins with a slash", () => {
    // The wrap fell exactly on a directory boundary, so the second row looks
    // like an absolute path of its own.
    const rows = ["Hard: /tmp/dddd/eeeeeee", "/ffff/final cut.mp4"];
    const { pending } = plan(rows, 23, 1);

    expect(pending.map((item) => item.candidate.text)).toContain("/tmp/dddd/eeeeeee/ffff/final cut.mp4");
  });

  it("does not join a line that stopped well short of the edge", () => {
    const { window, pending } = plan(["see the notes", "my clip.mp4"], 40, 1);

    expect(window.lines).toHaveLength(1);
    expect(pending.map((item) => item.candidate.text)).toEqual(["my clip.mp4"]);
  });

  it("follows a path over several hard-wrapped rows", () => {
    const rows = ["/home/me/aaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb", "cccc.mp4"];
    const { pending } = plan(rows, 20, 1);

    expect(pending.map((item) => item.candidate.text)).toContain("/home/me/aaaaaaaaaaabbbbbbbbbbbbbbbbbbbbcccc.mp4");
  });

  it("leaves the plain case free of lookups", () => {
    expect(plan(["total 12", "-rw-r--r-- 1 me me 4 notes.txt"], 40, 1).pending).toEqual([]);
  });

  it("finds a quoted name with spaces", () => {
    const { pending } = plan([`ffmpeg -i "my clip.mp4" out.mp4`], 60, 0);

    expect(pending.map((item) => item.candidate.text)).toContain("my clip.mp4");
    expect(pending.find((item) => item.candidate.text === "my clip.mp4")!.range).toEqual({
      start: { x: 12, y: 1 },
      end: { x: 22, y: 1 },
    });
  });
});

describe("verifyFileLinks", () => {
  const pendingFor = (rows: string[], cols = 60, hovered = 0) => plan(rows, cols, hovered).pending;
  const probeOf = (real: (path: string) => FileEntry | undefined) => {
    const probe = vi.fn(async (paths: string[]) => paths.map(real));
    return probe;
  };

  it("keeps the longest candidate that is a real file", async () => {
    const real = new Set(["clip one.mp4", "Videos/clip one.mp4"]);
    const probe = probeOf((path) => (real.has(path) ? file({ path }) : undefined));

    const links = await verifyFileLinks(pendingFor(["Saved Videos/clip one.mp4"]), probe);

    expect(links.map((link) => link.path)).toEqual(["Videos/clip one.mp4"]);
    expect(links[0]!.file?.path).toBe("Videos/clip one.mp4");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("asks about every candidate in one lookup", async () => {
    const probe = probeOf(() => undefined);

    await verifyFileLinks(pendingFor(["see /v/a b.mp4 and my c d.png"]), probe);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![0]).toEqual(expect.arrayContaining(["/v/a b.mp4", "my c d.png"]));
  });

  it("drops candidates that do not exist or are directories", async () => {
    const probe = probeOf((path) => (path === "a b.mp4" ? file({ path, kind: "directory" }) : undefined));

    expect(await verifyFileLinks(pendingFor(["a b.mp4"]), probe)).toEqual([]);
  });

  it("falls back to the plain links when the lookup fails", async () => {
    const probe = vi.fn(async () => {
      throw new Error("offline");
    });

    expect(await verifyFileLinks(pendingFor(["a b.mp4"]), probe)).toEqual([]);
  });

  it("resolves each name on its own", async () => {
    const probe = probeOf((path) => (path.endsWith(".mp4") ? file({ path }) : undefined));

    const links = await verifyFileLinks(pendingFor(["/v/a b.mp4 and /v/c d.png"]), probe);

    expect(links.map((link) => link.path)).toEqual(["/v/a b.mp4"]);
  });
});

describe("mergeFileLinks", () => {
  it("replaces the fragments a verified name is made of", async () => {
    const rows = ["Saved to /home/me/My Videos/clip.mp4"];
    const { certain, pending } = plan(rows, 60, 0);
    expect(certain.map((link) => link.path)).toEqual(["/home/me/My", "Videos/clip.mp4"]);

    const verified = await verifyFileLinks(pending, async (paths) => paths.map((path) => file({ path })));
    const merged = mergeFileLinks(certain, verified);

    expect(merged.map((link) => link.path)).toEqual(["/home/me/My Videos/clip.mp4"]);
  });

  it("keeps links that do not overlap a verified name", () => {
    const certain = [{ path: "a.png", range: { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } } }];
    const verified = [{ path: "b c.png", range: { start: { x: 7, y: 1 }, end: { x: 13, y: 1 } }, file: file() }];

    expect(mergeFileLinks(certain, verified).map((link) => link.path)).toEqual(["b c.png", "a.png"]);
  });
});

describe("createFileProbe", () => {
  const found = (paths: string[]) => paths.map((path) => file({ path }));

  it("answers repeated questions from one lookup until the answer expires", async () => {
    let now = 0;
    const fetchFiles = vi.fn(async (_cwd: string | undefined, paths: string[]) => found(paths));
    const probe = createFileProbe(fetchFiles, () => now);

    await Promise.all([probe({ path: "a.mp4", cwd: "/w" }), probe({ path: "a.mp4", cwd: "/w" })]);
    await probe({ path: "a.mp4", cwd: "/other" });
    expect(fetchFiles).toHaveBeenCalledTimes(2);

    now = 29_000;
    await probe({ path: "a.mp4", cwd: "/w" });
    expect(fetchFiles).toHaveBeenCalledTimes(2);
    now = 31_000;
    await probe({ path: "a.mp4", cwd: "/w" });
    expect(fetchFiles).toHaveBeenCalledTimes(3);
  });

  it("asks for only the paths it does not know, together", async () => {
    const fetchFiles = vi.fn(async (_cwd: string | undefined, paths: string[]) => found(paths));
    const probe = createFileProbe(fetchFiles);

    await probe.many("/w", ["a.mp4", "b.mp4"]);
    const answers = await probe.many("/w", ["b.mp4", "c.mp4", "d.mp4", "c.mp4"]);

    expect(fetchFiles.mock.calls.map(([, paths]) => paths)).toEqual([["a.mp4", "b.mp4"], ["c.mp4", "d.mp4"]]);
    expect(answers.map((answer) => answer?.path)).toEqual(["b.mp4", "c.mp4", "d.mp4", "c.mp4"]);
  });

  it("splits a very long list into requests the server accepts", async () => {
    const fetchFiles = vi.fn(async (_cwd: string | undefined, paths: string[]) => found(paths));
    const probe = createFileProbe(fetchFiles);

    await probe.many("/w", Array.from({ length: 130 }, (_, index) => `f${index}.mp4`));

    expect(fetchFiles.mock.calls.map(([, paths]) => paths.length)).toEqual([64, 64, 2]);
  });

  it("forgets a missing file quickly, since it may be written any moment", async () => {
    let now = 0;
    const fetchFiles = vi.fn(async (_cwd: string | undefined, paths: string[]) => paths.map(() => null));
    const probe = createFileProbe(fetchFiles, () => now);

    expect(await probe({ path: "late.mp4" })).toBeUndefined();
    now = 2_000;
    await probe({ path: "late.mp4" });
    expect(fetchFiles).toHaveBeenCalledTimes(1);
    now = 4_000;
    await probe({ path: "late.mp4" });
    expect(fetchFiles).toHaveBeenCalledTimes(2);
  });

  it("treats a failed lookup as missing rather than throwing", async () => {
    const probe = createFileProbe(async () => {
      throw new Error("offline");
    });

    expect(await probe({ path: "a.mp4" })).toBeUndefined();
  });
});
