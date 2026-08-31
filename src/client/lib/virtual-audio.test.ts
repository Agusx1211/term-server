import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_DEFAULT_DEVICE_ID,
  AUDIO_OFF_DEVICE_ID,
  audioDeviceOptions,
  parseVirtualAudioServerMessage,
  type VirtualAudioSnapshot,
  VirtualAudioClient,
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

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: (string | ArrayBuffer)[] = [];
  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;

  constructor(readonly url: string | URL) {
    super();
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
  }

  message(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

class FakeAudioWorkletNode {
  readonly port = {
    onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
}

const readyMessage = (available = true, error?: string) => JSON.stringify({
  type: "ready",
  available,
  inputDevice: "Term Server Microphone",
  outputDevice: "Term Server Speaker",
  sampleRate: 48_000,
  channels: 1,
  frameSamples: 960,
  jitterFrames: 3,
  inputPeers: 0,
  outputPeers: 0,
  error,
});

describe("virtual audio client state", () => {
  let track = { stop: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    track = { stop: vi.fn() };
    vi.stubGlobal("window", {
      location: { protocol: "https:", host: "terminal.test" },
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        enumerateDevices: vi.fn(async () => []),
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [track],
        })),
      },
    });
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("AudioContext", class {
      readonly sampleRate = 48_000;
      readonly audioWorklet = { addModule: vi.fn(async () => undefined) };
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createMediaStreamSource = vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
      }));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reconnects after a delay and restores the selected input route", async () => {
    let snapshot: VirtualAudioSnapshot | undefined;
    const client = new VirtualAudioClient((next) => {
      snapshot = next;
    });
    client.start();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.message(readyMessage());
    await client.selectInput("microphone-a");
    expect(snapshot?.inputDeviceId).toBe("microphone-a");
    expect(first.sent).toContain(JSON.stringify({ type: "input", enabled: true }));

    first.close();
    expect(snapshot?.connection).toBe("disconnected");
    expect(snapshot?.inputDeviceId).toBe("microphone-a");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    const second = FakeWebSocket.instances[1]!;
    second.open();
    second.message(readyMessage());
    expect(second.sent).toContain(JSON.stringify({ type: "input", enabled: true }));
    client.dispose();
  });

  it("drops active selections when the host runtime becomes unavailable", async () => {
    let snapshot: VirtualAudioSnapshot | undefined;
    const client = new VirtualAudioClient((next) => {
      snapshot = next;
    });
    client.start();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message(readyMessage());
    await client.selectInput("microphone-a");

    socket.message(readyMessage(false, "virtual microphone keepalive stopped"));
    expect(snapshot?.connection).toBe("unavailable");
    expect(snapshot?.inputDeviceId).toBe(AUDIO_OFF_DEVICE_ID);
    expect(snapshot?.outputDeviceId).toBe(AUDIO_OFF_DEVICE_ID);
    expect(snapshot?.error).toBe("virtual microphone keepalive stopped");
    expect(track.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.dispose();
  });

  it("ignores a microphone selection that resolves after it was turned off", async () => {
    let resolveStream: ((stream: { getTracks(): typeof track[] }) => void) | undefined;
    const pendingStream = new Promise<{ getTracks(): typeof track[] }>((resolve) => {
      resolveStream = resolve;
    });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(
      pendingStream as unknown as Promise<MediaStream>,
    );
    let snapshot: VirtualAudioSnapshot | undefined;
    const client = new VirtualAudioClient((next) => {
      snapshot = next;
    });
    client.start();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message(readyMessage());

    const selecting = client.selectInput("microphone-a");
    await client.selectInput(AUDIO_OFF_DEVICE_ID);
    resolveStream?.({ getTracks: () => [track] });
    await selecting;

    expect(snapshot?.inputDeviceId).toBe(AUDIO_OFF_DEVICE_ID);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(socket.sent).not.toContain(JSON.stringify({ type: "input", enabled: true }));
    client.dispose();
  });
});
