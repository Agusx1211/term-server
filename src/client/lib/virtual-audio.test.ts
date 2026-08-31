import { describe, expect, it } from "vitest";
import {
  AUDIO_DEFAULT_DEVICE_ID,
  audioDeviceOptions,
  parseVirtualAudioServerMessage,
  virtualAudioSocketUrl,
} from "./virtual-audio";

describe("virtual audio protocol", () => {
  it("accepts the negotiated PCM format and peer counts", () => {
    expect(parseVirtualAudioServerMessage({
      type: "ready",
      available: true,
      inputDevice: "Term Server Microphone",
      outputDevice: "Term Server Speaker",
      sampleRate: 48_000,
      channels: 1,
      frameSamples: 960,
      jitterFrames: 3,
      inputPeers: 2,
      outputPeers: 4,
      error: null,
    })).toEqual({
      type: "ready",
      available: true,
      inputDevice: "Term Server Microphone",
      outputDevice: "Term Server Speaker",
      sampleRate: 48_000,
      channels: 1,
      frameSamples: 960,
      jitterFrames: 3,
      inputPeers: 2,
      outputPeers: 4,
      error: undefined,
    });
  });

  it("rejects malformed messages instead of partially applying them", () => {
    expect(parseVirtualAudioServerMessage({ type: "state", inputEnabled: true })).toBeUndefined();
    expect(parseVirtualAudioServerMessage({
      type: "ready",
      available: true,
      inputDevice: "mic",
      outputDevice: "speaker",
      sampleRate: 48_000,
      channels: 1,
      frameSamples: -1,
      jitterFrames: 3,
      inputPeers: 0,
      outputPeers: 0,
    })).toBeUndefined();
    expect(parseVirtualAudioServerMessage({ type: "unknown" })).toBeUndefined();
  });

  it("uses the authenticated same-origin audio WebSocket", () => {
    expect(virtualAudioSocketUrl({ protocol: "https:", host: "terminal.test:8090" }).toString())
      .toBe("wss://terminal.test:8090/api/audio/socket");
    expect(virtualAudioSocketUrl({ protocol: "http:", host: "localhost:8090" }).protocol)
      .toBe("ws:");
  });
});

describe("browser audio devices", () => {
  it("keeps one stable default and labels permission-hidden devices", () => {
    const devices = [
      { deviceId: "default", kind: "audioinput", label: "Default microphone" },
      { deviceId: "mic-a", kind: "audioinput", label: "Studio microphone" },
      { deviceId: "mic-b", kind: "audioinput", label: "" },
      { deviceId: "speaker-a", kind: "audiooutput", label: "Desk speakers" },
    ] satisfies Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[];

    expect(audioDeviceOptions(devices, "audioinput")).toEqual([
      { id: AUDIO_DEFAULT_DEVICE_ID, label: "System default microphone" },
      { id: "mic-a", label: "Studio microphone" },
      { id: "mic-b", label: "Microphone 2" },
    ]);
    expect(audioDeviceOptions(devices, "audiooutput")).toEqual([
      { id: AUDIO_DEFAULT_DEVICE_ID, label: "System default speaker" },
      { id: "speaker-a", label: "Desk speakers" },
    ]);
  });
});
