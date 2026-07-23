import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { lazy, Suspense } from "preact/compat";
import { ChevronLeft, ChevronRight, Menu, Plus, ShieldCheck } from "lucide-preact";
import type { ClientConfig, FileEntry, FileTarget, TerminalInfo } from "../shared/types";
import { api, ApiError } from "./lib/api";
import {
  agentNeedsAttention,
  markAgentRevisionViewed,
  parseViewedAgentRevisions,
  pruneViewedAgentRevisions,
  VIEWED_AGENT_REVISIONS_STORAGE_KEY,
} from "./lib/agent-attention";
import { documentTitle } from "./lib/document-title";
import {
  arrangeLayout,
  isPaneLayout,
  layoutFromIds,
  paneIds as idsFromLayout,
  paneLeaf,
  paneRects,
  placeNewTerminal,
  pruneLayout,
  reconcileMounted,
  removePane,
  TERMINAL_DRAG_TYPE,
  type DropPosition,
  type PaneLayout,
} from "./lib/layout";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { TermServerLogo } from "./components/TermServerLogo";
import { WelcomeSection } from "./components/WelcomeSection";
import { ResourceTabBar, type ResourceTab } from "./components/ResourceTabs";
import type { ThemeName } from "./components/TerminalPane";

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((module) => ({ default: module.TerminalPane })),
);
const ResourceDocuments = lazy(() => import("./components/ResourceWorkspace"));

const defaultConfig: ClientConfig = {
  scrollbackLines: 200_000,
  maxPanes: 4,
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
};
const dropPositions: DropPosition[] = ["left", "top", "center", "bottom", "right"];
const TILE_NEW_TERMINALS_STORAGE_KEY = "term-server:tile-new-terminals";

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

const initialNotifications = () =>
  localStorage.getItem("term-server:notifications") === "true" &&
  typeof Notification !== "undefined" &&
  Notification.permission === "granted";

const initialTileNewTerminals = () =>
  localStorage.getItem(TILE_NEW_TERMINALS_STORAGE_KEY) === "true";

const initialViewedAgentRevisions = () =>
  parseViewedAgentRevisions(localStorage.getItem(VIEWED_AGENT_REVISIONS_STORAGE_KEY));

