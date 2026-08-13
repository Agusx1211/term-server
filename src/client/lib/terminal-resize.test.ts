import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { resizeTerminalPreservingTail } from "./terminal-resize";

const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => {
  terminal.write(data, resolve);
});

const bufferText = (terminal: Terminal): string[] => {
  const active = terminal.buffer.active;
  return Array.from(
    { length: active.length },
    (_, index) => active.getLine(index)?.translateToString(true) ?? "",
  );
};

async function tuiTerminal(): Promise<Terminal> {
  const terminal = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
  for (let line = 0; line < 50; line += 1) {
    await write(terminal, `transcript line ${line}\r\n`);
  }
  // Fill the screen like a TUI frame, park the cursor mid-screen with real
  // content below it — an agent composer above its status bar.
  for (let row = 0; row < 9; row += 1) {
    await write(terminal, `frame row ${row}\r\n`);
  }
  await write(terminal, "TAIL-STATUS-BAR");
  await write(terminal, "\x1b[4;1H");
  return terminal;
}

describe("terminal resize preserving the tail", () => {
  it("keeps content below a mid-screen cursor when rows shrink", async () => {
    const terminal = await tuiTerminal();
    expect(bufferText(terminal).join("\n")).toContain("TAIL-STATUS-BAR");
    const cursorLine = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;

    resizeTerminalPreservingTail(terminal, 40, 6);

    const lines = bufferText(terminal);
    expect(lines.join("\n")).toContain("TAIL-STATUS-BAR");
    expect(lines.join("\n")).toContain("transcript line 49");
    expect(terminal.rows).toBe(6);
    // The screen is always the last rows of the buffer, so preserving every
    // line can push the cursor's line into scrollback; the cursor then clamps
    // to the closest visible row instead of deleting the content below it.
    const active = terminal.buffer.active;
    expect(active.baseY + active.cursorY).toBe(Math.max(cursorLine, active.baseY));
    terminal.dispose();
  });

  it("documents that xterm's native shrink deletes those lines", async () => {
    const terminal = await tuiTerminal();
    terminal.resize(40, 6);
    expect(bufferText(terminal).join("\n")).not.toContain("TAIL-STATUS-BAR");
    terminal.dispose();
  });

  it("applies a simultaneous column change after the safe rows shrink", async () => {
    const terminal = await tuiTerminal();
    resizeTerminalPreservingTail(terminal, 33, 6);
    expect(terminal.cols).toBe(33);
    expect(terminal.rows).toBe(6);
    expect(bufferText(terminal).join("\n")).toContain("TAIL-STATUS-BAR");
    terminal.dispose();
  });

  it("keeps xterm's native behavior when the popped rows are blank", async () => {
    const terminal = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
    for (let line = 0; line < 20; line += 1) {
      await write(terminal, `shell line ${line}\r\n`);
    }
    // Move up and erase below, leaving materialized blank rows under the cursor.
    await write(terminal, "\x1b[4;1H\x1b[J");
    const before = terminal.buffer.active.baseY;

    resizeTerminalPreservingTail(terminal, 40, 6);

    // Blank rows below the cursor are removed, not converted to scrollback.
    expect(terminal.buffer.active.baseY).toBe(before);
    expect(bufferText(terminal).join("\n")).toContain("shell line 13");
    terminal.dispose();
  });

  it("keeps xterm's native behavior when rows grow", async () => {
    const terminal = await tuiTerminal();
    const lines = bufferText(terminal).join("\n");
    resizeTerminalPreservingTail(terminal, 40, 14);
    expect(terminal.rows).toBe(14);
    expect(bufferText(terminal).join("\n")).toContain("TAIL-STATUS-BAR");
    expect(lines).toContain("TAIL-STATUS-BAR");
    terminal.dispose();
  });
});
