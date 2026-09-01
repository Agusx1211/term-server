import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, DEFAULT_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_ERROR } from "./api";

interface PendingRequest {
  readonly signal?: AbortSignal | null;
}

/** A fetch that never answers, so only the client-side budget can end it. */
function hangingFetch(): { fetch: ReturnType<typeof vi.fn>; pending: PendingRequest[] } {
  const pending: PendingRequest[] = [];
  const fetch = vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    pending.push({ signal: init?.signal });
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  }));
  return { fetch, pending };
}

describe("API request timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fails a stalled mutation with a clear error once the budget elapses", async () => {
    const { fetch } = hangingFetch();
    vi.stubGlobal("fetch", fetch);

    const saving = api.saveFile({ path: "/tmp/note.txt", content: "hello", version: "1" });
    const assertion = expect(saving).rejects.toThrow(REQUEST_TIMEOUT_ERROR);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    await assertion;
    await expect(saving.catch((error) => error)).resolves.toBeInstanceOf(ApiError);
  });

  it("gives long-running endpoints a larger budget", async () => {
    const { fetch, pending } = hangingFetch();
    vi.stubGlobal("fetch", fetch);

    const installing = api.installUpdate("abc123");
    const settled = installing.then(() => "resolved", () => "rejected");
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS * 2);
    expect(pending[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(900_000);
    await expect(settled).resolves.toBe("rejected");
  });

  it("reports a caller abort as an abort rather than a timeout", async () => {
    const { fetch } = hangingFetch();
    vi.stubGlobal("fetch", fetch);

    const controller = new AbortController();
    const session = api.session(controller.signal);
    const failure = session.catch((error: unknown) => error);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const error = await failure;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as Error).message).not.toContain(REQUEST_TIMEOUT_ERROR);
  });

  it("clears the timer once the response arrives", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ authenticated: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(api.session()).resolves.toEqual({ authenticated: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
