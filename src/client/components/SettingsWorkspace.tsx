import { useEffect, useState } from "preact/hooks";
import {
  Activity,
  Bell,
  BellOff,
  BellRing,
  Download,
  Eye,
  Gauge,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  MessageSquareText,
  Moon,
  PackageOpen,
  Settings,
  Shield,
  Smartphone,
  Sparkles,
  SplitSquareHorizontal,
  Square,
  Sun,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Video,
} from "lucide-preact";
import type {
  AgentIntegrationAction,
  AgentIntegrationProvider,
  AgentIntegrationsConfig,
  ArtifactSkillAction,
  ArtifactSkillConfig,
  BuildInfo,
  DebugRecordingStatus,
  PiConfig,
  PushoverConfig,
  PushoverMode,
  SessionBrokerInfo,
  StatusModulesSettings,
  UpdateConfig,
  UpdateChannel,
  UpdateStatus,
  UpdateStatusModulesSettings,
} from "../../shared/types";
import type {
  NotificationDuration,
  NotificationMode,
  NotificationPosition,
} from "../lib/notifications";
import {
  DEFAULT_TERMINAL_PREVIEW_SETTINGS,
  TERMINAL_PREVIEW_LIMITS,
  type TerminalPreviewMode,
  type TerminalPreviewSettings,
} from "../lib/terminal-preview";
import {
  CACHED_TERMINALS_LIMITS,
  clampCachedTerminals,
  describeCachedTerminals,
} from "../lib/cached-terminals";
import {
  clampTerminalScrollback,
  TERMINAL_SCROLLBACK_LIMITS,
} from "../lib/terminal-scrollback";
import {
  agentIntegrationActionFor,
  agentIntegrationProfileSummary,
} from "../lib/agent-integrations";
import { ChangePassword } from "./ChangePassword";
import type { ThemeName } from "../lib/terminal-theme";

interface SettingsWorkspaceProps {
  active: boolean;
  theme: ThemeName;
  pi: PiConfig;
  agentIntegrations: AgentIntegrationsConfig;
  updatingAgentIntegration?: AgentIntegrationProvider;
  artifactSkill: ArtifactSkillConfig;
  updatingArtifactSkill?: AgentIntegrationProvider;
  build: BuildInfo;
  broker: SessionBrokerInfo | null;
  updateConfig: UpdateConfig;
  updateStatus: UpdateStatus | null;
  checkingForUpdate: boolean;
  installingUpdate: boolean;
  updatingUpdateChannel: boolean;
  restartingBroker: boolean;
  passwordManagedExternally: boolean;
  notificationMode: NotificationMode;
  notificationPosition: NotificationPosition;
  notificationDuration: NotificationDuration;
  tileNewTerminals: boolean;
  confirmTerminalKills: boolean;
  terminalPreviewSettings: TerminalPreviewSettings;
  cachedTerminals: number;
  cachedTerminalsOverridden: boolean;
  serverCachedTerminals: number;
  scrollbackLines: number;
  scrollbackLinesOverridden: boolean;
  serverScrollbackLines: number;
  recording: DebugRecordingStatus | null;
  frontendRecordingEvents: number;
  recordingBusy: boolean;
  pushover: PushoverConfig;
  statusModules: StatusModulesSettings;
  onTheme: (theme: ThemeName) => void;
  onPiChange: (titlesEnabled: boolean, summariesEnabled: boolean, model: string) => void;
  onAgentIntegration: (
    provider: AgentIntegrationProvider,
    action: AgentIntegrationAction,
  ) => void;
  onArtifactSkill: (
    provider: AgentIntegrationProvider,
    action: ArtifactSkillAction,
  ) => void;
  onCheckForUpdate: () => void;
  onUpdateChannelChange: (channel: UpdateChannel) => void;
  onInstallUpdate: () => void;
  onRestartBroker: () => void;
  onNotificationModeChange: (mode: NotificationMode) => void;
  onNotificationPositionChange: (position: NotificationPosition) => void;
  onNotificationDurationChange: (duration: NotificationDuration) => void;
  onTileNewTerminalsChange: (enabled: boolean) => void;
  onConfirmTerminalKillsChange: (enabled: boolean) => void;
  onTerminalPreviewSettingsChange: (settings: TerminalPreviewSettings) => void;
  onCachedTerminalsChange: (limit: number | undefined) => void;
  onScrollbackLinesChange: (lines: number | undefined) => void;
  onRecordingStart: () => void;
  onRecordingStop: () => void;
  onRecordingDownload: () => void;
  onRecordingClear: () => void;
  onPushoverChange: (changes: { userKey?: string; appKey?: string; mode?: PushoverMode }) => void;
  onStatusModulesChange: (changes: UpdateStatusModulesSettings) => void;
  onPasswordChanged: () => void;
  onLogout: () => void;
}

