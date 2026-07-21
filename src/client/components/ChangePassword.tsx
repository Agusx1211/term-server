import { useState } from "preact/hooks";
import { KeyRound, LoaderCircle } from "lucide-preact";
import { api } from "../lib/api";

interface ChangePasswordProps {
  managedExternally: boolean;
  onChanged: () => void;
}

export function ChangePassword({ managedExternally, onChanged }: ChangePasswordProps) {
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    setError("");
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    if (newPassword !== confirmation) {
      setError("New passwords do not match");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await api.changePassword(currentPassword, newPassword);
      close();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to change password");
    } finally {
      setBusy(false);
    }
  };

  if (managedExternally) {
    return (
      <>
        <button class="settings-password" disabled>
          <KeyRound size={14} /> Password managed externally
        </button>
        <p class="settings-hint">
          Update TERM_SERVER_PASSWORD or the configured password file, then restart the server.
        </p>
      </>
    );
  }

  if (!open) {
    return (
      <button class="settings-password" onClick={() => setOpen(true)}>
        <KeyRound size={14} /> Change password
      </button>
    );
  }

  return (
    <form class="settings-password-form" onSubmit={submit}>
      <label>
        <span>Current password</span>
        <input
          type="password"
          value={currentPassword}
          onInput={(event) => setCurrentPassword(event.currentTarget.value)}
          autocomplete="current-password"
          autofocus
          required
        />
      </label>
      <label>
        <span>New password</span>
        <input
          type="password"
          value={newPassword}
          onInput={(event) => setNewPassword(event.currentTarget.value)}
          autocomplete="new-password"
          minlength={8}
          required
        />
      </label>
      <label>
        <span>Confirm new password</span>
        <input
          type="password"
          value={confirmation}
          onInput={(event) => setConfirmation(event.currentTarget.value)}
          autocomplete="new-password"
          minlength={8}
          required
        />
      </label>
      {error && <p class="form-error" role="alert">{error}</p>}
      <div class="settings-password-actions">
        <button type="button" onClick={close} disabled={busy}>Cancel</button>
        <button class="primary" type="submit" disabled={busy}>
          {busy && <LoaderCircle class="spin" size={13} />}
          {busy ? "Changing…" : "Change password"}
        </button>
      </div>
    </form>
  );
}
