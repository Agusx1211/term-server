import type { SerializeAddon } from "@xterm/addon-serialize";
import type { ClientTerminalMessage } from "../../shared/types";
import { encodeBytesBase64 } from "./debug-recording";
import {
  terminalCheckpointCompatibilityState,
  type TerminalCheckpointCompatibilityState,
  type TerminalKittyKeyboardState,
} from "./terminal-compatibility";

export const TERMINAL_CHECKPOINT_CHUNK_BYTES = 32 * 1024;
export const TERMINAL_CHECKPOINT_IDLE_MS = 750;
export const TERMINAL_CHECKPOINT_MAX_INTERVAL_MS = 5_000;
const MAX_CHECKPOINT_SCROLLBACK_LINES = 10_000;
const KITTY_KEYBOARD_STACK_LIMIT = 16;

const encoder = new TextEncoder();

interface CheckpointTerminal {
  buffer: {
    active: { type: "normal" | "alternate" };
    normal: { baseY: number };
  };
}

/**
 * Serializes the browser's real xterm model, trimming only old scrollback until
 * it fits the broker-advertised bound. The live screen, modes, cursor, normal
 * buffer, and alternate buffer are always included by the serialize addon.
 */
export function serializeTerminalCheckpoint(
  serializer: Pick<SerializeAddon, "serialize">,
  terminal: CheckpointTerminal,
  maximumBytes: number,
): Uint8Array | undefined {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) return undefined;
  let scrollback = Math.min(
    MAX_CHECKPOINT_SCROLLBACK_LINES,
    Math.max(0, Math.floor(terminal.buffer.normal.baseY)),
  );

  for (;;) {
    const serialized = restorePrivateTerminalState(
      serializer.serialize({ scrollback }),
      terminal,
    );
    const bytes = encoder.encode(serialized);
    if (bytes.byteLength <= maximumBytes) return bytes.byteLength ? bytes : undefined;
    if (scrollback === 0) return undefined;

    // The live screen is a fixed part of the result, so leave margin instead
    // of assuming the whole serialization scales with its scrollback count.
    scrollback = Math.min(
      scrollback - 1,
      Math.max(0, Math.floor(scrollback * maximumBytes / bytes.byteLength * 0.8)),
    );
  }
}

/**
 * The official serialize addon restores public terminal modes but omits a few
 * private states needed by full-screen TUIs. Preserve them as ordinary protocol
 * sequences so the checkpoint remains portable terminal output.
 */
function restorePrivateTerminalState(
  serialized: string,
  terminal: CheckpointTerminal,
): string {
  const state = terminalCheckpointCompatibilityState(terminal);
  return restoreKittyKeyboardState(serialized, terminal, state.kittyKeyboard)
    + serializeMouseEncoding(state)
    + serializeCursorStyle(state);
}

function restoreKittyKeyboardState(
  serialized: string,
  terminal: CheckpointTerminal,
  state: TerminalKittyKeyboardState | undefined,
): string {
  if (!state) return serialized;

  const alternate = terminal.buffer.active.type === "alternate";
  const main = serializeKittyBufferState(
    alternate ? state.mainFlags : state.flags,
    state.mainStack,
  );
  const alt = serializeKittyBufferState(
    alternate ? state.flags : state.altFlags,
    state.altStack,
  );
  if (!main && !alt) return serialized;

  if (alternate) {
    const marker = "\x1b[?1049h";
    const offset = serialized.indexOf(marker);
    if (offset < 0) return serialized + alt;
    return serialized.slice(0, offset) + main + serialized.slice(offset) + alt;
  }
  if (!alt) return serialized + main;
  return `${serialized}${main}\x1b[?47h${alt}\x1b[?47l`;
}

function serializeMouseEncoding(state: TerminalCheckpointCompatibilityState): string {
  if (state.mouseEncoding === "SGR") return "\x1b[?1006h";
  if (state.mouseEncoding === "SGR_PIXELS") return "\x1b[?1016h";
  return "";
}

function serializeCursorStyle(state: TerminalCheckpointCompatibilityState): string {
  const base = state.cursorStyle === "block"
    ? 1
    : state.cursorStyle === "underline"
      ? 3
      : state.cursorStyle === "bar"
        ? 5
        : undefined;
  return base === undefined ? "" : `\x1b[${base + (state.cursorBlink === false ? 1 : 0)} q`;
}

function serializeKittyBufferState(flags: number, stack: readonly number[]): string {
  const current = kittyFlag(flags);
  const saved = Array.isArray(stack)
    ? stack.slice(-KITTY_KEYBOARD_STACK_LIMIT).map(kittyFlag)
    : [];
  if (current === 0 && saved.length === 0) return "";
  if (saved.length === 0) return `\x1b[=${current}u`;

  let output = `\x1b[=${saved[0]}u`;
  for (const value of saved.slice(1)) output += `\x1b[>${value}u`;
  return output + `\x1b[>${current}u`;
}

function kittyFlag(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 0x7fff_ffff) : 0;
}

/** Sends an exact checkpoint as ordered sub-64-KiB JSON messages. */
export function sendTerminalCheckpoint(
  socket: Pick<WebSocket, "send">,
  sequence: number,
  epoch: number,
  bytes: Uint8Array,
): void {
  for (let offset = 0; offset < bytes.byteLength; offset += TERMINAL_CHECKPOINT_CHUNK_BYTES) {
    const end = Math.min(bytes.byteLength, offset + TERMINAL_CHECKPOINT_CHUNK_BYTES);
    socket.send(JSON.stringify({
      type: "checkpoint",
      sequence,
      epoch,
      offset,
      data: encodeBytesBase64(bytes.subarray(offset, end)),
      final: end === bytes.byteLength,
    } satisfies ClientTerminalMessage));
  }
}
