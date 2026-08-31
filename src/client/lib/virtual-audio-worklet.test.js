import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let FRAME_SAMPLES;
let JITTER_SAMPLES;
let MAX_BUFFERED_SAMPLES;
let PlaybackRingBuffer;

const pcm = (samples, value) => {
  const frame = new Int16Array(samples);
  frame.fill(value);
  return frame.buffer;
};

beforeAll(async () => {
  vi.stubGlobal("AudioWorkletProcessor", class {
    constructor() {
      this.port = {};
    }
  });
  vi.stubGlobal("registerProcessor", vi.fn());
  ({
    FRAME_SAMPLES,
    JITTER_SAMPLES,
    MAX_BUFFERED_SAMPLES,
    PlaybackRingBuffer,
  } = await import("../public/virtual-audio-worklet.js"));
});

afterAll(() => vi.unstubAllGlobals());

describe("virtual audio playback ring buffer", () => {
  it("waits for the jitter target and rebuffers after an underrun", () => {
    const buffer = new PlaybackRingBuffer();
    const output = new Float32Array(128);

    buffer.enqueue(pcm(FRAME_SAMPLES * 2, 16_384));
    buffer.render(output);
    expect(output.every((sample) => sample === 0)).toBe(true);

    buffer.enqueue(pcm(FRAME_SAMPLES, 16_384));
    buffer.render(output);
    expect(output.every((sample) => sample === 0.5)).toBe(true);

    buffer.render(new Float32Array(JITTER_SAMPLES));
    buffer.enqueue(pcm(FRAME_SAMPLES, 8_192));
    buffer.render(output);
    expect(output.every((sample) => sample === 0)).toBe(true);
  });

  it("retains only the newest jitter window when the ring overflows", () => {
    const buffer = new PlaybackRingBuffer();
    buffer.enqueue(pcm(MAX_BUFFERED_SAMPLES, 1_000));
    buffer.render(new Float32Array(FRAME_SAMPLES));

    buffer.enqueue(pcm(FRAME_SAMPLES * 2, 2_000));
    const retained = new Float32Array(JITTER_SAMPLES);
    buffer.render(retained);
    expect(retained.every((sample) => sample === 1_000 / 0x8000)).toBe(true);

    const incoming = new Float32Array(128);
    buffer.render(incoming);
    expect(incoming.every((sample) => sample === 2_000 / 0x8000)).toBe(true);
  });

  it("ignores malformed and oversized packets", () => {
    const buffer = new PlaybackRingBuffer();
    buffer.enqueue(new ArrayBuffer(3));
    buffer.enqueue(pcm(MAX_BUFFERED_SAMPLES + 1, 1_000));

    const output = new Float32Array(128);
    buffer.render(output);
    expect(output.every((sample) => sample === 0)).toBe(true);
  });
});
