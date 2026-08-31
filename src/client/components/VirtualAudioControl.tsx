import { AudioLines, Mic, Volume2 } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  AUDIO_OFF_DEVICE_ID,
  INITIAL_VIRTUAL_AUDIO_SNAPSHOT,
  type VirtualAudioSnapshot,
  UNSUPPORTED_VIRTUAL_AUDIO_SNAPSHOT,
  VirtualAudioClient,
} from "../lib/virtual-audio";


export interface VirtualAudioController {
  snapshot: VirtualAudioSnapshot;
  selectInput(deviceId: string): Promise<void>;
  selectOutput(deviceId: string): Promise<void>;
}

export function useVirtualAudioController(
  enabled: boolean,
  supported: boolean,
): VirtualAudioController {
  const [snapshot, setSnapshot] = useState<VirtualAudioSnapshot>(INITIAL_VIRTUAL_AUDIO_SNAPSHOT);
  const client = useRef<VirtualAudioClient>();
  useEffect(() => {
    if (!enabled) {
      setSnapshot(INITIAL_VIRTUAL_AUDIO_SNAPSHOT);
      return;
    }
    if (!supported) {
      setSnapshot(UNSUPPORTED_VIRTUAL_AUDIO_SNAPSHOT);
      return;
    }
    const next = new VirtualAudioClient(setSnapshot);
    client.current = next;
    next.start();
    return () => {
      client.current = undefined;
      next.dispose();
    };
  }, [enabled, supported]);
  return {
    snapshot,
    async selectInput(deviceId) {
      await client.current?.selectInput(deviceId);
    },
    async selectOutput(deviceId) {
      await client.current?.selectOutput(deviceId);
    },
  };
}

interface VirtualAudioControlProps {
  controller: VirtualAudioController;
  placement: "desktop" | "mobile";
}

export function VirtualAudioControl({ controller, placement }: VirtualAudioControlProps) {
  const { snapshot } = controller;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = snapshot.inputDeviceId !== AUDIO_OFF_DEVICE_ID
    || snapshot.outputDeviceId !== AUDIO_OFF_DEVICE_ID;
  const canEnable = snapshot.connection === "ready" && snapshot.available;
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const status = snapshot.connection === "connecting"
    ? "Connecting"
    : snapshot.connection === "disconnected"
      ? "Reconnecting"
      : snapshot.available
        ? active ? "Forwarding" : "Ready"
        : snapshot.error ? "Unavailable" : "Off";
  const inputOptions = [...snapshot.inputDevices];
  if (
    snapshot.inputDeviceId !== AUDIO_OFF_DEVICE_ID
    && !inputOptions.some((option) => option.id === snapshot.inputDeviceId)
  ) {
    inputOptions.push({ id: snapshot.inputDeviceId, label: "Selected microphone" });
  }
  const outputOptions = [...snapshot.outputDevices];
  if (
    snapshot.outputDeviceId !== AUDIO_OFF_DEVICE_ID
    && !outputOptions.some((option) => option.id === snapshot.outputDeviceId)
  ) {
    outputOptions.push({ id: snapshot.outputDeviceId, label: "Selected speaker" });
  }

  return (
    <div ref={root} class={`virtual-audio-control virtual-audio-${placement}`}>
      <button
        class={`virtual-audio-trigger ${active ? "active" : ""} ${snapshot.error ? "warning" : ""}`}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="Configure virtual audio"
        aria-expanded={open}
        title={`Virtual audio: ${status.toLowerCase()}`}
      >
        <AudioLines size={14} />
        <span class="virtual-audio-trigger-label">Audio</span>
        <span class={`virtual-audio-state ${active ? "active" : snapshot.error ? "warning" : ""}`} />
      </button>
      {open && (
        <div class="virtual-audio-popover">
          <div class="virtual-audio-header">
            <strong>Virtual audio</strong>
            <span>{status}</span>
          </div>
          <label class="virtual-audio-field">
            <span><Mic size={13} /> Browser microphone</span>
            <select
              value={snapshot.inputDeviceId}
              onChange={(event) => void controller.selectInput(event.currentTarget.value)}
            >
              <option value={AUDIO_OFF_DEVICE_ID}>Off</option>
              {inputOptions.map((option) => (
                <option key={option.id} value={option.id} disabled={!canEnable}>{option.label}</option>
              ))}
            </select>
            <small>Pipes into {snapshot.inputDeviceName}</small>
          </label>
          <label class="virtual-audio-field">
            <span><Volume2 size={13} /> Browser speaker</span>
            <select
              value={snapshot.outputDeviceId}
              onChange={(event) => void controller.selectOutput(event.currentTarget.value)}
            >
              <option value={AUDIO_OFF_DEVICE_ID}>Off</option>
              {outputOptions.map((option) => (
                <option
                  key={option.id}
                  value={option.id}
                  disabled={!canEnable || (option.id !== "default" && !snapshot.outputSelectionSupported)}
                >
                  {option.label}
                </option>
              ))}
            </select>
            <small>Plays {snapshot.outputDeviceName}</small>
          </label>
          <div class="virtual-audio-routes" aria-live="polite">
            <span>{snapshot.inputPeers} browser input{snapshot.inputPeers === 1 ? "" : "s"} mixed</span>
            <span>{snapshot.outputPeers} browser listener{snapshot.outputPeers === 1 ? "" : "s"}</span>
          </div>
          {!snapshot.outputSelectionSupported && (
            <p class="virtual-audio-note">This browser can only play through its system default speaker.</p>
          )}
          {snapshot.error && <p class="virtual-audio-error" role="status">{snapshot.error}</p>}
          <p class="virtual-audio-note">
            Audio is never recorded by term-server. Programs using the virtual devices control where it goes next.
          </p>
        </div>
      )}
    </div>
  );
}
