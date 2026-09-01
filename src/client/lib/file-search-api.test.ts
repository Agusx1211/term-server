import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("file search API", () => {
  it("sends the request with an abort signal so a superseded search can stop the server-side walk", async () => {
    let received: AbortSignal | null | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      received = init?.signal;
      return new Response(JSON.stringify({ root: "/home/user", entries: [], truncated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await api.searchFiles("/home/user", "needle", undefined, controller.signal);

    // `request()` combines the caller's signal with its own deadline, so fetch
    // sees a derived signal rather than the caller's instance.
    expect(fetch).toHaveBeenCalledWith(
      "/api/files/search?root=%2Fhome%2Fuser&query=needle",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
  });

  it("rejects with the abort reason when the request is cancelled", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    const pending = api.searchFiles("/home/user", "needle", undefined, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow("Aborted");
  });
});
