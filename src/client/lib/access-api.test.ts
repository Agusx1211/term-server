import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("terminal access API", () => {
  it("submits sudo authentication only to the immutable request endpoint", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(api.approveTerminalSudo("terminal-1", "request/1", "hash-1", "sudo-password"))
      .resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "/api/terminals/terminal-1/access/requests/request%2F1/sudo",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({ requestHash: "hash-1", password: "sudo-password" }),
      }),
    );
    expect(fetch.mock.calls[0]?.[0]).not.toContain("sudo-password");
  });

  it("keeps proactively added secret values out of URLs", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      id: "grant-1",
      name: "SERVICE_TOKEN",
      source: "Added by you",
      createdAt: 1,
      uses: 0,
    }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    await api.addTerminalSecret("terminal-1", "SERVICE_TOKEN", "secret-value", "Deploy preview");
    expect(fetch).toHaveBeenCalledWith(
      "/api/terminals/terminal-1/access/secrets",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({
          name: "SERVICE_TOKEN",
          value: "secret-value",
          description: "Deploy preview",
        }),
      }),
    );
    expect(fetch.mock.calls[0]?.[0]).not.toContain("secret-value");
  });
});
