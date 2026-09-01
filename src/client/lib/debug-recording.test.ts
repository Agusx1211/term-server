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
  onDebugRecordingChange,
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

  it("keeps the newest events in order once the cap is reached", () => {
    resetDebugRecording();
    startDebugRecording();
    const overflow = 100;
    for (let i = 0; i < MAX_FRONTEND_RECORDING_EVENTS + overflow; i += 1) {
      recordDebugEvent("cap", { type: "notice", message: `event-${i}` });
    }

    const taken = takeFrontendRecording();
    expect(taken.truncated).toBe(true);
    expect(taken.events).toHaveLength(MAX_FRONTEND_RECORDING_EVENTS);
    expect(taken.events[0]?.event).toEqual({ type: "notice", message: `event-${overflow}` });
    expect(taken.events.at(-1)?.event).toEqual({
      type: "notice",
      message: `event-${MAX_FRONTEND_RECORDING_EVENTS + overflow - 1}`,
    });
    const ordered = taken.events.every((entry, index) => (
      index === 0 || entry.ts >= (taken.events[index - 1]?.ts ?? 0)
    ));
    expect(ordered).toBe(true);
    stopDebugRecording();
  });

  it("starts a fresh buffer after the cap was reached", () => {
    resetDebugRecording();
    startDebugRecording();
    for (let i = 0; i < MAX_FRONTEND_RECORDING_EVENTS + 1; i += 1) {
      recordDebugEvent("cap", { type: "connect" });
    }
    takeFrontendRecording();

    recordDebugEvent("next", { type: "notice", message: "after" });
    const taken = takeFrontendRecording();
    expect(taken.truncated).toBe(false);
    expect(taken.events).toHaveLength(1);
    expect(taken.events[0]?.terminal).toBe("next");
    stopDebugRecording();
  });

  it("base64 encodes bytes and text", () => {
    expect(encodeTextBase64("hi")).toBe("aGk=");
    expect(encodeBytesBase64(new Uint8Array([0x00, 0x01, 0xff]))).toBe("AAH/");
  });

  it("notifies subscribers when recording starts and stops", () => {
    resetDebugRecording();
    const changes: boolean[] = [];
    const off = onDebugRecordingChange((active) => changes.push(active));
    startDebugRecording();
    stopDebugRecording();
    startDebugRecording();
    off();
    startDebugRecording();
    stopDebugRecording();
    resetDebugRecording();
    expect(changes).toEqual([true, false, true]);
  });
});
