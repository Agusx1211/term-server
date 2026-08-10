import { describe, expect, it } from "vitest";
import type { StatusModule, StatusModulesResponse } from "../../shared/types";
import {
  STATUS_MODULE_FALLBACK_ERROR_MESSAGE,
  markStatusModulesStale,
  parseStatusModulesResponse,
  statusModuleAccessibleLabel,
  statusModuleCompactText,
  statusModuleValue,
  statusModulesPollDelay,
  statusModulesRetryDelay,
} from "./status-modules";

const baseModule: StatusModule = {
  id: "codex",
  label: "Codex",
  provider: "openai",
  state: "ok",
  primary: "42% used",
  details: [{ label: "Window", value: "42% used" }],
  refresh: { updatedAt: 90, nextAt: 120, intervalSeconds: 30, stale: false },
  error: null,
};

function response(modules: StatusModule[]): StatusModulesResponse {
  return {
    enabled: true,
    display: { showOnMobile: true },
    modules,
    generatedAt: 100,
  };
}

describe("status module normalization and presentation", () => {
  it("preserves configured order while dropping duplicate and malformed modules", () => {
    const parsed = parseStatusModulesResponse({
      enabled: true,
      display: { showOnMobile: true },
      generatedAt: 100,
      modules: [
        { ...baseModule, id: "zai", label: "Z.AI", provider: "zai" },
        { ...baseModule, id: "codex" },
        { ...baseModule, id: "zai", label: "Duplicate", provider: "zai" },
        { ...baseModule, id: "loading", state: "loading" },
      ],
    });

    expect(parsed?.modules.map((module) => module.id)).toEqual(["zai", "codex"]);
  });

  it("filters malformed detail rows and redacts secret-like error text", () => {
    const parsed = parseStatusModulesResponse({
      enabled: true,
      display: {},
      modules: [{
        ...baseModule,
        details: [{ label: "Window", value: "safe" }, { label: "bad" }, "bad"],
        error: { code: "provider", message: "Authorization: Bearer super-secret", retryable: true },
      }],
    });

    expect(parsed?.display.showOnMobile).toBe(false);
    expect(parsed?.modules[0]?.details).toEqual([{ label: "Window", value: "safe" }]);
    expect(parsed?.modules[0]?.error?.message).toBe(STATUS_MODULE_FALLBACK_ERROR_MESSAGE);
  });

  it("keeps state cues visible in compact and accessible text", () => {
    expect(statusModuleCompactText(baseModule)).toBe("Codex 42% used");
    expect(statusModuleCompactText({ ...baseModule, state: "warn", refresh: { ...baseModule.refresh, stale: true } }))
      .toBe("Codex 42% used · stale");
    expect(statusModuleCompactText({ ...baseModule, state: "error", primary: null })).toBe("Codex unavailable");
    expect(statusModuleCompactText({ ...baseModule, state: "unconfigured", primary: null })).toBe("Codex setup");
    expect(statusModuleValue({ ...baseModule, state: "unconfigured", primary: null })).toBe("Not configured");
    expect(statusModuleAccessibleLabel(baseModule, 100))
      .toBe("Codex usage: 42% used; state OK; updated 10s ago");
  });
});

describe("status module refresh timing", () => {
  it("uses the earliest server refresh and never polls unconfigured modules", () => {
    const later = { ...baseModule, id: "later", refresh: { ...baseModule.refresh, nextAt: 180 } };
    expect(statusModulesPollDelay([later, baseModule], 100)).toBe(20_000);
    expect(statusModulesPollDelay([{ ...baseModule, state: "unconfigured", primary: null }], 100)).toBeNull();
  });

  it("clamps an overdue refresh to avoid a tight request loop", () => {
    expect(statusModulesPollDelay([{ ...baseModule, refresh: { ...baseModule.refresh, nextAt: 99 } }], 100))
      .toBe(1_000);
  });

  it("honors a server retry deadline instead of polling every second", () => {
    const failed: StatusModule = {
      ...baseModule,
      state: "error",
      primary: null,
      refresh: { ...baseModule.refresh, nextAt: 105 },
      error: { code: "timeout", message: "retry later", retryable: true },
    };
    expect(statusModulesPollDelay([failed], 100)).toBe(5_000);
  });

  it("retains prior values as stale when transport refresh fails", () => {
    const stale = markStatusModulesStale(response([baseModule]), 100);
    expect(stale.modules[0]).toMatchObject({
      state: "warn",
      primary: "42% used",
      refresh: { stale: true, nextAt: 102 },
      error: { code: "transport", retryable: true, message: STATUS_MODULE_FALLBACK_ERROR_MESSAGE },
    });
  });

  it("backs off initial and repeated transport retries", () => {
    expect(statusModulesRetryDelay(0)).toBe(2_000);
    expect(statusModulesRetryDelay(3)).toBe(16_000);
    expect(statusModulesRetryDelay(99)).toBe(30_000);
    expect(markStatusModulesStale(response([baseModule]), 100, 3).modules[0]?.refresh.nextAt)
      .toBe(116);
  });
});
