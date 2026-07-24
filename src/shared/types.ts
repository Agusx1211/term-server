export type TerminalStatus = "running" | "exited";
export type AgentStatus = "working" | "idle" | "closed";

export interface AgentActivity {
  label: string;
  updatedAt: number;
}

export interface AgentInfo {
  kind: "codex" | "claude" | "pi" | string;
  status: AgentStatus;
  statusChangedAt: number;
  startedAt: number;
  revision: number;
  completedAt: number | null;
  summary: string | null;
  activity?: AgentActivity | null;
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
  cpuPercent: number;
  memoryBytes: number;
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
  agentIntegrations: AgentIntegrationsConfig;
  build: BuildInfo;
  broker: SessionBrokerInfo | null;
  updates: UpdateConfig;
}

export interface BuildInfo {
  version: string;
  commit: string;
}

export interface SessionBrokerInfo extends BuildInfo {
  sessions: number;
  restartRequired: boolean;
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

export type AgentIntegrationProvider = "codex" | "claude" | "pi";
export type AgentIntegrationState =
  | "unavailable"
  | "notInstalled"
  | "installed"
  | "needsRepair";
export type AgentIntegrationAction = "install" | "repair" | "remove";

export interface AgentIntegrationStatus {
  provider: AgentIntegrationProvider;
  name: string;
  state: AgentIntegrationState;
  message: string;
}

export interface AgentIntegrationsConfig {
  providers: AgentIntegrationStatus[];
  fallbacksEnabled: boolean;
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
  pdf: boolean;
  editable: boolean;
}

export interface ArtifactEntry extends FileEntry {
  id: string;
  sessionId: string;
  createdAt: number;
  producer?: string;
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
  | { type: "focus"; focused: boolean }
  | { type: "ping" };

export type ServerTerminalMessage =
  | { type: "ready"; terminal: TerminalInfo }
  | { type: "exit"; exitCode: number }
  | { type: "size"; cols: number; rows: number; focused: boolean; controller: boolean }
  | { type: "pong" }
  | { type: "error"; message: string };
