import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("file search API", () => {
  it("forwards an abort signal so a superseded search stops the server-side walk", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ root: "/home/user", entries: [], truncated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await api.searchFiles("/home/user", "needle", undefined, controller.signal);

    expect(fetch).toHaveBeenCalledWith(
      "/api/files/search?root=%2Fhome%2Fuser&query=needle",
      expect.objectContaining({ cache: "no-store", signal: controller.signal }),
    );
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
