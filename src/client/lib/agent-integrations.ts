import type {
  AgentIntegrationAction,
  AgentIntegrationProfileStatus,
  AgentIntegrationStatus,
} from "../../shared/types";

/** Returns the primary action for an aggregate provider status. */
export function agentIntegrationActionFor(
  status: Pick<AgentIntegrationStatus, "provider" | "state" | "profiles">,
): AgentIntegrationAction | null {
  if (status.state === "unavailable") return null;
  if (status.provider === "omp" && status.profiles?.length === 0) return null;
  return status.state === "notInstalled" ? "install" : "repair";
}

/** Summarizes per-profile state without exposing filesystem paths. */
export function agentIntegrationProfileSummary(
  profiles: readonly AgentIntegrationProfileStatus[] | undefined,
): string | null {
  if (!profiles?.length) return null;
  const counts = new Map<string, number>();
  for (const profile of profiles) {
    const label = profile.state === "installed"
      ? "installed"
      : profile.state === "notInstalled"
        ? "missing"
        : profile.state === "needsRepair"
          ? "needs repair"
          : "unavailable";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(" · ");
}
