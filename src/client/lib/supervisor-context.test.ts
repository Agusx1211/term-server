import { describe, expect, it } from "vitest";
import { supervisorContextActive } from "./supervisor-context";

describe("supervisor context", () => {
  it("stays active at and below the managed root", () => {
    const base = {
      kind: "supervisor" as const,
      supervisorRoot: "/data/supervisor/",
    };
    expect(supervisorContextActive({ ...base, cwd: "/data/supervisor" })).toBe(true);
    expect(supervisorContextActive({ ...base, cwd: "/data/supervisor/project" })).toBe(true);
  });

  it("is inactive in sibling paths and without metadata", () => {
    expect(supervisorContextActive({
      kind: "supervisor",
      supervisorRoot: "/data/supervisor",
      cwd: "/data/supervisor-old",
    })).toBe(false);
    expect(supervisorContextActive({
      kind: "supervisor",
      cwd: "/tmp",
    })).toBe(false);
  });

  it("never warns for regular terminals", () => {
    expect(supervisorContextActive({
      kind: "regular",
      cwd: "/tmp",
    })).toBe(true);
  });
});
