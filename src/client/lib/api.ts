import type {
  AgentIntegrationAction,
  AgentIntegrationProvider,
  AgentIntegrationsConfig,
  ActivityView,
  AccessSnapshot,
  SecretGrant,
  BrowserTabCommandAck,
  BrowserTabHeartbeat,
  BrowserTabSnapshot,
  ArtifactSkillAction,
  ArtifactSkillConfig,
  ArtifactEntry,
  ClientConfig,
  CreateTerminalRequest,
  RenameTerminalRequest,
  TerminalInfo,
  PiConfig,
  ProcessInspectorSnapshot,
  UpdatePiConfig,
  UpdateActivityView,
  DirectoryListing,
  FileDocument,
  FileEntry,
  FileSearchResults,
  FileTarget,
  SaveFileRequest,
  UploadedFile,
  SessionBrokerInfo,
  StatusModulesResponse,
  StatusModulesSettings,
  UpdateStatusModulesSettings,
  UpdateStatus,
  UpdateChannel,
  UpdateConfig,
  ReleaseInfo,
  DebugRecordingStatus,
  DebugRecordingExport,
  PushoverConfig,
  UpdatePushoverConfig,
} from "../../shared/types";

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Default budget for a JSON API call. Without it a request that is never
 * answered (a server restarted mid-save, a dropped connection the OS has not
 * noticed yet) leaves its UI wedged until the TCP timeout, and re-entrancy
 * guards such as the editor's Save keep refusing new attempts for minutes.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Endpoints that shell out to agent CLIs (`COMMAND_TIMEOUT` is 60 s server-side). */
const COMMAND_REQUEST_TIMEOUT_MS = 120_000;
/** Endpoints that reach the release host, whose own HTTP client waits 5 minutes. */
const RELEASE_REQUEST_TIMEOUT_MS = 360_000;
/** Downloading, verifying, and installing a release. */
const INSTALL_REQUEST_TIMEOUT_MS = 900_000;
/** Endpoints that call an external provider (status modules allow 60 s each). */
const PROVIDER_REQUEST_TIMEOUT_MS = 90_000;

export const REQUEST_TIMEOUT_ERROR = "Request timed out";

interface TimedRequestInit extends RequestInit {
  /** Override the default budget; 0 disables the timeout entirely. */
  readonly timeoutMs?: number;
}

interface RequestDeadline {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

/**
 * Abort the request once the budget elapses, while still honouring a caller
 * supplied signal. `AbortSignal.any` is not available everywhere the client
 * runs, so the two sources are combined by hand.
 */
function requestDeadline(signal: AbortSignal | null | undefined, timeoutMs: number): RequestDeadline {
  const controller = new AbortController();
  let expired = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      expired = true;
      controller.abort();
    }, timeoutMs)
    : undefined;
  const forward = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forward, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

