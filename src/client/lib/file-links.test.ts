import { describe, expect, it } from "vitest";
import { findFileLinks } from "./file-links";

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
