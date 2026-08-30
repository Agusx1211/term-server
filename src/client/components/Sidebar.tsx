import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { lazy, Suspense } from "preact/compat";
import {
  Activity,
  Bell,
  BellOff,
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  CircleCheck,
  Crown,
  CirclePause,
  CircleX,
  Download,
  Folder,
  FolderSearch,
  FolderOpen,
  Hand,
  LoaderCircle,
  PackageOpen,
  Pencil,
  Plus,
  Radio,
  Search,
  Settings,
  SplitSquareHorizontal,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-preact";
import type {
  AgentInfo,
  FileEntry,
  ForegroundCommandInfo,
  PushoverConfig,
  PushoverMode,
  TerminalInfo,
} from "../../shared/types";
import { pushoverBellEnabled, setPushoverBell } from "../lib/pushover";
import { agentSubtitle } from "../lib/agent-activity";
import { agentStatusPresentation, type AgentStatusTone } from "../lib/agent-status";
import { commandSubtitle } from "../lib/command-status";
import { configureTerminalDrag } from "../lib/layout";
import {
  terminalPreviewAllowed,
  terminalPreviewPosition,
  type TerminalPreviewSettings,
} from "../lib/terminal-preview";
import type { ThemeName } from "../lib/terminal-theme";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  parseSidebarWidth,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "../lib/sidebar-width";
import { buildTerminalTree, type TerminalTreeNode } from "../lib/tree";
import { supervisorContextActive } from "../lib/supervisor-context";
import { FileExplorer } from "./FileExplorer";
import { WorkingDuration } from "./WorkingDuration";

const TerminalPreview = lazy(() =>
  import("./TerminalPreview").then((module) => ({ default: module.TerminalPreview })),
);

interface SidebarProps {
  terminals: TerminalInfo[];
  activeIds: string[];
  attentionTerminalIds: Set<string>;
  artifactCounts: ReadonlyMap<string, number>;
  mobileOpen: boolean;
  supervisor?: TerminalInfo;
  supervisorCreating: boolean;
  creating: boolean;
  settingsActive: boolean;
  updateAvailable: boolean;
  fileRoot: string;
  previewSettings: TerminalPreviewSettings;
  pushover: PushoverConfig;
  theme: ThemeName;
  onSupervisor: () => void;
  onMobileClose: () => void;
  onNew: (cwd?: string) => void;
  onOpen: (id: string) => void;
  onSplit: (id: string) => void;
  onRename: (terminal: TerminalInfo) => void;
  onRemove: (terminal: TerminalInfo) => void;
  onSettings: () => void;
  onOpenFile: (entry: FileEntry) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}

interface NodeProps {
  node: TerminalTreeNode;
  depth: number;
  collapsed: Set<string>;
  activeIds: string[];
  attentionTerminalIds: Set<string>;
  artifactCounts: ReadonlyMap<string, number>;
  pushoverEnabled: boolean;
  pushoverMode: PushoverMode;
  onTogglePushoverBell: (terminalId: string) => void;
  onPreview: (terminal: TerminalInfo, row: HTMLElement, pointerType: string) => void;
  onPreviewLeave: () => void;
  onToggle: (path: string) => void;
  onNew: (cwd?: string) => void;
  onOpen: (id: string) => void;
  onSplit: (id: string) => void;
  onRename: (terminal: TerminalInfo) => void;
  onRemove: (terminal: TerminalInfo) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}

function TreeNode({
  node,
  depth,
  collapsed,
  activeIds,
  attentionTerminalIds,
  artifactCounts,
  pushoverEnabled,
  pushoverMode,
  onTogglePushoverBell,
  onPreview,
  onPreviewLeave,
  onToggle,
  onNew,
  onOpen,
  onSplit,
  onRename,
  onRemove,
  onDragStart,
  onDragEnd,
}: NodeProps) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.path);
  const terminal = node.terminal;

  if (!hasChildren && terminal) {
    const needsAttention = attentionTerminalIds.has(terminal.id);
    const artifactCount = artifactCounts.get(terminal.id) ?? 0;
    const isSupervisor = terminal.kind === "supervisor";
    const supervisorOutsideRoot = isSupervisor && !supervisorContextActive(terminal);
    const activityClass = terminal.agent
      ? `agent-row agent-${terminal.agent.status}`
      : terminal.command
        ? `command-row command-${terminal.command.status}`
        : "shell-row";
    return (
      <div
        class={`tree-row terminal-row ${isSupervisor ? "supervisor-row" : ""} ${supervisorOutsideRoot ? "supervisor-context-outside" : ""} ${activityClass} ${needsAttention ? "activity-attention" : ""} ${activeIds.includes(terminal.id) ? "active" : ""}`}
        data-terminal-id={terminal.id}
        data-terminal-kind={terminal.kind}
        data-supervisor={isSupervisor ? "true" : "false"}
        data-supervisor-context={isSupervisor ? (supervisorOutsideRoot ? "outside" : "active") : undefined}
        style={{ "--depth": depth, "--workspace-color": terminal.color }}
        onPointerEnter={(event) => (
          onPreview(terminal, event.currentTarget, event.pointerType)
        )}
        onPointerLeave={onPreviewLeave}
      >
        <button
          class="tree-main terminal-drag-source"
          draggable
          onClick={() => onOpen(terminal.id)}
          onDragStart={(event) => {
            const transfer = event.dataTransfer;
            if (!transfer) return;
            configureTerminalDrag(transfer, terminal.id, terminal.name, "copyMove");
            onDragStart(terminal.id);
          }}
          onDragEnd={onDragEnd}
          title={supervisorOutsideRoot
            ? `Supervisor skill discovery is inactive outside ${terminal.supervisorRoot}`
            : `${terminal.name} — ${terminal.cwd}`}
        >
          <span class={`terminal-kind ${isSupervisor ? "supervisor" : terminal.agent ? "agent" : "shell"}`} aria-hidden="true" data-supervisor-identity={isSupervisor ? "sidebar" : undefined}>
            {isSupervisor ? <Crown size={14} /> : terminal.agent ? <Bot size={15} /> : <TerminalSquare size={14} />}
          </span>
          <span class="terminal-copy">
            <span class="terminal-title">{terminal.name}</span>
            <span class="terminal-meta">
              <span>{supervisorOutsideRoot
                ? "Return to supervisor directory"
                : terminal.agent
                  ? agentSubtitle(terminal.agent)
                  : terminal.command
                    ? commandSubtitle(terminal.command)
                    : isSupervisor ? "Supervisor shell" : terminal.program}</span>
              {artifactCount > 0 && (
                <span
                  class="terminal-artifact-count"
                  title={`${artifactCount} session ${artifactCount === 1 ? "artifact" : "artifacts"}`}
                >
                  <PackageOpen size={9} /> {artifactCount}
                </span>
              )}
            </span>
          </span>
          {terminal.agent && <AgentState agent={terminal.agent} needsAttention={needsAttention} />}
          {!terminal.agent && terminal.command && (
            <CommandState command={terminal.command} needsAttention={needsAttention} />
          )}
          {terminal.status === "exited" && <span class="tree-status">{terminal.exitCode ?? "exit"}</span>}
        </button>
        <span class="row-actions">
          {pushoverEnabled && (() => {
            const bellOn = pushoverBellEnabled(terminal.id, pushoverMode);
            return (
              <button
                class={`row-action pushover-bell ${bellOn ? "active" : ""}`}
                onClick={() => onTogglePushoverBell(terminal.id)}
                aria-label={bellOn ? `Disable Pushover alerts for ${terminal.name}` : `Enable Pushover alerts for ${terminal.name}`}
                title={bellOn ? `Pushover on — click to mute ${terminal.name}` : `Pushover off — click to alert for ${terminal.name}`}
              >
                {bellOn ? <Bell size={13} /> : <BellOff size={13} />}
              </button>
            );
          })()}
          <button class="row-action" onClick={() => onRename(terminal)} aria-label={`Rename ${terminal.name}`}>
            <Pencil size={13} />
          </button>
          <button class="row-action" onClick={() => onSplit(terminal.id)} aria-label={`Open ${terminal.name} in split`}>
            <SplitSquareHorizontal size={13} />
          </button>
          <button
            class="row-action danger"
            onClick={() => onRemove(terminal)}
            aria-label={`Kill ${terminal.name}`}
            title={`Kill ${terminal.name}`}
          >
            <Trash2 size={13} />
          </button>
        </span>
      </div>
    );
  }

  return (
    <div class="tree-node">
      <div
        class="tree-row category-row"
        style={{ "--depth": depth, "--workspace-color": node.color ?? "transparent" }}
      >
        <button class="tree-main" onClick={() => onToggle(node.path)} title={node.path}>
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          {isCollapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
          <span class="tree-label">{node.name}</span>
        </button>
        {node.workspaceCwd && (
          <button
            class="row-action workspace-add"
            onClick={() => onNew(node.workspaceCwd)}
            aria-label={`New terminal in ${node.path}`}
            title={`New terminal in ${node.path}`}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      {!isCollapsed && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.key}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              activeIds={activeIds}
              attentionTerminalIds={attentionTerminalIds}
              artifactCounts={artifactCounts}
              pushoverEnabled={pushoverEnabled}
              pushoverMode={pushoverMode}
              onTogglePushoverBell={onTogglePushoverBell}
              onPreview={onPreview}
              onPreviewLeave={onPreviewLeave}
              onToggle={onToggle}
              onNew={onNew}
              onOpen={onOpen}
              onSplit={onSplit}
              onRename={onRename}
              onRemove={onRemove}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const loadCollapsed = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem("term-server:collapsed") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

const loadSidebarWidth = () => {
  try {
    return parseSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
};

export function Sidebar({
  terminals,
  activeIds,
  attentionTerminalIds,
  artifactCounts,
  mobileOpen,
  supervisor,
  supervisorCreating,
  creating,
  settingsActive,
  updateAvailable,
  fileRoot,
  onSupervisor,
  previewSettings,
  pushover,
  theme,
  onMobileClose,
  onNew,
  onOpen,
  onSplit,
  onRename,
  onRemove,
  onSettings,
  onOpenFile,
  onDragStart,
  onDragEnd,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [filesOpen, setFilesOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [, setPushoverBellsTick] = useState(0);
  const sidebarWidthRef = useRef(sidebarWidth);
  const resizeStart = useRef<{ pointerId: number; x: number; width: number }>();
  const previewTimer = useRef<number>();
  const previewLeaveTimer = useRef<number>();
  const mobileCloseButton = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<{
    terminal: TerminalInfo;
    position: { left: number; top: number };
  }>();
  const matching = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? terminals.filter((terminal) => terminal.path.toLocaleLowerCase().includes(needle)) : terminals;
  }, [query, terminals]);
  const tree = useMemo(() => buildTerminalTree(matching), [matching]);

  useEffect(() => {
    const hidePreview = () => setPreview(undefined);
    window.addEventListener("resize", hidePreview);
    return () => {
      document.body.classList.remove("sidebar-resizing");
      window.removeEventListener("resize", hidePreview);
      if (previewTimer.current) clearTimeout(previewTimer.current);
      if (previewLeaveTimer.current) clearTimeout(previewLeaveTimer.current);
    };
  }, []);

  useEffect(() => {
    if (mobileOpen) requestAnimationFrame(() => mobileCloseButton.current?.focus());
  }, [mobileOpen]);

  const clearPreviewTimers = () => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (previewLeaveTimer.current) clearTimeout(previewLeaveTimer.current);
    previewTimer.current = undefined;
    previewLeaveTimer.current = undefined;
  };

  useEffect(() => {
    if (!preview || terminals.some((terminal) => terminal.id === preview.terminal.id)) return;
    clearPreviewTimers();
    setPreview(undefined);
  }, [preview, terminals]);

  useEffect(() => {
    if (filesOpen || mobileOpen || !previewSettings.enabled) {
      clearPreviewTimers();
      setPreview(undefined);
    }
  }, [filesOpen, mobileOpen, previewSettings.enabled]);

  const beginPreview = (terminal: TerminalInfo, row: HTMLElement, pointerType: string) => {
    if (!terminalPreviewAllowed(previewSettings.enabled, pointerType)) return;
    clearPreviewTimers();
    const rectangle = row.getBoundingClientRect();
    previewTimer.current = window.setTimeout(() => {
      setPreview({
        terminal,
        position: terminalPreviewPosition(rectangle, window.innerHeight),
      });
      previewTimer.current = undefined;
    }, previewSettings.hoverDelay);
  };

  const leavePreview = () => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = undefined;
    previewLeaveTimer.current = window.setTimeout(() => {
      setPreview(undefined);
      previewLeaveTimer.current = undefined;
    }, 80);
  };

  const updateSidebarWidth = (width: number, persist = false) => {
    sidebarWidthRef.current = width;
    setSidebarWidth(width);
    if (persist) localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  };

  const startResize = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    resizeStart.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      width: handle.parentElement?.getBoundingClientRect().width ?? sidebarWidthRef.current,
    };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("sidebar-resizing");
    event.preventDefault();
  };

  const moveResize = (event: PointerEvent) => {
    const start = resizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    updateSidebarWidth(clampSidebarWidth(start.width + event.clientX - start.x, window.innerWidth));
  };

  const finishResize = (event: PointerEvent) => {
    const start = resizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const handle = event.currentTarget as HTMLElement;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    resizeStart.current = undefined;
    document.body.classList.remove("sidebar-resizing");
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidthRef.current));
  };

  const resizeWithKeyboard = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 32 : 10;
    let width: number | undefined;
    if (event.key === "ArrowLeft") width = sidebarWidthRef.current - step;
    if (event.key === "ArrowRight") width = sidebarWidthRef.current + step;
    if (event.key === "Home") width = MIN_SIDEBAR_WIDTH;
    if (event.key === "End") width = MAX_SIDEBAR_WIDTH;
    if (width === undefined) return;
    event.preventDefault();
    updateSidebarWidth(clampSidebarWidth(width, window.innerWidth), true);
  };

  const resetSidebarWidth = () => {
    updateSidebarWidth(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, window.innerWidth), true);
  };

  const togglePushoverBell = (terminalId: string) => {
    setPushoverBell(terminalId, !pushoverBellEnabled(terminalId, pushover.mode));
    setPushoverBellsTick((tick) => tick + 1);
  };

  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsed(next);
    localStorage.setItem("term-server:collapsed", JSON.stringify([...next]));
  };
  const collapseAll = () => {
    const categoryPaths: string[] = [];
    const collect = (nodes: TerminalTreeNode[]) => {
      for (const node of nodes) {
        if (node.children.length) categoryPaths.push(node.path);
        collect(node.children);
      }
    };
    collect(tree);
    setCollapsed(new Set(categoryPaths));
    localStorage.setItem("term-server:collapsed", JSON.stringify(categoryPaths));
  };

  return (
    <aside
      class={`sidebar ${mobileOpen ? "mobile-open" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` }}
      role={mobileOpen ? "dialog" : undefined}
      aria-modal={mobileOpen ? "true" : undefined}
      aria-label={mobileOpen ? "Workspaces and files" : undefined}
    >
      <header class="sidebar-header">
        <span>{filesOpen ? "FILES" : "WORKSPACES"}</span>
        <div>
          <button ref={mobileCloseButton} class="icon-button mobile-only" onClick={onMobileClose} aria-label="Close sidebar"><X size={18} /></button>
          <button
            class={`icon-button ${filesOpen ? "active" : ""}`}
            onClick={() => setFilesOpen((current) => !current)}
            aria-label={filesOpen ? "Show terminal workspaces" : "Open file explorer"}
            title={filesOpen ? "Terminal workspaces" : "File explorer"}
          >
            {filesOpen ? <TerminalSquare size={15} /> : <FolderSearch size={15} />}
          </button>
          <button
            class={`icon-button supervisor-action ${supervisor ? "active" : ""}`}
            onClick={onSupervisor}
            disabled={supervisorCreating}
            aria-busy={supervisorCreating}
            aria-label={supervisorCreating
              ? "Creating supervisor terminal"
              : supervisor ? "Open supervisor terminal" : "Create supervisor terminal"}
            title={supervisorCreating
              ? "Creating supervisor terminal…"
              : supervisor ? "Open supervisor terminal" : "Create supervisor terminal"}
            data-supervisor-action="true"
            data-supervisor-open={supervisor ? "true" : "false"}
          >
            <Crown size={15} />
          </button>
          {!filesOpen && (
            <>
              <button class="icon-button" onClick={() => onNew()} disabled={creating} aria-label="New terminal in home" title="New terminal in home">
                {creating ? <LoaderCircle class="spin" size={15} /> : <Plus size={16} />}
              </button>
              <button class="icon-button" onClick={collapseAll} aria-label="Collapse all" title="Collapse all"><ChevronsDownUp size={15} /></button>
            </>
          )}
        </div>
      </header>
      {filesOpen ? (
        <FileExplorer initialRoot={fileRoot} onOpen={onOpenFile} />
      ) : (
        <>
          <div class="tree-search">
            <Search size={14} />
            <input
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="Filter workspaces"
              aria-label="Filter workspaces"
            />
            {query && <button onClick={() => setQuery("")} aria-label="Clear filter"><X size={13} /></button>}
          </div>
          <div class="tree" role="tree">
            {tree.map((node) => (
              <TreeNode
                key={node.key}
                node={node}
                depth={0}
                collapsed={query ? new Set() : collapsed}
                activeIds={activeIds}
                attentionTerminalIds={attentionTerminalIds}
                artifactCounts={artifactCounts}
                pushoverEnabled={pushover.enabled}
                pushoverMode={pushover.mode}
                onTogglePushoverBell={togglePushoverBell}
                onPreview={beginPreview}
                onPreviewLeave={leavePreview}
                onToggle={toggle}
                onNew={onNew}
                onOpen={onOpen}
                onSplit={onSplit}
                onRename={onRename}
                onRemove={onRemove}
                onDragStart={(id) => {
                  clearPreviewTimers();
                  setPreview(undefined);
                  onDragStart(id);
                }}
                onDragEnd={onDragEnd}
              />
            ))}
            {!matching.length && (
              <div class="sidebar-empty">
                <TerminalSquare size={20} />
                <span>{terminals.length ? "No matching workspaces" : "No terminals yet"}</span>
                {!terminals.length && <button onClick={() => onNew()}>Create one</button>}
              </div>
            )}
          </div>
        </>
      )}

      <footer class="sidebar-footer">
        <button
          class={`sidebar-settings ${settingsActive ? "active" : ""}`}
          onClick={onSettings}
          aria-pressed={settingsActive}
        >
          <Settings size={14} /> Settings
        </button>
        {updateAvailable && (
          <button class="sidebar-update" onClick={onSettings}>
            <Download size={13} />
            Update
          </button>
        )}
        <span class="footer-spacer" />
        <span class="status-dot online" />
        <span>{terminals.filter((terminal) => terminal.status === "running").length}</span>
      </footer>
      {preview && (
        <Suspense fallback={null}>
          <TerminalPreview
            terminal={preview.terminal}
            theme={theme}
            mode={previewSettings.mode}
            position={preview.position}
            animationDuration={previewSettings.animationDuration}
          />
        </Suspense>
      )}
      <div
        class="sidebar-resize-handle"
        role="separator"
        aria-label="Resize workspace sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        title="Drag to resize · Double-click to reset"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onKeyDown={resizeWithKeyboard}
        onDblClick={resetSidebarWidth}
      />
    </aside>
  );
}

