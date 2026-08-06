import { useEffect, useRef, useState } from "preact/hooks";
import {
  Activity,
  Bell,
  Bot,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CirclePause,
  CircleX,
  ClipboardCopy,
  ClipboardPaste,
  CopyPlus,
  EllipsisVertical,
  GripVertical,
  ListTree,
  Maximize2,
  PackageOpen,
  Radio,
  RefreshCw,
  Search,
  TerminalSquare,
  TriangleAlert,
  Trash2,
  WifiOff,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-preact";
import { Terminal as XTerm, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type {
  ArtifactEntry,
  ClientConfig,
  ClientTerminalMessage,
  FileEntry,
  FileTarget,
  ServerTerminalMessage,
  TerminalInfo,
} from "../../shared/types";
import { configureTerminalDrag } from "../lib/layout";
import { api } from "../lib/api";
import { createHoverPreviewController, findFileLinks, imagePreviewPosition } from "../lib/file-links";
import {
  installTerminalTouchScroll,
  NO_TERMINAL_MODIFIERS,
  transformTerminalInput,
  type TerminalModifiers,
} from "../lib/mobile-terminal";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  terminalZoomPercent,
} from "../lib/terminal-zoom";
import { addTerminalStreamProtocol, closeTerminalSocket } from "../lib/terminal-socket";
import {
  encodeBytesBase64,
  encodeTextBase64,
  isDebugRecordingActive,
  recordDebugEvent,
} from "../lib/debug-recording";
import {
  encodeTerminalBinary,
  encodeTerminalText,
  sendTerminalChunks,
  terminalDataDisposition,
  trackTerminalUserInput,
} from "../lib/terminal-input";
import {
  TERMINAL_FRAME_OUTPUT,
  TerminalRenderBacklog,
  TerminalStreamState,
  decodeTerminalFrame,
  type TerminalFrame,
  type TerminalStreamIssue,
} from "../lib/terminal-stream";
import {
  createSettledTask,
  terminalViewportSize,
} from "../lib/terminal-viewport";
import { PanoptesUnicode17Addon } from "../lib/terminal-unicode";
import {
  mixedTerminalBackground,
  terminalTheme,
  type ThemeName,
} from "../lib/terminal-theme";
import { ProcessInspector } from "./ProcessInspector";
import { ArtifactDrawer } from "./ArtifactDrawer";
import { WorkingDuration } from "./WorkingDuration";

interface TerminalPaneProps {
  terminal: TerminalInfo;
  config: ClientConfig;
  theme: ThemeName;
  fontSize: number;
  active: boolean;
  visible: boolean;
  needsAttention: boolean;
  artifacts: ArtifactEntry[];
  onActivate: () => void;
  onClose: () => void;
  onRemove: () => void;
  onClone: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onExit: () => void;
  onUpdate: (terminal: TerminalInfo) => void;
  onStreamIssue: (issue?: TerminalStreamIssue) => void;
  onNotice: (message: string) => void;
  onFontSizeChange: (fontSize: number) => void;
  onOpenFile: (target: FileTarget) => void;
  onOpenArtifact: (artifact: ArtifactEntry) => void;
  onDeleteArtifact: (artifact: ArtifactEntry) => Promise<void>;
}

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
  fontSize,
  active,
  visible,
  needsAttention,
  artifacts,
  onActivate,
  onClose,
  onRemove,
  onClone,
  onDragStart,
  onDragEnd,
  onExit,
  onUpdate,
  onStreamIssue,
  onNotice,
  onFontSizeChange,
  onOpenFile,
  onOpenArtifact,
  onDeleteArtifact,
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
  const reportTerminalViewport = useRef<() => void>();
  const setTerminalVisibility = useRef<(visible: boolean) => void>();
  const terminalState = useRef(terminal);
  const openFile = useRef(onOpenFile);
  const streamIssue = useRef(onStreamIssue);
  const activeState = useRef(active);
  const visibleState = useRef(visible);
  const modifiers = useRef<TerminalModifiers>(NO_TERMINAL_MODIFIERS);
  terminalState.current = terminal;
  openFile.current = onOpenFile;
  streamIssue.current = onStreamIssue;
  activeState.current = active;
  visibleState.current = visible;
  const [processesOpen, setProcessesOpen] = useState(false);
  const knownArtifactIds = useRef(new Set(artifacts.map((artifact) => artifact.id)));
  const [artifactsOpen, setArtifactsOpen] = useState(artifacts.length > 0);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState({ index: -1, count: 0 });
  const [mobileModifiers, setMobileModifiers] = useState(NO_TERMINAL_MODIFIERS);
  const [scrolledBack, setScrolledBack] = useState(false);
  const [imagePreview, setImagePreview] = useState<{ file: FileEntry; left: number; top: number }>();
  const [terminalSize, setTerminalSize] = useState({ focused: false, controller: false });
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "recovering" | "disconnected" | "exited"
  >(
    terminal.status === "exited" ? "exited" : "connecting",
  );
  const artifactSignature = artifacts.map((artifact) => artifact.id).join("\u0000");
  const artifactsVisible = artifactsOpen && artifacts.length > 0;

  useEffect(() => {
    const discovered = artifacts.some((artifact) => !knownArtifactIds.current.has(artifact.id));
    for (const artifact of artifacts) knownArtifactIds.current.add(artifact.id);
    if (!discovered) return;
    setProcessesOpen(false);
    setArtifactsOpen(true);
  }, [artifactSignature]);

  const updateMobileModifiers = (next: TerminalModifiers) => {
    modifiers.current = next;
    setMobileModifiers(next);
  };

  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let attempts = 0;
    const fit = new FitAddon();
    const search = new SearchAddon({ highlightLimit: 1000 });
    const term = new XTerm({
      // The official search addon's multi-match decorations use xterm's decoration API.
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      disableStdin: true,
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
      fontSize,
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
    term.loadAddon(new PanoptesUnicode17Addon());
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

    const send = (message: ClientTerminalMessage) => {
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
    };
    const sendTextInput = (data: string) => {
      if (isDebugRecordingActive()) {
        recordDebugEvent(terminal.id, { type: "input", data: encodeTextBase64(data) });
      }
      const current = socket.current;
      if (current?.readyState === WebSocket.OPEN) {
        sendTerminalChunks(current, encodeTerminalText(data));
      }
    };
    const sendBinaryInput = (data: string) => {
      if (isDebugRecordingActive()) {
        recordDebugEvent(terminal.id, { type: "input", data: encodeTextBase64(data) });
      }
      const current = socket.current;
      if (current?.readyState === WebSocket.OPEN) {
        sendTerminalChunks(current, encodeTerminalBinary(data));
      }
    };
    const stream = new TerminalStreamState();
    const backlog = new TerminalRenderBacklog();
    let acceptingInput = false;
    let parsingOutput = false;
    let responder = false;
    let messageQueue = Promise.resolve();
    let lastServerMessage = Date.now();
    let hasSynced = false;
    let recoveringOutput = false;
    let reportedIssue = "";
    let suspendSocket: (() => void) | undefined;
    const reportStreamIssue = (issue?: TerminalStreamIssue) => {
      const key = issue ? `${issue.kind}:${issue.pendingBytes ?? 0}` : "";
      if (key === reportedIssue) return;
      reportedIssue = key;
      streamIssue.current(issue);
    };
    const proposedViewport = () => {
      if (!container.current?.clientWidth || !container.current.clientHeight) return;
      try {
        const proposed = fit.proposeDimensions();
        const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
        if (!proposed || !screen) return;
        const bounds = screen.getBoundingClientRect();
        return terminalViewportSize(proposed, {
          cols: term.cols,
          rows: term.rows,
          pixelWidth: bounds.width,
          pixelHeight: bounds.height,
        });
      } catch {
        // The pane may be between layout states.
      }
    };
    let reportedViewport = "";
    const viewportReporter = createSettledTask(() => {
      if (!visibleState.current) return;
      const size = proposedViewport();
      if (!size) return;
      const key = `${size.cols}x${size.rows}@${size.pixelWidth}x${size.pixelHeight}`;
      if (key === reportedViewport) return;
      reportedViewport = key;
      recordDebugEvent(terminal.id, {
        type: "resize",
        cols: size.cols,
        rows: size.rows,
        pixelWidth: size.pixelWidth,
        pixelHeight: size.pixelHeight,
      });
      send({ type: "resize", ...size });
    });
    const reportViewport = viewportReporter.schedule;
    reportTerminalViewport.current = reportViewport;

    // xterm's public onData event omits its internal wasUserInput bit. Track that
    // bit so a pending asynchronous parser write cannot make a real keystroke
    // look like a device-query response. The server owns common terminal-query
    // replies; one elected browser still handles replies that need browser state.
    const inputSource = trackTerminalUserInput(term);
    const dataDisposable = term.onData((data) => {
      const disposition = terminalDataDisposition({
        acceptingInput,
        data,
        parsingOutput,
        responder,
        userInput: inputSource.consume(),
      });
      if (disposition === "ignore") return;
      if (disposition === "response") {
        sendTextInput(data);
        return;
      }
      const currentModifiers = modifiers.current;
      sendTextInput(transformTerminalInput(data, currentModifiers));
      if (currentModifiers.alt || currentModifiers.ctrl) {
        updateMobileModifiers(NO_TERMINAL_MODIFIERS);
      }
    });
    const binaryDisposable = term.onBinary((data) => {
      if (acceptingInput) sendBinaryInput(data);
    });
    const scrollDisposable = term.onScroll((position) => {
      setScrolledBack(position < term.buffer.active.baseY);
    });
    const disposeTouchScroll = installTerminalTouchScroll(container.current, term, () => {
      const screen = container.current?.querySelector<HTMLElement>(".xterm-screen");
      return screen && term.rows ? screen.getBoundingClientRect().height / term.rows : 15;
    });
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
        event.preventDefault();
        void navigator.clipboard?.readText().then((value) => term.paste(value)).catch(() => onNotice("Clipboard permission was denied"));
        return false;
      }
      return true;
    });

    const writeTerminal = (data: Uint8Array, commit?: number) => new Promise<void>((resolve, reject) => {
      if (isDebugRecordingActive()) {
        recordDebugEvent(terminal.id, { type: "write", data: encodeBytesBase64(data) });
      }
      parsingOutput = true;
      try {
        term.write(data, () => {
          parsingOutput = false;
          try {
            if (commit !== undefined) stream.commit(commit);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        parsingOutput = false;
        reject(error);
      }
    });

    const connect = () => {
      if (disposed || exited.current || !visibleState.current) return;
      acceptingInput = false;
      responder = false;
      term.options.disableStdin = true;
      setConnection(recoveringOutput ? "recovering" : "connecting");
      recordDebugEvent(terminal.id, { type: "connect" });
      recordDebugEvent(terminal.id, { type: "state", state: recoveringOutput ? "recovering" : "connecting" });
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const url = addTerminalStreamProtocol(
        new URL(`${protocol}//${location.host}/api/terminals/${terminal.id}/socket`),
      );
      const size = proposedViewport();
      if (size) {
        url.searchParams.set("cols", String(size.cols));
        url.searchParams.set("rows", String(size.rows));
        url.searchParams.set("pixelWidth", String(size.pixelWidth));
        url.searchParams.set("pixelHeight", String(size.pixelHeight));
        reportedViewport = `${size.cols}x${size.rows}@${size.pixelWidth}x${size.pixelHeight}`;
      }
      const resumeSequence = stream.resumeSequence;
      if (resumeSequence !== undefined) url.searchParams.set("sequence", String(resumeSequence));
      const next = new WebSocket(url);
      let protocolFailed = false;
      let abandoned = false;
      const failProtocol = (error: unknown) => {
        if (protocolFailed || abandoned) return;
        protocolFailed = true;
        acceptingInput = false;
        term.options.disableStdin = true;
        onNotice(error instanceof Error ? error.message : "Invalid terminal stream");
        closeTerminalSocket(next, "protocol-error");
      };
      const recoverBacklog = () => {
        abandoned = true;
        recoveringOutput = true;
        acceptingInput = false;
        term.options.disableStdin = true;
        reportStreamIssue({ kind: "recovering", pendingBytes: backlog.pendingBytes });
        setConnection("recovering");
        closeTerminalSocket(next, "backlog");
      };
      const suspend = () => {
        if (abandoned) return;
        abandoned = true;
        acceptingInput = false;
        term.options.disableStdin = true;
        next.close(1000, "Pane cached");
      };
      suspendSocket = suspend;
      next.binaryType = "arraybuffer";
      socket.current = next;
      next.addEventListener("open", () => {
        lastServerMessage = Date.now();
        reportViewport();
      });
      next.addEventListener("message", (event) => {
        if (protocolFailed || abandoned) return;
        lastServerMessage = Date.now();
        let eagerFrame: TerminalFrame | undefined;
        let queuedBytes = 0;
        if (event.data instanceof ArrayBuffer) {
          try {
            eagerFrame = decodeTerminalFrame(event.data);
          } catch (error) {
            failProtocol(error);
            return;
          }
          if (eagerFrame.kind === TERMINAL_FRAME_OUTPUT) {
            queuedBytes = eagerFrame.data.byteLength;
            if (backlog.enqueue(queuedBytes)) {
              recoverBacklog();
              return;
            }
          }
        }
        messageQueue = messageQueue.then(async () => {
          try {
            if (protocolFailed || abandoned) return;
            const binary = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
            if (binary instanceof ArrayBuffer) {
              const frame = eagerFrame ?? decodeTerminalFrame(binary);
              if (isDebugRecordingActive()) {
                recordDebugEvent(terminal.id, {
                  type: "output",
                  sequence: frame.sequence,
                  data: encodeBytesBase64(frame.data),
                });
              }
              const commit = stream.accept(frame);
              await writeTerminal(frame.data, commit);
              return;
            }
            const message = JSON.parse(String(event.data)) as ServerTerminalMessage;
            if (message.type === "ready") {
              recordDebugEvent(terminal.id, { type: "control", message });
              onUpdate(message.terminal);
            }
            if (message.type === "size") {
              recordDebugEvent(terminal.id, {
                type: "size",
                cols: message.cols,
                rows: message.rows,
                controller: message.controller,
                responder: message.responder,
              });
              // A resize reflows the local buffer, which may no longer match the
              // server's canonical model at the committed sequence. Drop the
              // resume baseline so the next reconnect pulls a fresh snapshot.
              if (message.cols !== term.cols || message.rows !== term.rows) {
                stream.invalidateResume();
              }
              term.resize(message.cols, message.rows);
              responder = message.responder;
              if (!acceptingInput) term.options.disableStdin = !responder;
              setTerminalSize({ focused: message.focused, controller: message.controller });
            }
            if (message.type === "sync") {
              recordDebugEvent(terminal.id, {
                type: "sync",
                mode: message.mode,
                sequence: message.sequence,
              });
              acceptingInput = false;
              term.options.disableStdin = !responder;
              if (hasSynced && !recoveringOutput) {
                recoveringOutput = true;
                reportStreamIssue({ kind: "recovering" });
              }
              if (hasSynced || recoveringOutput) {
                setConnection("recovering");
              }
              if (stream.begin(message.mode, message.sequence)) term.reset();
            }
            if (message.type === "synced") {
              recordDebugEvent(terminal.id, { type: "synced", sequence: message.sequence });
              stream.finish(message.sequence);
              hasSynced = true;
              recoveringOutput = false;
              acceptingInput = true;
              term.options.disableStdin = false;
              attempts = 0;
              reportStreamIssue();
              setConnection("connected");
              reportViewport();
              if (activeState.current && visibleState.current) term.focus();
            }
            if (message.type === "exit") {
              recordDebugEvent(terminal.id, { type: "control", message });
              exited.current = true;
              acceptingInput = false;
              term.options.disableStdin = true;
              reportStreamIssue();
              setConnection("exited");
              onExit();
            }
            if (message.type === "error") {
              recordDebugEvent(terminal.id, { type: "notice", message: message.message });
              onNotice(message.message);
            }
          } finally {
            backlog.settle(queuedBytes);
          }
        }).catch((error) => {
          failProtocol(error);
        });
      });
      next.addEventListener("close", () => {
        recordDebugEvent(terminal.id, { type: "disconnect", cause: "close" });
        if (disposed || exited.current) return;
        acceptingInput = false;
        term.options.disableStdin = true;
        if (socket.current === next) socket.current = undefined;
        if (suspendSocket === suspend) suspendSocket = undefined;
        setTerminalSize({ focused: false, controller: false });
        if (!visibleState.current) {
          reportStreamIssue();
          setConnection("connecting");
          void messageQueue.then(() => {
            backlog.reset();
            if (recoveringOutput) stream.restart();
          });
          return;
        }
        if (!recoveringOutput) {
          reportStreamIssue({ kind: "reconnecting" });
          setConnection("disconnected");
        }
        attempts += 1;
        void messageQueue.then(() => {
          if (disposed || exited.current) return;
          backlog.reset();
          if (recoveringOutput) stream.restart();
          reconnectTimer.current = window.setTimeout(
            connect,
            recoveringOutput ? 0 : Math.min(5000, 250 * 2 ** attempts),
          );
        });
      });
      next.addEventListener("error", () => next.close());
    };

    setTerminalVisibility.current = (nextVisible) => {
      visibleState.current = nextVisible;
      if (!nextVisible) {
        viewportReporter.cancel();
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = undefined;
        reportStreamIssue();
        term.blur();
        suspendSocket?.();
        return;
      }
      void messageQueue.then(() => {
        if (disposed || exited.current || !visibleState.current) return;
        const current = socket.current;
        if (!current || current.readyState === WebSocket.CLOSED) connect();
        reportViewport();
        if (hasSynced && activeState.current) term.focus();
      });
    };

    const keepaliveTimer = window.setInterval(() => {
      const current = socket.current;
      if (current?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastServerMessage > 45_000) {
        closeTerminalSocket(current, "timeout");
        return;
      }
      current.send(JSON.stringify({ type: "ping" } satisfies ClientTerminalMessage));
    }, 15_000);

    const observer = new ResizeObserver(reportViewport);
    observer.observe(container.current);
    if (visibleState.current) connect();
    reportViewport();

    return () => {
      disposed = true;
      viewportReporter.cancel();
      clearInterval(keepaliveTimer);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      observer.disconnect();
      imagePreviews.clear();
      disposeTouchScroll();
      dataDisposable.dispose();
      inputSource.dispose();
      binaryDisposable.dispose();
      scrollDisposable.dispose();
      fileLinksDisposable.dispose();
      searchResultsDisposable.dispose();
      reportStreamIssue();
      socket.current?.close(1000, "Pane closed");
      socket.current = undefined;
      reportTerminalViewport.current = undefined;
      setTerminalVisibility.current = undefined;
      term.dispose();
      xterm.current = undefined;
      searchAddon.current = undefined;
    };
  }, [terminal.id, config.scrollbackLines]);

  useEffect(() => {
    setTerminalVisibility.current?.(visible);
  }, [visible]);

  useEffect(() => {
    activeState.current = active;
    visibleState.current = visible;
    const term = xterm.current;
    if (!term) return;
    if (!active || !visible) {
      term.blur();
      return;
    }
    const frame = requestAnimationFrame(() => term.focus());
    return () => cancelAnimationFrame(frame);
  }, [active, visible]);

  useEffect(() => {
    const term = xterm.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    reportTerminalViewport.current?.();
  }, [fontSize]);

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
  const toggleSizeFocus = () => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    const message: ClientTerminalMessage = {
      type: "focus",
      focused: !terminalSize.controller,
    };
    socket.current.send(JSON.stringify(message));
  };
  const sizeFocusTitle = terminalSize.controller
    ? "Return to the smallest connected terminal size"
    : terminalSize.focused
      ? "Use this device's size instead"
      : "Focus this terminal at this device's size";
  const toggleModifier = (modifier: keyof TerminalModifiers) => {
    updateMobileModifiers({
      ...modifiers.current,
      [modifier]: !modifiers.current[modifier],
    });
    xterm.current?.focus();
  };
  const inputKey = (data: string) => {
    xterm.current?.input(data, true);
    xterm.current?.focus();
  };
  const changeFontSize = (next: number) => {
    onFontSizeChange(next);
    xterm.current?.focus();
  };
  const keepTerminalFocused = (event: PointerEvent) => event.preventDefault();
  const zoomPercent = terminalZoomPercent(fontSize);

  return (
    <section
      ref={pane}
      class={`terminal-pane ${active ? "active" : ""} ${artifactsVisible ? "artifacts-visible" : ""}`}
      style={{
        "--terminal-color": terminal.color,
        "--terminal-background": mixedTerminalBackground(theme, terminal.color),
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
        {terminal.broker && (
          terminal.broker.version !== config.build.version
          || terminal.broker.commit !== config.build.commit
        ) && (
          <span
            class="pane-broker-warning"
            title={`This terminal is still running on broker v${terminal.broker.version} (${terminal.broker.commit.slice(0, 12)}). New terminals use v${config.build.version}. Close it when convenient to retire the older broker.`}
          >
            <TriangleAlert size={11} />
            Broker v{terminal.broker.version}
          </span>
        )}
        {terminal.agent && (
          <PaneAgentState agent={terminal.agent} needsAttention={needsAttention} />
        )}
        {!terminal.agent && terminal.command && (
          <PaneCommandState command={terminal.command} needsAttention={needsAttention} />
        )}
        {artifacts.length > 0 && (
          <button
            class={`pane-artifacts ${artifactsVisible ? "active" : ""}`}
            onClick={() => {
              setProcessesOpen(false);
              setArtifactsOpen((current) => !current);
            }}
            aria-label={`${artifactsVisible ? "Close" : "Open"} ${artifacts.length} session ${artifacts.length === 1 ? "artifact" : "artifacts"}`}
            aria-expanded={artifactsVisible}
            title={`${artifacts.length} ${terminal.agent?.kind ?? "terminal"} ${artifacts.length === 1 ? "artifact" : "artifacts"}`}
          >
            <PackageOpen size={13} />
            <span>{artifacts.length}</span>
          </button>
        )}
        <span class={`connection ${connection}`} title={connection} />
        {connection === "recovering" && (
          <span class="pane-stream-status" title="Loading the current terminal state after falling behind or reconnecting">
            <RefreshCw class="spin" size={11} /> Catching up
          </span>
        )}
        <span class="pane-spacer" />
        <span class="desktop-pane-actions">
          <button
            class={`pane-action ${terminalSize.controller ? "active" : ""}`}
            onClick={toggleSizeFocus}
            aria-label={sizeFocusTitle}
            aria-pressed={terminalSize.controller}
            title={sizeFocusTitle}
          >
            <Maximize2 size={14} />
          </button>
          <button
            class={`pane-action ${processesOpen ? "active" : ""}`}
            onClick={() => {
              setArtifactsOpen(false);
              setProcessesOpen((current) => !current);
            }}
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
              <button role="menuitem" onClick={() => { setActionsOpen(false); toggleSizeFocus(); }}>
                <Maximize2 size={16} />
                {terminalSize.controller ? "Use smallest terminal size" : "Focus terminal size here"}
              </button>
              <button role="menuitem" onClick={() => { setActionsOpen(false); setSearchOpen(true); }}>
                <Search size={16} /> Search scrollback
              </button>
              <button role="menuitem" onClick={() => { setActionsOpen(false); void copy(); }}>
                <ClipboardCopy size={16} /> Copy selection
              </button>
              <button role="menuitem" onClick={() => { setActionsOpen(false); void paste(); }}>
                <ClipboardPaste size={16} /> Paste
              </button>
              <button role="menuitem" onClick={() => {
                setActionsOpen(false);
                setArtifactsOpen(false);
                setProcessesOpen(true);
              }}>
                <ListTree size={16} /> Inspect processes
              </button>
              {artifacts.length > 0 && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setActionsOpen(false);
                    setProcessesOpen(false);
                    setArtifactsOpen(true);
                  }}
                >
                  <PackageOpen size={16} /> Open artifacts ({artifacts.length})
                </button>
              )}
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
      <div class="terminal-body">
        <div
          ref={container}
          class="xterm-host"
          onContextMenu={(event) => {
            event.preventDefault();
            if (xterm.current?.hasSelection()) void copy();
            else void paste();
          }}
        />
        {artifactsVisible && (
          <ArtifactDrawer
            terminal={terminal}
            artifacts={artifacts}
            onClose={() => setArtifactsOpen(false)}
            onOpen={onOpenArtifact}
            onDelete={onDeleteArtifact}
            onNotice={onNotice}
          />
        )}
      </div>
      <nav
        class="terminal-keybar"
        aria-label="Terminal keyboard shortcuts"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) keepTerminalFocused(event);
        }}
      >
        <button
          onClick={() => changeFontSize(fontSize - 1)}
          disabled={fontSize <= MIN_TERMINAL_FONT_SIZE}
          aria-label={`Zoom terminal out. Current zoom ${zoomPercent}%`}
          title="Zoom terminal out"
        >
          <ZoomOut size={16} />
        </button>
        <button
          class="terminal-zoom-level"
          onClick={() => changeFontSize(DEFAULT_TERMINAL_FONT_SIZE)}
          aria-label={`Reset terminal zoom to 100%. Current zoom ${zoomPercent}%`}
          title="Reset terminal zoom"
        >
          {zoomPercent}%
        </button>
        <button
          onClick={() => changeFontSize(fontSize + 1)}
          disabled={fontSize >= MAX_TERMINAL_FONT_SIZE}
          aria-label={`Zoom terminal in. Current zoom ${zoomPercent}%`}
          title="Zoom terminal in"
        >
          <ZoomIn size={16} />
        </button>
        <span class="terminal-keybar-divider" aria-hidden="true" />
        <button
          class={mobileModifiers.ctrl ? "active" : ""}
          aria-pressed={mobileModifiers.ctrl}
          onClick={() => toggleModifier("ctrl")}
        >
          Ctrl
        </button>
        <button
          class={mobileModifiers.alt ? "active" : ""}
          aria-pressed={mobileModifiers.alt}
          onClick={() => toggleModifier("alt")}
        >
          Alt
        </button>
        <button onClick={() => inputKey("\u001b")}>Esc</button>
        <button onClick={() => inputKey("\t")}>Tab</button>
        <span class="terminal-keybar-divider" aria-hidden="true" />
        <button onClick={() => inputKey("\u001b[D")} aria-label="Left arrow">←</button>
        <button onClick={() => inputKey("\u001b[A")} aria-label="Up arrow">↑</button>
        <button onClick={() => inputKey("\u001b[B")} aria-label="Down arrow">↓</button>
        <button onClick={() => inputKey("\u001b[C")} aria-label="Right arrow">→</button>
        <span class="terminal-keybar-divider" aria-hidden="true" />
        <button onClick={() => inputKey("\u001b[5~")}>PgUp</button>
        <button onClick={() => inputKey("\u001b[6~")}>PgDn</button>
      </nav>
      {scrolledBack && (
        <button
          class="terminal-scroll-latest"
          onPointerDown={keepTerminalFocused}
          onClick={() => {
            xterm.current?.scrollToBottom();
            xterm.current?.focus();
          }}
        >
          <ChevronDown size={14} /> Latest
        </button>
      )}
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
          <img src={api.previewFileUrl({ path: imagePreview.file.path })} alt={imagePreview.file.name} />
        </div>
      )}
      {processesOpen && <ProcessInspector terminalId={terminal.id} onClose={() => setProcessesOpen(false)} />}
      {connection === "disconnected" && <div class="pane-banner"><WifiOff size={13} /> Reconnecting…</div>}
      {connection === "exited" && <div class="pane-banner exited">Process exited with code {terminal.exitCode ?? 0}</div>}
    </section>
  );
}