const notificationModes: Array<{
  mode: NotificationMode;
  label: string;
  description: string;
  Icon: typeof Bell;
}> = [
  {
    mode: "in-app",
    label: "In-app",
    description: "Show a completion card inside term-server.",
    Icon: MessageSquareText,
  },
  {
    mode: "system",
    label: "System",
    description: "Use desktop notifications, falling back in-app on delivery errors.",
    Icon: Bell,
  },
  {
    mode: "both",
    label: "Both",
    description: "Always show in-app and also attempt a desktop notification.",
    Icon: BellRing,
  },
  {
    mode: "off",
    label: "Off",
    description: "Keep only unread bells on completed rows.",
    Icon: BellOff,
  },
];

const notificationPositions: Array<{
  position: NotificationPosition;
  label: string;
}> = [
  { position: "top-left", label: "Top left" },
  { position: "top-right", label: "Top right" },
  { position: "bottom-left", label: "Bottom left" },
  { position: "bottom-right", label: "Bottom right" },
];

function formatDebugBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDebugDuration(startedAt: number, stoppedAt: number | null): string {
  const end = stoppedAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes === 0) return `${remaining}s`;
  return `${minutes}m ${remaining}s`;
}

const notificationDurations: Array<{
  duration: NotificationDuration;
  label: string;
}> = [
  { duration: 4_000, label: "4 sec" },
  { duration: 7_000, label: "7 sec" },
  { duration: 12_000, label: "12 sec" },
  { duration: 0, label: "Keep open" },
];

