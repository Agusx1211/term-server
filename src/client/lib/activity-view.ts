import type {
  ActivityView,
  TerminalInfo,
  UpdateActivityView,
} from "../../shared/types";
import type { ViewedAgentRevisions } from "./agent-attention";
import { commandCompletionEvent, type ViewedCommandCompletions } from "./command-status";
import { structurallyEqual } from "./structural-equality";

const EMPTY_ACTIVITY_VIEW: ActivityView = {
  agentCompletedAt: 0,
  commandCompletedAt: 0,
};

export function activityView(terminal: TerminalInfo): ActivityView {
  return terminal.activityViewed ?? EMPTY_ACTIVITY_VIEW;
}

export function mergeActivityViews(
  current: ActivityView | undefined,
  next: ActivityView | undefined,
): ActivityView {
  return {
    agentCompletedAt: Math.max(
      current?.agentCompletedAt ?? 0,
      next?.agentCompletedAt ?? 0,
    ),
    commandCompletedAt: Math.max(
      current?.commandCompletedAt ?? 0,
      next?.commandCompletedAt ?? 0,
    ),
  };
}

export function withActivityView(
  terminal: TerminalInfo,
  viewed: ActivityView,
): TerminalInfo {
  return {
    ...terminal,
    activityViewed: mergeActivityViews(terminal.activityViewed, viewed),
  };
}

/**
 * Merge the locally observed activity watermarks into a freshly polled list.
 *
 * The poll runs every 1.5 s and almost always reports identical terminals, so
 * unchanged entries keep their previous object and an entirely unchanged list
 * keeps the previous array. That lets the workspace state update bail out
 * instead of re-rendering every mounted pane on each tick.
 */
export function mergeTerminalActivityViews(
  next: TerminalInfo[],
  current: TerminalInfo[],
): TerminalInfo[] {
  const currentById = new Map(current.map((terminal) => [terminal.id, terminal]));
  let changed = next.length !== current.length;
  const merged = next.map((terminal, index) => {
    const previous = currentById.get(terminal.id);
    const updated = previous ? withActivityView(terminal, activityView(previous)) : terminal;
    const stable = previous && structurallyEqual(previous, updated) ? previous : updated;
    if (stable !== current[index]) changed = true;
    return stable;
  });
  return changed ? merged : current;
}

export function currentActivityViewUpdate(
  terminal: TerminalInfo,
): UpdateActivityView | null {
  const viewed = activityView(terminal);
  const update: UpdateActivityView = {};
  if (
    terminal.agent?.status === "idle"
    && terminal.agent.completedAt != null
    && terminal.agent.revision > 1
    && terminal.agent.completedAt > viewed.agentCompletedAt
  ) {
    update.agentCompletedAt = terminal.agent.completedAt;
  }
  const completion = commandCompletionEvent(terminal.command);
  if (completion != null && completion > viewed.commandCompletedAt) {
    update.commandCompletedAt = completion;
  }
  return Object.keys(update).length ? update : null;
}

export function legacyActivityViewUpdate(
  terminal: TerminalInfo,
  agentRevisions: ViewedAgentRevisions,
  commandCompletions: ViewedCommandCompletions,
): UpdateActivityView | null {
  const viewed = activityView(terminal);
  const agentRevision = agentRevisions[terminal.id] ?? 0;
  const commandCompletedAt = commandCompletions[terminal.id] ?? 0;
  const agent = terminal.agent;
  const observableCommandCompletion = terminal.command?.completedAt ?? 0;
  const update: UpdateActivityView = {};
  if (
    agent?.completedAt != null
    && agentRevision >= agent.revision
    && agent.completedAt > viewed.agentCompletedAt
  ) update.agentCompletedAt = agent.completedAt;
  if (
    commandCompletedAt > viewed.commandCompletedAt
    && commandCompletedAt <= observableCommandCompletion
  ) {
    update.commandCompletedAt = commandCompletedAt;
  }
  return Object.keys(update).length ? update : null;
}
