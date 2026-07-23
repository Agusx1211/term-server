import type {
  ArtifactEntry,
  ClientConfig,
  CreateTerminalRequest,
  RenameTerminalRequest,
  TerminalInfo,
  PiConfig,
  ProcessInspectorSnapshot,
  UpdatePiConfig,
  DirectoryListing,
  FileDocument,
  FileEntry,
  FileSearchResults,
  FileTarget,
  SaveFileRequest,
} from "../../shared/types";

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function fileQuery(target: FileTarget): string {
  const query = new URLSearchParams({ path: target.path });
  if (target.cwd) query.set("cwd", target.cwd);
  return query.toString();
}

export const api = {
  session: () => request<{ authenticated: boolean }>("/api/session"),
  login: (password: string) =>
    request<{ ok: true }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>("/api/logout", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("/api/password", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  config: () => request<ClientConfig>("/api/config"),
  updatePiConfig: (config: UpdatePiConfig) =>
    request<PiConfig>("/api/config/pi", { method: "PATCH", body: JSON.stringify(config) }),
  terminals: () => request<TerminalInfo[]>("/api/terminals"),
  createTerminal: (terminal: CreateTerminalRequest) =>
    request<TerminalInfo>("/api/terminals", { method: "POST", body: JSON.stringify(terminal) }),
  renameTerminal: (id: string, terminal: RenameTerminalRequest) =>
    request<TerminalInfo>(`/api/terminals/${id}`, { method: "PATCH", body: JSON.stringify(terminal) }),
  removeTerminal: (id: string) => request<void>(`/api/terminals/${id}`, { method: "DELETE" }),
  terminalProcesses: (id: string) =>
    request<ProcessInspectorSnapshot>(`/api/terminals/${id}/processes`),
  artifacts: () => request<ArtifactEntry[]>("/api/artifacts"),
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
  rawFileUrl: (target: FileTarget) => `/api/files/raw?${fileQuery(target)}`,
};