export function SettingsWorkspace({
  active,
  theme,
  pi,
  agentIntegrations,
  updatingAgentIntegration,
  artifactSkill,
  updatingArtifactSkill,
  build,
  broker,
  updateConfig,
  updateStatus,
  checkingForUpdate,
  installingUpdate,
  updatingUpdateChannel,
  restartingBroker,
  passwordManagedExternally,
  notificationMode,
  notificationPosition,
  notificationDuration,
  tileNewTerminals,
  confirmTerminalKills,
  terminalPreviewSettings,
  cachedTerminals,
  cachedTerminalsOverridden,
  serverCachedTerminals,
  scrollbackLines,
  scrollbackLinesOverridden,
  serverScrollbackLines,
  recording,
  frontendRecordingEvents,
  recordingBusy,
  pushover,
  statusModules,
  onTheme,
  onPiChange,
  onAgentIntegration,
  onArtifactSkill,
  onCheckForUpdate,
  onUpdateChannelChange,
  onInstallUpdate,
  onRestartBroker,
  onNotificationModeChange,
  onNotificationPositionChange,
  onNotificationDurationChange,
  onTileNewTerminalsChange,
  onConfirmTerminalKillsChange,
  onTerminalPreviewSettingsChange,
  onCachedTerminalsChange,
  onScrollbackLinesChange,
  onRecordingStart,
  onRecordingStop,
  onRecordingDownload,
  onRecordingClear,
  onPushoverChange,
  onStatusModulesChange,
  onPasswordChanged,
  onLogout,
}: SettingsWorkspaceProps) {
  const systemPermission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  const outdatedBrokers = broker?.generations.filter(
    (generation) => !generation.current && generation.sessions > 0,
  ) ?? [];
  const rollingUpdateChannel = updateConfig.channel === "main" || updateConfig.channel === "beta";
  const updatePreviewSettings = (changes: Partial<TerminalPreviewSettings>) => {
    onTerminalPreviewSettingsChange({ ...terminalPreviewSettings, ...changes });
  };
  const [pushoverUserKey, setPushoverUserKey] = useState(pushover.userKey);
  const [pushoverAppKey, setPushoverAppKey] = useState(pushover.appKey);
  useEffect(() => {
    setPushoverUserKey(pushover.userKey);
    setPushoverAppKey(pushover.appKey);
  }, [pushover.userKey, pushover.appKey]);
  const pushoverKeysDirty = pushoverUserKey !== pushover.userKey || pushoverAppKey !== pushover.appKey;

  return (
    <section class={`settings-workspace ${active ? "visible" : ""}`} aria-hidden={!active}>
      <div class="settings-page">
        <header class="settings-page-header">
          <span class="settings-page-icon"><Settings size={24} /></span>
          <span>
            <h1>Settings</h1>
            <p>Configure this browser and the term-server workspace.</p>
          </span>
        </header>

        <div class="settings-grid">
          <section class="settings-card">
            <header><Sun size={16} /><h2>Appearance</h2></header>
            <p>Choose how the workspace is rendered in this browser.</p>
            <div class="theme-switch" role="group" aria-label="Color theme">
              <button class={theme === "dark" ? "active" : ""} onClick={() => onTheme("dark")}>
                <Moon size={14} /> Dark
              </button>
              <button class={theme === "light" ? "active" : ""} onClick={() => onTheme("light")}>
                <Sun size={14} /> Light
              </button>
            </div>
          </section>

          <section class="settings-card">
            <header><LayoutDashboard size={16} /><h2>Terminal behavior</h2></header>
            <p>Control terminal creation and destructive actions in this browser.</p>
            <label class={`settings-toggle ${tileNewTerminals ? "active" : ""}`}>
              <SplitSquareHorizontal size={14} />
              <span>Tile new terminals</span>
              <input
                type="checkbox"
                checked={tileNewTerminals}
                onChange={(event) => onTileNewTerminalsChange(event.currentTarget.checked)}
              />
            </label>
            <p class="settings-hint">When off, a new terminal replaces the active pane.</p>
            <label class={`settings-toggle ${confirmTerminalKills ? "active" : ""}`}>
              <Trash2 size={14} />
              <span>Confirm before killing terminals</span>
              <input
                type="checkbox"
                checked={confirmTerminalKills}
                onChange={(event) => onConfirmTerminalKillsChange(event.currentTarget.checked)}
              />
            </label>
            <p class="settings-hint">Turn this off to make every terminal kill action immediate.</p>
            <label class={`settings-toggle ${terminalPreviewSettings.enabled ? "active" : ""}`}>
              <Eye size={14} />
              <span>Live terminal hover previews</span>
              <input
                type="checkbox"
                checked={terminalPreviewSettings.enabled}
                onChange={(event) => updatePreviewSettings({
                  enabled: event.currentTarget.checked,
                })}
              />
            </label>
            <p class="settings-hint">
              Open a read-only terminal view when the pointer rests on a workspace row.
            </p>
            <fieldset class="terminal-preview-setting">
              <legend>Hover preview controls</legend>
              <span class="terminal-preview-control-label">Size</span>
              <div class="terminal-preview-mode-grid" role="radiogroup">
                {([
                  {
                    mode: "compact",
                    label: "Compact",
                    description: "A small card beside the terminal row.",
                  },
                  {
                    mode: "large",
                    label: "Large",
                    description: "A centered modal-size preview.",
                  },
                ] satisfies Array<{
                  mode: TerminalPreviewMode;
                  label: string;
                  description: string;
                }>).map(({ mode, label, description }) => (
                  <label
                    key={mode}
                    class={`terminal-preview-mode ${terminalPreviewSettings.mode === mode ? "active" : ""}`}
                  >
                    <input
                      type="radio"
                      name="terminal-preview-mode"
                      value={mode}
                      checked={terminalPreviewSettings.mode === mode}
                      onChange={() => updatePreviewSettings({ mode })}
                    />
                    <span class={`terminal-preview-mode-icon ${mode}`} aria-hidden="true">
                      <span />
                    </span>
                    <span>
                      <b>{label}</b>
                      <small>{description}</small>
                    </span>
                  </label>
                ))}
              </div>
              <div class="terminal-preview-range-grid">
                <label class="terminal-preview-range">
                  <span>
                    <b>Hover delay</b>
                    <output>
                      {terminalPreviewSettings.hoverDelay === 0
                        ? "Immediate"
                        : `${terminalPreviewSettings.hoverDelay} ms`}
                    </output>
                  </span>
                  <input
                    type="range"
                    aria-label="Hover delay"
                    min={TERMINAL_PREVIEW_LIMITS.hoverDelay.min}
                    max={TERMINAL_PREVIEW_LIMITS.hoverDelay.max}
                    step={TERMINAL_PREVIEW_LIMITS.hoverDelay.step}
                    value={terminalPreviewSettings.hoverDelay}
                    onInput={(event) => updatePreviewSettings({
                      hoverDelay: Number(event.currentTarget.value),
                    })}
                  />
                  <small>How long the pointer must stay before opening a preview.</small>
                </label>
                <label class="terminal-preview-range">
                  <span>
                    <b>Open animation</b>
                    <output>
                      {terminalPreviewSettings.animationDuration === 0
                        ? "Off"
                        : `${terminalPreviewSettings.animationDuration} ms`}
                    </output>
                  </span>
                  <input
                    type="range"
                    aria-label="Open animation duration"
                    min={TERMINAL_PREVIEW_LIMITS.animationDuration.min}
                    max={TERMINAL_PREVIEW_LIMITS.animationDuration.max}
                    step={TERMINAL_PREVIEW_LIMITS.animationDuration.step}
                    value={terminalPreviewSettings.animationDuration}
                    onInput={(event) => updatePreviewSettings({
                      animationDuration: Number(event.currentTarget.value),
                    })}
                  />
                  <small>Controls the fade-in duration; set it to zero for no animation.</small>
                </label>
              </div>
              <button
                type="button"
                class="terminal-preview-reset"
                onClick={() => onTerminalPreviewSettingsChange({
                  ...DEFAULT_TERMINAL_PREVIEW_SETTINGS,
                })}
              >
                Reset preview controls
              </button>
            </fieldset>
            <fieldset class="terminal-preview-setting">
              <legend>Kept-alive terminals</legend>
              <p class="settings-hint">
                A kept-alive terminal holds its scrollback and its connection while it is off
                screen, so switching back to it is instant and loses nothing. Beyond this many, the
                least recently used one is discarded and has to be rebuilt from the server when you
                return to it.
              </p>
              <label class="terminal-preview-range">
                <span>
                  <b>Keep alive</b>
                  <output>{describeCachedTerminals(cachedTerminals)}</output>
                </span>
                <input
                  type="range"
                  aria-label="Terminals kept alive off screen"
                  min={CACHED_TERMINALS_LIMITS.min}
                  max={CACHED_TERMINALS_LIMITS.max}
                  step={CACHED_TERMINALS_LIMITS.step}
                  value={cachedTerminals}
                  onInput={(event) => onCachedTerminalsChange(
                    clampCachedTerminals(Number(event.currentTarget.value)),
                  )}
                />
                <small>
                  This browser only, and it is this browser that pays: each one holds its own
                  scrollback in memory. Raise it freely for a workspace of quiet shells; a phone, or
                  a row of agents that have each scrolled a long way, will want it lower.
                </small>
              </label>
              {cachedTerminalsOverridden && (
                <button
                  type="button"
                  class="terminal-preview-reset"
                  onClick={() => onCachedTerminalsChange(undefined)}
                >
                  Use the server default ({describeCachedTerminals(serverCachedTerminals)})
                </button>
              )}
            </fieldset>
            <fieldset class="terminal-preview-setting">
              <legend>Terminal scrollback</legend>
              <p class="settings-hint">
                This browser keeps its own terminal history. Changing the limit recreates each
                mounted renderer without changing the terminal process or server history.
              </p>
              <label class="terminal-preview-range">
                <span>
                  <b>Scrollback lines</b>
                  <output>{scrollbackLines.toLocaleString()} lines</output>
                </span>
                <input
                  type="number"
                  aria-label="Terminal scrollback lines"
                  min={TERMINAL_SCROLLBACK_LIMITS.min}
                  max={TERMINAL_SCROLLBACK_LIMITS.max}
                  step={TERMINAL_SCROLLBACK_LIMITS.step}
                  value={scrollbackLines}
                  onInput={(event) => onScrollbackLinesChange(
                    clampTerminalScrollback(Number(event.currentTarget.value)),
                  )}
                />
                <small>
                  Resolved browser value; the server default is {serverScrollbackLines.toLocaleString()} lines.
                </small>
              </label>
              {scrollbackLinesOverridden && (
                <button
                  type="button"
                  class="terminal-preview-reset"
                  onClick={() => onScrollbackLinesChange(undefined)}
                >
                  Use the server default ({serverScrollbackLines.toLocaleString()} lines)
                </button>
              )}
            </fieldset>
          </section>

          <section class="settings-card">
            <header><Gauge size={16} /><h2>Status bar limits</h2></header>
            <p>Show AI provider limit modules in the bottom status bar.</p>
            <label class={`settings-toggle ${statusModules.enabled ? "active" : ""}`}>
              <Gauge size={14} />
              <span>Show limits in the status bar</span>
              <input
                type="checkbox"
                checked={statusModules.enabled}
                onChange={(event) => onStatusModulesChange({ enabled: event.currentTarget.checked })}
              />
            </label>
            <p class="settings-hint">
              Provider credentials are detected automatically on the server from ~/.claude, ~/.codex,
              ~/.pi, and ~/.omp; environment variables take precedence. Providers without credentials
              stay hidden.
            </p>
            <label class={`settings-toggle ${statusModules.showOnMobile ? "active" : ""}`}>
              <Smartphone size={14} />
              <span>Also show on mobile</span>
              <input
                type="checkbox"
                checked={statusModules.showOnMobile}
                onChange={(event) => onStatusModulesChange({ showOnMobile: event.currentTarget.checked })}
              />
            </label>
            <p class="settings-hint">Small screens hide the limit modules unless this is on.</p>
          </section>

          <section class="settings-card settings-card-wide">
            <header><PackageOpen size={16} /><h2>Artifact skill</h2></header>
            <p>
              Use term-server&apos;s bundled artifact skill as the source of truth for every agent.
              Managed links automatically follow term-server updates.
            </p>
            <div class="agent-integration-list">
              {artifactSkill.providers.map((skill) => {
                const busy = updatingArtifactSkill === skill.provider;
                const unavailable = skill.state === "unavailable";
                const installed = skill.state === "installed";
                return (
                  <div class="agent-integration" key={skill.provider}>
                    <span
                      class={`agent-integration-state ${skill.state}`}
                      aria-hidden="true"
                    />
                    <span class="agent-integration-copy">
                      <b>{skill.name}</b>
                      <small>{skill.message}</small>
                    </span>
                    <span class="agent-integration-actions">
                      {skill.state === "notInstalled" ? (
                        <button
                          class="settings-update-action primary"
                          disabled={busy}
                          onClick={() => onArtifactSkill(skill.provider, "install")}
                        >
                          {busy && <LoaderCircle class="spin" size={13} />}
                          {busy ? "Installing…" : "Install"}
                        </button>
                      ) : unavailable ? (
                        <button class="settings-update-action" disabled>Unavailable</button>
                      ) : installed ? (
                        <button
                          class="settings-update-action danger"
                          disabled={busy}
                          onClick={() => onArtifactSkill(skill.provider, "remove")}
                        >
                          {busy && <LoaderCircle class="spin" size={13} />}
                          {busy ? "Removing…" : "Remove"}
                        </button>
                      ) : !skill.repairable ? (
                        <button class="settings-update-action" disabled>Move aside manually</button>
                      ) : (
                        <button
                          class="settings-update-action primary"
                          disabled={busy}
                          onClick={() => onArtifactSkill(skill.provider, "repair")}
                        >
                          {busy && <LoaderCircle class="spin" size={13} />}
                          {busy ? "Working…" : "Use bundled skill"}
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <p class="settings-hint">
              {artifactSkill.available
                ? `Bundled with term-server ${build.version}. Agent changes apply to new sessions.`
                : artifactSkill.message
                  ?? "The bundled skill is unavailable in this development or custom installation."}
            </p>
          </section>

          <section class="settings-card settings-card-wide">
            <header><Bell size={16} /><h2>Completion notifications</h2></header>
            <p>Choose how agent and long-running command completion alerts behave in this browser.</p>
            <div class="notification-mode-grid" role="radiogroup" aria-label="Completion notification delivery">
              {notificationModes.map(({ mode, label, description, Icon }) => (
                <label key={mode} class={`notification-mode ${notificationMode === mode ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="notification-mode"
                    value={mode}
                    checked={notificationMode === mode}
                    onChange={() => onNotificationModeChange(mode)}
                  />
                  <Icon size={17} />
                  <span>
                    <b>{label}</b>
                    <small>{description}</small>
                  </span>
                </label>
              ))}
            </div>
            <div class="notification-preferences">
              <fieldset class="notification-preference">
                <legend>In-app position</legend>
                <div class="notification-position-grid">
                  {notificationPositions.map(({ position, label }) => (
                    <label
                      key={position}
                      class={`notification-position ${notificationPosition === position ? "active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="notification-position"
                        value={position}
                        checked={notificationPosition === position}
                        onChange={() => onNotificationPositionChange(position)}
                      />
                      <span class={`notification-position-preview ${position}`} aria-hidden="true" />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset class="notification-preference">
                <legend>Auto-dismiss</legend>
                <div class="notification-duration-grid">
                  {notificationDurations.map(({ duration, label }) => (
                    <label
                      key={duration}
                      class={`notification-duration ${notificationDuration === duration ? "active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="notification-duration"
                        value={duration}
                        checked={notificationDuration === duration}
                        onChange={() => onNotificationDurationChange(duration)}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <p class="settings-hint">
              Desktop permission: <strong>{systemPermission}</strong>. Placement and timing apply to in-app cards and
              desktop fallbacks.
            </p>
          </section>

          <section class="settings-card settings-card-wide">
            <header><Activity size={16} /><h2>Live agent activity</h2></header>
            <p>
              Add private native lifecycle events and retained semantic agent history without
              replacing provider hooks or term-server&apos;s process, output, CPU, and terminal-signal
              inference. For OMP, Install, Repair, and Remove apply to every discovered profile.
            </p>
            <div class="agent-integration-list">
              {agentIntegrations.providers.map((integration) => {
                const busy = updatingAgentIntegration === integration.provider;
                const unavailable = integration.state === "unavailable";
                const primaryAction = agentIntegrationActionFor(integration);
                const noProfiles =
                  integration.provider === "omp" && integration.profiles?.length === 0;
                const profileSummary = agentIntegrationProfileSummary(integration.profiles);
                return (
                  <div class="agent-integration" key={integration.provider}>
                    <span
                      class={`agent-integration-state ${integration.state}`}
                      aria-hidden="true"
                    />
                    <span class="agent-integration-copy">
                      <b>{integration.name}</b>
                      <small>{integration.message}</small>
                      {profileSummary && (
                        <small class="agent-integration-profile-summary">{profileSummary}</small>
                      )}
                      {integration.profiles && integration.profiles.length > 0 && (
                        <span class="agent-integration-profiles" aria-label={`${integration.name} profile status`}>
                          {integration.profiles.map((profile) => (
                            <span class="agent-integration-profile" key={profile.id}>
                              <span
                                class={`agent-integration-state ${profile.state}`}
                                aria-hidden="true"
                              />
                              <span>
                                <b>{profile.label}</b>
                                <small>{profile.message}</small>
                              </span>
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    <span class="agent-integration-actions">
                      {unavailable ? (
                        <button class="settings-update-action" disabled>Unavailable</button>
                      ) : noProfiles ? (
                        <button class="settings-update-action" disabled>No profiles</button>
                      ) : (
                        <>
                          <button
                            class={`settings-update-action ${primaryAction === "install" ? "primary" : ""}`}
                            disabled={busy}
                            onClick={() => onAgentIntegration(
                              integration.provider,
                              primaryAction ?? "repair",
                            )}
                          >
                            {busy && <LoaderCircle class="spin" size={13} />}
                            {busy
                              ? primaryAction === "install" ? "Installing…" : "Working…"
                              : primaryAction === "install" ? "Install" : "Repair"}
                          </button>
                          <button
                            class="settings-update-action danger"
                            disabled={busy}
                            onClick={() => onAgentIntegration(integration.provider, "remove")}
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <p class="settings-hint">
              {agentIntegrations.fallbacksEnabled
                ? "Fallback detection stays enabled before, during, and after native package changes."
                : "Native packages are optional."}
              {" "}Package changes apply to new agent sessions.
            </p>
          </section>

          <section class="settings-card">
            <header><Sparkles size={16} /><h2>Agent metadata</h2></header>
            <p>Use Pi to generate concise labels from bounded terminal context.</p>
            <label class={`settings-toggle ${pi.titlesEnabled ? "active" : ""} ${pi.available ? "" : "disabled"}`}>
              <Sparkles size={14} />
              <span>Pi-generated titles</span>
              <input
                type="checkbox"
                checked={pi.titlesEnabled}
                disabled={!pi.available}
                onChange={(event) => onPiChange(
                  event.currentTarget.checked,
                  pi.summariesEnabled,
                  pi.model,
                )}
              />
            </label>
            <label class={`settings-toggle ${pi.summariesEnabled ? "active" : ""} ${pi.available ? "" : "disabled"}`}>
              <MessageSquareText size={14} />
              <span>Pi notification summaries</span>
              <input
                type="checkbox"
                checked={pi.summariesEnabled}
                disabled={!pi.available}
                onChange={(event) => onPiChange(
                  pi.titlesEnabled,
                  event.currentTarget.checked,
                  pi.model,
                )}
              />
            </label>
            {pi.available ? (
              <label class="pi-model-field">
                <span>Pi model</span>
                <select
                  value={pi.model}
                  disabled={!pi.titlesEnabled && !pi.summariesEnabled}
                  onChange={(event) => onPiChange(
                    pi.titlesEnabled,
                    pi.summariesEnabled,
                    event.currentTarget.value,
                  )}
                >
                  <option value="">Pi configured default</option>
                  {pi.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
              </label>
            ) : (
              <p class="settings-hint">Pi is unavailable. Install it for this user, then restart term-server.</p>
            )}
          </section>

          <section class="settings-card">
            <header><Download size={16} /><h2>Updates</h2></header>
            <p>Install releases authenticated by the embedded signing key.</p>
            <div class="settings-update">
              <div class="settings-update-version">
                <span>term-server v{build.version}</span>
                <code title={build.commit}>{build.commit.slice(0, 12)}</code>
              </div>
              <label class={`settings-toggle ${updateConfig.channel === "beta" ? "active" : ""}`}>
                {updatingUpdateChannel
                  ? <LoaderCircle class="spin" size={14} />
                  : <Sparkles size={14} />}
                <span>Receive beta releases</span>
                <input
                  type="checkbox"
                  checked={updateConfig.channel === "beta"}
                  disabled={!rollingUpdateChannel || updatingUpdateChannel || checkingForUpdate || installingUpdate}
                  onChange={(event) => onUpdateChannelChange(
                    event.currentTarget.checked ? "beta" : "main",
                  )}
                />
              </label>
              <p class="settings-hint">
                {!rollingUpdateChannel
                  ? `Pinned channel: ${updateConfig.channel}.`
                  : updateConfig.channel === "beta"
                    ? "Beta follows dev and may contain changes that have not reached main."
                    : "Main follows the current release branch."}
              </p>
              {broker?.restartRequired && (
                <div class="settings-broker-warning">
                  <div class="settings-broker-warning-title">
                    <TriangleAlert size={15} />
                    <span>
                      <strong>Older session brokers still active</strong>
                      <small>
                        {outdatedBrokers.map((generation) => (
                          `v${generation.version} · ${generation.commit.slice(0, 12)}`
                        )).join(", ")}
                      </small>
                    </span>
                  </div>
                  <p>
                    New terminals use v{broker.version}. Existing terminals stay on their original
                    broker until they close.
                  </p>
                  {outdatedBrokers.length > 0 && (
                    <p class="settings-broker-terminal-warning">
                      Restarting now will close all {broker.sessions} open terminal{broker.sessions === 1 ? "" : "s"}.
                    </p>
                  )}
                  <button
                    class="settings-update-action broker-restart"
                    onClick={onRestartBroker}
                    disabled={restartingBroker}
                  >
                    <RefreshCw class={restartingBroker ? "spin" : ""} size={14} />
                    {restartingBroker ? "Restarting…" : "Restart all session brokers"}
                  </button>
                </div>
              )}
              {updateStatus?.state === "available" && updateStatus.latest ? (
                <>
                  <p class="settings-update-available">
                    v{updateStatus.latest.version} is available
                    <code title={updateStatus.latest.commit}>
                      {updateStatus.latest.commit.slice(0, 12)}
                    </code>
                  </p>
                  <button
                    class="settings-update-action primary"
                    onClick={onInstallUpdate}
                    disabled={installingUpdate}
                  >
                    {installingUpdate
                      ? <LoaderCircle class="spin" size={14} />
                      : <Download size={14} />}
                    {installingUpdate ? "Installing…" : "Install and reconnect"}
                  </button>
                </>
              ) : (
                <button
                  class="settings-update-action"
                  onClick={onCheckForUpdate}
                  disabled={!updateConfig.enabled || checkingForUpdate}
                >
                  <RefreshCw class={checkingForUpdate ? "spin" : ""} size={14} />
                  {checkingForUpdate
                    ? "Checking…"
                    : updateStatus?.state === "current"
                      ? "Up to date · Check again"
                      : "Check for updates"}
                </button>
              )}
              {!updateConfig.enabled && (
                <p class="settings-hint">{updateConfig.reason ?? "Automatic updates are unavailable."}</p>
              )}
              {updateConfig.enabled && (
                <p class="settings-hint">
                  Running terminals stay active while the server reconnects.
                </p>
              )}
            </div>
          </section>

          <section class="settings-card settings-card-wide">
            <header><Video size={16} /><h2>Debug recording</h2></header>
            <p>
              Capture everything needed to debug terminal rendering problems. If a
              terminal starts rendering the wrong text, start a recording, reproduce
              the issue, then stop and download the trace. Recording is off by
              default and only captures while active, so it has no steady-state cost.
            </p>
            <div class="debug-recording-status">
              <span
                class={`debug-recording-dot ${recording?.active ? "active" : ""}`}
                aria-hidden="true"
              />
              <span>
                <b>{recording?.active ? "Recording" : "Not recording"}</b>
                {recording?.active && recording.startedAt != null
                  ? <small>Started {formatDebugDuration(recording.startedAt, null)} ago</small>
                  : recording?.startedAt != null && recording.stoppedAt != null
                    ? <small>Ran for {formatDebugDuration(recording.startedAt, recording.stoppedAt)}</small>
                    : <small>No recording captured yet</small>}
              </span>
            </div>
            {(recording && (recording.events > 0 || recording.active)) && (
              <p class="settings-hint">
                Server: {recording.events} events · {formatDebugBytes(recording.bytes)}
                {recording.truncated ? " · truncated" : ""}.
                Browser: {frontendRecordingEvents} events.
              </p>
            )}
            <div class="debug-recording-actions">
              {recording?.active ? (
                <button
                  class="settings-update-action danger"
                  onClick={onRecordingStop}
                  disabled={recordingBusy}
                >
                  <Square size={14} /> Stop recording
                </button>
              ) : (
                <button
                  class="settings-update-action primary"
                  onClick={onRecordingStart}
                  disabled={recordingBusy}
                >
                  <Video size={14} /> Start recording
                </button>
              )}
              {recording && (recording.events > 0 || recording.active) && (
                <button
                  class="settings-update-action"
                  onClick={onRecordingDownload}
                  disabled={recordingBusy}
                >
                  <Download size={14} /> Download recording
                </button>
              )}
              {recording && !recording.active && recording.events > 0 && (
                <button
                  class="settings-update-action danger"
                  onClick={onRecordingClear}
                  disabled={recordingBusy}
                >
                  <Trash2 size={14} /> Discard
                </button>
              )}
            </div>
            <p class="settings-hint">
              The download is a single JSON file combining the server-side and
              browser-side traces, so the exact bytes sent and what the terminal
              rendered can be compared side by side.
            </p>
          </section>

          <section class="settings-card settings-card-wide">
            <header><Bell size={16} /><h2>Pushover notifications</h2></header>
            <p>
              Get a mobile push notification when an agent finishes. Configure the
              Pushover user and application keys, then choose how much to be told.
            </p>
            <label class="pushover-field">
              <span>User key</span>
              <input
                type="text"
                value={pushoverUserKey}
                onInput={(event) => setPushoverUserKey(event.currentTarget.value)}
                placeholder="Pushover user key"
                autocomplete="off"
                spellcheck={false}
              />
            </label>
            <label class="pushover-field">
              <span>Application key</span>
              <input
                type="password"
                value={pushoverAppKey}
                onInput={(event) => setPushoverAppKey(event.currentTarget.value)}
                placeholder="Pushover application key"
                autocomplete="off"
                spellcheck={false}
              />
            </label>
            <button
              class="settings-update-action primary"
              onClick={() => onPushoverChange({ userKey: pushoverUserKey, appKey: pushoverAppKey })}
              disabled={!pushoverKeysDirty}
            >
              Save keys
            </button>
            <div class="pushover-mode-grid" role="radiogroup" aria-label="Pushover notification scope">
              {([
                {
                  mode: "off" as const,
                  label: "Off",
                  description: "Do not send Pushover alerts.",
                },
                {
                  mode: "select" as const,
                  label: "Select",
                  description: "Notify only for terminals you turn on in the sidebar.",
                },
                {
                  mode: "all" as const,
                  label: "All",
                  description: "Notify for every terminal; turn specific ones off in the sidebar.",
                },
              ] satisfies Array<{ mode: PushoverMode; label: string; description: string }>).map(({ mode, label, description }) => (
                <label key={mode} class={`pushover-mode ${pushover.mode === mode ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="pushover-mode"
                    value={mode}
                    checked={pushover.mode === mode}
                    onChange={() => onPushoverChange({ mode })}
                  />
                  <span>
                    <b>{label}</b>
                    <small>{description}</small>
                  </span>
                </label>
              ))}
            </div>
            <p class="settings-hint">
              {pushover.configured
                ? "Keys are saved. When enabled, alerts include the host, agent, directory, and terminal title."
                : "Add your Pushover keys and choose a scope to begin receiving alerts."}
            </p>
          </section>

          <section class="settings-card">
            <header><Shield size={16} /><h2>Security</h2></header>
            <p>Manage access to this terminal server.</p>
            <ChangePassword
              managedExternally={passwordManagedExternally}
              onChanged={onPasswordChanged}
            />
            <button class="settings-logout" onClick={onLogout}><LogOut size={14} /> Sign out</button>
          </section>
        </div>
      </div>
    </section>
  );
}
