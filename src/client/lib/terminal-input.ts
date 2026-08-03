export const MAX_TERMINAL_INPUT_CHUNK_BYTES = 16 * 1024;

const textEncoder = new TextEncoder();

type TerminalInputChunk = Uint8Array<ArrayBuffer>;

export interface TerminalUserInputTracker {
  consume(): boolean;
  dispose(): void;
}

export type TerminalDataDisposition = "user" | "response" | "ignore";

interface TerminalDataContext {
  acceptingInput: boolean;
  data: string;
  parsingOutput: boolean;
  responder: boolean;
  userInput: boolean;
}

const SERVER_OWNED_TERMINAL_REPLIES = [
  // Primary and secondary device attributes (DA1/DA2).
  /^\x1b\[(?:\?[0-9;]*|>[0-9;]*)c$/,
  // Operating status (DSR) and standard/private cursor position (CPR).
  /^\x1b\[0n$/,
  /^\x1b\[\??[0-9]+;[0-9]+R$/,
  // ANSI/DEC mode reports (DECRQM).
  /^\x1b\[\??[0-9]+;[0-4]\$y$/,
  // Pixel, character-cell, and text-area size reports (14t/16t/18t).
  /^\x1b\[(?:4|6|8);[0-9]+;[0-9]+t$/,
] as const;

export function isServerOwnedTerminalReply(data: string): boolean {
  return SERVER_OWNED_TERMINAL_REPLIES.some((pattern) => pattern.test(data));
}

export function terminalDataDisposition({
  acceptingInput,
  data,
  parsingOutput,
  responder,
  userInput,
}: TerminalDataContext): TerminalDataDisposition {
  if (userInput || !parsingOutput) return acceptingInput ? "user" : "ignore";
  if (isServerOwnedTerminalReply(data)) return "ignore";
  return responder ? "response" : "ignore";
}

interface InternalUserInputTerminal {
  _core?: {
    coreService?: {
      onUserInput?: (listener: () => void) => { dispose(): void };
    };
  };
}

export function trackTerminalUserInput(terminal: unknown): TerminalUserInputTracker {
  let pending = false;
  const source = (terminal as InternalUserInputTerminal)._core?.coreService?.onUserInput;
  const disposable = source?.(() => {
    pending = true;
    queueMicrotask(() => {
      pending = false;
    });
  });
  return {
    consume() {
      const userInput = pending;
      pending = false;
      return userInput;
    },
    dispose() {
      disposable?.dispose();
      pending = false;
    },
  };
}

function chunkBytes(
  bytes: TerminalInputChunk,
  maximum = MAX_TERMINAL_INPUT_CHUNK_BYTES,
): TerminalInputChunk[] {
  const size = Math.max(1, Math.floor(maximum));
  const chunks: TerminalInputChunk[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push(bytes.slice(offset, Math.min(bytes.byteLength, offset + size)));
  }
  return chunks;
}

export function encodeTerminalText(
  data: string,
  maximum = MAX_TERMINAL_INPUT_CHUNK_BYTES,
): TerminalInputChunk[] {
  return chunkBytes(textEncoder.encode(data), maximum);
}

export function encodeTerminalBinary(
  data: string,
  maximum = MAX_TERMINAL_INPUT_CHUNK_BYTES,
): TerminalInputChunk[] {
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    bytes[index] = data.charCodeAt(index) & 0xff;
  }
  return chunkBytes(bytes, maximum);
}

export function sendTerminalChunks(
  socket: Pick<WebSocket, "send">,
  chunks: readonly TerminalInputChunk[],
): void {
  for (const chunk of chunks) socket.send(chunk);
}
