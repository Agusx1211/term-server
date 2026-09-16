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

  it("reveals a shared secret with a same-origin POST and returns the value once", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      id: "share/1",
      name: "DB_PASSWORD",
      value: "shown-once",
    }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(api.revealTerminalShare("terminal-1", "share/1")).resolves.toEqual({
      id: "share/1",
      name: "DB_PASSWORD",
      value: "shown-once",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/terminals/terminal-1/access/shares/share%2F1/reveal",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("surfaces the gone status when a share was already revealed", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      error: "DB_PASSWORD was already revealed and is no longer available",
    }), {
      status: 410,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(api.revealTerminalShare("terminal-1", "share-1")).rejects.toMatchObject({
      status: 410,
      message: "DB_PASSWORD was already revealed and is no longer available",
    });
  });

  it("dismisses a shared secret without touching the value", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(api.dismissTerminalShare("terminal-1", "share-1")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "/api/terminals/terminal-1/access/shares/share-1/dismiss",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
  });
});
