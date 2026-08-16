import type { SerializeAddon } from "@xterm/addon-serialize";
import type { ClientTerminalMessage } from "../../shared/types.js";
import { encodeBytesBase64 } from "./debug-recording.js";
import {
  terminalCheckpointCompatibilityState,
  type TerminalCheckpointCompatibilityState,
  type TerminalKittyKeyboardState,
} from "./terminal-compatibility.js";

export const TERMINAL_CHECKPOINT_CHUNK_BYTES = 32 * 1024;
// Binary chunk frames mirror the server-to-browser frame header: one kind
// byte and a big-endian u64 sequence. The header lets both the server and
// protocol tooling attribute a raw chunk to its announced upload instead of
// telling it apart from binary input by position alone.
export const TERMINAL_CHECKPOINT_FRAME_KIND = 2;
export const TERMINAL_CHECKPOINT_FRAME_HEADER_BYTES = 9;
export const TERMINAL_CHECKPOINT_IDLE_MS = 750;
export const TERMINAL_CHECKPOINT_MAX_INTERVAL_MS = 5_000;
export const TERMINAL_CHECKPOINT_STREAMING_SCROLLBACK_LINES = 1_000;
const MAX_CHECKPOINT_SCROLLBACK_LINES = 10_000;
// Below this depth the fixed screen cost dominates the measurement, so the
// bytes-per-line estimate would be too noisy to seed or record.
const ESTIMATE_MINIMUM_SCROLLBACK_LINES = 64;
const KITTY_KEYBOARD_STACK_LIMIT = 16;

const encoder = new TextEncoder();

interface CheckpointTerminal {
  buffer: {
    active: { type: "normal" | "alternate" };
    normal: { baseY: number };
  };
}

/**
 * Rolling density measurement carried between checkpoints of one terminal.
 * The serializer updates it in place and uses it to size the next first pass.
 */
export interface TerminalCheckpointSerializeBudget {
  lineBytesEstimate?: number;
}

export interface TerminalCheckpointSerializeOptions {
  /**
   * Caps how much scrollback the checkpoint carries. Forced checkpoints taken
   * while output is still streaming pass a small cap here: serialization walks
   * the buffer cell by cell on the main thread, and a full-depth pass blocks
   * input and frames for hundreds of milliseconds exactly when the terminal
   * is busiest. The next idle checkpoint restores full depth.
   */
  maximumScrollbackLines?: number;
  budget?: TerminalCheckpointSerializeBudget;
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
  options?: TerminalCheckpointSerializeOptions,
): Uint8Array<ArrayBuffer> | undefined {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) return undefined;
  const maximumLines = Math.min(
    MAX_CHECKPOINT_SCROLLBACK_LINES,
    Math.max(0, Math.floor(options?.maximumScrollbackLines ?? MAX_CHECKPOINT_SCROLLBACK_LINES)),
  );
  let scrollback = Math.min(
    maximumLines,
    Math.max(0, Math.floor(terminal.buffer.normal.baseY)),
  );

  // Seed from the previous checkpoint's density so the first pass usually
  // fits, instead of serializing the full depth just to measure it. The
  // estimate includes the fixed screen cost, so it errs toward fewer lines;
  // the overflow loop below still corrects any overshoot.
  const estimate = options?.budget?.lineBytesEstimate;
  if (estimate !== undefined && estimate > 0 && scrollback > ESTIMATE_MINIMUM_SCROLLBACK_LINES) {
    scrollback = Math.min(
      scrollback,
      Math.max(ESTIMATE_MINIMUM_SCROLLBACK_LINES, Math.floor(maximumBytes / estimate)),
    );
  }

  for (;;) {
    const serialized = restorePrivateTerminalState(
      serializer.serialize({ scrollback }),
      terminal,
    );
    const bytes = encoder.encode(serialized);
    if (options?.budget && scrollback >= ESTIMATE_MINIMUM_SCROLLBACK_LINES) {
      options.budget.lineBytesEstimate = bytes.byteLength / scrollback;
    }
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

export interface TerminalCheckpointSendHooks {
  onChunk?: (offset: number, bytes: number, final: boolean) => void;
}

export interface TerminalCheckpointSendOptions {
  /**
   * Sends the checkpoint as raw binary frames behind a JSON announcement,
   * skipping the base64 and JSON encoding of the legacy path. Only safe once
   * the server advertised `binaryCheckpoint` in its ready message: an older
   * broker reads client binary frames as terminal input.
   */
  binary?: boolean;
  hooks?: TerminalCheckpointSendHooks;
}

/**
 * Sends an exact checkpoint as ordered sub-64-KiB messages: base64 JSON
 * chunks by default, or raw binary frames when the server supports them.
 */
export function sendTerminalCheckpoint(
  socket: Pick<WebSocket, "send">,
  sequence: number,
  epoch: number,
  bytes: Uint8Array<ArrayBuffer>,
  options?: TerminalCheckpointSendOptions,
): number {
  const hooks = options?.hooks;
  if (options?.binary && bytes.byteLength > 0) {
    socket.send(JSON.stringify({
      type: "checkpointBinary",
      sequence,
      epoch,
      size: bytes.byteLength,
    } satisfies ClientTerminalMessage));
    let chunks = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += TERMINAL_CHECKPOINT_CHUNK_BYTES) {
      const end = Math.min(bytes.byteLength, offset + TERMINAL_CHECKPOINT_CHUNK_BYTES);
      const frame = new Uint8Array(TERMINAL_CHECKPOINT_FRAME_HEADER_BYTES + end - offset);
      frame[0] = TERMINAL_CHECKPOINT_FRAME_KIND;
      new DataView(frame.buffer).setBigUint64(1, BigInt(sequence));
      frame.set(bytes.subarray(offset, end), TERMINAL_CHECKPOINT_FRAME_HEADER_BYTES);
      socket.send(frame);
      chunks += 1;
      hooks?.onChunk?.(offset, end - offset, end === bytes.byteLength);
    }
    return chunks;
  }
  let chunks = 0;
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
    chunks += 1;
    hooks?.onChunk?.(offset, end - offset, end === bytes.byteLength);
  }
  return chunks;
}
