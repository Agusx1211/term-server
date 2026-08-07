import type { AgentInfo } from "../../shared/types";

export function agentSubtitle(agent: AgentInfo): string {
  if (agent.status === "blocked") {
    // The activity label names what it is asking about when a hook reported it.
    return `${agent.kind} · ${agent.activity?.label ?? "waiting for input"}`;
  }
  if (agent.status === "working" && agent.activity?.label) {
    return `${agent.kind} · ${agent.activity.label}…`;
  }
  return `${agent.kind} agent`;
}
