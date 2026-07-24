import { useState } from "preact/hooks";
import { LockKeyhole } from "lucide-preact";
import { api } from "../lib/api";
import { credentialUsername, rememberPassword } from "../lib/browser-credentials";
import { clearBrowserSiteData } from "../lib/pwa";
import { TermServerLogo } from "./TermServerLogo";

interface LoginProps {
  onAuthenticated: () => void;
}

export function Login({ onAuthenticated }: LoginProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(password);
      rememberPassword(password);
      onAuthenticated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to sign in");
    } finally {
      setBusy(false);
    }
  };

  const clearSiteData = async () => {
    const confirmed = window.confirm(
      "This signs you out and removes this site's saved settings and cached files. "
      + "Terminal sessions on the server will keep running. Continue?",
    );
    if (!confirmed) return;

    setClearing(true);
    setError("");
    try {
      await Promise.allSettled([api.clearSiteData(), clearBrowserSiteData()]);
      const freshUrl = new URL("/", location.href);
      freshUrl.searchParams.set("fresh", Date.now().toString());
      location.replace(freshUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to clear site data");
      setClearing(false);
    }
  };

  return (
    <main class="login-shell">
      <section class="login-card" aria-labelledby="login-title">
        <TermServerLogo class="brand-mark large" title="term-server" />
        <p class="eyebrow">REMOTE TERMINAL WORKSPACE</p>
        <h1 id="login-title">term-server</h1>
        <p class="login-copy">Enter the server password to connect to your terminal sessions.</p>
        <form onSubmit={submit} autocomplete="on">
          <input
            class="login-username"
            name="username"
            type="text"
            value={credentialUsername(location.hostname)}
            autocomplete="username"
            tabindex={-1}
            aria-hidden="true"
            readonly
          />
          <label for="password">Password</label>
          <div class="input-with-icon">
            <LockKeyhole size={16} aria-hidden="true" />
            <input
              id="password"
              name="password"
              type="password"
              value={password}
              onInput={(event) => setPassword(event.currentTarget.value)}
              autocomplete="current-password"
              autofocus
              required
            />
          </div>
          {error && <p class="form-error" role="alert">{error}</p>}
          <button class="button primary login-button" type="submit" disabled={busy || clearing}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
        <p class="login-footnote">
          This device stays signed in, and your browser can save the password for future logins.
        </p>
        <div class="login-recovery">
          <span>Seeing an old version or unable to sign in?</span>
          <button
            class="button login-clear-button"
            type="button"
            disabled={busy || clearing}
            onClick={() => void clearSiteData()}
          >
            {clearing ? "Clearing…" : "Clear cache and site data"}
          </button>
        </div>
      </section>
    </main>
  );
}
