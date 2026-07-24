import type { AgentInfo } from "../../shared/types";

export function agentSubtitle(agent: AgentInfo): string {
  if (agent.status === "working" && agent.activity?.label) {
    return `${agent.kind} · ${agent.activity.label}…`;
  }
  return `${agent.kind} agent`;
}
