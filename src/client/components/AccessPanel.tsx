import { useCallback, useEffect, useState } from "preact/hooks";
import {
  Ban,
  Check,
  CircleCheck,
  CircleX,
  Clock3,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Plus,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  UserRoundPlus,
  Users,
  X,
} from "lucide-preact";
import type {
  AccessActivity,
  AccessRequest,
  AccessSnapshot,
  SecretGrant,
  TerminalInfo,
} from "../../shared/types";
import { api } from "../lib/api";

interface AccessPanelProps {
  open: boolean;
  terminal: TerminalInfo;
  onClose: () => void;
  onPendingCountChange: (count: number) => void;
  onNotice: (message: string) => void;
}

const emptySnapshot = (terminalId: string): AccessSnapshot => ({
  terminalId,
  revision: 0,
  requests: [],
  grants: [],
  activity: [],
});

export function AccessPanel({
  open,
  terminal,
  onClose,
  onPendingCountChange,
  onNotice,
}: AccessPanelProps) {
  const [snapshot, setSnapshot] = useState<AccessSnapshot>(() => emptySnapshot(terminal.id));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [secretRequestId, setSecretRequestId] = useState<string | null>(null);
  const [sudoRequestId, setSudoRequestId] = useState<string | null>(null);
  const [addingSecret, setAddingSecret] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const pendingCount = snapshot.requests.filter((request) => request.state === "pending").length;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await api.terminalAccess(terminal.id, signal);
    setSnapshot(next);
    setError("");
    setLoading(false);
  }, [terminal.id]);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    setSnapshot(emptySnapshot(terminal.id));
    setLoading(true);
    setError("");
    const poll = async () => {
      try {
        await refresh(controller.signal);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Unable to load access requests");
          setLoading(false);
        }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh, terminal.id]);

  useEffect(() => onPendingCountChange(pendingCount), [onPendingCountChange, pendingCount]);

  const perform = async (key: string, action: () => Promise<unknown>, notice: string) => {
    setBusy(key);
    setError("");
    try {
      await action();
      await refresh();
      onNotice(notice);
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Access action failed";
      await refresh().catch(() => undefined);
      setError(message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const rejectRequest = async (request: AccessRequest) => {
    const comment = window.prompt("Why reject this request? (optional)", "");
    if (comment === null) return;
    await perform(
      request.id,
      () => api.rejectTerminalAccess(terminal.id, request.id, request.requestHash, comment),
      "Access request rejected",
    );
  };

  const approveSecret = async (event: SubmitEvent, request: AccessRequest) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("secretValue") as HTMLInputElement;
    let value = input.value;
    input.value = "";
    const approved = await perform(
      request.id,
      () => api.approveTerminalSecret(terminal.id, request.id, request.requestHash, value),
      `${request.secretName ?? "Secret"} granted to this terminal`,
    );
    value = "";
    if (approved) setSecretRequestId(null);
  };

  const approveSudo = async (event: SubmitEvent, request: AccessRequest) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("sudoPassword") as HTMLInputElement;
    let password = input.value;
    input.value = "";
    const approved = await perform(
      request.id,
      () => api.approveTerminalSudo(terminal.id, request.id, request.requestHash, password),
      "Sudo authenticated; the reviewed command is running",
    );
    password = "";
    if (approved) setSudoRequestId(null);
  };

  const addSecret = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const name = (form.elements.namedItem("name") as HTMLInputElement).value;
    const description = (form.elements.namedItem("description") as HTMLInputElement).value;
    const valueInput = form.elements.namedItem("value") as HTMLInputElement;
    let value = valueInput.value;
    valueInput.value = "";
    const added = await perform(
      "add-secret",
      () => api.addTerminalSecret(terminal.id, name, value, description),
      `${name.toUpperCase()} granted to this terminal`,
    );
    value = "";
    if (added) {
      form.reset();
      setAddingSecret(false);
    }
  };

  const revokeGrant = async (grant: SecretGrant) => {
    if (!window.confirm(`Revoke ${grant.name} from ${terminal.name}?`)) return;
    await perform(
      grant.id,
      () => api.revokeTerminalSecret(terminal.id, grant.id),
      `${grant.name} revoked`,
    );
  };

  if (!open) return null;

  return (
    <aside class="process-inspector access-panel" aria-label="Terminal access requests" onPointerDown={(event) => event.stopPropagation()}>
      <header class="process-inspector-header access-panel-header">
        <span class="process-inspector-title"><ShieldCheck size={15} /> Access</span>
        <span class={`access-waiting-label ${pendingCount ? "pending" : "clear"}`}>
          {pendingCount ? `${pendingCount} waiting` : "clear"}
        </span>
        <button class="pane-action" onClick={onClose} aria-label="Close access panel" title="Close access panel">
          <X size={15} />
        </button>
      </header>
      <div class="process-inspector-note access-panel-note">
        Values are sent once to the local broker and never returned to the browser or agent. Access is scoped to <strong>{terminal.name}</strong>.
      </div>
      <div class="process-inspector-scroll access-panel-scroll">
        {error && <div class="process-inspector-error" role="alert">{error}</div>}
        <section class="process-section access-section">
          <div class="process-section-heading">
            <span>Needs your approval</span><span>{snapshot.requests.length}</span>
          </div>
          {loading && !snapshot.requests.length ? (
            <div class="process-empty">Reading access requests…</div>
          ) : snapshot.requests.length ? snapshot.requests.map((request) => (
            <AccessRequestCard
              key={request.id}
              request={request}
              terminalId={terminal.id}
              secretOpen={secretRequestId === request.id}
              sudoOpen={sudoRequestId === request.id}
              busy={busy === request.id}
              onReject={() => void rejectRequest(request)}
              onOpenSecret={() => { setSudoRequestId(null); setSecretRequestId(request.id); }}
              onOpenSudo={() => { setSecretRequestId(null); setSudoRequestId(request.id); }}
              onCancel={() => { setSecretRequestId(null); setSudoRequestId(null); }}
              onApproveSecret={(event) => void approveSecret(event, request)}
              onApproveSudo={(event) => void approveSudo(event, request)}
            />
          )) : (
            <div class="process-empty access-empty"><CircleCheck size={15} /> No requests are waiting.</div>
          )}
        </section>

        <section class="process-section access-section">
          <div class="process-section-heading access-section-controls">
            <span>Secrets granted here</span>
            <button onClick={() => setAddingSecret((current) => !current)} disabled={busy !== null}>
              <Plus size={11} /> Add secret
            </button>
          </div>
          {addingSecret && (
            <form class="access-add-secret" onSubmit={(event) => void addSecret(event)}>
              <div class="access-add-secret-heading"><UserRoundPlus size={14} /><span>Add and grant a secret</span></div>
              <label>
                Environment name
                <input name="name" placeholder="SERVICE_API_KEY" pattern="[A-Za-z_][A-Za-z0-9_]*" autocomplete="off" spellcheck={false} required autofocus />
              </label>
              <label>
                Secret value
                <input name="value" type="password" placeholder="Never shown again" autocomplete="off" required />
              </label>
              <label>
                Purpose <span>optional</span>
                <input name="description" placeholder="What should this terminal use it for?" autocomplete="off" />
              </label>
              <small><LockKeyhole size={10} /> Held only in broker memory until revoked, the terminal closes, or the broker stops.</small>
              <div class="access-actions">
                <button type="button" class="access-button" onClick={(event) => { event.currentTarget.form?.reset(); setAddingSecret(false); }}>Cancel</button>
                <button type="submit" class="access-button primary" disabled={busy !== null}>
                  {busy === "add-secret" ? <LoaderCircle class="spin" size={12} /> : <Plus size={12} />} Grant to terminal
                </button>
              </div>
            </form>
          )}
          {snapshot.grants.length ? snapshot.grants.map((grant) => (
            <SecretGrantRow key={grant.id} grant={grant} busy={busy === grant.id} onRevoke={() => void revokeGrant(grant)} />
          )) : <div class="process-empty">No secrets are granted to this terminal.</div>}
        </section>

        <section class="process-section access-section">
          <div class="process-section-heading">
            <span>Recent activity</span><span>{snapshot.activity.length}</span>
          </div>
          <div class="access-activity-list">
            {snapshot.activity.length ? snapshot.activity.map((entry) => <ActivityRow key={entry.id} entry={entry} />) : (
              <div class="process-empty">No access decisions yet.</div>
            )}
          </div>
        </section>

        <footer class="access-panel-footer">
          <span><LockKeyhole size={11} /> Secret values are never displayed or persisted</span>
          <span>{terminal.path}</span>
        </footer>
      </div>
    </aside>
  );
}

