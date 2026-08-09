import type { ITerminalOptions } from "@xterm/xterm";

type TuiCompatibilityOptions = Pick<
  ITerminalOptions,
  "rescaleOverlappingGlyphs" | "scrollOnEraseInDisplay" | "vtExtensions"
>;

export interface TerminalKittyKeyboardState {
  flags: number;
  mainFlags: number;
  altFlags: number;
  mainStack: number[];
  altStack: number[];
}

export type TerminalMouseEncoding = "DEFAULT" | "SGR" | "SGR_PIXELS";
export type TerminalCursorStyle = "block" | "underline" | "bar";

export interface TerminalCheckpointCompatibilityState {
  kittyKeyboard?: TerminalKittyKeyboardState;
  mouseEncoding?: TerminalMouseEncoding;
  cursorStyle?: TerminalCursorStyle;
  cursorBlink?: boolean;
}

interface InternalCompatibilityTerminal {
  _core?: {
    coreService?: {
      kittyKeyboard?: TerminalKittyKeyboardState;
      decPrivateModes?: {
        cursorStyle?: TerminalCursorStyle;
        cursorBlink?: boolean;
      };
    };
    mouseStateService?: {
      activeEncoding?: string;
    };
  };
}

/** Live emulator features kept in parity with the pinned VS Code terminal. */
export function tuiCompatibilityOptions(): TuiCompatibilityOptions {
  return {
    rescaleOverlappingGlyphs: true,
    scrollOnEraseInDisplay: true,
    vtExtensions: { kittyKeyboard: true },
  };
}

/** The pinned xterm core state needed to preserve and extend Kitty input. */
export function terminalKittyKeyboardState(
  terminal: unknown,
): TerminalKittyKeyboardState | undefined {
  return (terminal as InternalCompatibilityTerminal)._core?.coreService?.kittyKeyboard;
}

/** Private state omitted by the official serializer in the pinned xterm build. */
export function terminalCheckpointCompatibilityState(
  terminal: unknown,
): TerminalCheckpointCompatibilityState {
  const core = (terminal as InternalCompatibilityTerminal)._core;
  const mouseEncoding = core?.mouseStateService?.activeEncoding;
  const cursor = core?.coreService?.decPrivateModes;
  return {
    kittyKeyboard: core?.coreService?.kittyKeyboard,
    mouseEncoding: mouseEncoding === "DEFAULT"
      || mouseEncoding === "SGR"
      || mouseEncoding === "SGR_PIXELS"
      ? mouseEncoding
      : undefined,
    cursorStyle: cursor?.cursorStyle,
    cursorBlink: cursor?.cursorBlink,
  };
}
