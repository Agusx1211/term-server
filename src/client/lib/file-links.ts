export interface FileLinkMatch {
  text: string;
  start: number;
  end: number;
}

interface HoverPreviewTarget {
  key: string;
}

interface HoverPreviewOptions<TTarget extends HoverPreviewTarget, TValue> {
  load: (target: TTarget) => Promise<TValue | undefined>;
  show: (value: TValue, target: TTarget) => void;
  hide: () => void;
}

// A backslash-escaped character is part of the name (`My\ Clip\ \(1\).mp4`, as
// shells print and complete it); plain whitespace or brackets end the candidate.
const fileLinkCandidatePattern = /(?:\\[ '"`()[\]{}=<>&;|*?!$#~]|[^\s'"`<>()[\]{}=])+/g;
const shellEscapePattern = /\\([ '"`()[\]{}=<>&;|*?!$#~])/g;
const localFileUriPattern = /^file:\/\/(?:localhost\/|\/).+/;
const uriPattern = /^[a-z][a-z0-9+.-]*:\/\//i;
const explicitFilePathPattern = /^(?:\/|~\/|\.\.?\/).+/;
const bareFilenamePattern = /^(?:\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|[^./][^/]*\.(?=[a-z0-9_-]*[a-z])[a-z0-9_-]+)$/i;
const trailingPunctuation = /[.,;:!?]+$/;

/**
 * Extensions of files the app previews inline. Paths that contain spaces, or
 * that a program wrapped across rows, are only recognised when they end in one
 * of these: without a name that is known to be a file, "see my notes" cannot be
 * told apart from a path.
 */
const previewableExtensions = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico",
  "mp4", "m4v", "webm", "mov", "mkv", "ogv",
  "mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", "weba",
  "pdf",
];
const previewableEndPattern = new RegExp(
  `^(.*\\.(?:${previewableExtensions.join("|")}))[)\\]}>"'\`.,;:!?]*$`,
  "i",
);

function looksLikeFileLink(text: string): boolean {
  if (localFileUriPattern.test(text)) return true;
  if (uriPattern.test(text) || text.startsWith("//")) return false;
  if (explicitFilePathPattern.test(text)) return true;
  return bareFilenamePattern.test(text.slice(text.lastIndexOf("/") + 1));
}

function startsLikeExplicitPath(text: string): boolean {
  return localFileUriPattern.test(text) || explicitFilePathPattern.test(text);
}

/**
 * Paths a single line states unambiguously: no whitespace, or only escaped
 * whitespace. Names with plain spaces are separate (`findSpacedFileCandidates`)
 * because they have to be checked against the filesystem.
 */
export function findFileLinks(line: string): FileLinkMatch[] {
  const matches: FileLinkMatch[] = [];
  for (const match of line.matchAll(fileLinkCandidatePattern)) {
    const raw = match[0].replace(trailingPunctuation, "");
    const text = raw.replace(shellEscapePattern, "$1");
    if (!looksLikeFileLink(text)) continue;
    const start = match.index ?? 0;
    matches.push({ text, start, end: start + raw.length });
  }
  return matches;
}

export interface SpacedFileLine {
  text: string;
  /**
   * Set when a program, not the terminal, broke this line from the next one
   * (a TUI wrapping a long path with a real newline, which xterm cannot tell
   * from two lines). `tight` means the break fell where a word would have
   * filled the row, so it may have split a word and the pieces join with
   * nothing between them.
   */
  joinsNext?: "tight" | "loose";
}

export interface TextPosition {
  line: number;
  /** Index of a character in that line's text. */
  index: number;
}

export interface SpacedFileCandidate {
  /** The path the candidate reads as. */
  text: string;
  start: TextPosition;
  /** The last character of the path, inclusive. */
  end: TextPosition;
  /** Candidates that end at the same word compete: the longest real file wins. */
  group: string;
}

interface LineWord {
  line: number;
  text: string;
  start: number;
}

// How far a name can reach back from its extension. A path that starts with
// `/`, `~/`, `./` or `../` has an unmistakable start, so it may reach much
// further than a bare name, whose start is anyone's guess.
const MAX_BARE_WORDS_BACK = 4;
const MAX_EXPLICIT_WORDS_BACK = 16;
const MAX_JOIN_VARIANTS = 8;
const MAX_CANDIDATES = 48;
const MAX_CANDIDATE_LENGTH = 1024;
const leadingWrapper = /^(?:-{0,2}[A-Za-z_][\w-]*=)?[([{<"'`]*/;
const phraseEnd = /[,;:!?.]$/;
const impossibleInPath = /["`<>|\u0000-\u001f]/;

function previewableEndLength(word: string): number | undefined {
  return previewableEndPattern.exec(word)?.[1]?.length;
}

function wordsOf(lines: SpacedFileLine[]): LineWord[] {
  const words: LineWord[] = [];
  lines.forEach((line, lineIndex) => {
    for (const match of line.text.matchAll(/\S+/g)) {
      words.push({ line: lineIndex, text: match[0], start: match.index ?? 0 });
    }
  });
  return words;
}

/**
 * Paths that contain spaces, or that a program wrapped over several rows, and
 * end in a previewable extension. Reading `Saved to /home/me/My Videos/a b.mp4`
 * from text alone is guesswork, so this only proposes candidates (every start
 * that could belong to the name, with every way a wrapped break could have
 * joined); the caller keeps the ones that exist.
 */
export function findSpacedFileCandidates(lines: SpacedFileLine[]): SpacedFileCandidate[] {
  const words = wordsOf(lines);
  const candidates: SpacedFileCandidate[] = [];
  for (let end = 0; end < words.length && candidates.length < MAX_CANDIDATES; end += 1) {
    const endWord = words[end]!;
    const endLength = previewableEndLength(endWord.text);
    if (endLength === undefined) continue;
    for (const first of startingWords(lines, words, end)) {
      for (const candidate of candidatesFrom(lines, words, first, end, endLength)) {
        candidates.push(candidate);
      }
    }
  }
  return candidates.slice(0, MAX_CANDIDATES);
}

/** Whether the words before `index` can still belong to one name with it. */
function continuesName(lines: SpacedFileLine[], words: LineWord[], index: number): boolean {
  const word = words[index]!;
  const next = words[index + 1]!;
  if (word.line !== next.line && (next.line !== word.line + 1 || !lines[word.line]?.joinsNext)) {
    return false;
  }
  const bare = word.text.replace(leadingWrapper, "");
  return bare !== "" && !phraseEnd.test(bare) && previewableEndLength(bare) === undefined;
}

function startingWords(lines: SpacedFileLine[], words: LineWord[], end: number): number[] {
  const starts: number[] = [];
  for (let index = end - 1; index >= Math.max(0, end - MAX_EXPLICIT_WORDS_BACK); index -= 1) {
    if (!continuesName(lines, words, index)) break;
    const explicit = startsLikeExplicitPath(words[index]!.text.replace(leadingWrapper, ""));
    if (end - index <= MAX_BARE_WORDS_BACK || explicit) starts.push(index);
    // A path that opens a wrapped row may be the tail of one that began above
    // it: a directory boundary can fall exactly at the end of the row before.
    if (explicit && !continuesFromAbove(lines, words, index)) break;
  }
  return starts;
}

function continuesFromAbove(lines: SpacedFileLine[], words: LineWord[], index: number): boolean {
  const line = words[index]!.line;
  return line > 0 && words[index - 1]?.line !== line && Boolean(lines[line - 1]?.joinsNext);
}

function candidatesFrom(
  lines: SpacedFileLine[],
  words: LineWord[],
  first: number,
  end: number,
  endLength: number,
): SpacedFileCandidate[] {
  const firstWord = words[first]!;
  const endWord = words[end]!;
  const startIndex = firstWord.start + (leadingWrapper.exec(firstWord.text)?.[0].length ?? 0);
  // One slice of text per line the name touches, and how each break joins.
  const segments: string[] = [];
  const joins: Array<"tight" | "loose"> = [];
  for (let line = firstWord.line; line <= endWord.line; line += 1) {
    const from = line === firstWord.line ? startIndex : firstWordStart(words, line, first, end);
    const to = line === endWord.line
      ? endWord.start + endLength
      : lastEnd(words, line, first, end);
    segments.push(lines[line]!.text.slice(from, to));
    if (line < endWord.line) joins.push(lines[line]!.joinsNext ?? "loose");
  }
  let texts = [segments[0]!];
  segments.slice(1).forEach((segment, index) => {
    const joiners = joins[index] === "tight" ? ["", " "] : [" "];
    texts = texts.flatMap((text) => joiners.map((joiner) => text + joiner + segment));
  });
  return texts.slice(0, MAX_JOIN_VARIANTS).flatMap((text) => {
    if (text.length > MAX_CANDIDATE_LENGTH || impossibleInPath.test(text)) return [];
    return [{
      text,
      start: { line: firstWord.line, index: startIndex },
      end: { line: endWord.line, index: endWord.start + endLength - 1 },
      group: `${endWord.line}:${endWord.start}`,
    }];
  });
}

function firstWordStart(words: LineWord[], line: number, first: number, end: number): number {
  for (let index = first; index <= end; index += 1) {
    if (words[index]!.line === line) return words[index]!.start;
  }
  return 0;
}

function lastEnd(words: LineWord[], line: number, first: number, end: number): number {
  let to = 0;
  for (let index = first; index <= end; index += 1) {
    const word = words[index]!;
    if (word.line === line) to = word.start + word.text.length;
  }
  return to;
}

const quoteCharacters = "\"'`";

/**
 * Quoted names that hold whitespace (`ffmpeg -i "my clip.mp4"`). The quotes
 * mark both ends, so there is exactly one candidate per pair.
 */
export function findQuotedFileCandidates(lines: SpacedFileLine[]): SpacedFileCandidate[] {
  const candidates: SpacedFileCandidate[] = [];
  lines.forEach((line, lineIndex) => {
    const text = line.text;
    let index = 0;
    while (index < text.length && candidates.length < MAX_CANDIDATES) {
      const quote = text[index]!;
      // An apostrophe inside a word ("don't") is not an opening quote.
      const opens = quoteCharacters.includes(quote) && !(index > 0 && /[\p{L}\p{N}]/u.test(text[index - 1]!));
      const close = opens ? text.indexOf(quote, index + 1) : -1;
      const inner = close > index ? text.slice(index + 1, close) : "";
      if (close < 0 || !isQuotedFileName(inner)) {
        index += 1;
        continue;
      }
      candidates.push({
        text: inner,
        start: { line: lineIndex, index: index + 1 },
        end: { line: lineIndex, index: close - 1 },
        group: `quoted:${lineIndex}:${index}`,
      });
      index = close + 1;
    }
  });
  return candidates;
}

function isQuotedFileName(inner: string): boolean {
  if (inner.length > MAX_CANDIDATE_LENGTH || inner !== inner.trim() || !/\s/.test(inner)) return false;
  if (impossibleInPath.test(inner)) return false;
  return looksLikeFileLink(inner);
}

export function imagePreviewPosition(clientX: number, clientY: number, width = 360, height = 280) {
  return {
    left: Math.max(8, Math.min(clientX + 14, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(clientY + 16, window.innerHeight - height - 8)),
  };
}

export function createHoverPreviewController<TTarget extends HoverPreviewTarget, TValue>(
  { load, show, hide }: HoverPreviewOptions<TTarget, TValue>,
) {
  let activeTarget: TTarget | undefined;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let request = 0;

  const clearActive = () => {
    const hadActiveTarget = activeTarget !== undefined;
    request += 1;
    if (hoverTimer !== undefined) clearTimeout(hoverTimer);
    hoverTimer = undefined;
    activeTarget = undefined;
    if (hadActiveTarget) hide();
  };

  const clear = () => {
    if (leaveTimer !== undefined) clearTimeout(leaveTimer);
    leaveTimer = undefined;
    clearActive();
  };

  return {
    hover(target: TTarget) {
      if (leaveTimer !== undefined) clearTimeout(leaveTimer);
      leaveTimer = undefined;
      if (activeTarget?.key === target.key) {
        activeTarget = target;
        return;
      }

      clearActive();
      activeTarget = target;
      const currentRequest = request;
      hoverTimer = setTimeout(() => {
        hoverTimer = undefined;
        void load(target).then((value) => {
          const currentTarget = activeTarget;
          if (currentRequest === request && currentTarget?.key === target.key && value !== undefined) {
            show(value, currentTarget);
          }
        }).catch(() => undefined);
      }, 180);
    },
    leave() {
      if (!activeTarget || leaveTimer !== undefined) return;
      leaveTimer = setTimeout(() => {
        leaveTimer = undefined;
        clearActive();
      });
    },
    clear,
  };
}
