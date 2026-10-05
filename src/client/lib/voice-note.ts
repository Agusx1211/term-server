/** Container formats tried in order. Chromium and Firefox record Opus in
 * WebM/Ogg; Safari (including every iOS browser) only records AAC in MP4. */
const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/aac",
];

/** Chunk interval for the recorder. Periodic chunks keep memory flat and mean
 * a recording interrupted by the browser still has its audio so far. */
const RECORDING_TIMESLICE_MS = 1000;

/** The first container the browser can record, or `undefined` to let the
 * recorder choose its default. */
export function pickRecordingMimeType(
  isTypeSupported: (type: string) => boolean,
): string | undefined {
  return RECORDING_MIME_TYPES.find((type) => {
    try {
      return isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

/** File extension for a recorded container (codec parameters ignored). */
export function voiceNoteExtension(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "audio/webm":
    case "video/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    case "audio/mp4":
    case "video/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/aac":
      return "aac";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    default:
      return "webm";
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A sortable, shell-safe file name in local time, e.g.
 * `voice-note-2026-10-05-14-03-09.webm`. */
export function voiceNoteFileName(date: Date, mimeType: string): string {
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("-");
  return `voice-note-${stamp}.${voiceNoteExtension(mimeType)}`;
}

/** Elapsed recording time as `m:ss` (or `h:mm:ss` past an hour). */
export function formatRecordingDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Why recording could not start, phrased for a toast. */
export function voiceNoteErrorMessage(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone permission was denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found";
    case "NotReadableError":
    case "AbortError":
      return "The microphone is busy or unavailable";
    default:
      return error instanceof Error && error.message
        ? `Could not record: ${error.message}`
        : "Could not record a voice note";
  }
}

/** Mono 16-bit PCM WAV from float samples in [-1, 1]. */
export function encodeWav(chunks: readonly Float32Array[], sampleRate: number): Blob {
  const samples = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

type AudioContextConstructor = typeof AudioContext;

function audioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext
    ?? (window as Window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
}

/** Whether this page can record at all. Microphone access needs a secure
 * context (HTTPS or localhost), so a plain-HTTP LAN address cannot record. */
export function voiceNoteSupport(): { supported: true } | { supported: false; reason: string } {
  if (typeof window === "undefined" || !window.isSecureContext) {
    return { supported: false, reason: "Voice notes need HTTPS (or localhost) for microphone access" };
  }
  if (
    !navigator.mediaDevices?.getUserMedia
    || (typeof MediaRecorder === "undefined" && !audioContextConstructor())
  ) {
    return { supported: false, reason: "This browser cannot record audio" };
  }
  return { supported: true };
}

/** A running capture of one microphone stream. `stop` finalises it into
 * `finished`; `discard` drops the audio. */
interface CaptureEngine {
  finished: Promise<Blob>;
  stop(): void;
  discard(): void;
}

/** Compressed capture through `MediaRecorder` (every current browser). */
function startMediaRecorder(stream: MediaStream): CaptureEngine {
  const mimeType = pickRecordingMimeType((type) => MediaRecorder.isTypeSupported(type));
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  let chunks: Blob[] = [];
  let discarded = false;
  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (!discarded && event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      const type = recorder.mimeType || mimeType || chunks[0]?.type || "audio/webm";
      resolve(new Blob(chunks, { type }));
      chunks = [];
    });
    recorder.addEventListener("error", (event) => {
      const error = (event as Event & { error?: unknown }).error;
      reject(error instanceof Error ? error : new Error("Recording failed"));
    });
  });
  recorder.start(RECORDING_TIMESLICE_MS);
  const stop = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };
  return {
    finished,
    stop,
    discard() {
      discarded = true;
      chunks = [];
      stop();
    },
  };
}

/** Uncompressed WAV capture for browsers without `MediaRecorder` (older iOS
 * and some embedded web views). `ScriptProcessorNode` is deprecated but needs
 * no worklet module, which the page's script policy would block as a blob. */
function startPcmRecorder(stream: MediaStream, Context: AudioContextConstructor): CaptureEngine {
  const context = new Context();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silence = context.createGain();
  silence.gain.value = 0;
  let chunks: Float32Array[] = [];
  let running = true;
  processor.onaudioprocess = (event) => {
    if (running) chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  // The processor only runs while connected to the destination; the muted
  // gain keeps the microphone out of the speakers.
  source.connect(processor);
  processor.connect(silence);
  silence.connect(context.destination);
  void context.resume();
  let resolveFinished: (blob: Blob) => void = () => undefined;
  const finished = new Promise<Blob>((resolve) => {
    resolveFinished = resolve;
  });
  const end = (keep: boolean) => {
    if (!running) return;
    running = false;
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    silence.disconnect();
    const blob = keep ? encodeWav(chunks, context.sampleRate) : new Blob([], { type: "audio/wav" });
    chunks = [];
    void context.close().catch(() => undefined);
    resolveFinished(blob);
  };
  return { finished, stop: () => end(true), discard: () => end(false) };
}

/** One microphone recording. `start` asks for the microphone; `stop` resolves
 * with the recorded file; `cancel` discards it. The microphone is released as
 * soon as recording ends either way, so the browser's recording indicator
 * goes away. */
export class VoiceNoteRecorder {
  private stream?: MediaStream;
  private engine?: CaptureEngine;
  private startedAt = new Date();
  private finished?: Promise<File>;
  private cancelled = false;

  /** Fires when recording ends without `stop` (the microphone was unplugged,
   * revoked, or suspended by the OS); `stop()` still returns what was
   * recorded up to that point. */
  onInterrupted?: () => void;

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.stream = stream;
    if (this.cancelled) {
      this.release();
      throw new DOMException("Recording was cancelled", "AbortError");
    }
    const Context = audioContextConstructor();
    let engine: CaptureEngine;
    try {
      if (typeof MediaRecorder !== "undefined") engine = startMediaRecorder(stream);
      else if (Context) engine = startPcmRecorder(stream, Context);
      else throw new Error("This browser cannot record audio");
    } catch (error) {
      this.release();
      throw error;
    }
    this.engine = engine;
    this.startedAt = new Date();
    this.finished = engine.finished.then(
      (blob) => {
        this.release();
        if (this.cancelled) throw new DOMException("Recording was cancelled", "AbortError");
        if (blob.size === 0) throw new Error("No audio was recorded");
        return new File([blob], voiceNoteFileName(this.startedAt, blob.type), { type: blob.type });
      },
      (error: unknown) => {
        this.release();
        throw error;
      },
    );
    // A rejected promise nobody awaited yet must not surface as unhandled.
    this.finished.catch(() => undefined);
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (this.cancelled || !this.engine) return;
        this.onInterrupted?.();
      });
    }
  }

  /** Stops recording and resolves with the audio file. */
  stop(): Promise<File> {
    if (!this.engine || !this.finished) return Promise.reject(new Error("Recording never started"));
    this.engine.stop();
    return this.finished;
  }

  /** Discards the recording and releases the microphone. */
  cancel(): void {
    this.cancelled = true;
    if (this.engine) this.engine.discard();
    else this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
  }
}
