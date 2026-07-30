export const TERMINAL_FRAME_SNAPSHOT = 0;
export const TERMINAL_FRAME_OUTPUT = 1;
const TERMINAL_FRAME_HEADER_BYTES = 9;

export interface TerminalFrame {
  kind: number;
  sequence: number;
  data: Uint8Array;
}

export type TerminalSyncMode = "snapshot" | "resume";

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

  get resumeSequence(): number | undefined {
    return this.committedSequence;
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