function AccessRequestCard({
  request,
  terminalId,
  secretOpen,
  sudoOpen,
  busy,
  onReject,
  onOpenSecret,
  onOpenSudo,
  onCancel,
  onApproveSecret,
  onApproveSudo,
}: {
  request: AccessRequest;
  terminalId: string;
  secretOpen: boolean;
  sudoOpen: boolean;
  busy: boolean;
  onReject: () => void;
  onOpenSecret: () => void;
  onOpenSudo: () => void;
  onCancel: () => void;
  onApproveSecret: (event: SubmitEvent) => void;
  onApproveSudo: (event: SubmitEvent) => void;
}) {
  const actionable = request.state === "pending" && !busy;
  return (
    <article class={`access-request ${request.kind}`}>
      <div class={`access-request-icon ${request.kind}`}>
        {request.kind === "secret" ? <KeyRound size={15} /> : <TerminalSquare size={15} />}
      </div>
      <div class="access-request-main">
        <div class="access-request-heading">
          <strong>{request.kind === "secret" ? request.secretName : "Run as root"}</strong>
          <span class={`access-kind ${request.kind}`}>{request.kind}</span>
          {request.state !== "pending" && <span class={`access-request-state ${request.state}`}>{request.state}</span>}
        </div>
        <p>{request.description}</p>
        {request.command && <code class="access-command">{request.command}</code>}
        <div class="access-request-meta">
          <span><Clock3 size={10} /> {relativeTime(request.createdAt)}</span>
          <span><Users size={10} /> {request.waiters} {request.waiters === 1 ? "waiter" : "waiters"}</span>
          <span>{request.agent}</span>
        </div>
        {request.cwd && (
          <div class="access-scope"><span>{request.cwd}</span><span>#{request.fingerprint?.slice(0, 12)}</span></div>
        )}
        {secretOpen && request.state === "pending" ? (
          <form class="access-secret-entry" onSubmit={onApproveSecret}>
            <label for={`secret-value-${terminalId}-${request.id}`}>
              Secret value
              <input id={`secret-value-${terminalId}-${request.id}`} name="secretValue" type="password" placeholder="Never shown again" autocomplete="off" required autofocus />
            </label>
            <small><LockKeyhole size={10} /> Sent once to the local broker, then cleared from this form.</small>
            <div class="access-actions">
              <button type="button" class="access-button" onClick={onCancel}>Cancel</button>
              <button type="submit" class="access-button primary" disabled={busy}>
                {busy ? <LoaderCircle class="spin" size={12} /> : <Check size={12} />} Grant secret
              </button>
            </div>
          </form>
        ) : sudoOpen && request.state === "pending" ? (
          <form class="access-secret-entry access-sudo-entry" onSubmit={onApproveSudo}>
            <label for={`sudo-password-${terminalId}-${request.id}`}>
              Sudo password
              <input id={`sudo-password-${terminalId}-${request.id}`} name="sudoPassword" type="password" placeholder="Required for this exact command" autocomplete="off" required autofocus />
            </label>
            <small><LockKeyhole size={10} /> Used once for this immutable command, never shared with the agent, then best-effort zeroed.</small>
            <div class="access-actions">
              <button type="button" class="access-button" onClick={onCancel}>Cancel</button>
              <button type="submit" class="access-button primary" disabled={busy}>
                {busy ? <LoaderCircle class="spin" size={12} /> : <ShieldCheck size={12} />} Authenticate &amp; run
              </button>
            </div>
          </form>
        ) : request.state === "pending" ? (
          <div class="access-actions">
            <button class="access-button danger" disabled={!actionable} onClick={onReject}><Ban size={12} /> Reject</button>
            {request.kind === "secret" ? (
              <button class="access-button primary" disabled={!actionable} onClick={onOpenSecret}><KeyRound size={12} /> Provide secret</button>
            ) : (
              <button class="access-button primary" disabled={!actionable} onClick={onOpenSudo}><ShieldCheck size={12} /> Run as root</button>
            )}
          </div>
        ) : (
          <div class="access-running"><LoaderCircle class="spin" size={12} /> {request.state === "authenticating" ? "Checking sudo password…" : "Reviewed command is running…"}</div>
        )}
      </div>
    </article>
  );
}

