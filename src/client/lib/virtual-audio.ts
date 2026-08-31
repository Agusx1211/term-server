export const AUDIO_OFF_DEVICE_ID = "off";
export const AUDIO_DEFAULT_DEVICE_ID = "default";
const AUDIO_WORKLET_PATH = "/virtual-audio-worklet.js";
const MAX_SOCKET_AUDIO_BACKLOG = 64 * 1024;
const RECONNECT_DELAY_MS = 2_000;

export interface AudioDeviceOption {
  id: string;
  label: string;
}

export interface VirtualAudioSnapshot {
  connection: "connecting" | "ready" | "unavailable" | "disconnected";
  available: boolean;
  inputDeviceId: string;
  outputDeviceId: string;
  inputDevices: AudioDeviceOption[];
  outputDevices: AudioDeviceOption[];
  inputDeviceName: string;
  outputDeviceName: string;
  inputPeers: number;
  outputPeers: number;
  inputEnabled: boolean;
  outputEnabled: boolean;
  outputSelectionSupported: boolean;
  error?: string;
}

export const INITIAL_VIRTUAL_AUDIO_SNAPSHOT: VirtualAudioSnapshot = {
  connection: "connecting",
  available: false,
  inputDeviceId: AUDIO_OFF_DEVICE_ID,
  outputDeviceId: AUDIO_OFF_DEVICE_ID,
  inputDevices: [{ id: AUDIO_DEFAULT_DEVICE_ID, label: "System default microphone" }],
  outputDevices: [{ id: AUDIO_DEFAULT_DEVICE_ID, label: "System default speaker" }],
  inputDeviceName: "Term Server Microphone",
  outputDeviceName: "Term Server Speaker",
  inputPeers: 0,
  outputPeers: 0,
  inputEnabled: false,
  outputEnabled: false,
  outputSelectionSupported: false,
};

export const UNSUPPORTED_VIRTUAL_AUDIO_SNAPSHOT: VirtualAudioSnapshot = {
  ...INITIAL_VIRTUAL_AUDIO_SNAPSHOT,
  connection: "unavailable",
};

interface AudioReadyMessage {
  type: "ready";
  available: boolean;
  inputDevice: string;
  outputDevice: string;
  sampleRate: number;
  channels: number;
  frameSamples: number;
  jitterFrames: number;
  inputPeers: number;
  outputPeers: number;
  error?: string;
}

interface AudioStateMessage {
  type: "state";
  inputEnabled: boolean;
  outputEnabled: boolean;
  inputPeers: number;
  outputPeers: number;
}

interface AudioErrorMessage {
  type: "error";
  message: string;
}

interface AudioPongMessage {
  type: "pong";
}

export type VirtualAudioServerMessage =
  | AudioReadyMessage
  | AudioStateMessage
  | AudioErrorMessage
  | AudioPongMessage;

type SnapshotListener = (snapshot: VirtualAudioSnapshot) => void;
type AudioElementWithSink = HTMLAudioElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

const record = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

const nonNegativeInteger = (value: unknown): value is number => (
  typeof value === "number" && Number.isInteger(value) && value >= 0
);

export function parseVirtualAudioServerMessage(value: unknown): VirtualAudioServerMessage | undefined {
  const message = record(value);
  if (!message || typeof message.type !== "string") return undefined;
  if (message.type === "ready") {
    if (
      typeof message.available !== "boolean"
      || typeof message.inputDevice !== "string"
      || typeof message.outputDevice !== "string"
      || !nonNegativeInteger(message.sampleRate)
      || !nonNegativeInteger(message.channels)
      || !nonNegativeInteger(message.frameSamples)
      || !nonNegativeInteger(message.jitterFrames)
      || !nonNegativeInteger(message.inputPeers)
      || !nonNegativeInteger(message.outputPeers)
      || (message.error !== undefined && message.error !== null && typeof message.error !== "string")
    ) return undefined;
    return {
      type: "ready",
      available: message.available,
      inputDevice: message.inputDevice,
      outputDevice: message.outputDevice,
      sampleRate: message.sampleRate,
      channels: message.channels,
      frameSamples: message.frameSamples,
      jitterFrames: message.jitterFrames,
      inputPeers: message.inputPeers,
      outputPeers: message.outputPeers,
      error: typeof message.error === "string" ? message.error : undefined,
    };
  }
  if (message.type === "state") {
    if (
      typeof message.inputEnabled !== "boolean"
      || typeof message.outputEnabled !== "boolean"
      || !nonNegativeInteger(message.inputPeers)
      || !nonNegativeInteger(message.outputPeers)
    ) return undefined;
    return {
      type: "state",
      inputEnabled: message.inputEnabled,
      outputEnabled: message.outputEnabled,
      inputPeers: message.inputPeers,
      outputPeers: message.outputPeers,
    };
  }
  if (message.type === "error" && typeof message.message === "string") {
    return { type: "error", message: message.message };
  }
  if (message.type === "pong") return { type: "pong" };
  return undefined;
}

