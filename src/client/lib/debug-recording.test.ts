import { describe, expect, it } from "vitest";
import {
  MAX_FRONTEND_RECORDING_EVENTS,
  debugRecordingEventCount,
  encodeBytesBase64,
  encodeTextBase64,
  resetDebugRecording,
  startDebugRecording,
  stopDebugRecording,
  takeFrontendRecording,
  recordDebugEvent,
} from "./debug-recording";

describe("debug-recording", () => {
  it("drops events while recording is inactive", () => {
    resetDebugRecording();
    recordDebugEvent("a", { type: "connect" });
    expect(debugRecordingEventCount()).toBe(0);
    expect(takeFrontendRecording().events).toHaveLength(0);
  });

  it("captures events while recording is active", () => {
    resetDebugRecording();
    startDebugRecording();
    recordDebugEvent("a", { type: "connect" });
    recordDebugEvent("a", { type: "output", sequence: 5, data: "aGk=" });
    expect(debugRecordingEventCount()).toBe(2);
    const taken = takeFrontendRecording();
    expect(taken.events).toHaveLength(2);
    const [first, second] = taken.events;
    expect(first?.terminal).toBe("a");
    expect(first?.event.type).toBe("connect");
    expect(second?.event).toEqual({ type: "output", sequence: 5, data: "aGk=" });
    // Taking clears the buffer.
    expect(debugRecordingEventCount()).toBe(0);
    stopDebugRecording();
  });

  it("stops capturing after stopDebugRecording", () => {
    resetDebugRecording();
    startDebugRecording();
    recordDebugEvent("a", { type: "notice", message: "hi" });
    stopDebugRecording();
    recordDebugEvent("a", { type: "notice", message: "ignored" });
    expect(debugRecordingEventCount()).toBe(1);
  });

  it("caps the number of retained events and flags truncation", () => {
    resetDebugRecording();
    startDebugRecording();
    const id = "cap";
    for (let i = 0; i < MAX_FRONTEND_RECORDING_EVENTS + 100; i += 1) {
      recordDebugEvent(id, { type: "connect" });
    }
    expect(debugRecordingEventCount()).toBe(MAX_FRONTEND_RECORDING_EVENTS);
    const taken = takeFrontendRecording();
    expect(taken.truncated).toBe(true);
    expect(taken.events).toHaveLength(MAX_FRONTEND_RECORDING_EVENTS);
  });

  it("base64 encodes bytes and text", () => {
    expect(encodeTextBase64("hi")).toBe("aGk=");
    expect(encodeBytesBase64(new Uint8Array([0x00, 0x01, 0xff]))).toBe("AAH/");
  });
});
