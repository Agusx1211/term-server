import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("update channel API", () => {
  it("sends an authenticated same-origin channel patch", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      enabled: true,
      channel: "beta",
      reason: null,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(api.updateChannel("beta")).resolves.toEqual({
      enabled: true,
      channel: "beta",
      reason: null,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/config/updates", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ channel: "beta" }),
      cache: "no-store",
    }));
  });
});