export function audioDeviceOptions(
  devices: readonly Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[],
  kind: MediaDeviceKind,
): AudioDeviceOption[] {
  const noun = kind === "audioinput" ? "microphone" : "speaker";
  const unnamedLabel = kind === "audioinput" ? "Microphone" : "Speaker";
  const options: AudioDeviceOption[] = [{ id: AUDIO_DEFAULT_DEVICE_ID, label: `System default ${noun}` }];
  let unnamed = 0;
  const seen = new Set([AUDIO_DEFAULT_DEVICE_ID, ""]);
  for (const device of devices) {
    if (device.kind !== kind || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    unnamed += 1;
    options.push({
      id: device.deviceId,
      label: device.label || `${unnamedLabel} ${unnamed}`,
    });
  }
  return options;
}

export function virtualAudioSocketUrl(location: Pick<Location, "protocol" | "host">): URL {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new URL(`${protocol}//${location.host}/api/audio/socket`);
}

export class VirtualAudioClient {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private disposed = false;
  private contextPromise?: Promise<AudioContext>;
  private context?: AudioContext;
  private inputStream?: MediaStream;
  private inputSource?: MediaStreamAudioSourceNode;
  private captureNode?: AudioWorkletNode;
  private playbackNode?: AudioWorkletNode;
  private playbackDestination?: MediaStreamAudioDestinationNode;
  private playbackElement?: AudioElementWithSink;
  private inputSelection = 0;
  private outputSelection = 0;
  private sampleRate = 48_000;
  private snapshot: VirtualAudioSnapshot;

  constructor(private readonly listener: SnapshotListener) {
    this.snapshot = {
      ...INITIAL_VIRTUAL_AUDIO_SNAPSHOT,
      inputDevices: [...INITIAL_VIRTUAL_AUDIO_SNAPSHOT.inputDevices],
      outputDevices: [...INITIAL_VIRTUAL_AUDIO_SNAPSHOT.outputDevices],
      outputSelectionSupported: typeof HTMLMediaElement !== "undefined"
        && "setSinkId" in HTMLMediaElement.prototype,
    };
  }

  start(): void {
    this.listener(this.current());
    this.connect();
    void this.refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", this.handleDeviceChange);
  }

  private current(): VirtualAudioSnapshot {
    return {
      ...this.snapshot,
      inputDevices: [...this.snapshot.inputDevices],
      outputDevices: [...this.snapshot.outputDevices],
    };
  }

  async selectInput(deviceId: string): Promise<void> {
    const generation = ++this.inputSelection;
    if (deviceId === AUDIO_OFF_DEVICE_ID) {
      this.stopInput();
      this.update({ inputDeviceId: AUDIO_OFF_DEVICE_ID, inputEnabled: false, error: undefined });
      this.sendControl("input", false);
      this.closeContextIfIdle();
      return;
    }
    if (!this.snapshot.available) {
      this.update({ error: this.snapshot.error || "Host virtual audio is unavailable" });
      return;
    }
    try {
      const context = await this.ensureContext();
      await context.resume();
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser cannot capture a microphone");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId === AUDIO_DEFAULT_DEVICE_ID ? undefined : { exact: deviceId },
          channelCount: 1,
          sampleRate: this.sampleRate,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.disposed || generation !== this.inputSelection) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(context, "term-server-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
      });
      capture.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => this.sendInputFrame(data);
      source.connect(capture);
      this.stopInput();
      this.inputStream = stream;
      this.inputSource = source;
      this.captureNode = capture;
      this.update({ inputDeviceId: deviceId, inputEnabled: true, error: undefined });
      this.sendControl("input", true);
      await this.refreshDevices();
    } catch (error) {
      if (generation !== this.inputSelection) return;
      this.closeContextIfIdle();
      this.update({ error: error instanceof Error ? error.message : "Unable to open microphone" });
    }
  }

  async selectOutput(deviceId: string): Promise<void> {
    const generation = ++this.outputSelection;
    if (deviceId === AUDIO_OFF_DEVICE_ID) {
      this.stopOutput();
      this.update({ outputDeviceId: AUDIO_OFF_DEVICE_ID, outputEnabled: false, error: undefined });
      this.sendControl("output", false);
      this.closeContextIfIdle();
      return;
    }
    if (!this.snapshot.available) {
      this.update({ error: this.snapshot.error || "Host virtual audio is unavailable" });
      return;
    }
    if (deviceId !== AUDIO_DEFAULT_DEVICE_ID && !this.snapshot.outputSelectionSupported) {
      this.update({ error: "This browser can only use the system default speaker" });
      return;
    }
    const outputWasActive = this.snapshot.outputDeviceId !== AUDIO_OFF_DEVICE_ID;
    try {
      const context = await this.ensureContext();
      await context.resume();
      const element = await this.ensurePlayback(context);
      if (element.setSinkId) {
        await element.setSinkId(deviceId === AUDIO_DEFAULT_DEVICE_ID ? "" : deviceId);
      }
      await element.play();
      if (this.disposed || generation !== this.outputSelection) return;
      this.update({ outputDeviceId: deviceId, outputEnabled: true, error: undefined });
      this.sendControl("output", true);
      await this.refreshDevices();
    } catch (error) {
      if (generation !== this.outputSelection) return;
      if (!outputWasActive) this.stopOutput();
      this.closeContextIfIdle();
      this.update({ error: error instanceof Error ? error.message : "Unable to open speaker" });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.handleDeviceChange);
    this.socket?.close();
    this.stopInput();
    this.stopOutput();
    const context = this.context;
    this.context = undefined;
    this.contextPromise = undefined;
    if (context) void context.close();
  }

  private readonly handleDeviceChange = () => {
    void this.refreshDevices();
  };

  private connect(): void {
    if (this.disposed || (this.socket && this.socket.readyState < WebSocket.CLOSING)) return;
    this.update({ connection: "connecting", error: undefined });
    const socket = new WebSocket(virtualAudioSocketUrl(window.location));
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleSocketMessage(socket, event));
    socket.addEventListener("close", () => {
      if (this.socket !== socket || this.disposed) return;
      this.socket = undefined;
      this.update({ connection: "disconnected", inputEnabled: false, outputEnabled: false });
      this.reconnectTimer = window.setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.update({ error: "Virtual audio connection failed" });
    });
  }

  private handleSocketMessage(socket: WebSocket, event: MessageEvent): void {
    if (socket !== this.socket) return;
    if (event.data instanceof ArrayBuffer) {
      if (this.snapshot.outputDeviceId !== AUDIO_OFF_DEVICE_ID && this.playbackNode) {
        this.playbackNode.port.postMessage(event.data, [event.data]);
      }
      return;
    }
    if (typeof event.data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      this.update({ error: "Invalid virtual audio server message" });
      return;
    }
    const message = parseVirtualAudioServerMessage(parsed);
    if (!message) {
      this.update({ error: "Invalid virtual audio server message" });
      return;
    }
    if (message.type === "ready") {
      this.sampleRate = message.sampleRate;
      const supported = message.available && message.channels === 1 && message.frameSamples > 0;
      const error = message.error || (
        message.available ? "Unsupported host audio format" : "Host virtual audio is unavailable"
      );
      if (!supported) {
        this.inputSelection += 1;
        this.outputSelection += 1;
        this.stopInput();
        this.stopOutput();
        this.update({
          connection: "unavailable",
          available: false,
          inputDeviceId: AUDIO_OFF_DEVICE_ID,
          outputDeviceId: AUDIO_OFF_DEVICE_ID,
          inputEnabled: false,
          outputEnabled: false,
          inputDeviceName: message.inputDevice,
          outputDeviceName: message.outputDevice,
          inputPeers: message.inputPeers,
          outputPeers: message.outputPeers,
          error,
        });
        this.closeContextIfIdle();
        return;
      }
      this.update({
        connection: "ready",
        available: true,
        inputDeviceName: message.inputDevice,
        outputDeviceName: message.outputDevice,
        inputPeers: message.inputPeers,
        outputPeers: message.outputPeers,
        error: undefined,
      });
      this.sendControl("input", this.snapshot.inputDeviceId !== AUDIO_OFF_DEVICE_ID);
      this.sendControl("output", this.snapshot.outputDeviceId !== AUDIO_OFF_DEVICE_ID);
      return;
    }
    if (message.type === "state") {
      this.update({
        inputEnabled: message.inputEnabled,
        outputEnabled: message.outputEnabled,
        inputPeers: message.inputPeers,
        outputPeers: message.outputPeers,
      });
      return;
    }
    if (message.type === "error") this.update({ error: message.message });
  }

  private sendControl(type: "input" | "output", enabled: boolean): void {
    const socket = this.socket;
    if (!this.snapshot.available || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type, enabled }));
  }

  private sendInputFrame(data: ArrayBuffer): void {
    const socket = this.socket;
    if (
      !this.snapshot.inputEnabled
      || socket?.readyState !== WebSocket.OPEN
      || socket.bufferedAmount > MAX_SOCKET_AUDIO_BACKLOG
    ) return;
    socket.send(data);
  }

  private async ensureContext(): Promise<AudioContext> {
    if (this.contextPromise) return this.contextPromise;
    if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") {
      throw new Error("This browser does not support low-latency audio worklets");
    }
    this.contextPromise = (async () => {
      const context = new AudioContext({ latencyHint: "interactive", sampleRate: this.sampleRate });
      try {
        if (context.sampleRate !== this.sampleRate) {
          throw new Error(`Browser audio uses ${context.sampleRate} Hz; ${this.sampleRate} Hz is required`);
        }
        if (!context.audioWorklet) {
          throw new Error("Audio forwarding requires a secure browser context");
        }
        await context.audioWorklet.addModule(AUDIO_WORKLET_PATH);
        this.context = context;
        return context;
      } catch (error) {
        await context.close();
        throw error;
      }
    })();
    try {
      return await this.contextPromise;
    } catch (error) {
      this.contextPromise = undefined;
      throw error;
    }
  }

  private async ensurePlayback(context: AudioContext): Promise<AudioElementWithSink> {
    if (this.playbackElement) return this.playbackElement;
    const playback = new AudioWorkletNode(context, "term-server-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const destination = context.createMediaStreamDestination();
    playback.connect(destination);
    const element = document.createElement("audio") as AudioElementWithSink;
    element.autoplay = true;
    element.hidden = true;
    element.srcObject = destination.stream;
    document.body.append(element);
    this.playbackNode = playback;
    this.playbackDestination = destination;
    this.playbackElement = element;
    return element;
  }

  private stopInput(): void {
    this.captureNode?.disconnect();
    this.captureNode?.port.close();
    this.inputSource?.disconnect();
    for (const track of this.inputStream?.getTracks() ?? []) track.stop();
    this.captureNode = undefined;
    this.inputSource = undefined;
    this.inputStream = undefined;
  }

  private stopOutput(): void {
    this.playbackElement?.pause();
    if (this.playbackElement) {
      this.playbackElement.srcObject = null;
      this.playbackElement.remove();
    }
    this.playbackNode?.disconnect();
    this.playbackNode?.port.close();
    this.playbackDestination?.disconnect();
    this.playbackElement = undefined;
    this.playbackNode = undefined;
    this.playbackDestination = undefined;
  }

  private closeContextIfIdle(): void {
    if (this.captureNode || this.playbackNode || !this.context) return;
    const context = this.context;
    this.context = undefined;
    this.contextPromise = undefined;
    void context.close();
  }

  private async refreshDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.update({
        inputDevices: audioDeviceOptions(devices, "audioinput"),
        outputDevices: audioDeviceOptions(devices, "audiooutput"),
      });
    } catch {
      // Device enumeration is optional. Selecting the default devices still works.
    }
  }

  private update(changes: Partial<VirtualAudioSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    this.listener(this.current());
  }
}
