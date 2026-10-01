import type { FileEntry, FileTarget } from "../../shared/types";
import {
  findFileLinks,
  findQuotedFileCandidates,
  findSpacedFileCandidates,
  type SpacedFileCandidate,
  type TextPosition,
} from "./file-links";

/** The slice of xterm's buffer API the link scan reads, so tests can fake it. */
export interface LinkBufferCell {
  getChars(): string;
  getWidth(): number;
}

export interface LinkBufferLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): LinkBufferCell | undefined;
}

export interface LinkBuffer {
  getLine(y: number): LinkBufferLine | undefined;
}

/** A buffer cell: zero-based row and column. */
export interface LinkCell {
  x: number;
  y: number;
}

/**
 * Text as the program wrote it: every row xterm soft-wrapped into one line,
 * with the cell behind each character so a match maps back onto the screen.
 */
export interface LogicalLine {
  text: string;
  /** The cell where each UTF-16 unit of `text` starts. */
  starts: LinkCell[];
  /** The cell where each unit ends; past `starts` for a double-width character. */
  ends: LinkCell[];
  top: number;
  bottom: number;
  joinsNext?: "tight" | "loose";
}

export interface LinkWindow {
  lines: LogicalLine[];
}

const MAX_LINE_CHARS = 2048;
// How many lines a hard-wrapped path is followed across, each way.
const MAX_JOINED_LINES = 6;
// A row may stop this many cells short of the edge for a program's own margin.
const WRAP_MARGIN = 2;
// ... and this close to the edge a word was probably split mid-way.
const TIGHT_WRAP_PAD = 4;

function groupTop(buffer: LinkBuffer, row: number): number {
  let top = row;
  while (top > 0 && buffer.getLine(top)?.isWrapped) top -= 1;
  return top;
}

function readLogicalLine(buffer: LinkBuffer, top: number): LogicalLine {
  const chars: string[] = [];
  const starts: LinkCell[] = [];
  const ends: LinkCell[] = [];
  let row = top;
  for (;;) {
    const line = buffer.getLine(row);
    if (!line) break;
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      if (!cell) break;
      const width = cell.getWidth();
      // The trailing half of a double-width character holds no text.
      if (width === 0) continue;
      const text = cell.getChars() || " ";
      for (let offset = 0; offset < text.length; offset += 1) {
        chars.push(text[offset]!);
        starts.push({ x, y: row });
        ends.push({ x: x + width - 1, y: row });
      }
    }
    const continues = buffer.getLine(row + 1)?.isWrapped ?? false;
    if (!continues || chars.length >= MAX_LINE_CHARS) break;
    row += 1;
  }
  // Only the end of the whole line is trimmed: blanks in the middle of a
  // wrapped line are real columns a name can run through.
  let length = chars.length;
  while (length > 0 && chars[length - 1] === " ") length -= 1;
  return {
    text: chars.slice(0, length).join(""),
    starts: starts.slice(0, length),
    ends: ends.slice(0, length),
    top,
    bottom: row,
  };
}

/**
 * Whether `next` reads as the rest of `prev`, cut where a program wrapped its
 * own output with a real newline (which xterm sees as two lines, unlike a
 * terminal soft wrap). A wrapper only breaks when the next word does not fit,
 * so the earlier row has to end too close to the edge for that word to have
 * stayed on it.
 */
function hardWrapJoin(prev: LogicalLine, next: LogicalLine, cols: number): "tight" | "loose" | undefined {
  if (!prev.text || !next.text.trim()) return undefined;
  const last = prev.ends[prev.text.length - 1]!;
  const pad = cols - 1 - last.x;
  const lead = next.text.length - next.text.trimStart().length;
  const word = /^\S+/.exec(next.text.slice(lead))?.[0].length ?? 0;
  if (pad > word + WRAP_MARGIN) return undefined;
  return pad <= TIGHT_WRAP_PAD ? "tight" : "loose";
}

/**
 * The text around a hovered buffer row (zero-based): its own line, plus the
 * neighbouring lines a program's hard wrap may have continued it on.
 */
export function readLinkWindow(buffer: LinkBuffer, cols: number, row: number): LinkWindow {
  const lines = [readLogicalLine(buffer, groupTop(buffer, row))];
  for (let joined = 0; joined < MAX_JOINED_LINES; joined += 1) {
    const first = lines[0]!;
    if (first.top === 0) break;
    const prev = readLogicalLine(buffer, groupTop(buffer, first.top - 1));
    const join = hardWrapJoin(prev, first, cols);
    if (!join) break;
    prev.joinsNext = join;
    lines.unshift(prev);
  }
  for (let joined = 0; joined < MAX_JOINED_LINES; joined += 1) {
    const last = lines[lines.length - 1]!;
    if (!buffer.getLine(last.bottom + 1)) break;
    const next = readLogicalLine(buffer, last.bottom + 1);
    const join = hardWrapJoin(last, next, cols);
    if (!join) break;
    last.joinsNext = join;
    lines.push(next);
  }
  return { lines };
}

