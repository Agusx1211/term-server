import { LoaderCircle, Mic, Square, X } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  VoiceNoteRecorder,
  formatRecordingDuration,
  voiceNoteErrorMessage,
  voiceNoteSupport,
} from "../lib/voice-note";

interface VoiceNoteButtonProps {
  /** Called with the finished recording; the app uploads it and pastes the
   * path into the terminal. */
  onRecorded: (file: File) => void;
  onNotice: (message: string) => void;
}

type RecordingState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "recording"; startedAt: number };

/** Pane-header microphone: tap to record, tap again to send the voice note to
 * this terminal, or discard it with the cross. */
export function VoiceNoteButton({ onRecorded, onNotice }: VoiceNoteButtonProps) {
  const [state, setState] = useState<RecordingState>({ phase: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const recorder = useRef<VoiceNoteRecorder>();
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;

  useEffect(() => () => recorder.current?.cancel(), []);

  useEffect(() => {
    if (state.phase !== "recording") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [state.phase]);

  const finish = (current: VoiceNoteRecorder) => {
    if (recorder.current !== current) return;
    recorder.current = undefined;
    setState({ phase: "idle" });
    current.stop().then(
      (file) => onRecordedRef.current(file),
      (error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          onNoticeRef.current(voiceNoteErrorMessage(error));
        }
      },
    );
  };

  const start = () => {
    const support = voiceNoteSupport();
    if (!support.supported) {
      onNotice(support.reason);
      return;
    }
    const next = new VoiceNoteRecorder();
    recorder.current = next;
    next.onInterrupted = () => {
      onNoticeRef.current("Microphone stopped; sending what was recorded");
      finish(next);
    };
    setState({ phase: "starting" });
    next.start().then(
      () => {
        if (recorder.current === next) setState({ phase: "recording", startedAt: Date.now() });
      },
      (error) => {
        if (recorder.current !== next) return;
        recorder.current = undefined;
        setState({ phase: "idle" });
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          onNoticeRef.current(voiceNoteErrorMessage(error));
        }
      },
    );
  };

  const discard = () => {
    const current = recorder.current;
    recorder.current = undefined;
    current?.cancel();
    setState({ phase: "idle" });
    onNotice("Voice note discarded");
  };

  if (state.phase === "idle") {
    return (
      <button
        class="pane-action voice-note-action"
        onClick={start}
        aria-label="Record a voice note for this terminal"
        title="Record a voice note (saved to the temp folder, path typed into this terminal)"
      >
        <Mic size={14} />
      </button>
    );
  }

  const elapsed = state.phase === "recording" ? formatRecordingDuration(now - state.startedAt) : "";
  return (
    <span class="voice-note-recording" role="group" aria-label="Voice note recording">
      <button
        class="voice-note-stop"
        onClick={() => {
          if (recorder.current && state.phase === "recording") finish(recorder.current);
        }}
        disabled={state.phase !== "recording"}
        aria-label={state.phase === "recording" ? `Stop and send voice note (${elapsed})` : "Starting microphone"}
        title="Stop and send to this terminal"
      >
        {state.phase === "recording"
          ? <><span class="voice-note-dot" aria-hidden="true" /><span class="voice-note-time">{elapsed}</span><Square size={11} fill="currentColor" /></>
          : <LoaderCircle class="spin" size={13} />}
      </button>
      <button
        class="pane-action voice-note-discard"
        onClick={discard}
        aria-label="Discard voice note"
        title="Discard voice note"
      >
        <X size={14} />
      </button>
    </span>
  );
}
