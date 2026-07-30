import type { ForegroundCommandInfo } from "../../shared/types";

export const VIEWED_COMMAND_COMPLETIONS_STORAGE_KEY =
  "term-server:viewed-command-completions";

export type ViewedCommandCompletions = Record<string, number>;

export function parseViewedCommandCompletions(
  raw: string | null,
): ViewedCommandCompletions {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => (
        typeof entry[1] === "number"
        && Number.isSafeInteger(entry[1])
        && entry[1] >= 0
      )),
    );
  } catch {
    return {};
  }
}

export function commandCompletionEvent(
  command: ForegroundCommandInfo | null,
): number | null {
  if (!command || command.status !== "completed") return null;
  return command.completedAt;
}

export function commandNeedsAttention(
  command: ForegroundCommandInfo | null,
  viewedCompletion: number | undefined,
): boolean {
  const completedAt = commandCompletionEvent(command);
  return completedAt != null && completedAt > (viewedCompletion ?? 0);
}

export function markCommandCompletionViewed(
  current: ViewedCommandCompletions,
  terminalId: string,
  completedAt: number,
): ViewedCommandCompletions {
  if ((current[terminalId] ?? 0) >= completedAt) return current;
  return { ...current, [terminalId]: completedAt };
}

export function pruneViewedCommandCompletions(
  current: ViewedCommandCompletions,
  terminalIds: Set<string>,
): ViewedCommandCompletions {
  const entries = Object.entries(current).filter(([id]) => terminalIds.has(id));
  if (entries.length === Object.keys(current).length) return current;
  return Object.fromEntries(entries);
}

export function commandSubtitle(command: ForegroundCommandInfo): string {
  if (command.status === "running") return `${command.name} · running`;
  if (command.status === "live") return `${command.name} · live`;
  return `${command.name} · finished`;
}
