import { describe, expect, it } from "vitest";
import { exposureLabel, terminalControlBadges } from "./terminal-control";

describe("terminal control badges", () => {
  it("shows nothing for terminals that are neither shared nor controlling", () => {
    expect(terminalControlBadges(undefined)).toEqual([]);
    expect(terminalControlBadges({ exposure: "off", controller: false })).toEqual([]);
  });

  it("lists the controller role before the exposure level", () => {
    expect(
      terminalControlBadges({ exposure: "write", controller: true }).map((badge) => badge.kind),
    ).toEqual(["controller", "write"]);
  });

  it("distinguishes read-only from read and write sharing", () => {
    const [read] = terminalControlBadges({ exposure: "read", controller: false });
    expect(read?.label).toBe("Shared · read");
    expect(read?.title).toContain("not type");
    const [write] = terminalControlBadges({ exposure: "write", controller: false });
    expect(write?.label).toBe("Shared · read & write");
    expect(exposureLabel("off")).toBe("Not shared");
  });

  it("says when the sharing comes from the default for all terminals", () => {
    const [inherited] = terminalControlBadges({ exposure: "read", exposureDefault: true, controller: false });
    expect(inherited?.title).toContain("default for all terminals");
    const [own] = terminalControlBadges({ exposure: "read", exposureDefault: false, controller: false });
    expect(own?.title).not.toContain("default");
  });
});
