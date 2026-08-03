import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import {
  PANOPTES_UNICODE_VERSION,
  PANOPTES_UNICODE_WIDTH_COUNTS,
  PANOPTES_UNICODE_WIDTH_FNV1A64,
} from "./terminal-unicode-ranges";
import {
  PanoptesUnicode17Addon,
  PanoptesUnicode17Provider,
} from "./terminal-unicode";

const WIDTH_CORPUS = [
  { label: "ASCII", value: "A", legacy: 1, panoptes: 1 },
  { label: "CJK", value: "界", legacy: 2, panoptes: 2 },
  { label: "combining", value: "e\u0301", legacy: 1, panoptes: 1 },
  { label: "emoji", value: "👩", legacy: 1, panoptes: 2 },
  { label: "emoji ZWJ", value: "👩‍💻", legacy: 2, panoptes: 4 },
  { label: "emoji modifier", value: "👍🏽", legacy: 2, panoptes: 4 },
  { label: "regional indicators", value: "🇺🇸", legacy: 2, panoptes: 2 },
  { label: "emoji presentation", value: "☕️", legacy: 1, panoptes: 2 },
  { label: "Khmer width-three character", value: "\u17D8", legacy: 1, panoptes: 2 },
  { label: "Unicode 13 pinched fingers", value: "\u{1F90C}", legacy: 1, panoptes: 2 },
  { label: "Unicode 14 melting face", value: "\u{1FAE0}", legacy: 1, panoptes: 2 },
  { label: "Unicode 15 shaking face", value: "\u{1FAE8}", legacy: 1, panoptes: 2 },
  { label: "Unicode 16 face with bags", value: "\u{1FAE9}", legacy: 1, panoptes: 2 },
  { label: "Unicode 16 shovel", value: "\u{1FA8F}", legacy: 1, panoptes: 2 },
  { label: "Unicode 17 distorted face", value: "\u{1FAEA}", legacy: 1, panoptes: 2 },
  { label: "Unicode 17 fight cloud", value: "\u{1FAEF}", legacy: 1, panoptes: 2 },
  { label: "Unicode 17 landslide", value: "\u{1F6D8}", legacy: 1, panoptes: 2 },
  { label: "Unicode 17 treasure chest", value: "\u{1FA8E}", legacy: 1, panoptes: 2 },
  { label: "post-11 combining mark", value: "A\u{1E4EC}", legacy: 2, panoptes: 1 },
  { label: "post-11 wide kana", value: "\u{1AFF0}", legacy: 1, panoptes: 2 },
] as const;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

describe("panoptes Unicode width", () => {
  it("matches the generated unicode-width 0.2.2 table for every scalar", () => {
    const provider = new PanoptesUnicode17Provider();
    const counts = [0, 0, 0];
    let hash = FNV_OFFSET;
    for (let codepoint = 0; codepoint <= 0x10ffff; codepoint += 1) {
      const validScalar = codepoint < 0xd800 || codepoint > 0xdfff;
      const width = validScalar ? provider.wcwidth(codepoint) : 0xff;
      if (validScalar) counts[width] = (counts[width] ?? 0) + 1;
      hash = BigInt.asUintN(64, (hash ^ BigInt(width)) * FNV_PRIME);
    }
    expect(counts).toEqual([...PANOPTES_UNICODE_WIDTH_COUNTS]);
    expect(hash.toString(16).padStart(16, "0")).toBe(PANOPTES_UNICODE_WIDTH_FNV1A64);
  });

  it.each(WIDTH_CORPUS)(
    "advances the headless cursor consistently for $label",
    async ({ value, legacy, panoptes }) => {
      const defaultTerminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      const current = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      current.loadAddon(new PanoptesUnicode17Addon());

      try {
        await Promise.all([write(defaultTerminal, value), write(current, value)]);
        expect(defaultTerminal.buffer.active.cursorX).toBe(legacy);
        expect(current.unicode.activeVersion).toBe(PANOPTES_UNICODE_VERSION);
        expect(current.buffer.active.cursorX).toBe(panoptes);
      } finally {
        defaultTerminal.dispose();
        current.dispose();
      }
    },
  );
});

function write(terminal: Terminal, value: string): Promise<void> {
  return new Promise((resolve) => terminal.write(value, resolve));
}
