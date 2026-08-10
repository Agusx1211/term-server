import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { lazy, Suspense } from "preact/compat";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Menu,
  Plus,
  ShieldCheck,
  X,
} from "lucide-preact";
import type {
  AgentIntegrationAction,
  AgentIntegrationProvider,
  ArtifactSkillAction,
  AgentInfo,
  ArtifactEntry,
  ClientConfig,
  DebugRecordingExport,
  DebugRecordingStatus,
  FileEntry,
  FileTarget,
  PushoverMode,
  ReleaseInfo,
  TerminalInfo,
  UpdateActivityView,
  UpdateStatus,
} from "../shared/types";
import { api, ApiError } from "./lib/api";
import { withBrokerSessions } from "./lib/broker-generations";
import { buildPushoverMessage, pushoverBellEnabled } from "./lib/pushover";
import {
  debugRecordingEventCount,
  debugRecordingTruncated,
  isDebugRecordingActive,
  resetDebugRecording,
  startDebugRecording,
  stopDebugRecording,
  takeFrontendRecording,
} from "./lib/debug-recording";
import { installE2EDiagnostics } from "./lib/e2e-diagnostics";
import {
  agentNeedsAttention,
  parseViewedAgentRevisions,
  VIEWED_AGENT_REVISIONS_STORAGE_KEY,
} from "./lib/agent-attention";
import {
  commandCompletionEvent,
  commandNeedsAttention,
  parseViewedCommandCompletions,
  VIEWED_COMMAND_COMPLETIONS_STORAGE_KEY,
} from "./lib/command-status";
import {
  activityView,
  currentActivityViewUpdate,
  legacyActivityViewUpdate,
  mergeTerminalActivityViews,
  withActivityView,
} from "./lib/activity-view";
import { documentTitle } from "./lib/document-title";
import {
  CONFIRM_TERMINAL_KILLS_STORAGE_KEY,
  parseConfirmTerminalKills,
  terminalKillAllowed,
} from "./lib/terminal-kill";
import { installVisualViewportCssVars } from "./lib/visual-viewport";
import {
  agentNotificationEvent,
  includesInAppNotifications,
  includesSystemNotifications,
  LEGACY_NOTIFICATIONS_STORAGE_KEY,
  NOTIFICATION_DURATION_STORAGE_KEY,
  NOTIFICATION_MODE_STORAGE_KEY,
  NOTIFICATION_POSITION_STORAGE_KEY,
  parseNotificationDuration,
  parseNotificationMode,
  parseNotificationPosition,
  type NotificationDuration,
  type NotificationMode,
  type NotificationPosition,
} from "./lib/notifications";
import {
  clampTerminalFontSize,
  parseTerminalFontSize,
  TERMINAL_FONT_SIZE_STORAGE_KEY,
} from "./lib/terminal-zoom";
import {
  parseTerminalPreviewSettings,
  TERMINAL_PREVIEW_MODE_STORAGE_KEY,
  TERMINAL_PREVIEW_SETTINGS_STORAGE_KEY,
  type TerminalPreviewSettings,
} from "./lib/terminal-preview";
import {
  CACHED_TERMINALS_STORAGE_KEY,
  parseCachedTerminals,
  resolveCachedTerminals,
} from "./lib/cached-terminals";
import {
  parseTerminalScrollback,
  resolveTerminalScrollback,
  TERMINAL_SCROLLBACK_STORAGE_KEY,
} from "./lib/terminal-scrollback";
import {
  artifactCountsBySession,
  artifactOwnerLabel,
  discoverArtifacts,
  reconcileArtifactResources,
  removeArtifactResources,
  resourceForArtifact,
  sortArtifactsNewestFirst,
  stableArtifactInventory,
  type ArtifactDeleteTarget,
} from "./lib/artifacts";
import {
  arrangeLayout,
  clampSplitRatio,
  isPaneLayout,
  dividerRatioAtPoint,
  layoutFromIds,
  paneIds as idsFromLayout,
  paneLeaf,
  paneRects,
  placeNewTerminal,
  pruneLayout,
  reconcileMounted,
  removePane,
  removePaneAndSelect,
  splitDividerAt,
  splitDividers,
  TERMINAL_DRAG_TYPE,
  updateSplitRatio,
  type DropPosition,
  type PaneLayout,
  type PanePath,
} from "./lib/layout";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { SettingsWorkspace } from "./components/SettingsWorkspace";
import { StatusModules } from "./components/StatusModules";
import { TermServerLogo } from "./components/TermServerLogo";
import { WelcomeSection } from "./components/WelcomeSection";
import { ResourceTabBar } from "./components/ResourceTabs";
import type { ResourceTab } from "./lib/resources";
import type { TerminalStreamIssue } from "./lib/terminal-stream";
import type { ThemeName } from "./lib/terminal-theme";

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((module) => ({ default: module.TerminalPane })),
);
const ResourceDocuments = lazy(() => import("./components/ResourceWorkspace"));

const defaultConfig: ClientConfig = {
  scrollbackLines: 200_000,
  maxPanes: 4,
  cachedTerminals: 6,
  secure: true,
  hostname: "",
  passwordManagedExternally: true,
  pi: {
    available: false,
    enabled: false,
    titlesEnabled: false,
    summariesEnabled: false,
    model: "",
    models: [],
  },
  agentIntegrations: {
    providers: [],
    fallbacksEnabled: true,
  },
  artifactSkill: {
    available: false,
    source: null,
    message: null,
    providers: [],
  },
  pushover: {
    configured: false,
    userKey: "",
    appKey: "",
    mode: "off",
    enabled: false,
  },
  build: {
    version: "unknown",
    commit: "unknown",
  },
  broker: null,
  updates: {
    enabled: false,
    channel: "main",
    reason: null,
  },
};
const dropPositions: DropPosition[] = ["left", "top", "center", "bottom", "right"];
const TILE_NEW_TERMINALS_STORAGE_KEY = "term-server:tile-new-terminals";

interface CompletionToast {
  id: string;
  terminalId: string;
  title: string;
  body: string;
  color: string;
}

function deliverCompletionNotification({
  mode,
  toast,
  tag,
  showToast,
  onOpen,
}: {
  mode: NotificationMode;
  toast: CompletionToast;
  tag: string;
  showToast: (toast: CompletionToast) => void;
  onOpen: () => void;
}) {
  const showFallback = () => {
    if (!includesInAppNotifications(mode)) showToast(toast);
  };

  if (includesInAppNotifications(mode)) showToast(toast);
  if (!includesSystemNotifications(mode)) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    showFallback();
    return;
  }
  try {
    const notification = new Notification(toast.title, { body: toast.body, tag });
    notification.onerror = showFallback;
    notification.onclick = () => {
      window.focus();
      onOpen();
      notification.close();
    };
  } catch {
    showFallback();
  }
}

