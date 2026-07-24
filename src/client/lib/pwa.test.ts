import { afterEach, describe, expect, it, vi } from "vitest";
import { clearBrowserSiteData, pwaDisplayName } from "./pwa";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PWA identity", () => {
  it("uses the browser hostname for installed app names", () => {
    expect(pwaDisplayName("terminal.example")).toBe("terminal.example Term Server");
    expect(pwaDisplayName("100.64.0.8")).toBe("100.64.0.8 Term Server");
  });

  it("has a stable fallback when the hostname is unavailable", () => {
    expect(pwaDisplayName("")).toBe("Term Server");
  });
});

describe("site data recovery", () => {
  it("clears browser storage, caches, and service worker registrations", async () => {
    const localClear = vi.fn();
    const sessionClear = vi.fn();
    const deleteCache = vi.fn(async () => true);
    const unregister = vi.fn(async () => true);
    vi.stubGlobal("localStorage", { clear: localClear });
    vi.stubGlobal("sessionStorage", { clear: sessionClear });
    vi.stubGlobal("caches", {
      keys: async () => ["legacy-shell", "runtime"],
      delete: deleteCache,
    });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: async () => [{ unregister }],
      },
    });

    await clearBrowserSiteData();

    expect(localClear).toHaveBeenCalledOnce();
    expect(sessionClear).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenCalledWith("legacy-shell");
    expect(deleteCache).toHaveBeenCalledWith("runtime");
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("continues when one browser cleanup API fails", async () => {
    const sessionClear = vi.fn();
    const unregister = vi.fn(async () => true);
    vi.stubGlobal("localStorage", {
      clear: () => {
        throw new Error("storage is unavailable");
      },
    });
    vi.stubGlobal("sessionStorage", { clear: sessionClear });
    vi.stubGlobal("caches", {
      keys: async () => {
        throw new Error("cache access is unavailable");
      },
      delete: vi.fn(),
    });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: async () => [{ unregister }],
      },
    });

    await expect(clearBrowserSiteData()).resolves.toBeUndefined();
    expect(sessionClear).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
  });
});
