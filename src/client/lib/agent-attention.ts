import type { AgentInfo } from "../../shared/types";

export const VIEWED_AGENT_REVISIONS_STORAGE_KEY = "term-server:viewed-agent-revisions";

export type ViewedAgentRevisions = Record<string, number>;

export function parseViewedAgentRevisions(raw: string | null): ViewedAgentRevisions {
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

export function agentNeedsAttention(
  agent: AgentInfo | null,
  viewedCompletion: number | undefined,
): boolean {
  return Boolean(
    agent
    && agent.status === "idle"
    && agent.completedAt != null
    && agent.revision > 1
    && agent.completedAt > (viewedCompletion ?? 0),
  );
}