const AGENT_STATUS_ICONS: Record<AgentStatusTone, typeof Activity> = {
  blocked: Hand,
  attention: Bell,
  working: Activity,
  idle: CirclePause,
  closed: CircleX,
};

function AgentState({ agent, needsAttention }: { agent: AgentInfo; needsAttention: boolean }) {
  const { tone, label, description } = agentStatusPresentation(agent, needsAttention);
  const Icon = AGENT_STATUS_ICONS[tone];
  return (
    <span
      class={`activity-status-badge ${tone}`}
      title={agent.summary ?? description}
      aria-label={tone === "working" ? undefined : description}
    >
      <Icon size={12} strokeWidth={2.2} aria-hidden="true" />
      {tone === "working" ? <WorkingDuration since={agent.statusChangedAt} /> : <span class="activity-status-label">{label}</span>}
    </span>
  );
}

function CommandState({
  command,
  needsAttention,
}: {
  command: ForegroundCommandInfo;
  needsAttention: boolean;
}) {
  const label = command.status === "live" ? "Live" : "Done";
  const Icon = needsAttention
    ? Bell
    : command.status === "running"
      ? Activity
      : command.status === "live"
        ? Radio
        : CircleCheck;
  const stateTitle = command.status === "running"
    ? `${command.name} is running`
    : command.status === "live"
      ? `${command.name} is live`
      : `${command.name} finished`;
  const title = needsAttention ? `${stateTitle} — unread` : stateTitle;
  return (
    <span
      class={`activity-status-badge ${needsAttention ? "attention" : command.status}`}
      title={title}
      aria-label={command.status === "running" ? undefined : title}
    >
      <Icon size={12} strokeWidth={2.2} aria-hidden="true" />
      {command.status === "running"
        ? <WorkingDuration since={command.startedAt} />
        : <span class="activity-status-label">{label}</span>}
    </span>
  );
}
