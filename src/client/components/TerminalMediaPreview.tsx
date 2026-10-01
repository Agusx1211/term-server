import { useState } from "preact/hooks";
import { FileAudio } from "lucide-preact";
import type { FileEntry } from "../../shared/types";
import { api } from "../lib/api";
import { formatArtifactSize } from "../lib/artifacts";
import { formatMediaDuration, mediaKindOf } from "../lib/media";

export interface TerminalMediaPreviewState {
  file: FileEntry;
  left: number;
  top: number;
}

/**
 * The tooltip over a media path in the terminal: the picture, the first frame
 * of a video, or a card for audio. Ctrl+click opens the full player; the
 * tooltip itself ignores the pointer so it never steals the hover.
 */
export function TerminalMediaPreview({ file, left, top }: TerminalMediaPreviewState) {
  const [duration, setDuration] = useState<string>();
  const [failed, setFailed] = useState(false);
  const kind = mediaKindOf(file);
  const src = api.previewFileUrl({ path: file.path });
  const onMetadata = (event: Event) => {
    setDuration(formatMediaDuration((event.currentTarget as HTMLMediaElement).duration));
  };
  return (
    <div
      class="terminal-media-preview xterm-hover"
      style={{ left: `${left}px`, top: `${top}px` }}
      role="tooltip"
    >
      <header>
        <span>{file.name}</span>
        <small>{duration ? `${duration} · ` : ""}Ctrl+click to open</small>
      </header>
      {failed ? (
        <div class="terminal-media-note">This browser cannot preview this {kind}.</div>
      ) : kind === "image" ? (
        <img src={src} alt={file.name} />
      ) : kind === "video" ? (
        // The fragment seeks past the first instant so Safari paints a frame
        // instead of a black box while it only has the metadata.
        <video
          src={`${src}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={onMetadata}
          onError={() => setFailed(true)}
        />
      ) : (
        <div class="terminal-media-audio">
          <FileAudio size={30} strokeWidth={1.4} />
          <span>{file.mime} · {formatArtifactSize(file.size)}</span>
          <audio src={src} preload="metadata" onLoadedMetadata={onMetadata} onError={() => setFailed(true)} />
        </div>
      )}
    </div>
  );
}
