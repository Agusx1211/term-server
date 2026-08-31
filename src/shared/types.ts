export type TerminalStatus = "running" | "exited";
export type TerminalKind = "regular" | "supervisor";
export type AgentStatus = "working" | "blocked" | "idle" | "closed";

export interface AgentActivity {
  label: string;
  updatedAt: number;
}

export interface AgentInfo {
  kind: "codex" | "claude" | "pi" | "hermes" | string;
  status: AgentStatus;
  statusChangedAt: number;
  startedAt: number;
  revision: number;
  completedAt: number | null;
  summary: string | null;
  activity?: AgentActivity | null;
}

export type ForegroundCommandStatus = "running" | "live" | "completed";

export interface ForegroundCommandInfo {
  name: string;
  status: ForegroundCommandStatus;
  statusChangedAt: number;
  startedAt: number;
  completedAt: number | null;
}

export interface ActivityView {
  agentCompletedAt: number;
  commandCompletedAt: number;
}

export interface UpdateActivityView {
  agentCompletedAt?: number;
  commandCompletedAt?: number;
}

export interface TerminalInfo {
  id: string;
  kind: TerminalKind;
  /** Managed skill root for supervisor terminals; omitted by older brokers. */
  supervisorRoot?: string | null;
  name: string;
  workspace: string;
  path: string;
  cwd: string;
  shell: string;
  program: string;
  color: string;
  agent: AgentInfo | null;
  command: ForegroundCommandInfo | null;
  createdAt: number;
  pid: number | null;
  status: TerminalStatus;
  exitCode: number | null;
  clients: number;
  /** Pending secret or sudo requests; broker-ready messages and older brokers omit it. */
  pendingAccessRequests?: number;
  /** Present on REST responses; broker-ready messages omit it. */
  broker?: BuildInfo | null;
  /** Present on REST responses; broker-ready messages from older patch releases omit it. */
  activityViewed?: ActivityView;
}

export interface BrowserTerminalPaneSnapshot {
  terminalId: string;
  label: string;
  active: boolean;
}

export interface BrowserResourceSnapshot {
  path: string;
  name: string;
  dirty: boolean;
  active: boolean;
}

export interface BrowserTabSnapshot {
  title: string;
  focused: boolean;
  visible: boolean;
  terminalPanes: BrowserTerminalPaneSnapshot[];
  resources: BrowserResourceSnapshot[];
  settingsOpen: boolean;
  settingsActive: boolean;
}

export interface BrowserTabHeartbeat {
  commands: BrowserTabCommand[];
}

export type BrowserTabCommand =
  | { id: string; type: "closeTerminalPane"; terminalId: string }
  | { id: string; type: "closeResource"; path: string }
  | { id: string; type: "closeSettings" };

