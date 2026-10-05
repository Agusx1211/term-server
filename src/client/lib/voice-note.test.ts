import { describe, expect, it } from "vitest";
import {
  encodeWav,
  formatRecordingDuration,
  pickRecordingMimeType,
  voiceNoteErrorMessage,
  voiceNoteExtension,
  voiceNoteFileName,
} from "./voice-note";

describe("pickRecordingMimeType", () => {
  it("prefers Opus in WebM where the browser records it", () => {
    expect(pickRecordingMimeType(() => true)).toBe("audio/webm;codecs=opus");
  });

  it("falls back to AAC in MP4 for Safari and iOS", () => {
    expect(pickRecordingMimeType((type) => type.startsWith("audio/mp4"))).toBe("audio/mp4;codecs=mp4a.40.2");
  });

  it("leaves the choice to the recorder when nothing matches or the probe throws", () => {
    expect(pickRecordingMimeType(() => false)).toBeUndefined();
    expect(pickRecordingMimeType(() => {
      throw new Error("unsupported");
    })).toBeUndefined();
  });
});

describe("voiceNoteExtension", () => {
  it("maps recorded containers to file extensions, ignoring codec parameters", () => {
    expect(voiceNoteExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(voiceNoteExtension("audio/ogg; codecs=opus")).toBe("ogg");
    expect(voiceNoteExtension("audio/mp4")).toBe("m4a");
    expect(voiceNoteExtension("audio/aac")).toBe("aac");
    expect(voiceNoteExtension("")).toBe("webm");
  });
});

describe("voiceNoteFileName", () => {
  it("names the note after its local start time without shell metacharacters", () => {
    const name = voiceNoteFileName(new Date(2026, 9, 5, 4, 3, 9), "audio/mp4");
    expect(name).toBe("voice-note-2026-10-05-04-03-09.m4a");
    expect(name).toMatch(/^[\w.-]+$/);
  });
});

describe("formatRecordingDuration", () => {
  it("formats elapsed time as m:ss and h:mm:ss", () => {
    expect(formatRecordingDuration(-5)).toBe("0:00");
    expect(formatRecordingDuration(9_999)).toBe("0:09");
    expect(formatRecordingDuration(75_000)).toBe("1:15");
    expect(formatRecordingDuration(3_661_000)).toBe("1:01:01");
  });
});

describe("voiceNoteErrorMessage", () => {
  it("explains permission and device failures", () => {
    expect(voiceNoteErrorMessage(new DOMException("denied", "NotAllowedError"))).toBe("Microphone permission was denied");
    expect(voiceNoteErrorMessage(new DOMException("none", "NotFoundError"))).toBe("No microphone was found");
    expect(voiceNoteErrorMessage(new Error("No audio was recorded"))).toBe("Could not record: No audio was recorded");
    expect(voiceNoteErrorMessage("weird")).toBe("Could not record a voice note");
  });
});

describe("encodeWav", () => {
  it("writes a mono 16-bit PCM WAV with clamped samples", async () => {
    const blob = encodeWav([new Float32Array([0, 1]), new Float32Array([-1, 2])], 48_000);
    expect(blob.type).toBe("audio/wav");
    const view = new DataView(await blob.arrayBuffer());
    const ascii = (offset: number) => String.fromCharCode(...new Uint8Array(view.buffer, offset, 4));
    expect(view.byteLength).toBe(44 + 4 * 2);
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(28, true)).toBe(96_000);
    expect(view.getUint32(40, true)).toBe(8);
    expect([44, 46, 48, 50].map((offset) => view.getInt16(offset, true))).toEqual([0, 32767, -32768, 32767]);
  });
});
