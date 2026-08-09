export const TERMINAL_FONT_FAMILY =
  "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, 'Symbols Nerd Font Mono', monospace";

const NERD_FONT_LOAD_SPEC = '16px "Symbols Nerd Font Mono"';
const NERD_FONT_PROBE = "\ue0b0";

interface TerminalFontLoader {
  load(font: string, text?: string): Promise<unknown>;
}

const fontLoads = new WeakMap<TerminalFontLoader, Promise<void>>();

/** Starts the bundled symbol fallback once and treats font loading as best effort. */
export function loadTerminalNerdFont(
  fonts: TerminalFontLoader = document.fonts,
): Promise<void> {
  const existing = fontLoads.get(fonts);
  if (existing) return existing;
  const ready = Promise.resolve()
    .then(() => fonts.load(NERD_FONT_LOAD_SPEC, NERD_FONT_PROBE))
    .then(() => undefined, () => undefined);
  fontLoads.set(fonts, ready);
  return ready;
}
