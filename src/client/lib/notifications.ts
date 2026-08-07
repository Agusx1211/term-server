import type { AgentInfo } from "../../shared/types";

export const NOTIFICATION_MODE_STORAGE_KEY = "term-server:notification-mode";
export const NOTIFICATION_POSITION_STORAGE_KEY = "term-server:notification-position";
export const NOTIFICATION_DURATION_STORAGE_KEY = "term-server:notification-duration";
export const LEGACY_NOTIFICATIONS_STORAGE_KEY = "term-server:notifications";

export type NotificationMode = "off" | "in-app" | "system" | "both";
export type NotificationPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type NotificationDuration = 0 | 4_000 | 7_000 | 12_000;

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

export type AgentNotificationKind = "blocked" | "completion";

export interface AgentNotificationEvent {
  kind: AgentNotificationKind;
  /** Identifies this occurrence, so the same one is announced once. */
  event: number;
}

/**
 * The next thing worth telling someone about for this agent, if anything.
 *
 * A block is announced as soon as it appears and is keyed on the transition
 * itself, because nothing else will happen until a person answers. A
 * completion is keyed on `completedAt` as before.
 */
export function agentNotificationEvent(agent: AgentInfo | null): AgentNotificationEvent | null {
  if (!agent) return null;
  if (agent.status === "blocked") return { kind: "blocked", event: agent.statusChangedAt };
  if (agent.status === "working") return null;
  if (agent.completedAt == null) return null;
  return { kind: "completion", event: agent.completedAt };
}

export function parseNotificationPosition(stored: string | null): NotificationPosition {
  if (
    stored === "top-left"
    || stored === "top-right"
    || stored === "bottom-left"
    || stored === "bottom-right"
  ) {
    return stored;
  }
  return "top-right";
}

export function parseNotificationDuration(stored: string | null): NotificationDuration {
  if (stored === "0") return 0;
  if (stored === "4000") return 4_000;
  if (stored === "7000") return 7_000;
  if (stored === "12000") return 12_000;
  return 7_000;
}
