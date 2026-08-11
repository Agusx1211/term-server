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
// A canonical/browser snapshot may legitimately be larger than an ordinary
// output burst. It still needs a hard resource ceiling and an oldest-frame
// deadline, but must not be abandoned at the ordinary-output byte limit.
export const MAX_SNAPSHOT_RENDER_BACKLOG_BYTES = 64 * 1024 * 1024;
export const MAX_SNAPSHOT_RENDER_BACKLOG_FRAMES = 65_536;
export const MAX_SNAPSHOT_RENDER_BACKLOG_AGE_MS = MAX_RENDER_BACKLOG_AGE_MS;
const RENDER_BACKLOG_COMPACT_FRAMES = 256;

export type TerminalBacklogKind = "output" | "snapshot";

// Acknowledgements are batched rather than sent per frame, so a burst costs a
// handful of small messages instead of one per chunk. The batch size matches the
// server's low watermark: the unsent remainder is therefore always smaller than
// the amount that would keep the terminal paused, so a stream that goes quiet
// mid-batch still leaves the pty running.
export const TERMINAL_ACK_BYTES = 5_000;

/// Batches parsed-byte counts into acknowledgements for the server.
export class TerminalOutputAck {
  private pending = 0;

  get pendingBytes(): number {
    return this.pending;
  }
  /**
   * Records bytes the parser has consumed and returns the batch to acknowledge
   * once one is due. The remainder is carried, never dropped, so the server's
   * view of what this browser owes cannot drift upwards over a long session.
   */
  parsed(bytes: number): number | undefined {
    if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
    this.pending += bytes;
    if (this.pending < TERMINAL_ACK_BYTES) return undefined;
    const batch = this.pending;
    this.pending = 0;
    return batch;
  }
}

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
  private outputBytes = 0;
  private snapshotBytes = 0;
  private outputFrames = 0;
  private snapshotFrames = 0;
  // Frames settle in the order they were enqueued, so each entry dates the
  // oldest parser write still owed. Keeping the kind with the entry lets a
  // large valid snapshot use its own ceiling without masking a stuck output
  // stream that is queued behind it.
  private queued: Array<{ readonly bytes: number; readonly kind: TerminalBacklogKind; readonly at: number }> = [];
  private settled = 0;
  private settledBytes = 0;
  private oldestOutputAt: number | undefined;
  private oldestSnapshotAt: number | undefined;

  get pendingBytes(): number {
    return this.bytes;
  }
  get pendingFrames(): number {
    return this.frames;
  }

  get oldestAgeMs(): number {
    const oldest = this.queued[this.settled]?.at;
    return oldest === undefined ? 0 : Math.max(0, Date.now() - oldest);
  }

  private get frames(): number {
    return this.queued.length - this.settled;
  }

  enqueue(bytes: number, now = Date.now(), kind: TerminalBacklogKind = "output"): boolean {
    if (!Number.isFinite(bytes) || bytes <= 0) return false;
    const entry = { bytes, kind, at: now };
    this.bytes += bytes;
    this.queued.push(entry);
    if (kind === "snapshot") {
      this.snapshotBytes += bytes;
      this.snapshotFrames += 1;
      if (this.oldestSnapshotAt === undefined) this.oldestSnapshotAt = now;
      return this.snapshotBacklogExceeded(now);
    }
    this.outputBytes += bytes;
    this.outputFrames += 1;
    if (this.oldestOutputAt === undefined) this.oldestOutputAt = now;
    return this.outputBacklogExceeded(now);
  }

  settle(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    let remaining = bytes;
    while (remaining > 0 && this.settled < this.queued.length) {
      const entry = this.queued[this.settled];
      if (!entry) break;
      const available = entry.bytes - this.settledBytes;
      const settledBytes = Math.min(remaining, available);
      this.bytes = Math.max(0, this.bytes - settledBytes);
      if (entry.kind === "snapshot") {
        this.snapshotBytes = Math.max(0, this.snapshotBytes - settledBytes);
      } else {
        this.outputBytes = Math.max(0, this.outputBytes - settledBytes);
      }
      remaining -= settledBytes;
      this.settledBytes += settledBytes;
      if (this.settledBytes < entry.bytes) break;
      if (entry.kind === "snapshot") {
        this.snapshotFrames = Math.max(0, this.snapshotFrames - 1);
        this.oldestSnapshotAt = this.findOldest("snapshot", this.settled + 1);
      } else {
        this.outputFrames = Math.max(0, this.outputFrames - 1);
        this.oldestOutputAt = this.findOldest("output", this.settled + 1);
      }
      this.settled += 1;
      this.settledBytes = 0;
    }
    if (this.settled >= this.queued.length) {
      this.reset();
    } else if (this.settled >= RENDER_BACKLOG_COMPACT_FRAMES) {
      this.queued = this.queued.slice(this.settled);
      this.settled = 0;
    }
  }

  reset(): void {
    this.bytes = 0;
    this.outputBytes = 0;
    this.snapshotBytes = 0;
    this.outputFrames = 0;
    this.snapshotFrames = 0;
    this.queued = [];
    this.settled = 0;
    this.settledBytes = 0;
    this.oldestOutputAt = undefined;
    this.oldestSnapshotAt = undefined;
  }

  private findOldest(kind: TerminalBacklogKind, from: number): number | undefined {
    for (let index = from; index < this.queued.length; index += 1) {
      if (this.queued[index]?.kind === kind) return this.queued[index]!.at;
    }
    return undefined;
  }

  private outputBacklogExceeded(now: number): boolean {
    if (this.outputBytes > MAX_RENDER_BACKLOG_BYTES || this.outputFrames > MAX_RENDER_BACKLOG_FRAMES) return true;
    return this.outputBytes >= MIN_AGED_RENDER_BACKLOG_BYTES
      && this.oldestOutputAt !== undefined
      && now - this.oldestOutputAt > MAX_RENDER_BACKLOG_AGE_MS;
  }

  private snapshotBacklogExceeded(now: number): boolean {
    if (this.snapshotBytes > MAX_SNAPSHOT_RENDER_BACKLOG_BYTES || this.snapshotFrames > MAX_SNAPSHOT_RENDER_BACKLOG_FRAMES) return true;
    return this.oldestSnapshotAt !== undefined && now - this.oldestSnapshotAt > MAX_SNAPSHOT_RENDER_BACKLOG_AGE_MS;
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

  get synchronizing(): boolean {
    return this.syncMode !== undefined;
  }

  get committed(): number | undefined {
    return this.committedSequence;
  }

  get received(): number | undefined {
    return this.receivedSequence;
  }

  get mode(): TerminalSyncMode | undefined {
    return this.syncMode;
  }

  get target(): number | undefined {
    return this.syncTarget;
  }

  get resumeSequence(): number | undefined {
    return this.committedSequence;
  }

  restart(): void {
    this.committedSequence = undefined;
    this.receivedSequence = undefined;
    this.syncMode = undefined;
    this.syncTarget = undefined;
    this.snapshotReceived = false;
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
  }
}