export function App() {
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
  const [notice, setNotice] = useState("");
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(initialNotifications);
  const [tileNewTerminals, setTileNewTerminals] = useState(initialTileNewTerminals);
  const [viewedAgentRevisions, setViewedAgentRevisions] = useState(initialViewedAgentRevisions);
  const [resources, setResources] = useState<ResourceTab[]>([]);
  const [activeResource, setActiveResource] = useState<string>();
  const agentEventsInitialized = useRef(false);
  const deliveredAgentEvents = useRef(new Map<string, number>());
  const pendingAgentNotifications = useRef(new Map<string, { event: number; timer: number }>());
  const mobileMenuButton = useRef<HTMLButtonElement>(null);
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  const paneIds = useMemo(() => idsFromLayout(layout), [layout]);

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? "" : current)), 2400);
  };

  const loadWorkspace = async () => {
    try {
      const [nextConfig, nextTerminals] = await Promise.all([api.config(), api.terminals()]);
      const runningTerminals = nextTerminals.filter((terminal) => terminal.status === "running");
      setConfig(nextConfig);
      setTerminals(runningTerminals);
      setWorkspaceLoaded(true);
      setLayout((current) => {
        const available = new Set(runningTerminals.map((terminal) => terminal.id));
        const kept = pruneLayout(current, available);
        return kept ?? (runningTerminals[0] ? paneLeaf(runningTerminals[0].id) : null);
      });
      setActiveId((current) =>
        current && runningTerminals.some((terminal) => terminal.id === current)
          ? current
          : runningTerminals[0]?.id,
      );
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
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("term-server:theme", theme);
  }, [theme]);

  useEffect(() => {
    document.title = documentTitle(terminals);
  }, [terminals]);

  useEffect(() => {
    localStorage.setItem(
      VIEWED_AGENT_REVISIONS_STORAGE_KEY,
      JSON.stringify(viewedAgentRevisions),
    );
  }, [viewedAgentRevisions]);

  useEffect(() => {
    const syncViewedAgentRevisions = (event: StorageEvent) => {
      if (event.key !== VIEWED_AGENT_REVISIONS_STORAGE_KEY) return;
      setViewedAgentRevisions(parseViewedAgentRevisions(event.newValue));
    };
    window.addEventListener("storage", syncViewedAgentRevisions);
    return () => window.removeEventListener("storage", syncViewedAgentRevisions);
  }, []);

  useEffect(() => {
    if (!workspaceLoaded) return;
    const terminalIds = new Set(terminals.map((terminal) => terminal.id));
    setViewedAgentRevisions((current) => pruneViewedAgentRevisions(current, terminalIds));
  }, [workspaceLoaded, terminals]);

  useEffect(() => {
    sessionStorage.setItem("term-server:panes", JSON.stringify(paneIds));
    sessionStorage.setItem("term-server:layout", JSON.stringify(layout));
  }, [paneIds, layout]);

  useEffect(() => {
    if (!authenticated) return;
    const refresh = () => {
      void api
        .terminals()
        .then((next) => {
          const running = next.filter((terminal) => terminal.status === "running");
          setTerminals(running);
          const available = new Set(running.map((terminal) => terminal.id));
          setLayout((current) => pruneLayout(current, available));
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
    if (!agentEventsInitialized.current) {
      for (const terminal of terminals) {
        if (terminal.agent) deliveredAgentEvents.current.set(terminal.id, terminal.agent.statusChangedAt);
      }
      agentEventsInitialized.current = true;
      return;
    }

    const deliver = (terminalId: string, event: number) => {
      const terminal = terminalsRef.current.find((candidate) => candidate.id === terminalId);
      if (!terminal?.agent || terminal.agent.statusChangedAt !== event) return;
      deliveredAgentEvents.current.set(terminalId, event);
      const pending = pendingAgentNotifications.current.get(terminalId);
      if (pending) clearTimeout(pending.timer);
      pendingAgentNotifications.current.delete(terminalId);
      if (!notificationsEnabled || typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const body = terminal.agent.summary ?? (
        terminal.agent.status === "idle"
          ? `${terminal.agent.kind} is idle and ready for input in ${terminal.workspace}`
          : `${terminal.agent.kind} closed in ${terminal.workspace}`
      );
      const notification = new Notification(terminal.name, {
        body,
        tag: `term-server:${terminal.id}:${event}`,
      });
      notification.onclick = () => {
        window.focus();
        openTerminal(terminal.id);
        notification.close();
      };
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
      if (!agent || agent.status === "working") {
        if (agent) deliveredAgentEvents.current.set(terminal.id, agent.statusChangedAt);
        continue;
      }
      if (deliveredAgentEvents.current.get(terminal.id) === agent.statusChangedAt) continue;
      const pending = pendingAgentNotifications.current.get(terminal.id);
      if (pending?.event === agent.statusChangedAt) {
        if (agent.summary) deliver(terminal.id, agent.statusChangedAt);
        continue;
      }
      if (pending) clearTimeout(pending.timer);
      if (config.pi.summariesEnabled && !agent.summary) {
        const event = agent.statusChangedAt;
        const timer = window.setTimeout(() => deliver(terminal.id, event), 12_000);
        pendingAgentNotifications.current.set(terminal.id, { event, timer });
      } else {
        deliver(terminal.id, agent.statusChangedAt);
      }
    }
  }, [authenticated, terminals, notificationsEnabled, config.pi.summariesEnabled]);

  useEffect(() => () => {
    for (const pending of pendingAgentNotifications.current.values()) clearTimeout(pending.timer);
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
    if (paneIds.length && !paneIds.includes(activeId ?? "")) setActiveId(paneIds[0]);
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
  const attentionAgentIds = useMemo(
    () => new Set(terminals.flatMap((terminal) => (
      agentNeedsAttention(terminal.agent, viewedAgentRevisions[terminal.id]) ? [terminal.id] : []
    ))),
    [terminals, viewedAgentRevisions],
  );
  const visibleTerminals = paneIds.map((id) => terminalById.get(id)).filter(Boolean) as TerminalInfo[];
  const renderedIds = [...mountedIds, ...paneIds.filter((id) => !mountedIds.includes(id))];
  const mountedTerminals = renderedIds.map((id) => terminalById.get(id)).filter(Boolean) as TerminalInfo[];
  const rectangles = useMemo(() => paneRects(layout), [layout]);
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

  useEffect(() => {
    const available = new Set(terminals.map((terminal) => terminal.id));
    const cacheLimit = Math.max(config.maxPanes, 6);
    setMountedIds((current) => {
      const next = reconcileMounted(current, paneIds, available, cacheLimit);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [paneIds, terminals, config.maxPanes]);

  const markAgentViewed = (id: string) => {
    const agent = terminalsRef.current.find((terminal) => terminal.id === id)?.agent;
    if (!agent || agent.status !== "idle") return;
    setViewedAgentRevisions((current) => (
      markAgentRevisionViewed(current, id, agent.revision)
    ));
  };

  useEffect(() => {
    if (
      !activeId
      || activeResource
      || mobileSidebar
      || document.visibilityState !== "visible"
      || !document.hasFocus()
    ) return;
    markAgentViewed(activeId);
  }, [activeId, activeResource, mobileSidebar, terminals]);

  useEffect(() => {
    const markActiveAgentViewed = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      const id = activeId;
      if (id && !activeResource && !mobileSidebar) markAgentViewed(id);
    };
    window.addEventListener("focus", markActiveAgentViewed);
    document.addEventListener("visibilitychange", markActiveAgentViewed);
    return () => {
      window.removeEventListener("focus", markActiveAgentViewed);
      document.removeEventListener("visibilitychange", markActiveAgentViewed);
    };
  }, [activeId, activeResource, mobileSidebar]);

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
    setMobileSidebar(false);
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
        dirty: false,
      };
      setResources((current) => current.some((resource) => resource.path === file.path) ? current : [...current, next]);
      setActiveResource(file.path);
      setMobileSidebar(false);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to open file");
    }
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
    setLayout((current) => removePane(current, id));
  };

  const forgetTerminal = (id: string) => {
    setTerminals((current) => current.filter((terminal) => terminal.id !== id));
    setLayout((current) => removePane(current, id));
    setMountedIds((current) => current.filter((mounted) => mounted !== id));
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
      setMobileSidebar(false);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Unable to create terminal");
    } finally {
      setCreating(false);
    }
  };

  const removeTerminal = async (terminal: TerminalInfo) => {
    if (!confirm(`Kill and remove “${terminal.path}”? The process and its scrollback will be lost.`)) return;
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
    setTerminals((current) => current.map((terminal) => (terminal.id === next.id ? next : terminal)));
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

  const updateNotifications = async (enabled: boolean) => {
    if (!enabled) {
      setNotificationsEnabled(false);
      localStorage.setItem("term-server:notifications", "false");
      return;
    }
    if (typeof Notification === "undefined") {
      showNotice("This browser does not support notifications");
      return;
    }
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") {
      showNotice("Browser notification permission was not granted");
      return;
    }
    setNotificationsEnabled(true);
    localStorage.setItem("term-server:notifications", "true");
    showNotice("Agent completion notifications enabled");
  };

  const updateTileNewTerminals = (enabled: boolean) => {
    setTileNewTerminals(enabled);
    localStorage.setItem(TILE_NEW_TERMINALS_STORAGE_KEY, String(enabled));
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      setAuthenticated(false);
      setWorkspaceLoaded(false);
      setTerminals([]);
      setLayout(null);
      setMountedIds([]);
      setResources([]);
      setActiveResource(undefined);
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

  return (
    <div class="workbench">
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
            {activeResource
              ? resources.find((resource) => resource.path === activeResource)?.name
              : terminalById.get(activeId ?? "")?.name ?? "Terminal workspace"}
          </span>
          {!activeResource && paneIds.length > 1 && (
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
          attentionAgentIds={attentionAgentIds}
          mobileOpen={mobileSidebar}
          creating={creating}
          theme={theme}
          pi={config.pi}
          passwordManagedExternally={config.passwordManagedExternally}
          notificationsEnabled={notificationsEnabled}
          tileNewTerminals={tileNewTerminals}
          fileRoot={terminalById.get(activeId ?? "")?.cwd ?? "~"}
          onMobileClose={closeMobileSidebar}
          onNew={(cwd) => void createTerminal(cwd)}
          onOpen={(id) => openTerminal(id)}
          onSplit={(id) => openTerminal(id, true)}
          onRename={(terminal) => void renameTerminal(terminal)}
          onTheme={setTheme}
          onPiChange={(titlesEnabled, summariesEnabled, model) => (
            void updatePiConfig(titlesEnabled, summariesEnabled, model)
          )}
          onNotificationsChange={(enabled) => void updateNotifications(enabled)}
          onTileNewTerminalsChange={updateTileNewTerminals}
          onPasswordChanged={() => showNotice("Password changed; other sessions were signed out")}
          onOpenFile={(entry) => void openResource({ path: entry.path }, entry)}
          onLogout={() => void logout()}
          onDragStart={(id) => {
            setDraggedId(id);
            setDropTarget(undefined);
          }}
          onDragEnd={finishDrag}
        />
        <div
          class={`workspace-area ${resources.length ? "with-resource-tabs" : ""}`}
          aria-hidden={mobileSidebar || undefined}
        >
          {resources.length > 0 && (
            <ResourceTabBar
              tabs={resources}
              activePath={activeResource}
              onTerminal={() => setActiveResource(undefined)}
              onActivate={setActiveResource}
              onClose={closeResource}
            />
          )}
          <div class="workspace-stage">
            <main
          class={`editor-grid ${draggedId ? "dragging-terminal" : ""} ${activeResource ? "resource-hidden" : ""}`}
          aria-hidden={Boolean(activeResource)}
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
                    needsAttention={attentionAgentIds.has(terminal.id)}
                    config={config}
                    theme={theme}
                    active={visible && terminal.id === activeId && !activeResource}
                    onActivate={() => setActiveId(terminal.id)}
                    onClose={() => closePane(terminal.id)}
                    onRemove={() => void removeTerminal(terminal)}
                    onClone={() => void createTerminal(undefined, terminal.id)}
                    onDragStart={() => {
                      setDraggedId(terminal.id);
                      setDropTarget(undefined);
                    }}
                    onDragEnd={finishDrag}
                    onExit={() => forgetTerminal(terminal.id)}
                    onUpdate={updateTerminal}
                    onNotice={showNotice}
                    onOpenFile={(target) => void openResource(target)}
                  />
                </div>
              );
            })}
          </Suspense>
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
                />
              </Suspense>
            )}
          </div>
        </div>
      </div>
      <footer class="statusbar">
        <span class="statusbar-group statusbar-left">
          <span class="statusbar-item statusbar-connected"><span class="status-dot online" /> Connected</span>
          {config.hostname && (
            <span class="statusbar-item statusbar-host" title="Server hostname">
              {config.hostname}
            </span>
          )}
        </span>
        <span class="statusbar-group statusbar-right">
          <span class="statusbar-item">{visibleTerminals.length}/{config.maxPanes} panes</span>
          <span class="statusbar-item statusbar-scrollback">{config.scrollbackLines.toLocaleString()} line scrollback</span>
          <span class="statusbar-item" title={config.secure ? "HTTPS enabled" : "HTTPS disabled"}>
            <ShieldCheck size={13} /> {config.secure ? "HTTPS" : "HTTP"}
          </span>
        </span>
      </footer>
      {notice && <div class="toast" role="status">{notice}</div>}
    </div>
  );
}
