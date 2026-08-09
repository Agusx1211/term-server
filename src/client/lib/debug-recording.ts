/**
 * Client-side debug recording.
 *
 * Capturing is opt-in and gated by an `active` flag so the hot terminal paths
 * (per-frame writes, message handling) only pay a single boolean check while a
 * recording is not running. The user starts a recording from Settings, and the
 * captured events are merged with the server-side recording on download.
 */

/** Upper bound on captured client events before the oldest are dropped. */
export const MAX_FRONTEND_RECORDING_EVENTS = 50_000;

export type FrontendRecordEvent =
  | { type: "connect" }
  | { type: "disconnect"; cause: string }
  | { type: "state"; state: string }
  | { type: "sync"; mode: "snapshot" | "resume"; sequence: number }
  | { type: "synced"; sequence: number }
  | {
      type: "size";
      cols: number;
      rows: number;
      controller: boolean;
      responder: boolean;
      epoch?: number;
    }
  | { type: "control"; message: unknown }
  | { type: "output"; sequence: number; data: string }
  | { type: "write"; data: string }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number; pixelWidth: number; pixelHeight: number }
  | { type: "notice"; message: string }
  // Rendered-state captures. These record what the browser actually drew, so a
  // recording can be diffed against the server's byte stream to localize a bug
  // to the client model vs. the paint layer.
  | {
      type: "render";
      cols: number;
      rows: number;
      cursorX: number;
      cursorY: number;
      viewportY: number;
      lines: string[];
    }
  | { type: "screenshot"; dataUrl: string; width: number; height: number }
  | {
      type: "renderer";
      renderer: "webgl" | "canvas" | "dom";
      webglLoaded: boolean;
      contextLost: boolean;
      dpr: number;
    }
  | { type: "visibility"; visible: boolean };

export interface RecordedFrontendEvent {
  ts: number;
  terminal: string;
  event: FrontendRecordEvent;
}

let active = false;
let events: RecordedFrontendEvent[] = [];
let truncated = false;

const listeners = new Set<(active: boolean) => void>();

/** Subscribe to recording start/stop. Use this to run capture work only while a
 * recording is in progress. Returns an unsubscribe function. */
export function onDebugRecordingChange(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of listeners) listener(next);
}

export function isDebugRecordingActive(): boolean {
  return active;
}

export function startDebugRecording(): void {
  events = [];
  truncated = false;
  setActive(true);
}

export function stopDebugRecording(): void {
  setActive(false);
}

export function resetDebugRecording(): void {
  setActive(false);
  events = [];
  truncated = false;
}

export function debugRecordingEventCount(): number {
  return events.length;
}

export function debugRecordingTruncated(): boolean {
  return truncated;
}

/** Record a client-side event, dropping the oldest once the cap is reached. */
export function recordDebugEvent(terminal: string, event: FrontendRecordEvent): void {
  if (!active) return;
  events.push({ ts: Date.now(), terminal, event });
  if (events.length > MAX_FRONTEND_RECORDING_EVENTS) {
    events.splice(0, events.length - MAX_FRONTEND_RECORDING_EVENTS);
    truncated = true;
  }
}

/** Take (and clear) the captured client events. */
export function takeFrontendRecording(): {
  truncated: boolean;
  events: RecordedFrontendEvent[];
} {
  const snapshot = { truncated, events };
  events = [];
  truncated = false;
  return snapshot;
}

/** Encode a byte array as base64 without blowing the stack on large frames. */
export function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  if (typeof btoa === "function") return btoa(binary);
  return binary;
}

/** Encode a UTF-8 string as base64. */
export function encodeTextBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return encodeBytesBase64(bytes);
}
