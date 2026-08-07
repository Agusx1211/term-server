export const TERMINAL_FRAME_SNAPSHOT = 0;
export const TERMINAL_FRAME_OUTPUT = 1;
const TERMINAL_FRAME_HEADER_BYTES = 9;
// Abandoning the stream costs a reconnect plus a full snapshot, which is far
// more expensive than the backlog it avoids. A full-screen TUI redraw is
// routinely a megabyte or more arriving in a single burst, and xterm parses that
// in a fraction of a second, so these bounds only exist to catch a renderer that
// has genuinely stopped making progress.
const MAX_RENDER_BACKLOG_BYTES = 16 * 1024 * 1024;
const MAX_RENDER_BACKLOG_AGE_MS = 5_000;
const MAX_RENDER_BACKLOG_FRAMES = 8_192;
const MIN_AGED_RENDER_BACKLOG_BYTES = 4 * 1024 * 1024;
const RENDER_BACKLOG_COMPACT_FRAMES = 256;

export interface TerminalFrame {
  kind: number;
  sequence: number;
  data: Uint8Array;
}

export type TerminalSyncMode = "snapshot" | "resume";

export interface TerminalStreamIssue {
  kind: "recovering" | "reconnecting";
  pendingBytes?: number;
}

export class TerminalRenderBacklog {
  private bytes = 0;
  // Frames settle in the order they were enqueued, so a queue of arrival times
  // dates the oldest frame the parser still owes. Tracking only the last moment
  // the backlog stood empty would age out any terminal that never falls idle,
  // however well the renderer is keeping up.
  private queued: number[] = [];
  private settled = 0;

  get pendingBytes(): number {
    return this.bytes;
  }

  private get frames(): number {
    return this.queued.length - this.settled;
  }

  enqueue(bytes: number, now = Date.now()): boolean {
    if (bytes <= 0) return false;
    this.bytes += bytes;
    this.queued.push(now);
    if (this.bytes > MAX_RENDER_BACKLOG_BYTES || this.frames > MAX_RENDER_BACKLOG_FRAMES) {
      return true;
    }
    const oldest = this.queued[this.settled] ?? now;
    return this.bytes >= MIN_AGED_RENDER_BACKLOG_BYTES
      && now - oldest > MAX_RENDER_BACKLOG_AGE_MS;
  }

  settle(bytes: number): void {
    if (bytes <= 0) return;
    this.bytes = Math.max(0, this.bytes - bytes);
    if (this.settled < this.queued.length) this.settled += 1;
    if (this.settled >= this.queued.length) {
      this.reset();
    } else if (this.settled >= RENDER_BACKLOG_COMPACT_FRAMES) {
      this.queued = this.queued.slice(this.settled);
      this.settled = 0;
    }
  }

  reset(): void {
    this.bytes = 0;
    this.queued = [];
    this.settled = 0;
  }
}

export function decodeTerminalFrame(buffer: ArrayBuffer): TerminalFrame {
  if (buffer.byteLength < TERMINAL_FRAME_HEADER_BYTES) {
    throw new Error("terminal frame is missing its header");
  }
  const view = new DataView(buffer);
  const sequence = Number(view.getBigUint64(1));
  if (!Number.isSafeInteger(sequence)) {
    throw new Error("terminal sequence exceeds JavaScript's safe integer range");
  }
  return {
    kind: view.getUint8(0),
    sequence,
    data: new Uint8Array(buffer, TERMINAL_FRAME_HEADER_BYTES),
  };
}

export class TerminalStreamState {
  private committedSequence?: number;
  private receivedSequence?: number;
  private syncMode?: TerminalSyncMode;
  private syncTarget?: number;
  private snapshotReceived = false;
  // True once the local terminal state may have diverged from the server's
  // canonical model (e.g. after a resize reflows the buffer). While set, the
  // next reconnect asks for a full snapshot instead of resuming delta output
  // from a sequence that no longer matches the local grid.
  private resumeInvalid = false;

  get synchronizing(): boolean {
    return this.syncMode !== undefined;
  }

  get resumeSequence(): number | undefined {
    return this.resumeInvalid ? undefined : this.committedSequence;
  }

  /** Mark the local terminal state as potentially diverged from the server. */
  invalidateResume(): void {
    this.resumeInvalid = true;
  }

  restart(): void {
    this.committedSequence = undefined;
    this.receivedSequence = undefined;
    this.syncMode = undefined;
    this.syncTarget = undefined;
    this.snapshotReceived = false;
    this.resumeInvalid = false;
  }

  begin(mode: TerminalSyncMode, target: number): boolean {
    if (!Number.isSafeInteger(target) || target < 0) {
      throw new Error("invalid terminal sync sequence");
    }
    if (mode === "resume" && this.committedSequence === undefined) {
      throw new Error("cannot resume an uninitialized terminal");
    }
    this.syncMode = mode;
    this.syncTarget = target;
    this.snapshotReceived = false;
    if (mode === "snapshot") {
      this.committedSequence = undefined;
      this.receivedSequence = target;
      return true;
    }
    this.receivedSequence = this.committedSequence;
    return false;
  }

  accept(frame: TerminalFrame): number | undefined {
    if (frame.kind === TERMINAL_FRAME_SNAPSHOT) {
      if (this.syncMode !== "snapshot" || frame.sequence !== this.syncTarget) {
        throw new Error("unexpected terminal snapshot frame");
      }
      this.snapshotReceived = true;
      return undefined;
    }
    if (frame.kind !== TERMINAL_FRAME_OUTPUT) {
      throw new Error("unknown terminal frame kind");
    }
    if (this.receivedSequence === undefined || frame.sequence !== this.receivedSequence) {
      throw new Error("terminal output sequence gap");
    }
    this.receivedSequence += frame.data.byteLength;
    return this.receivedSequence;
  }

  commit(sequence: number): void {
    if (
      !Number.isSafeInteger(sequence)
      || sequence < 0
      || this.receivedSequence === undefined
      || sequence > this.receivedSequence
      || this.committedSequence !== undefined && sequence < this.committedSequence
    ) {
      throw new Error("invalid terminal parser commit");
    }
    this.committedSequence = sequence;
  }

  finish(target: number): void {
    if (target !== this.syncTarget || this.receivedSequence !== target) {
      throw new Error("terminal sync ended at an unexpected sequence");
    }
    if (this.syncMode === "snapshot") {
      if (!this.snapshotReceived) throw new Error("terminal snapshot contained no state");
      this.committedSequence = target;
    }
    if (this.committedSequence !== target) {
      throw new Error("terminal parser has not committed the complete sync");
    }
    this.syncMode = undefined;
    this.syncTarget = undefined;
    // A completed sync re-establishes an authoritative local state.
    this.resumeInvalid = false;
  }
}