async function request<T>(path: string, init?: TimedRequestInit): Promise<T> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal, ...rest } = init ?? {};
  const deadline = requestDeadline(signal, timeoutMs);
  try {
    const response = await fetch(path, {
      ...rest,
      signal: deadline.signal,
      cache: "no-store",
      headers: {
        ...(rest.body ? { "content-type": "application/json" } : {}),
        ...rest.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } catch (error) {
    if (deadline.timedOut()) throw new ApiError(REQUEST_TIMEOUT_ERROR, 0);
    throw error;
  } finally {
    deadline.dispose();
  }
}

interface ConfigRequestOptions {
  readonly agentIntegrations?: "lazy";
  readonly signal?: AbortSignal;
}

function fileQuery(target: FileTarget): string {
  const query = new URLSearchParams({ path: target.path });
  if (target.cwd) query.set("cwd", target.cwd);
  return query.toString();
}

export const api = {
  session: (signal?: AbortSignal) => request<{ authenticated: boolean }>("/api/session", { signal }),
  login: (password: string) =>
    request<{ ok: true }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>("/api/logout", { method: "POST" }),
  clearSiteData: () => request<void>("/api/site-data", { method: "DELETE" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("/api/password", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  config: (options: ConfigRequestOptions = {}) => {
    const query = options.agentIntegrations === "lazy"
      ? "?agentIntegrations=lazy"
      : "";
    return request<ClientConfig>(`/api/config${query}`, { signal: options.signal });
  },
  statusModules: (signal?: AbortSignal) => request<StatusModulesResponse>("/api/status-modules", {
    signal,
    timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
  }),
  statusModulesConfig: () => request<StatusModulesSettings>("/api/config/status-modules"),
  updateStatusModulesConfig: (config: UpdateStatusModulesSettings) =>
    request<StatusModulesSettings>("/api/config/status-modules", {
      method: "PATCH",
      body: JSON.stringify(config),
    }),
  updateStatus: () => request<UpdateStatus>("/api/update", { timeoutMs: RELEASE_REQUEST_TIMEOUT_MS }),
  installUpdate: (commit: string) =>
    request<ReleaseInfo>("/api/update", {
      method: "POST",
      body: JSON.stringify({ commit }),
      timeoutMs: INSTALL_REQUEST_TIMEOUT_MS,
    }),
  updateChannel: (channel: UpdateChannel) =>
    request<UpdateConfig>("/api/config/updates", {
      method: "PATCH",
      body: JSON.stringify({ channel }),
    }),
  restartBroker: (closeTerminals: boolean) =>
    request<SessionBrokerInfo>("/api/broker/restart", {
      method: "POST",
      body: JSON.stringify({ closeTerminals }),
    }),
  updatePiConfig: (config: UpdatePiConfig) =>
    request<PiConfig>("/api/config/pi", { method: "PATCH", body: JSON.stringify(config) }),
  agentIntegrations: (signal?: AbortSignal) =>
    request<AgentIntegrationsConfig>("/api/config/agent-integrations", {
      signal,
      timeoutMs: COMMAND_REQUEST_TIMEOUT_MS,
    }),
  updateAgentIntegration: (
    provider: AgentIntegrationProvider,
    action: AgentIntegrationAction,
  ) => request<AgentIntegrationsConfig>(`/api/config/agent-integrations/${provider}`, {
    method: "PATCH",
    body: JSON.stringify({ action }),
    timeoutMs: COMMAND_REQUEST_TIMEOUT_MS,
  }),
  artifactSkill: () => request<ArtifactSkillConfig>("/api/config/artifact-skill", {
    timeoutMs: COMMAND_REQUEST_TIMEOUT_MS,
  }),
  updateArtifactSkill: (
    provider: AgentIntegrationProvider,
    action: ArtifactSkillAction,
  ) => request<ArtifactSkillConfig>(`/api/config/artifact-skill/${provider}`, {
    method: "PATCH",
    body: JSON.stringify({ action }),
    timeoutMs: COMMAND_REQUEST_TIMEOUT_MS,
  }),
  createSupervisor: (signal?: AbortSignal) =>
    request<TerminalInfo>("/api/supervisor", {
      method: "POST",
      body: JSON.stringify({}),
      signal,
    }),
  browserTabHeartbeat: (viewId: string, snapshot: BrowserTabSnapshot) =>
    request<BrowserTabHeartbeat>(`/api/browser-tabs/${encodeURIComponent(viewId)}`, {
      method: "PUT",
      body: JSON.stringify(snapshot),
    }),
  ackBrowserTabCommand: (
    viewId: string,
    commandId: string,
    ack: BrowserTabCommandAck,
  ) => request<void>(
    `/api/browser-tabs/${encodeURIComponent(viewId)}/commands/${encodeURIComponent(commandId)}`,
    { method: "POST", body: JSON.stringify(ack) },
  ),
  terminals: () => request<TerminalInfo[]>("/api/terminals"),
  createTerminal: (terminal: CreateTerminalRequest) =>
    request<TerminalInfo>("/api/terminals", { method: "POST", body: JSON.stringify(terminal) }),
  renameTerminal: (id: string, terminal: RenameTerminalRequest) =>
    request<TerminalInfo>(`/api/terminals/${id}`, { method: "PATCH", body: JSON.stringify(terminal) }),
  updateTerminalActivityView: (id: string, activityView: UpdateActivityView) =>
    request<ActivityView>(`/api/terminals/${id}/activity-view`, {
      method: "PATCH",
      body: JSON.stringify(activityView),
    }),
  removeTerminal: (id: string) => request<void>(`/api/terminals/${id}`, { method: "DELETE" }),
  terminalProcesses: (id: string) =>
    request<ProcessInspectorSnapshot>(`/api/terminals/${id}/processes`),
  terminalAccess: (id: string, signal?: AbortSignal) =>
    request<AccessSnapshot>(`/api/terminals/${id}/access`, { signal }),
  addTerminalSecret: (id: string, name: string, value: string, description?: string) =>
    request<SecretGrant>(`/api/terminals/${id}/access/secrets`, {
      method: "POST",
      body: JSON.stringify({ name, value, description: description || undefined }),
    }),
  revokeTerminalSecret: (id: string, grantId: string) =>
    request<void>(`/api/terminals/${id}/access/secrets/${encodeURIComponent(grantId)}`, {
      method: "DELETE",
    }),
  approveTerminalSecret: (id: string, requestId: string, requestHash: string, value: string) =>
    request<SecretGrant>(
      `/api/terminals/${id}/access/requests/${encodeURIComponent(requestId)}/secret`,
      { method: "POST", body: JSON.stringify({ requestHash, value }) },
    ),
  approveTerminalSudo: (id: string, requestId: string, requestHash: string, password: string) =>
    request<void>(
      `/api/terminals/${id}/access/requests/${encodeURIComponent(requestId)}/sudo`,
      { method: "POST", body: JSON.stringify({ requestHash, password }) },
    ),
  rejectTerminalAccess: (id: string, requestId: string, requestHash: string, comment?: string) =>
    request<void>(
      `/api/terminals/${id}/access/requests/${encodeURIComponent(requestId)}/reject`,
      { method: "POST", body: JSON.stringify({ requestHash, comment: comment || undefined }) },
    ),
  terminateTerminalProcess: (id: string, processId: string) =>
    request<void>(`/api/terminals/${id}/processes/${encodeURIComponent(processId)}`, {
      method: "DELETE",
    }),
  artifacts: () => request<ArtifactEntry[]>("/api/artifacts"),
  removeArtifact: (sessionId: string, artifactId: string) =>
    request<void>(`/api/artifacts/${sessionId}/${artifactId}`, { method: "DELETE" }),
  fileMetadata: (target: FileTarget) => request<FileEntry>(`/api/files/meta?${fileQuery(target)}`),
  listFiles: (target: FileTarget) => request<DirectoryListing>(`/api/files/list?${fileQuery(target)}`),
  searchFiles: (root: string, query: string, cwd?: string) => {
    const params = new URLSearchParams({ root, query });
    if (cwd) params.set("cwd", cwd);
    return request<FileSearchResults>(`/api/files/search?${params}`);
  },
  readFile: (target: FileTarget) => request<FileDocument>(`/api/files/content?${fileQuery(target)}`),
  saveFile: (file: SaveFileRequest) =>
    request<FileDocument>("/api/files/content", { method: "PUT", body: JSON.stringify(file) }),
  // Multipart upload; the browser sets the `multipart/form-data` boundary, so
  // this bypasses the JSON helper rather than letting it set the content type.
  // XMLHttpRequest (not fetch) is used because it exposes upload progress and
  // reliable abort for the large multipart bodies this endpoint accepts.
  uploadFiles: (
    target: FileTarget,
    files: File[],
    onProgress?: (sent: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<UploadedFile[]> => {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/files/upload?${fileQuery(target)}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded, event.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (xhr.status === 204) {
            resolve([]);
            return;
          }
          try {
            resolve(JSON.parse(xhr.responseText) as UploadedFile[]);
          } catch {
            reject(new ApiError("Upload failed (invalid response)", xhr.status));
          }
          return;
        }
        let message = `Upload failed (${xhr.status})`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string } | null;
          if (body?.error) message = body.error;
        } catch {
          // keep the status-based fallback
        }
        reject(new ApiError(message, xhr.status));
      };
      xhr.onerror = () => reject(new ApiError("Upload failed (network error)", 0));
      xhr.onabort = () => reject(new ApiError("Upload cancelled", 0));
      if (signal) {
        if (signal.aborted) {
          xhr.abort();
          return;
        }
        signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }
      xhr.send(form);
    });
  },
  previewFileUrl: (target: FileTarget) => `/api/files/raw?${fileQuery(target)}`,
  downloadFileUrl: (target: FileTarget) => `/api/files/download?${fileQuery(target)}`,
  debugRecording: () => request<DebugRecordingStatus>("/api/debug/recording"),
  debugRecordingControl: (action: "start" | "stop" | "clear") =>
    request<DebugRecordingStatus>("/api/debug/recording", {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
  debugRecordingExport: () =>
    request<DebugRecordingExport>("/api/debug/recording/export"),
  pushoverConfig: () => request<PushoverConfig>("/api/config/pushover"),
  updatePushoverConfig: (config: UpdatePushoverConfig) =>
    request<PushoverConfig>("/api/config/pushover", {
      method: "PATCH",
      body: JSON.stringify(config),
    }),
  pushoverSend: (notification: { title?: string; message: string }) =>
    request<{ ok: true }>("/api/pushover/send", {
      method: "POST",
      body: JSON.stringify(notification),
      timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
    }),
};
