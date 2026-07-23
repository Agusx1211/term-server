import type { AgentInfo } from "../../shared/types";

export const NOTIFICATION_MODE_STORAGE_KEY = "term-server:notification-mode";
export const LEGACY_NOTIFICATIONS_STORAGE_KEY = "term-server:notifications";

export type NotificationMode = "off" | "in-app" | "system" | "both";

export function parseNotificationMode(
  stored: string | null,
  legacy: string | null,
): NotificationMode {
  if (stored === "off" || stored === "in-app" || stored === "system" || stored === "both") {
    return stored;
  }
  if (legacy === "true") return "both";
  if (legacy === "false") return "off";
  return "in-app";
}

export function includesInAppNotifications(mode: NotificationMode): boolean {
  return mode === "in-app" || mode === "both";
}

export function includesSystemNotifications(mode: NotificationMode): boolean {
  return mode === "system" || mode === "both";
}

export function agentCompletionEvent(agent: AgentInfo | null): number | null {
  if (!agent || agent.status === "working") return null;
  return agent.completedAt;
}