function SecretGrantRow({ grant, busy, onRevoke }: { grant: SecretGrant; busy: boolean; onRevoke: () => void }) {
  return (
    <div class="access-grant">
      <span class="access-grant-icon"><KeyRound size={13} /></span>
      <span class="access-grant-copy">
        <strong>{grant.name}</strong>
        <small>{grant.source} · {grant.uses} {grant.uses === 1 ? "use" : "uses"} · {grant.lastUsedAt ? relativeTime(grant.lastUsedAt) : "not used yet"}</small>
      </span>
      <span class="access-grant-state">Granted</span>
      <button class="access-icon-button danger" disabled={busy} onClick={onRevoke} aria-label={`Revoke ${grant.name}`} title={`Revoke ${grant.name}`}>
        {busy ? <LoaderCircle class="spin" size={13} /> : <Trash2 size={13} />}
      </button>
    </div>
  );
}

function ActivityRow({ entry }: { entry: AccessActivity }) {
  return (
    <div class={`access-activity ${entry.status}`}>
      <span class="access-activity-icon">
        {entry.status === "approved" ? <CircleCheck size={13} /> : entry.status === "rejected" ? <CircleX size={13} /> : <Trash2 size={13} />}
      </span>
      <span class="access-activity-copy"><strong>{entry.title}</strong><small>{entry.detail}</small></span>
      <time>{relativeTime(entry.createdAt)}</time>
    </div>
  );
}

function relativeTime(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
