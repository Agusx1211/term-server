import type { AgentInfo } from "../../shared/types";

/** Drives the badge colour class; also the icon each surface picks. */
export type AgentStatusTone = "blocked" | "attention" | "working" | "idle" | "closed";

export interface AgentStatusPresentation {
  tone: AgentStatusTone;
  /** Short uppercase badge text. */
  label: string;
  /** Sentence used for tooltips and accessible names. */
  description: string;
}

/**
 * How an agent's state reads in the sidebar and on a pane header.
 *
 * Pending access and a blocked agent outrank an unseen completion: both are
 * waiting on a person right now, where a completion has already happened and
 * will keep. Neither is "seen away" because the condition holds until someone
 * answers it.
 */
export function agentStatusPresentation(
  agent: Pick<AgentInfo, "kind" | "status">,
  needsAttention: boolean,
  pendingAccessRequests = 0,
): AgentStatusPresentation {
  const kind = agent.kind || "agent";
  if (pendingAccessRequests > 0) {
    const request = pendingAccessRequests === 1 ? "request" : "requests";
    return {
      tone: "blocked",
      label: "Needs you",
      description: `${kind} is waiting for ${pendingAccessRequests} access ${request}`,
    };
  }
  if (agent.status === "blocked") {
    return { tone: "blocked", label: "Needs you", description: `${kind} is waiting for input` };
  }
  if (needsAttention) {
    return { tone: "attention", label: "Ready", description: `${kind} is ready` };
  }
  if (agent.status === "working") {
    return { tone: "working", label: "Working", description: `${kind} is working` };
  }
  if (agent.status === "idle") {
    return { tone: "idle", label: "Idle", description: `${kind} is idle` };
  }
  return { tone: "closed", label: "Closed", description: `${kind} is closed` };
}

export function formatWorkingDuration(elapsedMilliseconds: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMilliseconds) / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);

  if (totalMinutes === 0) return `${seconds}s`;

  const minutes = totalMinutes % 60;
  if (totalMinutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;

  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  if (totalHours < 24) return `${hours}h ${String(minutes).padStart(2, "0")}m`;

  const days = Math.floor(totalHours / 24);
  return `${days}d ${String(hours).padStart(2, "0")}h`;
}
