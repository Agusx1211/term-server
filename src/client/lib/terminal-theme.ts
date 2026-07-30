import type { ITheme } from "@xterm/xterm";

export type ThemeName = "dark" | "light";

const terminalThemes: Record<ThemeName, ITheme> = {
  dark: {
    background: "#1e1e1e",
    foreground: "#cccccc",
    cursor: "#aeafad",
    cursorAccent: "#1e1e1e",
    selectionBackground: "#264f78",
    selectionInactiveBackground: "#3a3d41",
    black: "#000000",
    red: "#f14c4c",
    green: "#23d18b",
    yellow: "#f5f543",
    blue: "#3b8eea",
    magenta: "#d670d6",
    cyan: "#29b8db",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  },
  light: {
    background: "#ffffff",
    foreground: "#383a42",
    cursor: "#111111",
    selectionBackground: "#add6ff",
    selectionInactiveBackground: "#e5ebf1",
    black: "#000000",
    red: "#cd3131",
    green: "#00bc00",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#cd3131",
    brightGreen: "#14ce14",
    brightYellow: "#b5ba00",
    brightBlue: "#0451a5",
    brightMagenta: "#bc05bc",
    brightCyan: "#0598bc",
    brightWhite: "#a5a5a5",
  },
};

export function mixedTerminalBackground(theme: ThemeName, accent: string): string {
  const base = theme === "dark" ? "#1e1e1e" : "#ffffff";
  const ratio = theme === "dark" ? 0.065 : 0.035;
  const parse = (value: string) => (
    [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
  );
  if (!/^#[0-9a-f]{6}$/i.test(accent)) return base;
  const baseRgb = parse(base);
  const accentRgb = parse(accent);
  const channels = baseRgb.map((value, index) => (
    Math.round(value * (1 - ratio) + accentRgb[index]! * ratio)
  ));
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export const terminalTheme = (theme: ThemeName, accent: string): ITheme => ({
  ...terminalThemes[theme],
  background: mixedTerminalBackground(theme, accent),
});