function PaneAgentState({
  agent,
  needsAttention,
}: {
  agent: NonNullable<TerminalInfo["agent"]>;
  needsAttention: boolean;
}) {
  const label = needsAttention
    ? "Ready"
    : agent.status === "working"
      ? "Working"
      : agent.status === "idle"
        ? "Idle"
        : "Closed";
  const Icon = needsAttention
    ? Bell
    : agent.status === "working"
      ? Activity
      : agent.status === "idle"
        ? CirclePause
        : CircleX;
  return (
    <span
      class={`pane-activity ${needsAttention ? "attention" : agent.status}`}
      title={agent.summary ?? `${agent.kind} is ${label.toLocaleLowerCase()}`}
    >
      <Bot size={12} aria-hidden="true" />
      <span class="pane-activity-kind">{agent.kind}</span>
      <span class="pane-activity-state">
        <Icon size={11} strokeWidth={2.2} aria-hidden="true" />
        {agent.status === "working" ? <WorkingDuration since={agent.statusChangedAt} /> : label}
      </span>
    </span>
  );
}

function PaneCommandState({
  command,
  needsAttention,
}: {
  command: NonNullable<TerminalInfo["command"]>;
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
      class={`pane-activity ${needsAttention ? "attention" : command.status}`}
      title={title}
    >
      <TerminalSquare size={12} aria-hidden="true" />
      <span class="pane-activity-kind">{command.name}</span>
      <span class="pane-activity-state">
        <Icon size={11} strokeWidth={2.2} aria-hidden="true" />
        {command.status === "running" ? <WorkingDuration since={command.startedAt} /> : label}
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
