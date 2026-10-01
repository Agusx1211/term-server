import type { FileEntry } from "../../shared/types";

export type MediaKind = "image" | "video" | "audio";

/** What a file previews as on hover, if it previews at all. */
export function mediaKindOf(
  file: Pick<FileEntry, "image"> & Partial<Pick<FileEntry, "audio" | "video">>,
): MediaKind | undefined {
  if (file.image) return "image";
  if (file.video) return "video";
  if (file.audio) return "audio";
  return undefined;
}

/** `m:ss`, or `h:mm:ss` from an hour up. Streams without a length have none. */
export function formatMediaDuration(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
