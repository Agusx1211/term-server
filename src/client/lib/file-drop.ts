/** The four file-drop quadrants, arranged like a political spectrum: the
 * vertical axis is the destination (top = the active terminal's directory,
 * bottom = the temp drop folder), the horizontal axis is whether the uploaded
 * path is also pasted into the terminal (left = paste, right = toast only). */
export type FileDropZone = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Where files dropped on the bottom row land. */
export const TEMP_UPLOAD_DIRECTORY = "/tmp/temp-server/files";

export interface FileDropZoneGuide {
  zone: FileDropZone;
  emoji: string;
  label: string;
  hint: string;
}

export const FILE_DROP_ZONES: FileDropZoneGuide[] = [
  {
    zone: "top-left",
    emoji: "💻",
    label: "Upload & paste into terminal",
    hint: "Uploads to the active terminal's directory and types the path",
  },
  {
    zone: "top-right",
    emoji: "🔔",
    label: "Upload to terminal",
    hint: "Uploads to the active terminal's directory (toast only)",
  },
  {
    zone: "bottom-left",
    emoji: "📋",
    label: "Upload & paste into temp",
    hint: `Uploads to ${TEMP_UPLOAD_DIRECTORY} and types the path`,
  },
  {
    zone: "bottom-right",
    emoji: "📁",
    label: "Upload to temp",
    hint: `Uploads to ${TEMP_UPLOAD_DIRECTORY} (toast only)`,
  },
];

/** Maps a point inside the drop surface to a quadrant. The whole surface is
 * divided by a horizontal and vertical midline, so there is no dead zone —
 * every point belongs to a quadrant. */
export function fileZoneAt(width: number, height: number, x: number, y: number): FileDropZone {
  const left = x < width / 2;
  const top = y < height / 2;
  if (top) return left ? "top-left" : "top-right";
  return left ? "bottom-left" : "bottom-right";
}

/** The upload destination directory for a quadrant. */
export function fileDropDestination(zone: FileDropZone, activeDirectory: string): string {
  return zone === "bottom-left" || zone === "bottom-right" ? TEMP_UPLOAD_DIRECTORY : activeDirectory;
}

/** Whether a quadrant also pastes the uploaded path into the terminal. */
export function fileDropPastes(zone: FileDropZone): boolean {
  return zone === "top-left" || zone === "bottom-left";
}

/** Single-quote a path when it contains characters a shell would interpret, so
 * pasting an uploaded path into the terminal stays usable. */
export function shellQuote(path: string): string {
  return /[\s"'$`\\;|&()<>*?![\]#~]/.test(path) ? `'${path.replaceAll("'", "'\\''")}'` : path;
}
