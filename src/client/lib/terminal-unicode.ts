import type {
  ITerminalAddon,
  IUnicodeVersionProvider,
  Terminal,
} from "@xterm/xterm";
import {
  PANOPTES_UNICODE_VERSION,
  PANOPTES_WIDE_RANGES,
  PANOPTES_ZERO_WIDTH_RANGES,
} from "./terminal-unicode-ranges";

type TerminalCellWidth = 0 | 1 | 2;
type WidthRange = readonly [start: number, end: number];

// xterm 6 encodes shouldJoin in bit 0 and width in bits 1..2 of the
// charProperties result. The public provider API exposes this value as a number
// but does not export its packing helpers, so keep the encoding isolated here.
const SHOULD_JOIN = 1;
const WIDTH_SHIFT = 1;
const WIDTH_MASK = 0b11;

export function panoptesTerminalWidth(codepoint: number): TerminalCellWidth {
  if (inRanges(codepoint, PANOPTES_ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(codepoint, PANOPTES_WIDE_RANGES)) return 2;
  return 1;
}

export class PanoptesUnicode17Provider implements IUnicodeVersionProvider {
  readonly version = PANOPTES_UNICODE_VERSION;

  wcwidth(codepoint: number): TerminalCellWidth {
    return panoptesTerminalWidth(codepoint);
  }

  charProperties(codepoint: number, preceding: number): number {
    let width = this.wcwidth(codepoint);
    let shouldJoin = width === 0 && preceding !== 0;
    if (shouldJoin) {
      const precedingWidth = Math.min(
        (preceding >> WIDTH_SHIFT) & WIDTH_MASK,
        2,
      ) as TerminalCellWidth;
      if (precedingWidth === 0) {
        shouldJoin = false;
      } else if (precedingWidth > width) {
        width = precedingWidth;
      }
    }
    return width << WIDTH_SHIFT | (shouldJoin ? SHOULD_JOIN : 0);
  }
}

export class PanoptesUnicode17Addon implements ITerminalAddon {
  activate(terminal: Terminal): void {
    terminal.unicode.register(new PanoptesUnicode17Provider());
    terminal.unicode.activeVersion = PANOPTES_UNICODE_VERSION;
  }

  dispose(): void {}
}

function inRanges(codepoint: number, ranges: readonly WidthRange[]): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (!range) return false;
    if (codepoint < range[0]) {
      high = middle - 1;
    } else if (codepoint > range[1]) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}
