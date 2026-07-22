import { useEffect, useRef, useState } from "preact/hooks";
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronUp,
  CircleCheckBig,
  CirclePause,
  ClipboardCopy,
  ClipboardPaste,
  CopyPlus,
  EllipsisVertical,
  GripVertical,
  ListTree,
  Search,
  Trash2,
  WifiOff,
  X,
} from "lucide-preact";
import { Terminal as XTerm, type ILink, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { ClientConfig, FileEntry, FileTarget, ServerTerminalMessage, TerminalInfo } from "../../shared/types";
import { configureTerminalDrag } from "../lib/layout";
import { api } from "../lib/api";
import { createHoverPreviewController, findFileLinks, imagePreviewPosition } from "../lib/file-links";
import { ProcessInspector } from "./ProcessInspector";
import { WorkingDuration } from "./WorkingDuration";

export type ThemeName = "dark" | "light";

interface TerminalPaneProps {
  terminal: TerminalInfo;
  config: ClientConfig;
  theme: ThemeName;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  onRemove: () => void;
  onClone: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onExit: () => void;
  onUpdate: (terminal: TerminalInfo) => void;
  onNotice: (message: string) => void;
  onOpenFile: (target: FileTarget) => void;
}

const terminalThemes: Record<ThemeName, ITheme> = {
  dark: {
    background: "#1e1e1e",
    foreground: "#cccccc",
    cursor: "#aeafad",
    cursorAccent: "#1e1e1e",
    selectionBackground: "#264f78",
    selectionInactiveBackground: "#3a3d41",
    black: "#000000",
    red: "#f14c4c",
    green: "#23d18b",
    yellow: "#f5f543",
    blue: "#3b8eea",
    magenta: "#d670d6",
    cyan: "#29b8db",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  },
  light: {
    background: "#ffffff",
    foreground: "#383a42",
    cursor: "#111111",
    selectionBackground: "#add6ff",
    selectionInactiveBackground: "#e5ebf1",
    black: "#000000",
    red: "#cd3131",
    green: "#00bc00",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#cd3131",
    brightGreen: "#14ce14",
    brightYellow: "#b5ba00",
    brightBlue: "#0451a5",
    brightMagenta: "#bc05bc",
    brightCyan: "#0598bc",
    brightWhite: "#a5a5a5",
  },
};

function mixedBackground(theme: ThemeName, accent: string): string {
  const base = theme === "dark" ? "#1e1e1e" : "#ffffff";
  const ratio = theme === "dark" ? 0.065 : 0.035;
  const parse = (value: string) => [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  if (!/^#[0-9a-f]{6}$/i.test(accent)) return base;
  const baseRgb = parse(base);
  const accentRgb = parse(accent);
  const channels = baseRgb.map((value, index) => Math.round(value * (1 - ratio) + accentRgb[index]! * ratio));
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

const terminalTheme = (theme: ThemeName, accent: string): ITheme => ({
  ...terminalThemes[theme],
  background: mixedBackground(theme, accent),
});

const searchOptions = (theme: ThemeName, incremental = false): ISearchOptions => ({
  incremental,
  decorations: theme === "dark"
    ? {
        matchBackground: "#6b5318",
        matchBorder: "#d6a53a",
        matchOverviewRuler: "#d6a53a",
        activeMatchBackground: "#b57a16",
        activeMatchBorder: "#ffd866",
        activeMatchColorOverviewRuler: "#ffd866",
      }
    : {
        matchBackground: "#ffe59a",
        matchBorder: "#c58b00",
        matchOverviewRuler: "#c58b00",
        activeMatchBackground: "#f2b632",
        activeMatchBorder: "#8a5d00",
        activeMatchColorOverviewRuler: "#8a5d00",
      },
});

function fileLinkWindow(term: XTerm, bufferLineNumber: number) {
  let top = bufferLineNumber - 1;
  while (top > 0 && term.buffer.active.getLine(top)?.isWrapped) top -= 1;
  const parts: string[] = [];
  let row = top;
  while (parts.join("").length < 2048) {
    const line = term.buffer.active.getLine(row);
    if (!line) break;
    const continues = term.buffer.active.getLine(row + 1)?.isWrapped ?? false;
    parts.push(line.translateToString(!continues));
    if (!continues) break;
    row += 1;
  }
  return { text: parts.join(""), top };
}

export function TerminalPane({
  terminal,
  config,
  theme,
  active,
  onActivate,
  onClose,
  onRemove,
  onClone,
  onDragStart,
  onDragEnd,
  onExit,
  onUpdate,
  onNotice,
  onOpenFile,
}: TerminalPaneProps) {
  const container = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const mobileActions = useRef<HTMLDivElement>(null);
  const xterm = useRef<XTerm>();
  const searchAddon = useRef<SearchAddon>();
  const searchInput = useRef<HTMLInputElement>(null);
  const socket = useRef<WebSocket>();
  const exited = useRef(terminal.status === "exited");
  const reconnectTimer = useRef<number>();
  const terminalState = useRef(terminal);
  const openFile = useRef(onOpenFile);
  terminalState.current = terminal;
  openFile.current = onOpenFile;
  const [processesOpen, setProcessesOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState({ index: -1, count: 0 });
  const [imagePreview, setImagePreview] = useState<{ file: FileEntry; left: number; top: number }>();
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected" | "exited">(
    terminal.status === "exited" ? "exited" : "connecting",
  );

  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let attempts = 0;
    let resizeFrame = 0;
    const fit = new FitAddon();
    const search = new SearchAddon({ highlightLimit: 1000 });
    const term = new XTerm({
      // The official search addon's multi-match decorations use xterm's decoration API.
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
      fontSize: 13,
      letterSpacing: 0,
      lineHeight: 1.15,
      minimumContrastRatio: 1,
      scrollback: config.scrollbackLines,
      scrollSensitivity: 1.5,
      smoothScrollDuration: 0,
      theme: terminalTheme(theme, terminal.color),
    });
    xterm.current = term;
    searchAddon.current = search;
    term.loadAddon(fit);
    term.loadAddon(search);
    const searchResultsDisposable = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setSearchResults({ index: resultIndex, count: resultCount });
    });
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, "_blank", "noopener,noreferrer");
      }),
    );
    term.open(container.current);
    const imagePreviews = createHoverPreviewController<
      { key: string; path: string; cwd: string; left: number; top: number },
      FileEntry
    >({
      load: async ({ path, cwd }) => {
        const file = await api.fileMetadata({ path, cwd });
        return file.image ? file : undefined;
      },
      show: (file, position) => setImagePreview({ file, left: position.left, top: position.top }),
      hide: () => setImagePreview(undefined),
    });
    const fileLinksDisposable = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = fileLinkWindow(term, bufferLineNumber);
        if (!line.text) {
          callback(undefined);
          return;
        }
        const links: ILink[] = findFileLinks(line.text).flatMap((match) => {
          const endIndex = match.end - 1;
          const startRow = line.top + Math.floor(match.start / term.cols) + 1;
          const endRow = line.top + Math.floor(endIndex / term.cols) + 1;
          if (bufferLineNumber < startRow || bufferLineNumber > endRow) return [];
          return [{
            text: match.text,
            range: {
              start: { x: match.start % term.cols + 1, y: startRow },
              end: { x: endIndex % term.cols + 1, y: endRow },
            },
            decorations: { pointerCursor: true, underline: true },
            activate(event, text) {
              if (event.ctrlKey || event.metaKey) {
                imagePreviews.clear();
                openFile.current({ path: text, cwd: terminalState.current.cwd });
              }
            },
            hover(event, text) {
              const position = imagePreviewPosition(event.clientX, event.clientY);
              const cwd = terminalState.current.cwd;
              imagePreviews.hover({ key: `${cwd}\u0000${text}`, path: text, cwd, ...position });
            },
            leave() {
              imagePreviews.leave();
            },
          }];
        });
        callback(links.length ? links : undefined);
      },
    });
    void import("@xterm/addon-webgl").then(({ WebglAddon }) => {
      if (disposed) return;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // xterm's built-in renderer is the compatibility fallback.
      }
    });

    const send = (message: unknown) => {
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
    };
    const fitAndResize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (!container.current?.clientWidth || !container.current.clientHeight) return;
        try {
          fit.fit();
          send({ type: "resize", cols: term.cols, rows: term.rows });
        } catch {
          // The pane may be between layout states.
        }
      });
    };

    term.onData((data) => send({ type: "input", data }));
    term.attachCustomKeyEventHandler((event) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.shiftKey && event.code === "KeyC" && event.type === "keydown") {
        event.preventDefault();
        if (term.hasSelection()) {
          void navigator.clipboard?.writeText(term.getSelection()).catch(() => onNotice("Clipboard permission was denied"));
        }
        return false;
      }
      if (modifier && event.shiftKey && event.code === "KeyV" && event.type === "keydown") {
        void navigator.clipboard?.readText().then((value) => term.paste(value)).catch(() => onNotice("Clipboard permission was denied"));
        return false;
      }
      return true;
    });

    const connect = () => {
      if (disposed || exited.current) return;
      if (attempts > 0) term.reset();
      setConnection("connecting");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const next = new WebSocket(`${protocol}//${location.host}/api/terminals/${terminal.id}/socket`);
      next.binaryType = "arraybuffer";
      socket.current = next;
      next.addEventListener("open", () => {
        attempts = 0;
        setConnection("connected");
        fitAndResize();
        term.focus();
      });
      next.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
          return;
        }
        if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((data) => term.write(new Uint8Array(data)));
          return;
        }
        try {
          const message = JSON.parse(String(event.data)) as ServerTerminalMessage;
          if (message.type === "ready") onUpdate(message.terminal);
          if (message.type === "exit") {
            exited.current = true;
            setConnection("exited");
            onExit();
          }
          if (message.type === "error") onNotice(message.message);
        } catch {
          // Ignore malformed control frames; terminal data is always binary.
        }
      });
      next.addEventListener("close", () => {
        if (disposed || exited.current) return;
        setConnection("disconnected");
        attempts += 1;
        reconnectTimer.current = window.setTimeout(connect, Math.min(5000, 250 * 2 ** attempts));
      });
      next.addEventListener("error", () => next.close());
    };

    const observer = new ResizeObserver(fitAndResize);
    observer.observe(container.current);
    connect();
    fitAndResize();

    return () => {
      disposed = true;
      cancelAnimationFrame(resizeFrame);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      observer.disconnect();
      imagePreviews.clear();
      fileLinksDisposable.dispose();
      searchResultsDisposable.dispose();
      socket.current?.close(1000, "Pane closed");
      socket.current = undefined;
      term.dispose();
      xterm.current = undefined;
      searchAddon.current = undefined;
    };
  }, [terminal.id, config.scrollbackLines]);

  useEffect(() => {
    if (xterm.current) xterm.current.options.theme = terminalTheme(theme, terminal.color);
  }, [theme, terminal.color]);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = requestAnimationFrame(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);

  useEffect(() => {
    if (!actionsOpen) return;
    const closeActions = (event: PointerEvent) => {
      if (!mobileActions.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    const closeActionsOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionsOpen(false);
    };
    window.addEventListener("pointerdown", closeActions);
    window.addEventListener("keydown", closeActionsOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeActions);
      window.removeEventListener("keydown", closeActionsOnEscape);
    };
  }, [actionsOpen]);

  useEffect(() => {
    if (!active) setActionsOpen(false);
  }, [active]);

  useEffect(() => {
    const search = searchAddon.current;
    if (!search) return;
    if (!searchOpen || !searchQuery) {
      search.clearDecorations();
      setSearchResults({ index: -1, count: 0 });
      return;
    }
    search.findNext(searchQuery, searchOptions(theme, true));
  }, [searchOpen, searchQuery, theme]);

  useEffect(() => {
    if (!active) return;
    const handleFind = (event: KeyboardEvent) => {
      const target = event.target as Node | null;
      if (target && !pane.current?.contains(target) && document.activeElement !== document.body) return;
      if (searchOpen && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(false);
        searchAddon.current?.clearDecorations();
        requestAnimationFrame(() => xterm.current?.focus());
        return;
      }
      if (
        !(event.ctrlKey || event.metaKey)
        || event.shiftKey
        || event.altKey
        || event.key.toLocaleLowerCase() !== "f"
      ) return;
      event.preventDefault();
      event.stopPropagation();
      if (!searchOpen) {
        const selection = xterm.current?.getSelection();
        if (selection) setSearchQuery(selection);
      }
      setSearchOpen(true);
      requestAnimationFrame(() => {
        searchInput.current?.focus();
        searchInput.current?.select();
      });
    };
    window.addEventListener("keydown", handleFind, true);
    return () => window.removeEventListener("keydown", handleFind, true);
  }, [active, searchOpen]);

  const find = (previous: boolean) => {
    if (!searchQuery) return;
    const search = searchAddon.current;
    if (!search) return;
    const options = searchOptions(theme);
    if (previous) search.findPrevious(searchQuery, options);
    else search.findNext(searchQuery, options);
    searchInput.current?.focus();
  };

  const closeSearch = () => {
    setSearchOpen(false);
    searchAddon.current?.clearDecorations();
    requestAnimationFrame(() => xterm.current?.focus());
  };

  const copy = async () => {
    const selection = xterm.current?.getSelection();
    if (!selection) {
      onNotice("Select terminal text before copying");
      return;
    }
    if (!navigator.clipboard?.writeText) {
      onNotice("Clipboard access requires HTTPS or localhost");
      return;
    }
    try {
      await navigator.clipboard.writeText(selection);
      onNotice("Copied selection");
    } catch {
      onNotice("Clipboard permission was denied");
    }
  };
  const paste = async () => {
    if (!navigator.clipboard?.readText) {
      onNotice("Clipboard access requires HTTPS or localhost");
      xterm.current?.focus();
      return;
    }
    try {
      xterm.current?.paste(await navigator.clipboard.readText());
    } catch {
      onNotice("Clipboard permission was denied");
    }
  };

  return (
    <section
      ref={pane}
      class={`terminal-pane ${active ? "active" : ""}`}
      style={{
        "--terminal-color": terminal.color,
        "--terminal-background": mixedBackground(theme, terminal.color),
      }}
      onPointerDown={onActivate}
    >
      <header
        class="pane-header"
        draggable
        onDragStart={(event) => {
          if ((event.target as HTMLElement).closest("button")) {
            event.preventDefault();
            return;
          }
          const transfer = event.dataTransfer;
          if (!transfer) return;
          configureTerminalDrag(transfer, terminal.id, terminal.name, "move");
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        title="Drag to tile or reorder this pane"
      >
        <span class="pane-drag-handle" aria-hidden="true">
          <GripVertical size={13} />
        </span>
        <span class="terminal-color" style={{ background: terminal.color }} />
        <TerminalPath path={terminal.path} />
        {terminal.agent && (
          <PaneAgentState agent={terminal.agent} />
        )}
        <span class={`connection ${connection}`} title={connection} />
        <span class="pane-spacer" />
        <span class="desktop-pane-actions">
          <button
            class={`pane-action ${processesOpen ? "active" : ""}`}
            onClick={() => setProcessesOpen((current) => !current)}
            aria-label="Inspect terminal processes"
            aria-expanded={processesOpen}
            title="Inspect live child processes"
          >
            <ListTree size={14} />
          </button>
          <button class="pane-action" onClick={onClone} aria-label="Clone terminal" title="New terminal in this directory">
            <CopyPlus size={14} />
          </button>
          <button class="pane-action danger" onClick={onRemove} aria-label="Kill terminal" title="Kill terminal">
            <Trash2 size={14} />
          </button>
          <button class="pane-action" onClick={onClose} aria-label="Close pane" title="Close pane">
            <X size={15} />
          </button>
        </span>
        <div ref={mobileActions} class="mobile-pane-actions">
          <button
            class={`pane-action ${actionsOpen ? "active" : ""}`}
            onClick={() => setActionsOpen((current) => !current)}
            aria-label="Terminal actions"
            aria-expanded={actionsOpen}
          >
            <EllipsisVertical size={19} />
          </button>
          {actionsOpen && (
            <div class="pane-action-menu" role="menu">
              <button role="menuitem" onClick={() => { setActionsOpen(false); setSearchOpen(true); }}>
                <Search size={16} /> Search scrollback
              </button>
              <button role="menuitem" onClick={() => { setActionsOpen(false); void copy(); }}>
                <ClipboardCopy size={16} /> Copy selection
              </button>
              <button role="menuitem" onClick={() => { setActionsOpen(false); void paste(); }}>
                <ClipboardPaste size={16} /> Paste
              </button>
              <button role="menuitem" onClick={() => { setActionsOpen(false); setProcessesOpen(true); }}>
                <ListTree size={16} /> Inspect processes
              </button>
              <button role="menuitem" onClick={() => { setActionsOpen(false); onClone(); }}>
                <CopyPlus size={16} /> Clone terminal
              </button>
              <button class="danger" role="menuitem" onClick={() => { setActionsOpen(false); onRemove(); }}>
                <Trash2 size={16} /> Kill terminal
              </button>
              <button role="menuitem" onClick={() => { setActionsOpen(false); onClose(); }}>
                <X size={16} /> Close pane
              </button>
            </div>
          )}
        </div>
      </header>
      <div
        ref={container}
        class="xterm-host"
        onContextMenu={(event) => {
          event.preventDefault();
          if (xterm.current?.hasSelection()) void copy();
          else void paste();
        }}
      />
      {searchOpen && (
        <div class="terminal-search" role="search" onPointerDown={(event) => event.stopPropagation()}>
          <Search size={13} aria-hidden="true" />
          <input
            ref={searchInput}
            value={searchQuery}
            onInput={(event) => setSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              } else if (event.key === "Enter") {
                event.preventDefault();
                find(event.shiftKey);
              }
            }}
            placeholder="Search terminal"
            aria-label="Search terminal scrollback"
            autocomplete="off"
            spellcheck={false}
          />
          <span class={`terminal-search-results ${searchQuery && searchResults.count === 0 ? "empty" : ""}`} aria-live="polite">
            {searchQuery
              ? searchResults.count
                ? `${searchResults.index >= 0 ? searchResults.index + 1 : "?"}/${searchResults.count}`
                : "No results"
              : ""}
          </span>
          <button class="pane-action" onClick={() => find(true)} disabled={!searchQuery} aria-label="Previous match" title="Previous match (Shift+Enter)">
            <ChevronUp size={14} />
          </button>
          <button class="pane-action" onClick={() => find(false)} disabled={!searchQuery} aria-label="Next match" title="Next match (Enter)">
            <ChevronDown size={14} />
          </button>
          <button class="pane-action" onClick={closeSearch} aria-label="Close terminal search" title="Close (Escape)">
            <X size={14} />
          </button>
        </div>
      )}
      {imagePreview && (
        <div
          class="terminal-image-preview xterm-hover"
          style={{ left: `${imagePreview.left}px`, top: `${imagePreview.top}px` }}
          role="tooltip"
        >
          <header>
            <span>{imagePreview.file.name}</span>
            <small>Ctrl+click to open</small>
          </header>
          <img src={api.rawFileUrl({ path: imagePreview.file.path })} alt={imagePreview.file.name} />
        </div>
      )}
      {processesOpen && <ProcessInspector terminalId={terminal.id} onClose={() => setProcessesOpen(false)} />}
      {connection === "disconnected" && <div class="pane-banner"><WifiOff size={13} /> Reconnecting…</div>}
      {connection === "exited" && <div class="pane-banner exited">Process exited with code {terminal.exitCode ?? 0}</div>}
    </section>
  );
}

function PaneAgentState({ agent }: { agent: NonNullable<TerminalInfo["agent"]> }) {
  const label = agent.status === "working" ? "Working" : agent.status === "idle" ? "Idle" : "Done";
  const Icon = agent.status === "working" ? Activity : agent.status === "idle" ? CirclePause : CircleCheckBig;
  return (
    <span class={`pane-agent ${agent.status}`} title={agent.summary ?? `${agent.kind} is ${label.toLocaleLowerCase()}`}>
      <Bot size={12} aria-hidden="true" />
      <span class="pane-agent-kind">{agent.kind}</span>
      <span class="pane-agent-state">
        <Icon size={11} strokeWidth={2.2} aria-hidden="true" />
        {agent.status === "working" ? <WorkingDuration since={agent.statusChangedAt} /> : label}
      </span>
    </span>
  );
}

function TerminalPath({ path }: { path: string }) {
  const segments = path.split("/");
  return (
    <div class="pane-path" title={path}>
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`}>
          {index > 0 && <b>/</b>}
          {segment}
        </span>
      ))}
    </div>
  );
}
