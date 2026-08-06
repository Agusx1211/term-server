export const TERMINAL_FRAME_SNAPSHOT = 0;
export const TERMINAL_FRAME_OUTPUT = 1;
const TERMINAL_FRAME_HEADER_BYTES = 9;
const MAX_RENDER_BACKLOG_BYTES = 512 * 1024;
const MAX_RENDER_BACKLOG_AGE_MS = 1_500;
const MAX_RENDER_BACKLOG_FRAMES = 128;
const MIN_AGED_RENDER_BACKLOG_BYTES = 64 * 1024;

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
  private frames = 0;
  private pendingSince?: number;

  get pendingBytes(): number {
    return this.bytes;
  }

  enqueue(bytes: number, now = Date.now()): boolean {
    if (bytes <= 0) return false;
    if (this.bytes === 0) this.pendingSince = now;
    this.bytes += bytes;
    this.frames += 1;
    return this.frames > MAX_RENDER_BACKLOG_FRAMES
      || this.bytes > MAX_RENDER_BACKLOG_BYTES
      || this.bytes >= MIN_AGED_RENDER_BACKLOG_BYTES
        && now - (this.pendingSince ?? now) > MAX_RENDER_BACKLOG_AGE_MS;
  }

  settle(bytes: number): void {
    if (bytes <= 0) return;
    this.bytes = Math.max(0, this.bytes - bytes);
    this.frames = Math.max(0, this.frames - 1);
    if (this.bytes === 0) this.pendingSince = undefined;
  }

  reset(): void {
    this.bytes = 0;
    this.frames = 0;
    this.pendingSince = undefined;
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
