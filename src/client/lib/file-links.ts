export interface FileLinkMatch {
  text: string;
  start: number;
  end: number;
}

const fileLinkPattern = /file:\/\/(?:localhost\/|\/)[^\s'"<>()[\]{}]+|(?:~\/|\.\.?\/|\/)[^\s'"<>()[\]{}]+/g;
const trailingPunctuation = /[.,;:!?]+$/;

export function findFileLinks(line: string): FileLinkMatch[] {
  const matches: FileLinkMatch[] = [];
  for (const match of line.matchAll(fileLinkPattern)) {
    const raw = match[0];
    const text = raw.replace(trailingPunctuation, "");
    if (text.startsWith("//")) continue;
    if (!text || text === "/" || text === "./" || text === "../" || text === "~/") continue;
    const start = match.index ?? 0;
    matches.push({ text, start, end: start + text.length });
  }
  return matches;
}

export function imagePreviewPosition(clientX: number, clientY: number, width = 360, height = 280) {
  return {
    left: Math.max(8, Math.min(clientX + 14, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(clientY + 16, window.innerHeight - height - 8)),
  };
}
