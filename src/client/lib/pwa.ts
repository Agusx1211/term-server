export function pwaDisplayName(hostname: string): string {
  const host = hostname.trim();
  return host ? `${host} Term Server` : "Term Server";
}

export function configurePwaIdentity(): void {
  document
    .querySelector('meta[name="apple-mobile-web-app-title"]')
    ?.setAttribute("content", pwaDisplayName(location.hostname));
}

export function registerPwaWorker(): void {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => undefined);
  });
}

async function bestEffort(action: () => void | Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // Browser storage APIs can be unavailable or partially implemented.
  }
}

export async function clearBrowserSiteData(): Promise<void> {
  const cleanup = [
    bestEffort(() => localStorage.clear()),
    bestEffort(() => sessionStorage.clear()),
  ];

  if ("caches" in globalThis) {
    cleanup.push(bestEffort(async () => {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    }));
  }

  if ("serviceWorker" in navigator) {
    cleanup.push(bestEffort(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }));
  }

  await Promise.all(cleanup);
}
