import { describe, expect, it } from "vitest";
import {
  includesInAppNotifications,
  includesSystemNotifications,
  parseNotificationDuration,
  parseNotificationMode,
  parseNotificationPosition,
} from "./notifications";

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

  it("defaults in-app notifications to the top-right corner", () => {
    expect(parseNotificationPosition(null)).toBe("top-right");
    expect(parseNotificationPosition("unknown")).toBe("top-right");
  });

  it("restores each supported in-app notification position", () => {
    expect(parseNotificationPosition("top-left")).toBe("top-left");
    expect(parseNotificationPosition("top-right")).toBe("top-right");
    expect(parseNotificationPosition("bottom-left")).toBe("bottom-left");
    expect(parseNotificationPosition("bottom-right")).toBe("bottom-right");
  });

  it("defaults auto-dismiss to seven seconds and accepts supported durations", () => {
    expect(parseNotificationDuration(null)).toBe(7_000);
    expect(parseNotificationDuration("unknown")).toBe(7_000);
    expect(parseNotificationDuration("")).toBe(7_000);
    expect(parseNotificationDuration("4000")).toBe(4_000);
    expect(parseNotificationDuration("7000")).toBe(7_000);
    expect(parseNotificationDuration("12000")).toBe(12_000);
    expect(parseNotificationDuration("0")).toBe(0);
  });
});
