import { describe, expect, it } from "vitest";
import { pwaDisplayName } from "./pwa";

describe("PWA identity", () => {
  it("uses the browser hostname for installed app names", () => {
    expect(pwaDisplayName("terminal.example")).toBe("terminal.example Term Server");
    expect(pwaDisplayName("100.64.0.8")).toBe("100.64.0.8 Term Server");
  });

  it("has a stable fallback when the hostname is unavailable", () => {
    expect(pwaDisplayName("")).toBe("Term Server");
  });
});