export interface LinkRange {
  /** One-based, inclusive, as xterm's `ILink` expects. */
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface ResolvedFileLink {
  /** What to open. */
  path: string;
  range: LinkRange;
  /** Set when the path was checked and is a file. */
  file?: FileEntry;
}

const position = (cell: LinkCell) => cell.y * 65_536 + cell.x;

function rangeOf(window: LinkWindow, start: TextPosition, end: TextPosition): LinkRange {
  const from = window.lines[start.line]!.starts[start.index]!;
  const to = window.lines[end.line]!.ends[end.index]!;
  return { start: { x: from.x + 1, y: from.y + 1 }, end: { x: to.x + 1, y: to.y + 1 } };
}

const covers = (range: LinkRange, row: number) => range.start.y <= row && row <= range.end.y;

const overlaps = (left: LinkRange, right: LinkRange) => (
  position(left.start) <= position(right.end) && position(right.start) <= position(left.end)
);

export interface PendingFileLink {
  candidate: SpacedFileCandidate;
  range: LinkRange;
}

export interface FileLinkPlan {
  /** Paths the text states outright. */
  certain: ResolvedFileLink[];
  /** Names with spaces or wrapped breaks: links only if the file exists. */
  pending: PendingFileLink[];
}

/** What the text under the pointer could link to. `row` is the one-based line. */
export function planFileLinks(window: LinkWindow, row: number): FileLinkPlan {
  const certain: ResolvedFileLink[] = [];
  window.lines.forEach((line, lineIndex) => {
    for (const match of findFileLinks(line.text)) {
      const range = rangeOf(
        window,
        { line: lineIndex, index: match.start },
        { line: lineIndex, index: match.end - 1 },
      );
      if (covers(range, row)) certain.push({ path: match.text, range });
    }
  });
  const lines = window.lines.map(({ text, joinsNext }) => ({ text, joinsNext }));
  const pending = [...findQuotedFileCandidates(lines), ...findSpacedFileCandidates(lines)]
    .map((candidate) => ({ candidate, range: rangeOf(window, candidate.start, candidate.end) }))
    .filter(({ range }) => covers(range, row));
  return { certain, pending };
}

/** Looks up several paths at once: the entry for each, or undefined if it is not there. */
export type FileProbeMany = (paths: string[]) => Promise<Array<FileEntry | undefined>>;

/**
 * Keep the pending names that are real files. Candidates for one name compete
 * (`My Videos/a b.mp4` against `b.mp4`) and the longest that exists wins.
 */
export async function verifyFileLinks(
  pending: PendingFileLink[],
  probe: FileProbeMany,
): Promise<ResolvedFileLink[]> {
  const paths = [...new Set(pending.map((item) => item.candidate.text))];
  const entries = new Map<string, FileEntry | undefined>();
  (await probe(paths).catch(() => [])).forEach((entry, index) => entries.set(paths[index]!, entry));
  const groups = new Map<string, Array<{ item: PendingFileLink; file: FileEntry }>>();
  for (const item of pending) {
    const file = entries.get(item.candidate.text);
    if (!file || file.kind !== "file") continue;
    const group = groups.get(item.candidate.group) ?? [];
    group.push({ item, file });
    groups.set(item.candidate.group, group);
  }
  return [...groups.values()].map((group) => {
    const best = group.sort((left, right) => right.item.candidate.text.length - left.item.candidate.text.length)[0]!;
    return { path: best.item.candidate.text, range: best.item.range, file: best.file };
  });
}

/** Verified names replace the fragments of themselves the text also reads as. */
export function mergeFileLinks(
  certain: ResolvedFileLink[],
  verified: ResolvedFileLink[],
): ResolvedFileLink[] {
  const separate = certain.filter((link) => !verified.some((other) => overlaps(link.range, other.range)));
  return [...verified, ...separate];
}

const FOUND_TTL_MS = 30_000;
const MISSING_TTL_MS = 3_000;
const MAX_PROBES = 400;
// What the server answers for at most, in one request.
const MAX_PROBE_BATCH = 64;

export interface FileProbe {
  (target: FileTarget): Promise<FileEntry | undefined>;
  many(cwd: string | undefined, paths: string[]): Promise<Array<FileEntry | undefined>>;
}

/**
 * Remembers what the server said about a path. The link scan runs every time
 * the pointer enters a row and the hover preview asks about the same file
 * moments later, so one lookup has to serve both. A miss is remembered only
 * briefly: the file may be about to be written. Paths not yet known are asked
 * for together in one request.
 */
export function createFileProbe(
  fetchFiles: (cwd: string | undefined, paths: string[]) => Promise<Array<FileEntry | null>>,
  now: () => number = Date.now,
): FileProbe {
  const entries = new Map<string, { result: Promise<FileEntry | undefined>; expires: number }>();
  const many = (cwd: string | undefined, paths: string[]) => {
    const results = new Map<string, Promise<FileEntry | undefined>>();
    const unknown: string[] = [];
    for (const path of new Set(paths)) {
      const known = entries.get(`${cwd ?? ""}\u0000${path}`);
      if (known && known.expires > now()) results.set(path, known.result);
      else unknown.push(path);
    }
    for (let from = 0; from < unknown.length; from += MAX_PROBE_BATCH) {
      const batch = unknown.slice(from, from + MAX_PROBE_BATCH);
      const reply = fetchFiles(cwd, batch);
      batch.forEach((path, index) => {
        const entry = {
          expires: Number.POSITIVE_INFINITY,
          result: reply.then(
            (files) => {
              const file = files[index] ?? undefined;
              entry.expires = now() + (file ? FOUND_TTL_MS : MISSING_TTL_MS);
              return file;
            },
            () => {
              entry.expires = now() + MISSING_TTL_MS;
              return undefined;
            },
          ),
        };
        results.set(path, entry.result);
        entries.set(`${cwd ?? ""}\u0000${path}`, entry);
        if (entries.size > MAX_PROBES) entries.delete(entries.keys().next().value!);
      });
    }
    return Promise.all(paths.map((path) => results.get(path)!));
  };
  const probe = ((target: FileTarget) => many(target.cwd, [target.path]).then(([file]) => file)) as FileProbe;
  probe.many = many;
  return probe;
}
