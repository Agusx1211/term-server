import { describe, expect, it } from "vitest";
import { credentialUsername } from "./browser-credentials";

describe("browser credentials", () => {
  it("provides a stable username for password managers", () => {
    expect(credentialUsername("terminal.example")).toBe("term-server@terminal.example");
    expect(credentialUsername("")).toBe("term-server@localhost");
  });
});