const initialTheme = (): ThemeName => {
  const stored = localStorage.getItem("term-server:theme");
  if (stored === "dark" || stored === "light") return stored;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

const initialPanes = (): string[] => {
  try {
    const value = JSON.parse(sessionStorage.getItem("term-server:panes") ?? "[]");
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch {
    return [];
  }
};

const initialPaneLayout = (): PaneLayout | null => {
  try {
    const stored = JSON.parse(sessionStorage.getItem("term-server:layout") ?? "null") as unknown;
    if (isPaneLayout(stored)) return stored;
  } catch {
    // Fall back to the previous flat pane state.
  }
  return layoutFromIds(initialPanes());
};

const initialNotificationMode = () => parseNotificationMode(
  localStorage.getItem(NOTIFICATION_MODE_STORAGE_KEY),
  localStorage.getItem(LEGACY_NOTIFICATIONS_STORAGE_KEY),
);

const initialNotificationPosition = () => parseNotificationPosition(
  localStorage.getItem(NOTIFICATION_POSITION_STORAGE_KEY),
);

const initialNotificationDuration = () => parseNotificationDuration(
  localStorage.getItem(NOTIFICATION_DURATION_STORAGE_KEY),
);

const initialTileNewTerminals = () =>
  localStorage.getItem(TILE_NEW_TERMINALS_STORAGE_KEY) === "true";

const initialConfirmTerminalKills = () =>
  parseConfirmTerminalKills(localStorage.getItem(CONFIRM_TERMINAL_KILLS_STORAGE_KEY));

const initialTerminalFontSize = () =>
  parseTerminalFontSize(localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY));

const initialTerminalPreviewSettings = () =>
  parseTerminalPreviewSettings(
    localStorage.getItem(TERMINAL_PREVIEW_SETTINGS_STORAGE_KEY),
    localStorage.getItem(TERMINAL_PREVIEW_MODE_STORAGE_KEY),
  );

const initialCachedTerminals = () =>
  parseCachedTerminals(localStorage.getItem(CACHED_TERMINALS_STORAGE_KEY));

const initialTerminalScrollback = () =>
  parseTerminalScrollback(localStorage.getItem(TERMINAL_SCROLLBACK_STORAGE_KEY));

const initialViewedAgentRevisions = () =>
  parseViewedAgentRevisions(localStorage.getItem(VIEWED_AGENT_REVISIONS_STORAGE_KEY));

const initialViewedCommandCompletions = () =>
  parseViewedCommandCompletions(
    localStorage.getItem(VIEWED_COMMAND_COMPLETIONS_STORAGE_KEY),
  );

export function App() {
  useEffect(() => {
    installE2EDiagnostics();
  }, []);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [config, setConfig] = useState(defaultConfig);
  const [layout, setLayout] = useState<PaneLayout | null>(initialPaneLayout);
  const [mountedIds, setMountedIds] = useState<string[]>(initialPanes);
  const [activeId, setActiveId] = useState<string>();
  const [draggedId, setDraggedId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ id: string; position: DropPosition }>();
  const [theme, setTheme] = useState<ThemeName>(initialTheme);
  const [creating, setCreating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [checkingForUpdate, setCheckingForUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [restartingBroker, setRestartingBroker] = useState(false);
  const [updatingAgentIntegration, setUpdatingAgentIntegration] =
    useState<AgentIntegrationProvider>();
  const [updatingArtifactSkill, setUpdatingArtifactSkill] =
    useState<AgentIntegrationProvider>();
  const [restartingForUpdate, setRestartingForUpdate] = useState<ReleaseInfo>();
  const [notice, setNotice] = useState("");
  const [completionToasts, setCompletionToasts] = useState<CompletionToast[]>([]);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [notificationMode, setNotificationMode] = useState(initialNotificationMode);
  const [notificationPosition, setNotificationPosition] = useState(initialNotificationPosition);
  const [notificationDuration, setNotificationDuration] = useState(initialNotificationDuration);
  const [tileNewTerminals, setTileNewTerminals] = useState(initialTileNewTerminals);
  const [confirmTerminalKills, setConfirmTerminalKills] = useState(initialConfirmTerminalKills);
  const [terminalFontSize, setTerminalFontSize] = useState(initialTerminalFontSize);
  const [terminalPreviewSettings, setTerminalPreviewSettings] =
    useState(initialTerminalPreviewSettings);
  const [scrollbackLinesOverride, setScrollbackLinesOverride] = useState(initialTerminalScrollback);
  const [cachedTerminalsOverride, setCachedTerminalsOverride] = useState(initialCachedTerminals);
  const [terminalStreamIssues, setTerminalStreamIssues] =
    useState(new Map<string, TerminalStreamIssue>());
  const [recordingStatus, setRecordingStatus] = useState<DebugRecordingStatus | null>(null);
  const [frontendRecordingEvents, setFrontendRecordingEvents] = useState(0);
  const [statusModulesMobileVisible, setStatusModulesMobileVisible] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const legacyViewedAgentRevisions = useRef(initialViewedAgentRevisions());
  const legacyViewedCommandCompletions = useRef(initialViewedCommandCompletions());
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [resources, setResources] = useState<ResourceTab[]>([]);
  const [activeResource, setActiveResource] = useState<string>();
  const knownArtifactIds = useRef(new Set<string>());
  const artifactsInitialized = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsActive, setSettingsActive] = useState(false);
  const agentIntegrationsRequested = useRef(false);
  const agentEventsInitialized = useRef(false);
  const deliveredAgentEvents = useRef(new Map<string, number>());
  const commandEventsInitialized = useRef(false);
  const deliveredCommandEvents = useRef(new Map<string, number>());
  const pendingAgentNotifications = useRef(new Map<string, { event: number; timer: number }>());
  const pendingActivityViews = useRef(new Map<string, UpdateActivityView>());
  const completionToastTimers = useRef(new Map<string, number>());
  const notificationModeRef = useRef(notificationMode);
  notificationModeRef.current = notificationMode;
  const notificationDurationRef = useRef(notificationDuration);
  notificationDurationRef.current = notificationDuration;
  const mobileMenuButton = useRef<HTMLButtonElement>(null);
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  const configRef = useRef(config);
  configRef.current = config;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const editorGridRef = useRef<HTMLElement>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const dividerDragRef = useRef<{
    pointerId: number;
    path: PanePath;
    handle: HTMLElement;
  }>();
  const paneIds = useMemo(() => idsFromLayout(layout), [layout]);

  useEffect(() => installVisualViewportCssVars(), []);
  useEffect(() => {
    const finish = (event?: PointerEvent) => {
      const active = dividerDragRef.current;
      if (!active || (event && event.pointerId !== active.pointerId)) return;
      if (active.handle.hasPointerCapture(active.pointerId)) {
        active.handle.releasePointerCapture(active.pointerId);
      }
      dividerDragRef.current = undefined;
      document.body.classList.remove("pane-resizing");
    };

    const move = (event: PointerEvent) => {
      const active = dividerDragRef.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const currentLayout = layoutRef.current;
      const divider = splitDividerAt(currentLayout, active.path);
      const viewport = editorGridRef.current?.getBoundingClientRect();
      if (!divider || !viewport || viewport.width <= 0 || viewport.height <= 0) return;
      const ratio = dividerRatioAtPoint(divider, viewport, event.clientX, event.clientY);
      setLayout((current) => updateSplitRatio(current, active.path, ratio));
      event.preventDefault();
    };

    const cancel = () => finish();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", cancel);
    return () => {
      finish();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? "" : current)), 2400);
  };

  const updateTerminalStreamIssue = (id: string, issue?: TerminalStreamIssue) => {
    setTerminalStreamIssues((current) => {
      const previous = current.get(id);
      if (
        previous?.kind === issue?.kind
        && previous?.pendingBytes === issue?.pendingBytes
      ) return current;
      if (!issue && !previous) return current;
      const next = new Map(current);
      if (issue) next.set(id, issue);
      else next.delete(id);
      return next;
    });
  };

  const updateTerminalFontSize = (value: number) => {
    const next = clampTerminalFontSize(value);
    localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, String(next));
    setTerminalFontSize(next);
  };

  const syncArtifacts = (
    nextArtifacts: ArtifactEntry[],
    focusedSession = activeIdRef.current,
    artifactTerminals = terminalsRef.current,
  ) => {
    const ordered = sortArtifactsNewestFirst(nextArtifacts);
    const discovered = discoverArtifacts(knownArtifactIds.current, ordered);
    const initialized = artifactsInitialized.current;
    artifactsInitialized.current = true;

    setArtifacts((current) => stableArtifactInventory(current, ordered));
    setResources((current) => reconcileArtifactResources(current, ordered, artifactTerminals));

    if (!initialized || !discovered.length) return;
    const announced = discovered.find((artifact) => artifact.sessionId === focusedSession)
      ?? sortArtifactsNewestFirst(discovered)[0];
    if (!announced) return;
    const owner = artifactTerminals.find((terminal) => terminal.id === announced.sessionId);
    showNotice(`Artifact ready from ${artifactOwnerLabel(owner, announced.producer)}: ${announced.name}`);
  };

  const checkForUpdates = async (notify = false) => {
    setCheckingForUpdate(true);
    try {
      const status = await api.updateStatus();
      setUpdateStatus(status);
      if (notify) {
        showNotice(
          status.state === "available" && status.latest
            ? `term-server v${status.latest.version} is available`
            : status.state === "current"
              ? "term-server is up to date"
              : "Automatic updates are unavailable for this installation",
        );
      }
    } catch (error) {
      if (notify) {
        showNotice(error instanceof Error ? error.message : "Unable to check for updates");
      }
    } finally {
      setCheckingForUpdate(false);
    }
  };

  const dismissCompletionToast = (id: string) => {
    const timer = completionToastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    completionToastTimers.current.delete(id);
    setCompletionToasts((current) => current.filter((toast) => toast.id !== id));
  };

  const showCompletionToast = (toast: CompletionToast) => {
    const existingTimer = completionToastTimers.current.get(toast.id);
    if (existingTimer) clearTimeout(existingTimer);
    setCompletionToasts((current) => (
      [...current.filter((item) => item.id !== toast.id), toast].slice(-3)
    ));
    const duration = notificationDurationRef.current;
    if (duration === 0) {
      completionToastTimers.current.delete(toast.id);
      return;
    }
    const timer = window.setTimeout(() => dismissCompletionToast(toast.id), duration);
    completionToastTimers.current.set(toast.id, timer);
  };

  const migrateLegacyActivityViews = async (
    nextTerminals: TerminalInfo[],
  ): Promise<TerminalInfo[]> => {
    let failed = false;
    const migrated = await Promise.all(nextTerminals.map(async (terminal) => {
      const update = legacyActivityViewUpdate(
        terminal,
        legacyViewedAgentRevisions.current,
        legacyViewedCommandCompletions.current,
      );
      if (!update) return terminal;
      try {
        const viewed = await api.updateTerminalActivityView(terminal.id, update);
        return withActivityView(terminal, viewed);
      } catch {
        failed = true;
        return terminal;
      }
    }));
    if (!failed) {
      localStorage.removeItem(VIEWED_AGENT_REVISIONS_STORAGE_KEY);
      localStorage.removeItem(VIEWED_COMMAND_COMPLETIONS_STORAGE_KEY);
      legacyViewedAgentRevisions.current = {};
      legacyViewedCommandCompletions.current = {};
    }
    return migrated;
  };

  const loadWorkspace = async () => {
    try {
      const [nextConfig, nextTerminals, artifacts] = await Promise.all([
        api.config(),
        api.terminals(),
        api.artifacts(),
      ]);
      const workspaceTerminals = await migrateLegacyActivityViews(nextTerminals);
      const focusedSession = activeIdRef.current
        && workspaceTerminals.some((terminal) => terminal.id === activeIdRef.current)
        ? activeIdRef.current
        : workspaceTerminals[0]?.id;
      setConfig({
        ...nextConfig,
        broker: nextConfig.broker
          ? withBrokerSessions(nextConfig.broker, workspaceTerminals)
          : null,
      });
      setTerminals(workspaceTerminals);
      setWorkspaceLoaded(true);
      setLayout((current) => {
        const available = new Set(workspaceTerminals.map((terminal) => terminal.id));
        const kept = pruneLayout(current, available);
        return kept ?? (workspaceTerminals[0] ? paneLeaf(workspaceTerminals[0].id) : null);
      });
      setActiveId((current) =>
        current && workspaceTerminals.some((terminal) => terminal.id === current)
          ? current
          : workspaceTerminals[0]?.id,
      );
      syncArtifacts(artifacts, focusedSession, workspaceTerminals);
      setAuthenticated(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAuthenticated(false);
      else showNotice(error instanceof Error ? error.message : "Unable to load workspace");
    }
  };

  useEffect(() => {
    void api
      .session()
      .then(({ authenticated: active }) => {
        setAuthenticated(active);
        if (active) void loadWorkspace();
      })
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (!authenticated || !settingsActive || agentIntegrationsRequested.current) return;
    agentIntegrationsRequested.current = true;
    void api
      .agentIntegrations()
      .then((agentIntegrations) => {
        setConfig((current) => ({ ...current, agentIntegrations }));
      })
      .catch((error) => {
        agentIntegrationsRequested.current = false;
        showNotice(error instanceof Error ? error.message : "Unable to inspect agent integrations");
      });
  }, [authenticated, settingsActive]);

  useEffect(() => {
    if (!authenticated || !config.updates?.enabled) return;
    void checkForUpdates();
    const timer = window.setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [authenticated, config.updates?.enabled, config.updates?.channel]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("term-server:theme", theme);
  }, [theme]);

  useEffect(() => {
    document.title = documentTitle(terminals);
  }, [terminals]);

  useEffect(() => {
    localStorage.setItem(NOTIFICATION_MODE_STORAGE_KEY, notificationMode);
    localStorage.setItem(
      LEGACY_NOTIFICATIONS_STORAGE_KEY,
      String(includesSystemNotifications(notificationMode)),
    );
  }, [notificationMode]);

  useEffect(() => {
    localStorage.setItem(NOTIFICATION_POSITION_STORAGE_KEY, notificationPosition);
  }, [notificationPosition]);

  useEffect(() => {
    localStorage.setItem(NOTIFICATION_DURATION_STORAGE_KEY, String(notificationDuration));
  }, [notificationDuration]);

  useEffect(() => {
    const syncNotificationPreferences = (event: StorageEvent) => {
      if (event.key === NOTIFICATION_MODE_STORAGE_KEY) {
        setNotificationMode(parseNotificationMode(event.newValue, null));
      } else if (event.key === NOTIFICATION_POSITION_STORAGE_KEY) {
        setNotificationPosition(parseNotificationPosition(event.newValue));
      } else if (event.key === NOTIFICATION_DURATION_STORAGE_KEY) {
        setNotificationDuration(parseNotificationDuration(event.newValue));
      }
    };
    window.addEventListener("storage", syncNotificationPreferences);
    return () => window.removeEventListener("storage", syncNotificationPreferences);
  }, []);

  useEffect(() => {
    sessionStorage.setItem("term-server:panes", JSON.stringify(paneIds));
    sessionStorage.setItem("term-server:layout", JSON.stringify(layout));
  }, [paneIds, layout]);

  useEffect(() => {
    if (!authenticated) return;
    const refresh = () => {
      void Promise.all([api.terminals(), api.artifacts()])
        .then(([next, artifacts]) => {
          const workspaceTerminals = next;
          setTerminals((current) => mergeTerminalActivityViews(workspaceTerminals, current));
          setConfig((current) => ({
            ...current,
            broker: current.broker ? withBrokerSessions(current.broker, workspaceTerminals) : null,
          }));
          const available = new Set(workspaceTerminals.map((terminal) => terminal.id));
          setLayout((current) => pruneLayout(current, available));
          syncArtifacts(artifacts, activeIdRef.current, workspaceTerminals);
        })
        .catch((error) => {
          if (error instanceof ApiError && error.status === 401) setAuthenticated(false);
        });
    };
    const timer = window.setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) {
      agentEventsInitialized.current = false;
      deliveredAgentEvents.current.clear();
      return;
    }
    if (!workspaceLoaded) return;
    if (!agentEventsInitialized.current) {
      for (const terminal of terminals) {
        const notification = agentNotificationEvent(terminal.agent);
        if (notification) {
          deliveredAgentEvents.current.set(terminal.id, notification.event);
        }
      }
      agentEventsInitialized.current = true;
      return;
    }

    const deliver = (terminalId: string, event: number) => {
      const terminal = terminalsRef.current.find((candidate) => candidate.id === terminalId);
      const agent = terminal?.agent;
      if (!terminal || !agent || agentNotificationEvent(agent)?.event !== event) return;
      const pending = pendingAgentNotifications.current.get(terminalId);
      if (pending) clearTimeout(pending.timer);
      pendingAgentNotifications.current.delete(terminalId);
      const body = agent.status === "blocked"
        // A summary describes finished work, so it would misdescribe a block.
        ? `${agent.kind} is waiting for input in ${terminal.workspace}`
        : agent.summary ?? (
          agent.status === "idle"
            ? `${agent.kind} is idle and ready for input in ${terminal.workspace}`
            : `${agent.kind} closed in ${terminal.workspace}`
        );
      const toast = {
        id: `${terminal.id}:${event}`,
        terminalId: terminal.id,
        title: terminal.name,
        body,
        color: terminal.color,
      };
      deliverCompletionNotification({
        mode: notificationModeRef.current,
        toast,
        tag: `term-server:${terminal.id}:${event}`,
        showToast: showCompletionToast,
        onOpen: () => openTerminal(terminal.id),
      });
      maybeSendPushover(terminal, agent);
      deliveredAgentEvents.current.set(terminalId, event);
    };

    const activeIds = new Set(terminals.map((terminal) => terminal.id));
    for (const [id, pending] of pendingAgentNotifications.current) {
      if (!activeIds.has(id)) {
        clearTimeout(pending.timer);
        pendingAgentNotifications.current.delete(id);
      }
    }
    for (const terminal of terminals) {
      const agent = terminal.agent;
      const notification = agentNotificationEvent(agent);
      if (!agent || !notification) continue;
      const event = notification.event;
      if (deliveredAgentEvents.current.get(terminal.id) === event) continue;
      const pending = pendingAgentNotifications.current.get(terminal.id);
      if (pending?.event === event) {
        if (agent.summary) deliver(terminal.id, event);
        continue;
      }
      if (pending) clearTimeout(pending.timer);
      // A block is announced immediately; waiting on a summary would delay the
      // one state that is already waiting on the person being told.
      if (notification.kind === "completion" && config.pi.summariesEnabled && !agent.summary) {
        const timer = window.setTimeout(() => deliver(terminal.id, event), 12_000);
        pendingAgentNotifications.current.set(terminal.id, { event, timer });
      } else {
        deliver(terminal.id, event);
      }
    }
  }, [authenticated, workspaceLoaded, terminals, config.pi.summariesEnabled]);

  useEffect(() => {
    if (!authenticated) {
      commandEventsInitialized.current = false;
      deliveredCommandEvents.current.clear();
      return;
    }
    if (!workspaceLoaded) return;
    if (!commandEventsInitialized.current) {
      for (const terminal of terminals) {
        const event = commandCompletionEvent(terminal.command);
        if (event != null) deliveredCommandEvents.current.set(terminal.id, event);
      }
      commandEventsInitialized.current = true;
      return;
    }

    const deliver = (terminalId: string, event: number) => {
      const terminal = terminalsRef.current.find((candidate) => candidate.id === terminalId);
      const command = terminal?.command;
      if (!terminal || !command || commandCompletionEvent(command) !== event) return;
      const body = `${command.name} finished in ${terminal.workspace}`;
      const toast = {
        id: `command:${terminal.id}:${event}`,
        terminalId: terminal.id,
        title: terminal.name,
        body,
        color: terminal.color,
      };
      deliverCompletionNotification({
        mode: notificationModeRef.current,
        toast,
        tag: `term-server:command:${terminal.id}:${event}`,
        showToast: showCompletionToast,
        onOpen: () => openTerminal(terminal.id),
      });
      deliveredCommandEvents.current.set(terminalId, event);
    };

    for (const terminal of terminals) {
      const event = commandCompletionEvent(terminal.command);
      if (event == null || deliveredCommandEvents.current.get(terminal.id) === event) continue;
      deliver(terminal.id, event);
    }
  }, [authenticated, workspaceLoaded, terminals]);

  useEffect(() => () => {
    for (const pending of pendingAgentNotifications.current.values()) clearTimeout(pending.timer);
    for (const timer of completionToastTimers.current.values()) clearTimeout(timer);
  }, []);

  useEffect(() => {
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (!resources.some((resource) => resource.dirty)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnUnsaved);
    return () => window.removeEventListener("beforeunload", warnUnsaved);
  }, [resources]);

  useEffect(() => {
    if (activeId && !paneIds.includes(activeId)) setActiveId(paneIds[0]);
  }, [paneIds, activeId]);

  useEffect(() => {
    if (!mobileSidebar) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileSidebar(false);
      requestAnimationFrame(() => mobileMenuButton.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileSidebar]);

  const terminalById = useMemo(() => new Map(terminals.map((terminal) => [terminal.id, terminal])), [terminals]);
  const artifactCounts = useMemo(() => artifactCountsBySession(artifacts), [artifacts]);
  const artifactsBySession = useMemo(() => {
    const grouped = new Map<string, ArtifactEntry[]>();
    for (const artifact of artifacts) {
      const current = grouped.get(artifact.sessionId);
      if (current) current.push(artifact);
      else grouped.set(artifact.sessionId, [artifact]);
    }
    return grouped;
  }, [artifacts]);
  const attentionTerminalIds = useMemo(
    () => new Set(terminals.flatMap((terminal) => {
      const viewed = activityView(terminal);
      return agentNeedsAttention(terminal.agent, viewed.agentCompletedAt)
          || commandNeedsAttention(terminal.command, viewed.commandCompletedAt)
        ? [terminal.id]
        : [];
    })),
    [terminals],
  );
  const visibleTerminals = paneIds.map((id) => terminalById.get(id)).filter(Boolean) as TerminalInfo[];
  const renderedIds = [...mountedIds, ...paneIds.filter((id) => !mountedIds.includes(id))];
  const mountedTerminals = renderedIds.map((id) => terminalById.get(id)).filter(Boolean) as TerminalInfo[];
  const rectangles = useMemo(() => paneRects(layout), [layout]);
  const dividers = useMemo(() => splitDividers(layout), [layout]);
  const previewLayout = useMemo(
    () =>
      draggedId && dropTarget
        ? arrangeLayout(layout, draggedId, dropTarget.id, dropTarget.position, config.maxPanes)
        : undefined,
    [layout, draggedId, dropTarget, config.maxPanes],
  );
  const displayedLayout = previewLayout ?? (draggedId && !layout ? paneLeaf(draggedId) : layout) ?? null;
  const displayedRectangles = useMemo(() => paneRects(displayedLayout), [displayedLayout]);
  const displayedRectangleById = useMemo(
    () => new Map(displayedRectangles.map((rectangle) => [rectangle.id, rectangle])),
    [displayedRectangles],
  );

  const cachedTerminals = resolveCachedTerminals(cachedTerminalsOverride, config.cachedTerminals);
  const scrollbackLines = resolveTerminalScrollback(scrollbackLinesOverride, config.scrollbackLines);
  const terminalConfig = useMemo(
    () => (scrollbackLines === config.scrollbackLines
      ? config
      : { ...config, scrollbackLines }),
    [config, scrollbackLines],
  );

  useEffect(() => {
    const available = new Set(terminals.map((terminal) => terminal.id));
    setMountedIds((current) => {
      const next = reconcileMounted(current, paneIds, available, cachedTerminals);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [paneIds, terminals, cachedTerminals]);

  const markTerminalActivityViewed = (id: string) => {
    const terminal = terminalsRef.current.find((candidate) => candidate.id === id);
    if (!terminal) return;
    const update = currentActivityViewUpdate(terminal);
    if (!update) return;

    const pending = pendingActivityViews.current.get(id);
    if (
      (update.agentCompletedAt ?? 0) <= (pending?.agentCompletedAt ?? 0)
      && (update.commandCompletedAt ?? 0) <= (pending?.commandCompletedAt ?? 0)
    ) return;
    const requested = {
      agentCompletedAt: Math.max(
        update.agentCompletedAt ?? 0,
        pending?.agentCompletedAt ?? 0,
      ) || undefined,
      commandCompletedAt: Math.max(
        update.commandCompletedAt ?? 0,
        pending?.commandCompletedAt ?? 0,
      ) || undefined,
    };
    pendingActivityViews.current.set(id, requested);
    void api.updateTerminalActivityView(id, requested)
      .then((viewed) => {
        setTerminals((current) => current.map((candidate) => (
          candidate.id === id ? withActivityView(candidate, viewed) : candidate
        )));
      })
      .catch(() => {})
      .finally(() => {
        if (pendingActivityViews.current.get(id) === requested) {
          pendingActivityViews.current.delete(id);
        }
      });
  };

  useEffect(() => {
    if (
      !activeId
      || !paneIds.includes(activeId)
      || activeResource
      || settingsActive
      || mobileSidebar
      || document.visibilityState !== "visible"
      || !document.hasFocus()
    ) return;
    markTerminalActivityViewed(activeId);
  }, [activeId, activeResource, settingsActive, mobileSidebar, terminals, paneIds]);

  useEffect(() => {
    const markActiveActivityViewed = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      const id = activeId;
      if (
        id
        && paneIds.includes(id)
        && !activeResource
        && !settingsActive
        && !mobileSidebar
      ) {
        markTerminalActivityViewed(id);
      }
    };
    window.addEventListener("focus", markActiveActivityViewed);
    document.addEventListener("visibilitychange", markActiveActivityViewed);
    return () => {
      window.removeEventListener("focus", markActiveActivityViewed);
      document.removeEventListener("visibilitychange", markActiveActivityViewed);
    };
  }, [activeId, activeResource, settingsActive, mobileSidebar, paneIds]);

  const openTerminal = (id: string, split = false) => {
    setLayout((current) => {
      const currentIds = idsFromLayout(current);
      if (currentIds.includes(id)) return current;
      if (!current) return paneLeaf(id);
      const targetId = activeId && currentIds.includes(activeId) ? activeId : currentIds[0]!;
      if (split && currentIds.length < config.maxPanes) {
        return arrangeLayout(current, id, targetId, "right", config.maxPanes) ?? current;
      }
      return arrangeLayout(current, id, targetId, "center", config.maxPanes) ?? current;
    });
    setActiveId(id);
    setActiveResource(undefined);
    setSettingsActive(false);
    setMobileSidebar(false);
  };

  const openSettings = () => {
    setSettingsOpen(true);
    setSettingsActive(true);
    setActiveResource(undefined);
    setMobileSidebar(false);
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    setSettingsActive(false);
  };

  const openResource = async (target: FileTarget, known?: FileEntry) => {
    try {
      const file = known ?? await api.fileMetadata(target);
      if (file.kind === "directory") {
        showNotice("Open directories from the file explorer");
        return;
      }
      const next: ResourceTab = {
        path: file.path,
        name: file.name,
        type: file.image ? "image" : file.pdf ? "pdf" : "text",
        mime: file.mime,
        modifiedAt: file.modifiedAt,
        dirty: false,
      };
      setResources((current) => current.some((resource) => resource.path === file.path) ? current : [...current, next]);
      setActiveResource(file.path);
      setSettingsActive(false);
      setMobileSidebar(false);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to open file");
    }
  };

  const openArtifact = (artifact: ArtifactEntry) => {
    const tab = resourceForArtifact(artifact, terminalsRef.current.find(
      (terminal) => terminal.id === artifact.sessionId,
    ));
    setResources((current) => {
      const existing = current.findIndex((resource) => resource.path === tab.path);
      if (existing < 0) return [...current, tab];
      return current.map((resource, index) => (
        index === existing ? { ...tab, dirty: resource.dirty } : resource
      ));
    });
    setActiveResource(tab.path);
    setSettingsActive(false);
    setMobileSidebar(false);
  };

  const deleteArtifact = async (artifact: ArtifactDeleteTarget) => {
    const openResource = resources.find((resource) => (
      resource.path === artifact.path
      || (
        resource.artifact?.id === artifact.id
        && resource.artifact.sessionId === artifact.sessionId
      )
    ));
    const warning = openResource?.dirty
      ? `Delete “${artifact.name}” permanently? Its unsaved changes will also be lost.`
      : `Delete “${artifact.name}” permanently? This cannot be undone.`;
    if (!confirm(warning)) return;

    try {
      await api.removeArtifact(artifact.sessionId, artifact.id);
      setArtifacts((current) => current.filter((candidate) => (
        candidate.id !== artifact.id || candidate.sessionId !== artifact.sessionId
      )));
      setResources((current) => removeArtifactResources(current, artifact));
      setActiveResource((current) => (
        current === (openResource?.path ?? artifact.path) ? undefined : current
      ));
      showNotice(`Deleted ${artifact.name}`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to delete artifact");
    }
  };

  const returnToArtifactSession = (sessionId: string) => {
    if (!terminalsRef.current.some((terminal) => terminal.id === sessionId)) {
      showNotice("The terminal that created this artifact is no longer running");
      return;
    }
    openTerminal(sessionId);
  };

  const closeResource = (path: string) => {
    const index = resources.findIndex((resource) => resource.path === path);
    const resource = resources[index];
    if (!resource) return;
    if (resource.dirty && !confirm(`Close “${resource.name}” without saving?`)) return;
    const next = resources.filter((candidate) => candidate.path !== path);
    setResources(next);
    if (activeResource === path) setActiveResource(next[Math.min(index, next.length - 1)]?.path);
  };

  const closePane = (id: string) => {
    const next = removePaneAndSelect(layout, id, activeIdRef.current);
    setLayout(next.layout);
    setActiveId(next.activeId);
  };

  const forgetTerminal = (id: string) => {
    setTerminals((current) => current.filter((terminal) => terminal.id !== id));
    setLayout((current) => removePane(current, id));
    setMountedIds((current) => current.filter((mounted) => mounted !== id));
  };
  const startDividerDrag = (event: PointerEvent, path: PanePath) => {
    if (event.button !== 0 || dividerDragRef.current) return;
    const handle = event.currentTarget as HTMLElement;
    dividerDragRef.current = {
      pointerId: event.pointerId,
      path: [...path],
      handle,
    };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("pane-resizing");
    event.preventDefault();
    event.stopPropagation();
  };

  const resizeDividerWithKeyboard = (event: KeyboardEvent, path: PanePath) => {
    const divider = splitDividerAt(layoutRef.current, path);
    if (!divider) return;
    const step = event.shiftKey ? 0.1 : 0.05;
    let ratio: number | undefined;
    if (event.key === "Home") ratio = 0.15;
    if (event.key === "End") ratio = 0.85;
    if (
      divider.direction === "horizontal"
      && (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      ratio = divider.ratio + (event.key === "ArrowRight" ? step : -step);
    }
    if (
      divider.direction === "vertical"
      && (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      ratio = divider.ratio + (event.key === "ArrowDown" ? step : -step);
    }
    if (ratio === undefined) return;
    event.preventDefault();
    setLayout((current) => updateSplitRatio(current, path, clampSplitRatio(ratio!)));
  };

  const markTerminalExited = (id: string, exitCode: number) => {
    setTerminals((current) => current.map((terminal) => (
      terminal.id === id
        ? { ...terminal, pid: null, status: "exited", exitCode }
        : terminal
    )));
  };

  const finishDrag = () => {
    setDraggedId(undefined);
    setDropTarget(undefined);
  };

  const focusAdjacentPane = (offset: number) => {
    if (paneIds.length < 2) return;
    const currentIndex = Math.max(0, paneIds.indexOf(activeId ?? ""));
    const nextIndex = (currentIndex + offset + paneIds.length) % paneIds.length;
    setActiveId(paneIds[nextIndex]);
    setActiveResource(undefined);
    setSettingsActive(false);
  };

  const closeMobileSidebar = () => {
    setMobileSidebar(false);
    requestAnimationFrame(() => mobileMenuButton.current?.focus());
  };

  const dropOnPane = (sourceId: string, targetId: string, position: DropPosition) => {
    const next = arrangeLayout(layout, sourceId, targetId, position, config.maxPanes);
    if (!next) {
      showNotice(`A maximum of ${config.maxPanes} panes can be visible`);
      finishDrag();
      return;
    }
    setLayout(next);
    setActiveId(sourceId);
    finishDrag();
  };

  const createTerminal = async (cwd?: string, cloneFrom?: string) => {
    setCreating(true);
    try {
      const created = await api.createTerminal({ cwd, cloneFrom });
      setTerminals((current) => [...current, created].sort((left, right) => left.path.localeCompare(right.path)));
      setLayout((current) => placeNewTerminal(
        current,
        created.id,
        activeId,
        config.maxPanes,
        tileNewTerminals,
      ));
      setActiveId(created.id);
      setActiveResource(undefined);
      setSettingsActive(false);
      setMobileSidebar(false);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to create terminal");
    } finally {
      setCreating(false);
    }
  };

  const removeTerminal = async (terminal: TerminalInfo) => {
    if (!terminalKillAllowed(terminal.path, confirmTerminalKills)) return;
    try {
      await api.removeTerminal(terminal.id);
      forgetTerminal(terminal.id);
      showNotice(`Removed ${terminal.path}`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to remove terminal");
    }
  };

  const renameTerminal = async (terminal: TerminalInfo) => {
    const path = prompt("Terminal name", terminal.name)?.trim();
    if (!path || path === terminal.name) return;
    try {
      const renamed = await api.renameTerminal(terminal.id, { path });
      updateTerminal(renamed);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to rename terminal");
    }
  };

  const updateTerminal = (next: TerminalInfo) => {
    setTerminals((current) => current.map((terminal) => (
      terminal.id === next.id
        ? withActivityView(
            { ...next, broker: next.broker ?? terminal.broker },
            activityView(terminal),
          )
        : terminal
    )));
  };

  const updatePiConfig = async (titlesEnabled: boolean, summariesEnabled: boolean, model: string) => {
    try {
      const pi = await api.updatePiConfig({ titlesEnabled, summariesEnabled, model });
      setConfig((current) => ({ ...current, pi }));
      showNotice("Pi settings updated");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to update Pi settings");
    }
  };

  const updateAgentIntegration = async (
    provider: AgentIntegrationProvider,
    action: AgentIntegrationAction,
  ) => {
    setUpdatingAgentIntegration(provider);
    try {
      const agentIntegrations = await api.updateAgentIntegration(provider, action);
      setConfig((current) => ({ ...current, agentIntegrations }));
      showNotice(`Agent integration ${action === "remove" ? "removed" : "updated"}`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to update agent integration");
    } finally {
      setUpdatingAgentIntegration(undefined);
    }
  };

  const updateArtifactSkill = async (
    provider: AgentIntegrationProvider,
    action: ArtifactSkillAction,
  ) => {
    setUpdatingArtifactSkill(provider);
    try {
      const artifactSkill = await api.updateArtifactSkill(provider, action);
      setConfig((current) => ({ ...current, artifactSkill }));
      showNotice(`Artifact skill ${action === "remove" ? "removed" : "updated"}`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to update artifact skill");
    } finally {
      setUpdatingArtifactSkill(undefined);
    }
  };

  const updatePushoverConfig = async (changes: { userKey?: string; appKey?: string; mode?: PushoverMode }) => {
    try {
      const pushover = await api.updatePushoverConfig(changes);
      setConfig((current) => ({ ...current, pushover }));
      showNotice("Pushover settings updated");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to update Pushover settings");
    }
  };

  const maybeSendPushover = (terminal: TerminalInfo, agent: AgentInfo) => {
    const pushover = configRef.current.pushover;
    if (!pushover.enabled) return;
    if (!pushoverBellEnabled(terminal.id, pushover.mode)) return;
    const { title, message } = buildPushoverMessage(terminal, agent, configRef.current.hostname);
    void api.pushoverSend({ title, message }).catch(() => {
      // A failed push notification is non-blocking; never surface it.
    });
  };

  const updateNotificationMode = async (mode: NotificationMode) => {
    if (includesSystemNotifications(mode)) {
      if (typeof Notification === "undefined") {
        setNotificationMode("in-app");
        showNotice("System notifications are unavailable; using in-app notifications");
        return;
      }
      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== "granted") {
        setNotificationMode("in-app");
        showNotice("System notification permission was not granted; using in-app notifications");
        return;
      }
    }
    setNotificationMode(mode);
    showNotice(
      mode === "off"
        ? "Completion notifications disabled"
        : `Completion notifications set to ${mode === "in-app" ? "in-app" : mode}`,
    );
  };

  const updateNotificationPosition = (position: NotificationPosition) => {
    setNotificationPosition(position);
    showNotice(`In-app notifications will appear at the ${position.replace("-", " ")}`);
  };

  const updateNotificationDuration = (duration: NotificationDuration) => {
    setNotificationDuration(duration);
    showNotice(
      duration === 0
        ? "In-app notifications will stay until dismissed"
        : `In-app notifications will dismiss after ${duration / 1_000} seconds`,
    );
  };

  const updateTileNewTerminals = (enabled: boolean) => {
    setTileNewTerminals(enabled);
    localStorage.setItem(TILE_NEW_TERMINALS_STORAGE_KEY, String(enabled));
  };

  const updateConfirmTerminalKills = (enabled: boolean) => {
    setConfirmTerminalKills(enabled);
    localStorage.setItem(CONFIRM_TERMINAL_KILLS_STORAGE_KEY, String(enabled));
  };

  const updateTerminalPreviewSettings = (settings: TerminalPreviewSettings) => {
    setTerminalPreviewSettings(settings);
    localStorage.setItem(TERMINAL_PREVIEW_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  };

  // `undefined` clears the override and hands the choice back to the server,
  // which is not the same as storing whatever the server currently says: the
  // deployment can change its default and this browser should follow it.
  const updateCachedTerminals = (limit: number | undefined) => {
    setCachedTerminalsOverride(limit);
    if (limit === undefined) localStorage.removeItem(CACHED_TERMINALS_STORAGE_KEY);
    else localStorage.setItem(CACHED_TERMINALS_STORAGE_KEY, String(limit));
  };
  const updateScrollbackLines = (lines: number | undefined) => {
    const next = lines === undefined ? undefined : resolveTerminalScrollback(lines, config.scrollbackLines);
    setScrollbackLinesOverride(next);
    if (next === undefined) localStorage.removeItem(TERMINAL_SCROLLBACK_STORAGE_KEY);
    else localStorage.setItem(TERMINAL_SCROLLBACK_STORAGE_KEY, String(next));
  };

  const waitForServer = async (ready: (nextConfig: ClientConfig) => boolean) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      try {
        if (ready(await api.config())) return true;
      } catch {
        // The server is expected to be briefly unavailable during a restart.
      }
    }
    return false;
  };

  const waitForUpdatedServer = async (expectedCommit: string) => {
    if (await waitForServer((nextConfig) => nextConfig.build.commit === expectedCommit)) {
      location.reload();
      return;
    }
    setRestartingForUpdate(undefined);
    showNotice("The update was installed, but the server did not restart; restart term-server manually");
  };

  const installUpdate = async () => {
    const release = updateStatus?.latest;
    if (!release) return;
    const dirtyWarning = resources.some((resource) => resource.dirty)
      ? " You also have unsaved file edits."
      : "";
    if (!confirm(
      `Update to term-server v${release.version}? The server will reconnect while running terminal sessions stay active.${dirtyWarning}`,
    )) return;
    setInstallingUpdate(true);
    try {
      const installed = await api.installUpdate(release.commit);
      setRestartingForUpdate(installed);
      void waitForUpdatedServer(installed.commit);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to install the update");
      setInstallingUpdate(false);
    }
  };

  const waitForCurrentBroker = async () => {
    if (await waitForServer((nextConfig) => Boolean(
      nextConfig.broker && !nextConfig.broker.restartRequired,
    ))) {
      location.reload();
      return;
    }
    setRestartingBroker(false);
    showNotice("The session broker did not restart; restart term-server manually");
  };

  const restartBroker = async () => {
    const broker = config.broker;
    if (!broker?.restartRequired) return;
    const closeTerminals = broker.sessions > 0;
    if (closeTerminals && !confirm(
      `Restart the session broker? This will close ${broker.sessions} open terminal${broker.sessions === 1 ? "" : "s"}.`,
    )) return;
    setRestartingBroker(true);
    try {
      await api.restartBroker(closeTerminals);
      void waitForCurrentBroker();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to restart the session broker");
      setRestartingBroker(false);
    }
  };

  const refreshRecordingStatus = async (): Promise<DebugRecordingStatus | null> => {
    try {
      const status = await api.debugRecording();
      // Keep the client-side capture flag aligned with the server (e.g. after
      // a page reload while the server was left recording).
      if (status.active && !isDebugRecordingActive()) startDebugRecording();
      if (!status.active && isDebugRecordingActive()) stopDebugRecording();
      setRecordingStatus(status);
      return status;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        showNotice(error instanceof Error ? error.message : "Unable to read debug recording state");
      }
      return null;
    }
  };

  const refreshFrontendRecordingCount = () => {
    setFrontendRecordingEvents(debugRecordingEventCount());
  };

  const startRecording = async () => {
    setRecordingBusy(true);
    startDebugRecording();
    try {
      const status = await api.debugRecordingControl("start");
      setRecordingStatus(status);
      refreshFrontendRecordingCount();
      showNotice("Debug recording started");
    } catch (error) {
      stopDebugRecording();
      showNotice(error instanceof Error ? error.message : "Unable to start debug recording");
    } finally {
      setRecordingBusy(false);
    }
  };

  const stopRecording = async () => {
    setRecordingBusy(true);
    stopDebugRecording();
    refreshFrontendRecordingCount();
    try {
      const status = await api.debugRecordingControl("stop");
      setRecordingStatus(status);
      showNotice("Debug recording stopped");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to stop debug recording");
    } finally {
      setRecordingBusy(false);
    }
  };

  const downloadRecording = async () => {
    setRecordingBusy(true);
    stopDebugRecording();
    let backend: DebugRecordingExport;
    try {
      // Stop first so the server-side export includes the final events.
      const status = await api.debugRecording();
      if (status.active) {
        await api.debugRecordingControl("stop");
      }
      backend = await api.debugRecordingExport();
      setRecordingStatus(await api.debugRecording());
    } catch (error) {
      setRecordingBusy(false);
      showNotice(error instanceof Error ? error.message : "Unable to export debug recording");
      return;
    }
    const frontend = takeFrontendRecording();
    setFrontendRecordingEvents(0);
    const payload = {
      ...backend,
      client: {
        url: location.href,
        recordedAt: Date.now(),
        truncated: frontend.truncated || debugRecordingTruncated(),
        events: frontend.events,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `term-server-debug-${backend.id.slice(0, 8)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setRecordingBusy(false);
    showNotice("Debug recording downloaded");
  };

  const clearRecording = async () => {
    setRecordingBusy(true);
    resetDebugRecording();
    refreshFrontendRecordingCount();
    try {
      const status = await api.debugRecordingControl("clear");
      setRecordingStatus(status);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to clear debug recording");
    } finally {
      setRecordingBusy(false);
    }
  };

  useEffect(() => {
    if (!authenticated) return;
    void refreshRecordingStatus();
  }, [authenticated]);

  useEffect(() => {
    if (!recordingStatus?.active) return;
    const timer = window.setInterval(() => {
      void refreshRecordingStatus();
      refreshFrontendRecordingCount();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [recordingStatus?.active]);

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      setAuthenticated(false);
      setWorkspaceLoaded(false);
      setTerminals([]);
      setTerminalStreamIssues(new Map());
      setLayout(null);
      setMountedIds([]);
      setArtifacts([]);
      setResources([]);
      setActiveResource(undefined);
      knownArtifactIds.current.clear();
      artifactsInitialized.current = false;
      setUpdateStatus(null);
      resetDebugRecording();
      setFrontendRecordingEvents(0);
      setRecordingStatus(null);
      setSettingsOpen(false);
      setSettingsActive(false);
    }
  };

  if (authenticated === null) {
    return (
      <main class="loading-screen">
        <TermServerLogo class="brand-mark" />
        <span>Starting term-server…</span>
      </main>
    );
  }
  if (!authenticated) return <Login onAuthenticated={() => void loadWorkspace()} />;

  const recoveringStreams = [...terminalStreamIssues].filter(([, issue]) => issue.kind === "recovering");
  const reconnectingStreams = [...terminalStreamIssues].filter(([, issue]) => issue.kind === "reconnecting");
  const streamIssueTitle = [...recoveringStreams, ...reconnectingStreams]
    .map(([id, issue]) => {
      const name = terminalById.get(id)?.name ?? "Terminal";
      const backlog = issue.pendingBytes
        ? `, ${Math.ceil(issue.pendingBytes / 1024).toLocaleString()} KiB of stale redraws discarded`
        : "";
      return issue.kind === "recovering"
        ? `${name}: loading current terminal state${backlog}`
        : `${name}: reconnecting terminal stream`;
    })
    .join("\n");

  return (
    <div class={`workbench ${statusModulesMobileVisible ? "status-modules-mobile" : ""}`}>
      <div class="workbench-main">
        <header class="mobile-toolbar">
          <button
            ref={mobileMenuButton}
            class="mobile-menu-button"
            onClick={() => setMobileSidebar(true)}
            aria-label="Open workspaces"
            aria-expanded={mobileSidebar}
          >
            <Menu size={19} />
          </button>
          <span class="mobile-workspace-title">
            {settingsActive
              ? "Settings"
              : activeResource
              ? resources.find((resource) => resource.path === activeResource)?.name
              : terminalById.get(activeId ?? "")?.name ?? "Terminal workspace"}
          </span>
          {!activeResource && !settingsActive && paneIds.length > 1 && (
            <nav class="mobile-pane-navigation" aria-label="Visible terminal panes">
              <button onClick={() => focusAdjacentPane(-1)} aria-label="Previous terminal pane">
                <ChevronLeft size={18} />
              </button>
              <span>{Math.max(1, paneIds.indexOf(activeId ?? "") + 1)}/{paneIds.length}</span>
              <button onClick={() => focusAdjacentPane(1)} aria-label="Next terminal pane">
                <ChevronRight size={18} />
              </button>
            </nav>
          )}
        </header>
        {mobileSidebar && <button class="sidebar-scrim" onClick={closeMobileSidebar} aria-label="Close sidebar" />}
        <Sidebar
          terminals={terminals}
          activeIds={paneIds}
          attentionTerminalIds={attentionTerminalIds}
          artifactCounts={artifactCounts}
          mobileOpen={mobileSidebar}
          creating={creating}
          settingsActive={settingsActive}
          updateAvailable={updateStatus?.state === "available"}
          fileRoot={terminalById.get(activeId ?? "")?.cwd ?? "~"}
          previewSettings={terminalPreviewSettings}
          pushover={config.pushover}
          theme={theme}
          onMobileClose={closeMobileSidebar}
          onNew={(cwd) => void createTerminal(cwd)}
          onOpen={(id) => openTerminal(id)}
          onSplit={(id) => openTerminal(id, true)}
          onRename={(terminal) => void renameTerminal(terminal)}
          onRemove={(terminal) => void removeTerminal(terminal)}
          onSettings={openSettings}
          onOpenFile={(entry) => void openResource({ path: entry.path }, entry)}
          onDragStart={(id) => {
            setDraggedId(id);
            setDropTarget(undefined);
          }}
          onDragEnd={finishDrag}
        />
        <div
          class={`workspace-area ${resources.length || settingsOpen ? "with-resource-tabs" : ""}`}
          aria-hidden={mobileSidebar || undefined}
        >
          {(resources.length > 0 || settingsOpen) && (
            <ResourceTabBar
              tabs={resources}
              activePath={activeResource}
              settingsOpen={settingsOpen}
              settingsActive={settingsActive}
              onTerminal={() => {
                setActiveResource(undefined);
                setSettingsActive(false);
              }}
              onSettings={openSettings}
              onCloseSettings={closeSettings}
              onActivate={(path) => {
                setActiveResource(path);
                setSettingsActive(false);
              }}
              onClose={closeResource}
            />
          )}
          <div class="workspace-stage">
            <main
              ref={editorGridRef}
          class={`editor-grid ${draggedId ? "dragging-terminal" : ""} ${activeResource || settingsActive ? "resource-hidden" : ""}`}
          aria-hidden={Boolean(activeResource || settingsActive)}
          onDragOver={(event) => {
            if (draggedId && !visibleTerminals.length) event.preventDefault();
          }}
          onDrop={(event) => {
            if (visibleTerminals.length) return;
            event.preventDefault();
            const sourceId = draggedId ?? event.dataTransfer?.getData(TERMINAL_DRAG_TYPE);
            if (sourceId) openTerminal(sourceId);
            finishDrag();
          }}
        >
          <Suspense fallback={<div class="terminal-loading">Loading terminal renderer…</div>}>
            {mountedTerminals.map((terminal) => {
              const rectangle = displayedRectangleById.get(terminal.id);
              const visible = Boolean(rectangle);
              return (
                <div
                  key={terminal.id}
                  data-terminal-id={terminal.id}
                  data-pane-id={`pane-${terminal.id}`}
                  class={`pane-slot ${visible ? "" : "cached"} ${visible && terminal.id === activeId ? "active" : ""}`}
                  style={
                    rectangle
                      ? {
                          left: `${rectangle.x * 100}%`,
                          top: `${rectangle.y * 100}%`,
                          width: `${rectangle.width * 100}%`,
                          height: `${rectangle.height * 100}%`,
                        }
                      : undefined
                  }
                >
                  <TerminalPane
                    terminal={terminal}
                    artifacts={artifactsBySession.get(terminal.id) ?? []}
                    needsAttention={attentionTerminalIds.has(terminal.id)}
                    config={terminalConfig}
                    theme={theme}
                    fontSize={terminalFontSize}
                    active={visible && terminal.id === activeId && !activeResource && !settingsActive}
                    visible={visible}
                    onActivate={() => setActiveId(terminal.id)}
                    onClose={() => closePane(terminal.id)}
                    onRemove={() => void removeTerminal(terminal)}
                    onClone={() => void createTerminal(undefined, terminal.id)}
                    onDragStart={() => {
                      setDraggedId(terminal.id);
                      setDropTarget(undefined);
                    }}
                    onDragEnd={finishDrag}
                    onExit={markTerminalExited}
                    onUpdate={updateTerminal}
                    onStreamIssue={(issue) => updateTerminalStreamIssue(terminal.id, issue)}
                    onNotice={showNotice}
                    onFontSizeChange={updateTerminalFontSize}
                    onOpenFile={(target) => void openResource(target)}
                    onOpenArtifact={openArtifact}
                    onDeleteArtifact={deleteArtifact}
                  />
                </div>
              );
            })}
          </Suspense>
          {!draggedId && dividers.length > 0 && (
            <div class="layout-dividers" aria-label="Resize terminal panes">
              {dividers.map((divider) => {
                const vertical = divider.direction === "horizontal";
                const bounds = divider.bounds;
                return (
                  <div
                    key={divider.path.join(".") || "root"}
                    class={`layout-divider ${vertical ? "vertical" : "horizontal"}`}
                    role="separator"
                    aria-label="Resize terminal panes"
                    aria-orientation={vertical ? "vertical" : "horizontal"}
                    aria-valuemin={0.15}
                    aria-valuemax={0.85}
                    aria-valuenow={divider.ratio}
                    data-divider-path={divider.path.join("/") || "root"}
                    data-divider-direction={divider.direction}
                    tabIndex={0}
                    title="Drag to resize panes"
                    style={{
                      left: `${bounds.x * 100}%`,
                      top: `${bounds.y * 100}%`,
                      width: `${bounds.width * 100}%`,
                      height: `${bounds.height * 100}%`,
                    }}
                    onPointerDown={(event) => startDividerDrag(event, divider.path)}
                    onKeyDown={(event) => resizeDividerWithKeyboard(event, divider.path)}
                  />
                );
              })}
            </div>
          )}
          {draggedId && displayedLayout && !mountedTerminals.some((terminal) => terminal.id === draggedId) && (() => {
            const rectangle = displayedRectangleById.get(draggedId);
            const terminal = terminalById.get(draggedId);
            return rectangle ? (
              <div
                class="pane-live-placeholder"
                style={{
                  left: `${rectangle.x * 100}%`,
                  top: `${rectangle.y * 100}%`,
                  width: `${rectangle.width * 100}%`,
                  height: `${rectangle.height * 100}%`,
                }}
              >
                <div class="pane-live-placeholder-header">
                  <span class="terminal-color" style={{ background: terminal?.color }} />
                  <span>{terminal?.name ?? "Terminal"}</span>
                </div>
                <div class="pane-live-placeholder-body">Drop to open here</div>
              </div>
            ) : null;
          })()}
          {draggedId && visibleTerminals.length > 0 && (
            <div class="layout-drop-surface" aria-hidden="true">
              {rectangles.map((rectangle) => (
                <div
                  key={rectangle.id}
                  class="layout-drop-target"
                  style={{
                    left: `${rectangle.x * 100}%`,
                    top: `${rectangle.y * 100}%`,
                    width: `${rectangle.width * 100}%`,
                    height: `${rectangle.height * 100}%`,
                  }}
                >
                  {dropPositions.map((position) => (
                    <div
                      key={position}
                      class={`pane-drop-zone ${position} ${dropTarget?.id === rectangle.id && dropTarget.position === position ? `active ${previewLayout ? "" : "invalid"}` : ""}`}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setDropTarget({ id: rectangle.id, position });
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        if (event.dataTransfer) {
                          event.dataTransfer.dropEffect = paneIds.includes(draggedId) ? "move" : "copy";
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const sourceId = draggedId ?? event.dataTransfer?.getData(TERMINAL_DRAG_TYPE);
                        if (sourceId) dropOnPane(sourceId, rectangle.id, position);
                      }}
                    >
                      <span>
                        {position === "center"
                          ? paneIds.includes(draggedId)
                            ? "swap"
                            : "replace"
                          : `split ${position}`}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {!visibleTerminals.length && (
            <WelcomeSection
              terminalsCount={terminals.length}
              maxPanes={config.maxPanes}
              creating={creating}
              onCreate={() => void createTerminal()}
            />
          )}
            </main>
            {resources.length > 0 && (
              <Suspense fallback={<div class="terminal-loading">Loading file viewer…</div>}>
                <ResourceDocuments
                  tabs={resources}
                  activePath={activeResource}
                  theme={theme}
                  onDirty={(path, dirty) => setResources((current) => current.map((resource) => (
                    resource.path === path ? { ...resource, dirty } : resource
                  )))}
                  onNotice={showNotice}
                  onOpenArtifactSession={returnToArtifactSession}
                  onDeleteArtifact={deleteArtifact}
                />
              </Suspense>
            )}
            {settingsOpen && (
              <SettingsWorkspace
                active={settingsActive}
                theme={theme}
                pi={config.pi}
                agentIntegrations={config.agentIntegrations}
                updatingAgentIntegration={updatingAgentIntegration}
                artifactSkill={config.artifactSkill}
                updatingArtifactSkill={updatingArtifactSkill}
                build={config.build}
                broker={config.broker}
                updateConfig={config.updates}
                updateStatus={updateStatus}
                checkingForUpdate={checkingForUpdate}
                installingUpdate={installingUpdate}
                restartingBroker={restartingBroker}
                passwordManagedExternally={config.passwordManagedExternally}
                notificationMode={notificationMode}
                notificationPosition={notificationPosition}
                notificationDuration={notificationDuration}
                tileNewTerminals={tileNewTerminals}
                confirmTerminalKills={confirmTerminalKills}
                terminalPreviewSettings={terminalPreviewSettings}
                cachedTerminals={cachedTerminals}
                cachedTerminalsOverridden={cachedTerminalsOverride !== undefined}
                serverCachedTerminals={config.cachedTerminals}
                scrollbackLines={scrollbackLines}
                scrollbackLinesOverridden={scrollbackLinesOverride !== undefined}
                serverScrollbackLines={config.scrollbackLines}
                recording={recordingStatus}
                frontendRecordingEvents={frontendRecordingEvents}
                recordingBusy={recordingBusy}
                pushover={config.pushover}
                onTheme={setTheme}
                onPiChange={(titlesEnabled, summariesEnabled, model) => (
                  void updatePiConfig(titlesEnabled, summariesEnabled, model)
                )}
                onAgentIntegration={(provider, action) => (
                  void updateAgentIntegration(provider, action)
                )}
                onArtifactSkill={(provider, action) => (
                  void updateArtifactSkill(provider, action)
                )}
                onCheckForUpdate={() => void checkForUpdates(true)}
                onInstallUpdate={() => void installUpdate()}
                onRestartBroker={() => void restartBroker()}
                onNotificationModeChange={(mode) => void updateNotificationMode(mode)}
                onNotificationPositionChange={updateNotificationPosition}
                onNotificationDurationChange={updateNotificationDuration}
                onTileNewTerminalsChange={updateTileNewTerminals}
                onConfirmTerminalKillsChange={updateConfirmTerminalKills}
                onTerminalPreviewSettingsChange={updateTerminalPreviewSettings}
                onCachedTerminalsChange={updateCachedTerminals}
                onScrollbackLinesChange={updateScrollbackLines}
                onRecordingStart={() => void startRecording()}
                onRecordingStop={() => void stopRecording()}
                onRecordingDownload={() => void downloadRecording()}
                onRecordingClear={() => void clearRecording()}
                onPushoverChange={(changes) => void updatePushoverConfig(changes)}
                onPasswordChanged={() => showNotice("Password changed; other sessions were signed out")}
                onLogout={() => void logout()}
              />
            )}
          </div>
        </div>
      </div>
      <footer class="statusbar">
        <span class="statusbar-group statusbar-left">
          <span class="statusbar-item statusbar-connected"><span class="status-dot online" /> Connected</span>
          {recoveringStreams.length > 0 ? (
            <span class="statusbar-item statusbar-stream-issue" title={streamIssueTitle} role="status" aria-live="polite">
              <LoaderCircle class="spin" size={12} />
              Recovering output for {recoveringStreams.length} terminal{recoveringStreams.length === 1 ? "" : "s"}
            </span>
          ) : reconnectingStreams.length > 0 ? (
            <span class="statusbar-item statusbar-stream-issue disconnected" title={streamIssueTitle} role="status" aria-live="polite">
              Reconnecting {reconnectingStreams.length} terminal{reconnectingStreams.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {config.hostname && (
            <span class="statusbar-item statusbar-host" title="Server hostname">
              {config.hostname}
            </span>
          )}
        </span>
        <StatusModules onMobileVisibilityChange={setStatusModulesMobileVisible} />
        <span class="statusbar-group statusbar-right">
          <span
            class="statusbar-item statusbar-build"
            title={`term-server v${config.build.version} · ${config.build.commit}`}
          >
            v{config.build.version} · {config.build.commit.slice(0, 7)}
          </span>
          <span class="statusbar-item">{visibleTerminals.length}/{config.maxPanes} panes</span>
          <span class="statusbar-item statusbar-scrollback">{scrollbackLines.toLocaleString()} line scrollback</span>
          <span class="statusbar-item" title={config.secure ? "HTTPS enabled" : "HTTPS disabled"}>
            <ShieldCheck size={13} /> {config.secure ? "HTTPS" : "HTTP"}
          </span>
        </span>
      </footer>
      {(restartingForUpdate || restartingBroker) && (
        <div class="update-restarting" role="status" aria-live="assertive">
          <LoaderCircle class="spin" size={22} />
          <strong>
            {restartingBroker
              ? "Restarting session broker"
              : `Installing term-server v${restartingForUpdate?.version}`}
          </strong>
          <span>
            {restartingBroker
              ? "Loading the current broker build and reconnecting the server…"
              : "Verified update installed. Terminals are still running while the server reconnects…"}
          </span>
        </div>
      )}
      {(completionToasts.length > 0 || notice) && (
        <div class={`toast-stack ${notificationPosition}`} aria-live="polite">
          {completionToasts.map((toast) => (
            <div
              key={toast.id}
              class="toast completion-toast"
              style={{ "--notification-color": toast.color }}
            >
              <button
                class="completion-toast-main"
                onClick={() => {
                  openTerminal(toast.terminalId);
                  dismissCompletionToast(toast.id);
                }}
              >
                <span class="completion-toast-icon"><Bell size={16} /></span>
                <span class="completion-toast-copy">
                  <b>{toast.title}</b>
                  <span>{toast.body}</span>
                </span>
              </button>
              <button
                class="completion-toast-close"
                onClick={() => dismissCompletionToast(toast.id)}
                aria-label={`Dismiss ${toast.title} notification`}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {notice && <div class="toast" role="status">{notice}</div>}
        </div>
      )}
    </div>
  );
}
