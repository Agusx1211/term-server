import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  parseSidebarWidth,
} from "./sidebar-width";

describe("sidebar width", () => {
  it("clamps persisted and dragged widths to useful desktop bounds", () => {
    expect(clampSidebarWidth(120)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(400)).toBe(400);
    expect(clampSidebarWidth(900)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("leaves enough room for the editor in a narrow desktop viewport", () => {
    expect(clampSidebarWidth(560, 800)).toBe(480);
    expect(clampSidebarWidth(400, 500)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it("uses the default for missing or invalid persisted values", () => {
    expect(parseSidebarWidth(null)).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(parseSidebarWidth("not-a-number")).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(parseSidebarWidth("  ")).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(parseSidebarWidth("342")).toBe(342);
  });
});