export interface BrowserTabCommandAck {
  ok: boolean;
  error?: string;
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

export type AccessRequestKind = "secret" | "sudo";
export type AccessRequestState = "pending" | "authenticating" | "running";
export type AccessActivityStatus = "approved" | "rejected" | "revoked" | "failed" | "canceled";

export interface AccessRequest {
  id: string;
  requestHash: string;
  kind: AccessRequestKind;
  state: AccessRequestState;
  description: string;
  agent: string;
  createdAt: number;
  waiters: number;
  secretName: string | null;
  command: string | null;
  cwd: string | null;
  fingerprint: string | null;
}

export interface SecretGrant {
  id: string;
  name: string;
  source: string;
  createdAt: number;
  uses: number;
  lastUsedAt: number | null;
  lastCommand: string | null;
}

export interface AccessActivity {
  id: string;
  kind: AccessRequestKind;
  status: AccessActivityStatus;
  title: string;
  detail: string;
  createdAt: number;
}

export interface AccessSnapshot {
  terminalId: string;
  revision: number;
  requests: AccessRequest[];
  grants: SecretGrant[];
  activity: AccessActivity[];
}

export interface ClientConfig {
  scrollbackLines: number;
  maxPanes: number;
  cachedTerminals: number;
  secure: boolean;
  hostname: string;
  passwordManagedExternally: boolean;
  pi: PiConfig;
  agentIntegrations: AgentIntegrationsConfig;
  artifactSkill: ArtifactSkillConfig;
  pushover: PushoverConfig;
  statusModules: StatusModulesSettings;
  build: BuildInfo;
  broker: SessionBrokerInfo | null;
  updates: UpdateConfig;
}

export interface StatusModulesSettings {
  enabled: boolean;
  showOnMobile: boolean;
}

export interface UpdateStatusModulesSettings {
  enabled?: boolean;
  showOnMobile?: boolean;
}
export type StatusModuleState = "ok" | "warn" | "error" | "unconfigured";

export interface StatusModuleDetail {
  label: string;
  value: string;
}

export interface StatusModuleRefresh {
  updatedAt: number | null;
  nextAt: number | null;
  intervalSeconds: number;
  stale: boolean;
}

export interface StatusModuleError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface StatusModule {
  id: string;
  label: string;
  provider: string;
  state: StatusModuleState;
  primary: string | null;
  details: StatusModuleDetail[];
  refresh: StatusModuleRefresh;
  error: StatusModuleError | null;
}

export interface StatusModulesResponse {
  enabled: boolean;
  display: {
    showOnMobile: boolean;
  };
  modules: StatusModule[];
  generatedAt: number;
}


export interface BuildInfo {
  version: string;
  commit: string;
}

export interface SessionBrokerInfo extends BuildInfo {
  sessions: number;
  restartRequired: boolean;
  generations: SessionBrokerGenerationInfo[];
}

export interface SessionBrokerGenerationInfo extends BuildInfo {
  sessions: number;
  current: boolean;
}

export type UpdateChannel = "main" | "beta";

export interface UpdateConfig {
  enabled: boolean;
  channel: string;
  reason: string | null;
}

export interface ReleaseInfo extends BuildInfo {
  publishedAt: string;
}

export interface UpdateStatus {
  channel: string;
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

export type AgentIntegrationProvider = "codex" | "claude" | "pi" | "omp" | "hermes";
export type AgentIntegrationState =
  | "unavailable"
  | "notInstalled"
  | "installed"
  | "needsRepair";
export type AgentIntegrationAction = "install" | "repair" | "remove";

export interface AgentIntegrationProfileStatus {
  id: string;
  label: string;
  state: AgentIntegrationState;
  message: string;
}

export interface AgentIntegrationStatus {
  provider: AgentIntegrationProvider;
  name: string;
  state: AgentIntegrationState;
  message: string;
  profiles?: AgentIntegrationProfileStatus[];
}

export interface AgentIntegrationsConfig {
  providers: AgentIntegrationStatus[];
  fallbacksEnabled: boolean;
}

export type ArtifactSkillState =
  | "unavailable"
  | "notInstalled"
  | "installed"
  | "external"
  | "outdated"
  | "broken";
export type ArtifactSkillAction = "install" | "repair" | "remove";

export interface ArtifactSkillStatus {
  provider: AgentIntegrationProvider;
  name: string;
  state: ArtifactSkillState;
  message: string;
  path: string;
  repairable: boolean;
}

export interface ArtifactSkillConfig {
  available: boolean;
  source: string | null;
  message: string | null;
  providers: ArtifactSkillStatus[];
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

export interface UploadedFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
}

export interface DebugRecordingStatus {
  active: boolean;
  id: string | null;
  startedAt: number | null;
  stoppedAt: number | null;
  events: number;
  bytes: number;
  truncated: boolean;
}

export interface DebugRecordedEvent {
  ts: number;
  terminal: string;
  type: "output" | "input" | "control" | "snapshot" | "connect" | "disconnect" | "resize";
  sequence?: number;
  data?: string;
  message?: unknown;
  reason?: string;
  cols?: number;
  rows?: number;
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface DebugRecordingExport {
  format: string;
  version: string;
  id: string;
  startedAt: number;
  stoppedAt: number | null;
  truncated: boolean;
  server: {
    version: string;
    commit: string;
  };
  events: DebugRecordedEvent[];
}

export type PushoverMode = "off" | "select" | "all";

export interface PushoverConfig {
  configured: boolean;
  userKey: string;
  appKey: string;
  mode: PushoverMode;
  enabled: boolean;
}

export interface UpdatePushoverConfig {
  userKey?: string;
  appKey?: string;
  mode?: PushoverMode;
}

export type ClientTerminalMessage =
  | { type: "input"; data: string }
  | {
      type: "resize";
      cols: number;
      rows: number;
      pixelWidth: number;
      pixelHeight: number;
    }
  | { type: "focus"; focused: boolean }
  // The pane is cached: still mounted and still streaming, but off screen. It
  // gives up its say in the negotiated size until it reports a viewport again,
  // so a cached pane cannot hold the size down for the panes being read.
  | { type: "release" }
  // Bytes this browser's parser has consumed since the last acknowledgement.
  // The server stops draining the pty while a browser owes too many.
  | { type: "ack"; bytes: number }
  // A bounded chunk of an official xterm serialization. `checkpointBytes` in
  // the ready message is the feature negotiation and decoded-size ceiling.
  | {
      type: "checkpoint";
      sequence: number;
      epoch: number;
      offset: number;
      data: string;
      final: boolean;
    }
  // Announces a binary checkpoint upload: exactly `size` raw bytes follow as
  // ordered binary frames of at most TERMINAL_CHECKPOINT_CHUNK_BYTES each,
  // every frame prefixed with a kind byte (2) and a big-endian u64 sequence.
  // Only valid after the server advertised `binaryCheckpoint` in `ready` —
  // an older broker reads client binary frames as terminal input.
  | { type: "checkpointBinary"; sequence: number; epoch: number; size: number }
  | { type: "ping" };

export type ServerTerminalMessage =
  // `flowControl` is absent on brokers older than 0.10.0. A terminal keeps the
  // broker generation that created it, so a current browser regularly talks to
  // one of those; it must stay silent about acknowledgements until told
  // otherwise, because an older broker answers unknown messages with an error.
  // `viewportRelease` carries the same caveat and marks a server that lets a
  // cached pane hold its connection open instead of closing and resynchronizing.
  | {
      type: "ready";
      terminal: TerminalInfo;
      flowControl?: boolean;
      viewportRelease?: boolean;
      checkpointBytes?: number;
      // Marks a server that assembles `checkpointBinary` uploads. Absent on
      // older brokers, which read client binary frames as terminal input, so
      // a browser must keep base64 JSON checkpoints until it has seen this.
      binaryCheckpoint?: boolean;
    }
  | { type: "exit"; exitCode: number }
  | {
      type: "size";
      cols: number;
      rows: number;
      focused: boolean;
      controller: boolean;
      responder: boolean;
      epoch?: number;
    }
  | { type: "sync"; mode: "snapshot" | "resume"; sequence: number }
  | { type: "synced"; sequence: number }
  | { type: "pong" }
  | { type: "error"; message: string };
