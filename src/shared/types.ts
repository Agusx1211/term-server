export type TerminalStatus = "running" | "exited";
export type AgentStatus = "working" | "idle" | "closed";

export interface AgentInfo {
  kind: "codex" | "claude" | "pi" | string;
  status: AgentStatus;
  statusChangedAt: number;
  startedAt: number;
  revision: number;
  summary: string | null;
}

export interface TerminalInfo {
  id: string;
  name: string;
  workspace: string;
  path: string;
  cwd: string;
  shell: string;
  program: string;
  color: string;
  agent: AgentInfo | null;
  createdAt: number;
  pid: number | null;
  status: TerminalStatus;
  exitCode: number | null;
  clients: number;
}

export interface CreateTerminalRequest {
  path?: string;
  cwd?: string;
  shell?: string;
  cloneFrom?: string;
}

export interface RenameTerminalRequest {
  path: string;
}

export interface ProcessRecord {
  id: string;
  pid: number;
  parentId: string | null;
  command: string;
  arguments: string[];
  cwd: string | null;
  foreground: boolean;
}

export interface ProcessInspectorSnapshot {
  supported: boolean;
  processes: ProcessRecord[];
}

export interface ClientConfig {
  scrollbackLines: number;
  maxPanes: number;
  secure: boolean;
  hostname: string;
  passwordManagedExternally: boolean;
  pi: PiConfig;
  build: BuildInfo;
  updates: UpdateConfig;
}

export interface BuildInfo {
  version: string;
  commit: string;
}

export interface UpdateConfig {
  enabled: boolean;
  channel: string;
  reason: string | null;
}

export interface ReleaseInfo extends BuildInfo {
  publishedAt: string;
}

export interface UpdateStatus {
  current: BuildInfo;
  state: "current" | "available" | "unavailable";
  latest: ReleaseInfo | null;
}

export interface PiModel {
  id: string;
  label: string;
}

export interface PiConfig {
  available: boolean;
  /** Compatibility aggregate for older clients. */
  enabled: boolean;
  titlesEnabled: boolean;
  summariesEnabled: boolean;
  model: string;
  models: PiModel[];
}

export interface UpdatePiConfig {
  titlesEnabled: boolean;
  summariesEnabled: boolean;
  model: string;
}

export type FileEntryKind = "file" | "directory";

export interface FileEntry {
  path: string;
  name: string;
  kind: FileEntryKind;
  size: number;
  modifiedAt: number;
  mime: string;
  image: boolean;
  editable: boolean;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  truncated: boolean;
}

export interface FileSearchResults {
  root: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface FileDocument {
  path: string;
  name: string;
  mime: string;
  modifiedAt: number;
  version: string;
  content: string;
}

export interface FileTarget {
  path: string;
  cwd?: string;
}

export interface SaveFileRequest extends FileTarget {
  content: string;
  version: string;
}

export type ClientTerminalMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

export type ServerTerminalMessage =
  | { type: "ready"; terminal: TerminalInfo }
  | { type: "exit"; exitCode: number }
  | { type: "pong" }
  | { type: "error"; message: string };
