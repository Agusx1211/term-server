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
