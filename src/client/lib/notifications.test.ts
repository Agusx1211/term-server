import { describe, expect, it } from "vitest";
import {
  agentCompletionEvent,
  includesInAppNotifications,
  includesSystemNotifications,
  parseNotificationMode,
} from "./notifications";
import type { AgentInfo } from "../../shared/types";

const agent = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  kind: "codex",
  status: "idle",
  statusChangedAt: 2,
  startedAt: 1,
  revision: 2,
  completedAt: 2,
  summary: null,
  ...overrides,
});

describe("notification preferences", () => {
  it("defaults new installations to in-app notifications", () => {
    expect(parseNotificationMode(null, null)).toBe("in-app");
  });

  it("migrates the previous browser notification toggle", () => {
    expect(parseNotificationMode(null, "true")).toBe("both");
    expect(parseNotificationMode(null, "false")).toBe("off");
  });

  it("prefers a valid explicit mode and rejects unknown stored values", () => {
    expect(parseNotificationMode("both", "false")).toBe("both");
    expect(parseNotificationMode("unknown", "true")).toBe("both");
  });

  it("identifies the delivery channels enabled by each mode", () => {
    expect(includesInAppNotifications("off")).toBe(false);
    expect(includesInAppNotifications("in-app")).toBe(true);
    expect(includesInAppNotifications("system")).toBe(false);
    expect(includesInAppNotifications("both")).toBe(true);
    expect(includesSystemNotifications("off")).toBe(false);
    expect(includesSystemNotifications("in-app")).toBe(false);
    expect(includesSystemNotifications("system")).toBe(true);
    expect(includesSystemNotifications("both")).toBe(true);
  });

  it("only exposes notification events for completed submitted tasks", () => {
    expect(agentCompletionEvent(null)).toBeNull();
    expect(agentCompletionEvent(agent({ status: "working", completedAt: null }))).toBeNull();
    expect(agentCompletionEvent(agent({ completedAt: null }))).toBeNull();
    expect(agentCompletionEvent(agent())).toBe(2);
  });
});
