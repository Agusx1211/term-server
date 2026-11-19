import type { MarkdownComment } from "./api";

export type PassageLocation = { start: number } | { problem: "revision" | "preview" };

/**
 * Find where a stored comment's passage starts in the rendered document text.
 *
 * Comments taken from the revision on screen keep their exact offset. Comments
 * from another revision, or a preview of unsaved edits, are matched by their
 * quote and only when it appears exactly once.
 */
export function locatePassage(
  comment: Pick<MarkdownComment, "offset" | "version" | "quote">,
  text: string,
  version: string,
  dirty: boolean,
): PassageLocation {
  if (comment.version === version && !dirty) {
    return comment.quote && text.startsWith(comment.quote, comment.offset)
      ? { start: comment.offset }
      : { problem: "preview" };
  }
  const start = comment.quote ? text.indexOf(comment.quote) : -1;
  if (start < 0 || text.indexOf(comment.quote, start + 1) >= 0) return { problem: "revision" };
  return { start };
}

export const passageProblemMessage: Record<"revision" | "preview", string> = {
  revision: "This passage changed or appears more than once in the current revision.",
  preview: "The quoted passage could not be located in this preview.",
};

export interface RailEntry {
  key: string;
  /** Preferred top edge, in pixels from the top of the rail. */
  desired: number;
  height: number;
}

/**
 * Stack comment cards next to their passages without overlapping. The focused
 * entry sits exactly beside its passage; the others make room above and below
 * it, never moving above the top of the rail.
 */
export function placeRailEntries(entries: RailEntry[], focusKey: string | undefined, gap: number): Map<string, number> {
  const order = entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => left.desired - right.desired || left.index - right.index);
  const tops = order.map((entry) => Math.max(0, entry.desired));
  const pushDown = (from: number) => {
    for (let index = Math.max(1, from); index < order.length; index += 1) {
      tops[index] = Math.max(tops[index]!, tops[index - 1]! + order[index - 1]!.height + gap);
    }
  };
  const pivot = focusKey === undefined ? -1 : order.findIndex((entry) => entry.key === focusKey);
  if (pivot < 0) {
    pushDown(1);
  } else {
    pushDown(pivot + 1);
    for (let index = pivot - 1; index >= 0; index -= 1) {
      tops[index] = Math.min(tops[index]!, tops[index + 1]! - gap - order[index]!.height);
    }
    if (tops[0]! < 0) {
      tops[0] = 0;
      pushDown(1);
    }
  }
  return new Map(order.map((entry, index) => [entry.key, tops[index]!]));
}

export function commentCountLabel(count: number): string {
  if (count === 0) return "No comments";
  return count === 1 ? "1 comment" : `${count} comments`;
}

export type MarkdownView = "review" | "read";

export function parseMarkdownView(raw: string | null): MarkdownView {
  return raw === "read" ? "read" : "review";
}
