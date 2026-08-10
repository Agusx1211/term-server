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
  Hand,
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
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
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
import { addTerminalStreamProtocol, closeTerminalSocket, TerminalSocketFailureTracker } from "../lib/terminal-socket";
import {
  encodeBytesBase64,
  encodeTextBase64,
  isDebugRecordingActive,
  onDebugRecordingChange,
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
  copyTerminalSelection,
  handleTerminalClipboardShortcut,
  pasteTerminalClipboard,
  readTerminalOsc52Clipboard,
  writeTerminalOsc52Clipboard,
} from "../lib/terminal-clipboard";
import {
  TERMINAL_FRAME_OUTPUT,
  TERMINAL_FRAME_SNAPSHOT,
  TerminalOutputAck,
  TerminalRenderBacklog,
  TerminalStreamState,
  decodeTerminalFrame,
  type TerminalBacklogKind,
  type TerminalFrame,
  type TerminalStreamIssue,
} from "../lib/terminal-stream";
import {
  TERMINAL_CHECKPOINT_IDLE_MS,
  TERMINAL_CHECKPOINT_MAX_INTERVAL_MS,
  sendTerminalCheckpoint,
  serializeTerminalCheckpoint,
} from "../lib/terminal-checkpoint";
import {
  terminalKittyKeyboardState,
  tuiCompatibilityOptions,
} from "../lib/terminal-compatibility";
import { loadTerminalNerdFont, TERMINAL_FONT_FAMILY } from "../lib/terminal-font";
import { PanoptesUnicode17Addon } from "../lib/terminal-unicode";
import {
  createSettledTask,
  nextTerminalViewportReport,
  terminalViewportForServerSize,
  terminalViewportSize,
  type TerminalViewportSize,
} from "../lib/terminal-viewport";
import {
  registerE2ETerminal,
  type E2ETerminalDiagnosticsHandle,
  type E2EViewport,
} from "../lib/e2e-diagnostics";
import {
  mixedTerminalBackground,
  terminalTheme,
  type ThemeName,
} from "../lib/terminal-theme";
import { ProcessInspector } from "./ProcessInspector";
import { ArtifactDrawer } from "./ArtifactDrawer";
import { WorkingDuration } from "./WorkingDuration";
import { agentStatusPresentation, type AgentStatusTone } from "../lib/agent-status";

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
  onExit: (terminalId: string, exitCode: number) => void;
  onUpdate: (terminal: TerminalInfo) => void;
  onStreamIssue: (issue?: TerminalStreamIssue) => void;
  onNotice: (message: string) => void;
  onFontSizeChange: (fontSize: number) => void;
  onOpenFile: (target: FileTarget) => void;
  onOpenArtifact: (artifact: ArtifactEntry) => void;
  onDeleteArtifact: (artifact: ArtifactEntry) => Promise<void>;
}
const TERMINAL_PROTOCOL_MISMATCH_MESSAGE = "terminal client is out of date; reload the page";

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
  const reloadRequiredState = useRef(false);
  const modifiers = useRef<TerminalModifiers>(NO_TERMINAL_MODIFIERS);
  const paneId = `pane-${terminal.id}`;
  const diagnostics = useRef<E2ETerminalDiagnosticsHandle>();
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
  const [searchRevision, setSearchRevision] = useState(0);
  const [searchResults, setSearchResults] = useState({ index: -1, count: 0 });
  const [mobileModifiers, setMobileModifiers] = useState(NO_TERMINAL_MODIFIERS);
  const [scrolledBack, setScrolledBack] = useState(false);
  const [imagePreview, setImagePreview] = useState<{ file: FileEntry; left: number; top: number }>();
  const [terminalSize, setTerminalSize] = useState({ focused: false, controller: false });
  const [reloadRequired, setReloadRequired] = useState(false);
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "recovering" | "disconnected" | "exited"
  >(
    terminal.status === "exited" ? "exited" : "connecting",
  );
  const artifactSignature = artifacts.map((artifact) => artifact.id).join("\u0000");
  const artifactsVisible = artifactsOpen && artifacts.length > 0;

  useEffect(() => {
    const handle = diagnostics.current;
    if (!handle) return;
    handle.update({
      mounted: true,
      visible,
      cached: !visible,
      active,
      acceptingInput: visible && active && connection === "connected",
    });
    handle.record("visibility", { visible });
    handle.record("active", { active });
  }, [active, visible, connection]);

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
    const diagnosticsHandle = registerE2ETerminal({
      terminalId: terminal.id,
      paneId,
      kind: "pane",
    });
    diagnostics.current = diagnosticsHandle;
    const initiallyExited = terminal.status === "exited";
    const initialExitCode = initiallyExited && terminal.exitCode !== null ? terminal.exitCode : undefined;
    diagnosticsHandle.update({
      mounted: true,
      visible,
      cached: !visible,
      active,
      acceptingInput: visible && active && connection === "connected",
      socketState: initiallyExited ? "exited" : undefined,
      exitCode: initialExitCode,
    });
    diagnosticsHandle.record("visibility", { visible });
    diagnosticsHandle.record("active", { active });
    if (initialExitCode !== undefined) {
      diagnosticsHandle.record("exit", { exitCode: initialExitCode });
    }
    const host = container.current;
    if (!host) return;
    let disposed = false;
    let attempts = 0;
    const preSyncFailures = new TerminalSocketFailureTracker();
    let responder = false;
    const fit = new FitAddon();
    const search = new SearchAddon({ highlightLimit: 1000 });
    const serialize = new SerializeAddon();
    const term = new XTerm({
      // The official search addon's multi-match decorations use xterm's decoration API.
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      disableStdin: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize,
      letterSpacing: 0,
      lineHeight: 1.15,
      minimumContrastRatio: 1,
      scrollback: config.scrollbackLines,
      scrollSensitivity: 1.5,
      smoothScrollDuration: 0,
      theme: terminalTheme(theme, terminal.color),
      // Match VS Code's modern input contract. Window-size reports stay
      // disabled here because the broker answers them once from the elected
      // viewport; enabling xterm's copies would send duplicate PTY replies.
      ...tuiCompatibilityOptions(),
    });
    xterm.current = term;
    searchAddon.current = search;
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(serialize);
    term.loadAddon(new ClipboardAddon(undefined, {
      async readText() {
        if (!responder) return "";
        return readTerminalOsc52Clipboard(navigator.clipboard, onNotice);
      },
      async writeText(_selection, text) {
        if (!responder) return;
        await writeTerminalOsc52Clipboard(text, navigator.clipboard, onNotice);
      },
    }));
    term.loadAddon(new PanoptesUnicode17Addon());
    const searchResultsDisposable = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setSearchResults({ index: resultIndex, count: resultCount });
    });
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, "_blank", "noopener,noreferrer");
      }),
    );
    term.open(host);
    void loadTerminalNerdFont().then(() => {
      if (disposed) return;
      term.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
      diagnosticsHandle?.record("font-load", { result: "settled" });
      reportTerminalViewport.current?.();
    });
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
    // Renderer state for debug recording. xterm does not expose the active
    // renderer, so we track whether WebGL loaded and capture the rendered
    // output (buffer model + canvas) ourselves while a recording is active.
    let rendererKind: "webgl" | "canvas" | "dom" = "canvas";
    let reportedViewport = "";
    let webglLoaded = false;
    let webglContextLost = false;
    let webglAddon: { dispose(): void } | undefined;
    let removeWebglContextLossListener: (() => void) | undefined;
    let unregisterContextLossControl: (() => void) | undefined;
    const RENDER_SAMPLE_MS = 250;
    const SCREENSHOT_SAMPLE_MS = 1000;
    let lastRenderSample = 0;
    let lastScreenshotSample = 0;
    const recordRenderer = (): void => {
      diagnosticsHandle?.update({ renderer: rendererKind });
      if (!isDebugRecordingActive()) return;
      recordDebugEvent(terminal.id, {
        type: "renderer",
        renderer: rendererKind,
        webglLoaded,
        contextLost: webglContextLost,
        dpr: window.devicePixelRatio || 1,
      });
    };
    const captureRenderModel = (): void => {
      if (!isDebugRecordingActive()) return;
      const buffer = term.buffer.active;
      const rows = term.rows;
      const top = buffer.viewportY;
      const lines: string[] = [];
      for (let index = 0; index < rows; index += 1) {
        const line = buffer.getLine(top + index);
        lines.push(line ? line.translateToString(true) : "");
      }
      recordDebugEvent(terminal.id, {
        type: "render",
        cols: term.cols,
        rows,
        cursorX: buffer.cursorX,
        cursorY: buffer.cursorY,
        viewportY: top,
        lines,
      });
    };
    const captureScreenshot = (): void => {
      if (!isDebugRecordingActive()) return;
      const canvas = term.element?.querySelector<HTMLCanvasElement>("canvas");
      if (!canvas) return;
      let dataUrl: string | null = null;
      try {
        dataUrl = canvas.toDataURL("image/png");
      } catch {
        // The WebGL drawing buffer may already be cleared; skip this sample.
      }
      if (!dataUrl) return;
      recordDebugEvent(terminal.id, {
        type: "screenshot",
        dataUrl,
        width: canvas.width,
        height: canvas.height,
      });
    };
    const captureRenderState = (force = false): void => {
      if (!isDebugRecordingActive()) return;
      const now = Date.now();
      if (force || now - lastRenderSample >= RENDER_SAMPLE_MS) {
        lastRenderSample = now;
        captureRenderModel();
      }
      if (force || now - lastScreenshotSample >= SCREENSHOT_SAMPLE_MS) {
        lastScreenshotSample = now;
        captureScreenshot();
      }
    };
    const fallbackFromWebgl = (): void => {
      if (disposed || webglContextLost) return;
      // Mark the transition before disposing. xterm's addon cleanup removes
      // its restoration listener, so a restored context can never revive the
      // renderer or dispose resources that now belong to the fallback.
      webglContextLost = true;
      removeWebglContextLossListener?.();
      removeWebglContextLossListener = undefined;
      unregisterContextLossControl?.();
      unregisterContextLossControl = undefined;
      webglAddon?.dispose();
      webglAddon = undefined;
      rendererKind = "canvas";
      webglLoaded = false;
      diagnosticsHandle?.rendererContextLost();
      recordRenderer();
      term.refresh(0, term.rows - 1);
      reportedViewport = "";
      reportTerminalViewport.current?.();
    };
    void (diagnosticsHandle?.beforeRendererLoad() ?? Promise.resolve())
      .then(() => import("@xterm/addon-webgl"))
      .then(({ WebglAddon }) => {
        if (disposed || webglContextLost) return;
        try {
          const webgl = new WebglAddon();
          webglAddon = webgl;
          webgl.onContextLoss(fallbackFromWebgl);
          unregisterContextLossControl = diagnosticsHandle?.registerContextLossControl(() => {
            const canvases = term.element?.querySelectorAll<HTMLCanvasElement>("canvas") ?? [];
            for (const canvas of canvases) {
              const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
              const extension = context?.getExtension("WEBGL_lose_context");
              if (extension) {
                extension.loseContext();
                return;
              }
            }
            throw new Error("WEBGL_lose_context is unavailable for the active WebGL canvas");
          });
          term.loadAddon(webgl);
          const webglCanvas = term.element?.querySelector<HTMLCanvasElement>(
            ".xterm-screen canvas:not(.xterm-link-layer)",
          );
          if (webglCanvas) {
            const onContextLoss = (): void => fallbackFromWebgl();
            webglCanvas.addEventListener("webglcontextlost", onContextLoss);
            removeWebglContextLossListener = () => {
              webglCanvas.removeEventListener("webglcontextlost", onContextLoss);
            };
          }
          rendererKind = "webgl";
          webglLoaded = true;
          diagnosticsHandle?.rendererLoaded("webgl");
          reportTerminalViewport.current?.();
          recordRenderer();
        } catch {
          removeWebglContextLossListener?.();
          removeWebglContextLossListener = undefined;
          webglAddon?.dispose();
          webglAddon = undefined;
          unregisterContextLossControl?.();
          unregisterContextLossControl = undefined;
          // xterm's built-in renderer is the compatibility fallback.
          diagnosticsHandle?.rendererFallback("load-failed");
          recordRenderer();
        }
      })
      .catch(() => {
        if (!disposed) {
          diagnosticsHandle?.rendererFallback("load-failed");
          recordRenderer();
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
    let streamGeneration = 0;
    let messageQueueGeneration = 0;
    let messageQueue = Promise.resolve();
    // Resolves once xterm has parsed every frame handed to it so far.
    let pendingWrites = Promise.resolve();
    const isCurrentGeneration = (generation: number) =>
      !disposed && generation === streamGeneration;
    const isCurrentSocket = (generation: number, candidate: WebSocket) =>
      isCurrentGeneration(generation) && socket.current === candidate;
    // The stream is only quiescent once queued messages have been applied and
    // the writes they issued have been parsed. A settled callback from an old
    // generation must never wait on or mutate the current generation's queue.
    const settledStream = (generation = messageQueueGeneration) => {
      const queue = messageQueue;
      return queue.then(() => {
        if (messageQueueGeneration !== generation) return;
        return pendingWrites;
      });
    };
    let lastServerMessage = Date.now();
    let hasSynced = false;
    let recoveringOutput = false;
    let reportedIssue = "";
    const viewportHistory = new Map<string, TerminalViewportSize>();
    const serverViewportKey = (cols: number, rows: number): string => `${cols}x${rows}`;
    const rememberViewport = (viewport: TerminalViewportSize): void => {
      viewportHistory.set(serverViewportKey(viewport.cols, viewport.rows), viewport);
    };
    let serverViewport: TerminalViewportSize | undefined;
    let suspendSocket: (() => void) | undefined;
    let terminalEpoch: number | undefined;
    let checkpointMaximumBytes = 0;
    let checkpointTimer: number | undefined;
    let checkpointWindowStartedAt = 0;
    let lastCheckpointSequence: number | undefined;
    let lastCheckpointEpoch: number | undefined;
    const reportStreamIssue = (issue?: TerminalStreamIssue) => {
      const key = issue ? `${issue.kind}:${issue.pendingBytes ?? 0}` : "";
      if (key === reportedIssue) return;
      reportedIssue = key;
      streamIssue.current(issue);
    };
    const proposedViewport = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      try {
        const proposed = fit.proposeDimensions();
        const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
        if (!proposed || !screen) return;
        const bounds = screen.getBoundingClientRect();
        const size = terminalViewportSize(proposed, {
          cols: term.cols,
          rows: term.rows,
          pixelWidth: bounds.width,
          pixelHeight: bounds.height,
        });
        if (size) {
          diagnosticsHandle?.record("viewport", { source: "proposed", ...size });
          diagnosticsHandle?.update({ proposedViewport: { ...size, source: "proposed" } satisfies E2EViewport });
        }
        return size;
      } catch {
        // The pane may be between layout states.
      }
    };
    const viewportReporter = createSettledTask(() => {
      if (!visibleState.current) return;
      const size = proposedViewport();
      if (!size) return;
      const key = `${size.cols}x${size.rows}@${size.pixelWidth}x${size.pixelHeight}`;
      diagnosticsHandle?.update({
        desiredViewport: { ...size, source: "desired" } satisfies E2EViewport,
      });
      const current = socket.current;
      const nextReported = nextTerminalViewportReport(
        reportedViewport,
        key,
        current?.readyState === WebSocket.OPEN,
      );
      if (nextReported === undefined) return;
      reportedViewport = nextReported;
      recordDebugEvent(terminal.id, {
        type: "resize",
        cols: size.cols,
        rows: size.rows,
        pixelWidth: size.pixelWidth,
        pixelHeight: size.pixelHeight,
      });
      send({ type: "resize", ...size });
      rememberViewport(size);
      if (serverViewport && serverViewport.cols === size.cols && serverViewport.rows === size.rows) {
        serverViewport = {
          ...serverViewport,
          pixelWidth: size.pixelWidth,
          pixelHeight: size.pixelHeight,
        };
        diagnosticsHandle?.update({
          serverViewport: { ...serverViewport, source: "server" } satisfies E2EViewport,
        });
      }
      diagnosticsHandle?.update({
        sentViewport: { ...size, source: "sent" } satisfies E2EViewport,
      });
      diagnosticsHandle?.record("viewport", { source: "sent", ...size });
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
      sendTextInput(transformTerminalInput(
        data,
        currentModifiers,
        terminalKittyKeyboardState(term)?.flags ?? 0,
      ));
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
    term.attachCustomKeyEventHandler((event) => handleTerminalClipboardShortcut(
      event,
      navigator.platform,
      () => {
        if (term.hasSelection()) term.element?.ownerDocument.execCommand("copy");
      },
    ));
    const disposeTouchScroll = installTerminalTouchScroll(host, term, () => {
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      return screen && term.rows ? screen.getBoundingClientRect().height / term.rows : 15;
    });

    // Frames are handed to xterm as they arrive rather than one per settled
    // parse. xterm's write buffer already slices parsing into ~12ms budgets and
    // yields to the renderer between them; waiting for each frame's callback
    // before writing the next one restarts that scheduler per frame and caps a
    // burst at one frame per event-loop turn. A full-screen TUI repaint is a
    // megabyte of 4 KB frames, so that ceiling is what made the pane fall behind
    // and abandon its stream. More than one write can be in flight, so the
    // parsing flag counts them instead of tracking a single write.
    let unparsedWrites = 0;
    const updateStreamDiagnostics = (): void => {
      diagnosticsHandle?.parserState(unparsedWrites, backlog.pendingBytes);
      diagnosticsHandle?.renderBacklog({
        bytes: backlog.pendingBytes,
        frames: backlog.pendingFrames,
        oldestAgeMs: backlog.oldestAgeMs,
      });
      diagnosticsHandle?.streamState({
        gridEpoch: terminalEpoch,
        receivedSequence: stream.received,
        committedSequence: stream.committed,
        syncMode: stream.mode,
        syncTarget: stream.target,
      });
    };
    const clearCheckpointTimer = () => {
      if (checkpointTimer !== undefined) window.clearTimeout(checkpointTimer);
      checkpointTimer = undefined;
    };
    const writeCheckpoint = () => {
      clearCheckpointTimer();
      const current = socket.current;
      const sequence = stream.resumeSequence;
      if (
        disposed
        || !acceptingInput
        || stream.synchronizing
        || unparsedWrites > 0
        || sequence === undefined
        || terminalEpoch === undefined
        || checkpointMaximumBytes <= 0
        || current?.readyState !== WebSocket.OPEN
      ) return;
      if (current.bufferedAmount > 1024 * 1024) {
        checkpointWindowStartedAt = Date.now();
        checkpointTimer = window.setTimeout(writeCheckpoint, TERMINAL_CHECKPOINT_IDLE_MS);
        return;
      }
      if (sequence === lastCheckpointSequence && terminalEpoch === lastCheckpointEpoch) {
        checkpointWindowStartedAt = 0;
        return;
      }
      const serializationStartedAt = performance.now();
      const bytes = serializeTerminalCheckpoint(
        serialize,
        term,
        checkpointMaximumBytes,
      );
      const serializationDurationMs = performance.now() - serializationStartedAt;
      if (!bytes) {
        checkpointWindowStartedAt = 0;
        diagnosticsHandle?.checkpointState({
          sequence,
          epoch: terminalEpoch,
          size: 0,
          chunks: 0,
          serializationDurationMs,
          uploadDurationMs: 0,
          result: "skipped",
        });
        return;
      }
      try {
        const uploadStartedAt = performance.now();
        const chunks = sendTerminalCheckpoint(current, sequence, terminalEpoch, bytes);
        diagnosticsHandle?.checkpointState({
          sequence,
          epoch: terminalEpoch,
          size: bytes.byteLength,
          chunks,
          serializationDurationMs,
          uploadDurationMs: performance.now() - uploadStartedAt,
          result: "sent",
        });
      } catch (error) {
        diagnosticsHandle?.checkpointState({
          sequence,
          epoch: terminalEpoch,
          size: bytes.byteLength,
          chunks: 0,
          serializationDurationMs,
          uploadDurationMs: 0,
          result: "failed",
        });
        throw error;
      }
      checkpointWindowStartedAt = 0;
      lastCheckpointSequence = sequence;
      lastCheckpointEpoch = terminalEpoch;
    };
    const scheduleCheckpoint = () => {
      if (checkpointMaximumBytes <= 0 || terminalEpoch === undefined || !acceptingInput) return;
      const now = Date.now();
      if (!checkpointWindowStartedAt) checkpointWindowStartedAt = now;
      const dueAt = Math.min(
        now + TERMINAL_CHECKPOINT_IDLE_MS,
        checkpointWindowStartedAt + TERMINAL_CHECKPOINT_MAX_INTERVAL_MS,
      );
      clearCheckpointTimer();
      checkpointTimer = window.setTimeout(writeCheckpoint, Math.max(0, dueAt - now));
    };
    const writeTerminal = (
      data: Uint8Array,
      commit: number | undefined,
      generation: number,
      owner: WebSocket,
    ) => new Promise<void>((resolve, reject) => {
      if (!isCurrentSocket(generation, owner)) {
        resolve();
        return;
      }
      if (isDebugRecordingActive()) {
        recordDebugEvent(terminal.id, { type: "write", data: encodeBytesBase64(data) });
      }
      unparsedWrites += 1;
      parsingOutput = true;
      updateStreamDiagnostics();
      try {
        term.write(data, () => {
          if (!isCurrentSocket(generation, owner)) {
            resolve();
            return;
          }
          unparsedWrites -= 1;
          parsingOutput = unparsedWrites > 0;
          try {
            if (commit !== undefined) {
              stream.commit(commit);
              diagnosticsHandle?.record("parser-commit", { sequence: commit });
            }
            diagnosticsHandle?.updateXterm(term);
            updateStreamDiagnostics();
            resolve();
            scheduleCheckpoint();
          } catch (error) {
            updateStreamDiagnostics();
            reject(error);
          }
        });
      } catch (error) {
        if (isCurrentSocket(generation, owner)) {
          unparsedWrites -= 1;
          parsingOutput = unparsedWrites > 0;
          updateStreamDiagnostics();
        }
        reject(error);
      }
    });
    const clearReconnectTimer = () => {
      if (reconnectTimer.current !== undefined) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = undefined;
    };

    const connect = () => {
      const current = socket.current;
      if (disposed || exited.current || !visibleState.current || reloadRequiredState.current) return;
      if (current && current.readyState !== WebSocket.CLOSED) return;
      if (current) socket.current = undefined;
      clearReconnectTimer();
      const generation = ++streamGeneration;
      messageQueueGeneration = generation;
      messageQueue = Promise.resolve();
      pendingWrites = Promise.resolve();
      unparsedWrites = 0;
      parsingOutput = false;
      backlog.reset();
      suspendSocket = undefined;
      acceptingInput = false;
      responder = false;
      term.options.disableStdin = true;
      setConnection(recoveringOutput ? "recovering" : "connecting");
      diagnosticsHandle?.socketState(recoveringOutput ? "recovering" : "connecting");
      diagnosticsHandle?.update({ acceptingInput: false });
      recordDebugEvent(terminal.id, { type: "connect" });
      recordDebugEvent(terminal.id, { type: "state", state: recoveringOutput ? "recovering" : "connecting" });
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const url = addTerminalStreamProtocol(
        new URL(`${protocol}//${location.host}/api/terminals/${terminal.id}/socket`),
      );
      const protocolVersion = diagnosticsHandle?.socketProtocolVersion();
      if (protocolVersion !== undefined) url.searchParams.set("stream", String(protocolVersion));
      const size = proposedViewport();
      if (size) {
        rememberViewport(size);
        url.searchParams.set("cols", String(size.cols));
        url.searchParams.set("rows", String(size.rows));
        url.searchParams.set("pixelWidth", String(size.pixelWidth));
        url.searchParams.set("pixelHeight", String(size.pixelHeight));
        reportedViewport = `${size.cols}x${size.rows}@${size.pixelWidth}x${size.pixelHeight}`;
        diagnosticsHandle?.update({
          desiredViewport: { ...size, source: "desired" } satisfies E2EViewport,
          urlViewport: { ...size, source: "url" } satisfies E2EViewport,
          sentViewport: { ...size, source: "sent" } satisfies E2EViewport,
        });
      }
      const resumeSequence = stream.resumeSequence;
      if (resumeSequence !== undefined && (checkpointMaximumBytes <= 0 || terminalEpoch !== undefined)) {
        url.searchParams.set("sequence", String(resumeSequence));
        if (terminalEpoch !== undefined) url.searchParams.set("epoch", String(terminalEpoch));
      }
      const next = new WebSocket(url);
      const socketGeneration = diagnosticsHandle?.socketCreated(next, url.toString()) ?? 0;
      // The server tracks what it is owed per connection, so acknowledgements
      // belong to the socket the bytes arrived on and start over on reconnect.
      const outputAck = new TerminalOutputAck();
      // Stays false against a broker too old to have flow control. Terminals
      // keep the broker generation that created them, so this pane may well be
      // talking to one; an older broker rejects any message it does not know and
      // the pane would surface an error notice for every acknowledgement.
      let flowControlled = false;
      let acknowledgedBytes = 0;
      // Whether this server lets a cached pane keep its connection. Stays false
      // against an older broker, which would answer `release` with an error.
      let viewportRelease = false;
      const acknowledgeParsed = (bytes: number) => {
        if (!isCurrentSocket(generation, next)) return;
        const batch = outputAck.parsed(bytes);
        if (flowControlled && batch !== undefined && next.readyState === WebSocket.OPEN) {
          next.send(JSON.stringify({ type: "ack", bytes: batch } satisfies ClientTerminalMessage));
          acknowledgedBytes += batch;
        }
        diagnosticsHandle?.flowState({
          controlled: flowControlled,
          acknowledgedBytes,
          pendingAcknowledgementBytes: outputAck.pendingBytes,
        });
      };
      let protocolFailed = false;
      let socketSynced = false;
      let abandoned = false;
      let closeHandled = false;
      const failProtocol = (error: unknown) => {
        if (!isCurrentSocket(generation, next) || protocolFailed || abandoned) return;
        protocolFailed = true;
        acceptingInput = false;
        term.options.disableStdin = true;
        onNotice(error instanceof Error ? error.message : "Invalid terminal stream");
        closeTerminalSocket(next, "protocol-error");
      };
      const recoverBacklog = () => {
        if (!isCurrentSocket(generation, next) || abandoned) return;
        abandoned = true;
        recoveringOutput = true;
        acceptingInput = false;
        term.options.disableStdin = true;
        reportStreamIssue({ kind: "recovering", pendingBytes: backlog.pendingBytes });
        setConnection("recovering");
        closeTerminalSocket(next, "backlog");
      };
      // Called when the pane leaves the screen but stays mounted. Holding the
      // stream open is what makes coming back free: the buffer is never rebuilt
      // and the scrollback this pane has accumulated is never traded for the far
      // shallower snapshot a resynchronization would fall back to. The pane only
      // gives up its say in the negotiated size, which it takes back by
      // reporting its viewport once it is visible again.
      const suspend = () => {
        if (!isCurrentSocket(generation, next) || abandoned) return;
        if (viewportRelease && next.readyState === WebSocket.OPEN) {
          next.send(JSON.stringify({ type: "release" } satisfies ClientTerminalMessage));
          return;
        }
        abandoned = true;
        acceptingInput = false;
        term.options.disableStdin = true;
        next.close(1000, "Pane cached");
      };
      suspendSocket = suspend;
      next.binaryType = "arraybuffer";
      socket.current = next;
      next.addEventListener("open", () => {
        if (!isCurrentSocket(generation, next)) return;
        diagnosticsHandle?.socketOpened(next);
        lastServerMessage = Date.now();
        reportViewport();
      });

      next.addEventListener("message", (event) => {
        if (!isCurrentSocket(generation, next) || protocolFailed || abandoned) return;
        diagnosticsHandle?.socketMessage(next, event.data);
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
          if (eagerFrame.kind === TERMINAL_FRAME_OUTPUT || eagerFrame.kind === TERMINAL_FRAME_SNAPSHOT) {
            const backlogKind: TerminalBacklogKind = eagerFrame.kind === TERMINAL_FRAME_SNAPSHOT ? "snapshot" : "output";
            queuedBytes = eagerFrame.data.byteLength;
            if (backlog.enqueue(queuedBytes, Date.now(), backlogKind)) {
              recoverBacklog();
              return;
            }
            updateStreamDiagnostics();
          }
        }
        if (messageQueueGeneration !== generation) return;
        messageQueue = messageQueue.then(async () => {
          try {
            if (!isCurrentSocket(generation, next) || messageQueueGeneration !== generation) return;
            const binary = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
            if (!isCurrentSocket(generation, next) || messageQueueGeneration !== generation) return;
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
              diagnosticsHandle?.outputReceived(
                stream.received ?? frame.sequence,
                frame.data.byteLength,
              );
              updateStreamDiagnostics();
              // Hand the frame to xterm without waiting for it to be parsed. The
              // backlog is only settled once xterm reports the bytes parsed, so
              // it still measures what the renderer actually owes.
              const settled = queuedBytes;
              queuedBytes = 0;
              pendingWrites = writeTerminal(frame.data, commit, generation, next)
                // Acknowledged only once xterm reports the bytes parsed. Acking
                // on arrival would defeat the point: the server would keep
                // sending while this pane was still working through the last
                // burst, which is exactly the backlog flow control prevents.
                //
                // Only live output is acknowledged. Snapshot bytes are rebuilt
                // state rather than pty output, but they still count toward the
                // parser backlog so a stalled snapshot cannot wait forever.
                .then(() => {
                  if (frame.kind === TERMINAL_FRAME_OUTPUT) {
                    acknowledgeParsed(frame.data.byteLength);
                  }
                })
                .catch(failProtocol)
                .finally(() => {
                  if (isCurrentSocket(generation, next)) {
                    backlog.settle(settled);
                    updateStreamDiagnostics();
                  }
                });
              return;
            }
            // A control message may reset or resize the grid, so everything
            // written ahead of it has to be parsed before it is applied.
            await pendingWrites;
            if (!isCurrentSocket(generation, next) || messageQueueGeneration !== generation
              || protocolFailed || abandoned) return;
            const message = JSON.parse(String(event.data)) as ServerTerminalMessage;
            if (message.type === "ready") {
              recordDebugEvent(terminal.id, { type: "control", message });
              flowControlled = message.flowControl === true;
              viewportRelease = message.viewportRelease === true;
              const checkpointBytes = message.checkpointBytes;
              checkpointMaximumBytes = typeof checkpointBytes === "number"
                && Number.isSafeInteger(checkpointBytes)
                && checkpointBytes > 0
                ? checkpointBytes
                : 0;
              onUpdate(message.terminal);
              diagnosticsHandle?.flowState({
                controlled: flowControlled,
                acknowledgedBytes,
                pendingAcknowledgementBytes: outputAck.pendingBytes,
              });
            }
            if (message.type === "size") {
              recordDebugEvent(terminal.id, {
                type: "size",
                cols: message.cols,
                rows: message.rows,
                controller: message.controller,
                responder: message.responder,
                epoch: message.epoch,
              });
              terminalEpoch = message.epoch;
              term.resize(message.cols, message.rows);
              responder = message.responder;
              if (!acceptingInput) term.options.disableStdin = !responder;
              setTerminalSize({ focused: message.focused, controller: message.controller });
              const nextServerViewport = terminalViewportForServerSize(
                { cols: message.cols, rows: message.rows },
                viewportHistory.get(serverViewportKey(message.cols, message.rows)),
              );
              serverViewport = nextServerViewport;
              diagnosticsHandle?.update({
                focused: message.focused,
                gridEpoch: message.epoch,
                serverViewport: {
                  ...nextServerViewport,
                  source: "server",
                } satisfies E2EViewport,
              });
              diagnosticsHandle?.record("size", {
                cols: message.cols,
                rows: message.rows,
                focused: message.focused,
                controller: message.controller,
                responder: message.responder,
                epoch: message.epoch,
              });
              diagnosticsHandle?.record("focus", {
                focused: message.focused,
                controller: message.controller,
                responder: message.responder,
              });
              diagnosticsHandle?.updateXterm(term);
              updateStreamDiagnostics();
              captureRenderState(true);
              scheduleCheckpoint();
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
              diagnosticsHandle?.streamState({
                gridEpoch: terminalEpoch,
                receivedSequence: stream.received,
                committedSequence: stream.committed,
                syncMode: stream.mode,
                syncTarget: stream.target,
              });
              diagnosticsHandle?.record("sync", {
                mode: message.mode,
                sequence: message.sequence,
                epoch: terminalEpoch,
                generation: socketGeneration,
              });
              diagnosticsHandle?.update({ acceptingInput: false });
            }
            if (message.type === "synced") {
              recordDebugEvent(terminal.id, { type: "synced", sequence: message.sequence });
              stream.finish(message.sequence);
              hasSynced = true;
              socketSynced = true;
              preSyncFailures.reset();
              reloadRequiredState.current = false;
              setReloadRequired(false);
              recoveringOutput = false;
              acceptingInput = true;
              term.options.disableStdin = false;
              diagnosticsHandle?.update({ acceptingInput: true });
              diagnosticsHandle?.streamState({
                gridEpoch: terminalEpoch,
                receivedSequence: stream.received,
                committedSequence: stream.committed,
                syncMode: stream.mode,
                syncTarget: stream.target,
              });
              diagnosticsHandle?.updateXterm(term);
              attempts = 0;
              reportStreamIssue();
              setConnection("connected");
              diagnosticsHandle?.socketState("connected");
              setSearchRevision((revision) => revision + 1);
              diagnosticsHandle?.record("synced", {
                sequence: stream.committed ?? message.sequence,
                epoch: terminalEpoch,
              });
              reportViewport();
              if (activeState.current && visibleState.current) term.focus();
              captureRenderState(true);
              scheduleCheckpoint();
            }
            if (message.type === "exit") {
              recordDebugEvent(terminal.id, { type: "control", message });
              exited.current = true;
              acceptingInput = false;
              term.options.disableStdin = true;
              reportStreamIssue();
              setConnection("exited");
              diagnosticsHandle?.socketState("exited");
              diagnosticsHandle?.update({
                exitCode: message.exitCode,
                acceptingInput: false,
              });
              diagnosticsHandle?.record("exit", { exitCode: message.exitCode });
              onExit(terminal.id, message.exitCode);
            }
            if (message.type === "error") {
              recordDebugEvent(terminal.id, { type: "notice", message: message.message });
              onNotice(message.message);
            }
          } finally {
            if (isCurrentSocket(generation, next)) {
              backlog.settle(queuedBytes);
              updateStreamDiagnostics();
            }
          }
        }).catch((error) => {
          failProtocol(error);
        });
      });
      next.addEventListener("close", () => {
        if (closeHandled) return;
        closeHandled = true;
        diagnosticsHandle?.socketClosed(next);
        if (!isCurrentSocket(generation, next)) return;
        recordDebugEvent(terminal.id, { type: "disconnect", cause: "close" });
        // A server exit is sent immediately before the socket closes. Let all
        // messages already delivered by this socket run before invalidating it;
        // otherwise the close callback races the queue and drops the exit.
        void settledStream(generation).then(() => {
          if (!isCurrentSocket(generation, next) || exited.current) return;
          acceptingInput = false;
          term.options.disableStdin = true;
          socket.current = undefined;
          if (suspendSocket === suspend) suspendSocket = undefined;
          diagnosticsHandle?.update({ acceptingInput: false, focused: false });
          setTerminalSize({ focused: false, controller: false });
          if (!visibleState.current) {
            reportStreamIssue();
            diagnosticsHandle?.socketState("connecting");
            setConnection("connecting");
            backlog.reset();
            if (recoveringOutput) stream.restart();
            return;
          }
          if (!socketSynced && preSyncFailures.recordBeforeReady()) {
            reloadRequiredState.current = true;
            setReloadRequired(true);
            reportStreamIssue();
            setConnection("disconnected");
            diagnosticsHandle?.socketState("disconnected");
            diagnosticsHandle?.record("error", {
              kind: "protocol-version",
              message: TERMINAL_PROTOCOL_MISMATCH_MESSAGE,
            });
            onNotice(TERMINAL_PROTOCOL_MISMATCH_MESSAGE);
            return;
          }
          if (!recoveringOutput) {
            reportStreamIssue({ kind: "reconnecting" });
            setConnection("disconnected");
          }
          attempts += 1;
          diagnosticsHandle?.socketState("disconnected");
          backlog.reset();
          if (recoveringOutput) stream.restart();
          clearReconnectTimer();
          const delay = recoveringOutput ? 0 : Math.min(5000, 250 * 2 ** attempts);
          reconnectTimer.current = window.setTimeout(() => {
            reconnectTimer.current = undefined;
            if (!isCurrentGeneration(generation) || exited.current || !visibleState.current) return;
            connect();
          }, delay);
        });
      });
      next.addEventListener("error", () => {
        if (!isCurrentSocket(generation, next)) return;
        next.close();
      });
    };

    setTerminalVisibility.current = (nextVisible) => {
      diagnosticsHandle?.update({
        visible: nextVisible,
        cached: !nextVisible,
        acceptingInput: nextVisible ? undefined : false,
        focused: nextVisible ? undefined : false,
      });
      diagnosticsHandle?.record("visibility", { visible: nextVisible });
      visibleState.current = nextVisible;
      recordDebugEvent(terminal.id, { type: "visibility", visible: nextVisible });
      if (!nextVisible) {
        viewportReporter.cancel();
        clearReconnectTimer();
        reportStreamIssue();
        term.blur();
        // A released connection has no size registered against it, so the next
        // report has to be sent even though the pane came back the same shape.
        reportedViewport = "";
        suspendSocket?.();
        return;
      }
      clearReconnectTimer();
      const generation = streamGeneration;
      void settledStream(generation).then(() => {
        if (!isCurrentGeneration(generation) || exited.current || !visibleState.current) return;
        const current = socket.current;
        if (!current || current.readyState === WebSocket.CLOSED) connect();
        reportViewport();
        // A cached pane is display:none, so the renderer has drawn nothing while
        // it was away however much output it parsed. Repaint from the buffer.
        term.refresh(0, term.rows - 1);
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
    observer.observe(host);
    if (visibleState.current) connect();
    reportViewport();

    // Debug recording: capture the rendered state (xterm model + canvas) only
    // while a recording is active. onRender fires with a fresh WebGL buffer; the
    // interval covers idle periods when no output is being drawn. Diagnostics
    // refresh their full buffer text after parser commits instead of per frame.
    const renderDisposable = term.onRender(() => {
      diagnosticsHandle?.rendererRendered();
      captureRenderState(false);
    });
    const selectionDisposable = term.onSelectionChange(() => {
      diagnosticsHandle?.updateXterm(term);
    });
    let captureTimer: number | undefined;
    const startCapture = (): void => {
      if (captureTimer !== undefined) return;
      recordRenderer();
      captureRenderState(true);
      captureTimer = window.setInterval(() => captureRenderState(false), 1000);
    };
    const stopCapture = (): void => {
      if (captureTimer !== undefined) {
        clearInterval(captureTimer);
        captureTimer = undefined;
      }
    };
    const recordingDisposable = onDebugRecordingChange((active) => {
      if (active) startCapture();
      else stopCapture();
    });
    if (isDebugRecordingActive()) startCapture();

    return () => {
      removeWebglContextLossListener?.();
      removeWebglContextLossListener = undefined;
      webglAddon = undefined;
      unregisterContextLossControl?.();
      unregisterContextLossControl = undefined;
      writeCheckpoint();
      disposed = true;
      streamGeneration += 1;
      clearReconnectTimer();
      clearCheckpointTimer();
      viewportReporter.cancel();
      clearInterval(keepaliveTimer);
      renderDisposable.dispose();
      selectionDisposable.dispose();
      recordingDisposable();
      stopCapture();
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
      diagnosticsHandle.dispose();
      if (diagnostics.current === diagnosticsHandle) diagnostics.current = undefined;
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
  }, [searchOpen, searchQuery, theme, searchRevision]);

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
    await copyTerminalSelection(
      xterm.current?.getSelection(),
      navigator.clipboard,
      onNotice,
    );
  };
  const paste = async () => {
    await pasteTerminalClipboard(
      navigator.clipboard,
      (text) => xterm.current?.paste(text),
      () => xterm.current?.focus(),
      onNotice,
    );
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
    const terminal = xterm.current;
    if (!terminal || terminal.options.disableStdin) return;
    terminal.input(data, true);
    terminal.focus();
  };
  const changeFontSize = (next: number) => {
    onFontSizeChange(next);
    xterm.current?.focus();
  };
  const keepTerminalFocused = (event: PointerEvent) => event.preventDefault();
  const zoomPercent = terminalZoomPercent(fontSize);

  return (
    <section
      role="region"
      aria-label={`Terminal ${terminal.name}`}
      data-terminal-id={terminal.id}
      data-pane-id={paneId}
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
      {connection === "disconnected" && (
        <div class="pane-banner">
          {reloadRequired ? TERMINAL_PROTOCOL_MISMATCH_MESSAGE : <><WifiOff size={13} /> Reconnecting…</>}
        </div>
      )}
      {connection === "exited" && <div class="pane-banner exited">Process exited with code {terminal.exitCode ?? 0}</div>}
    </section>
  );
}

const AGENT_STATUS_ICONS: Record<AgentStatusTone, typeof Activity> = {
  blocked: Hand,
  attention: Bell,
  working: Activity,
  idle: CirclePause,
  closed: CircleX,
};

function PaneAgentState({
  agent,
  needsAttention,
}: {
  agent: NonNullable<TerminalInfo["agent"]>;
  needsAttention: boolean;
}) {
  const { tone, label, description } = agentStatusPresentation(agent, needsAttention);
  const Icon = AGENT_STATUS_ICONS[tone];
  return (
    <span class={`pane-activity ${tone}`} title={agent.summary ?? description}>
      <Bot size={12} aria-hidden="true" />
      <span class="pane-activity-kind">{agent.kind}</span>
      <span class="pane-activity-state">
        <Icon size={11} strokeWidth={2.2} aria-hidden="true" />
        {tone === "working" ? <WorkingDuration since={agent.statusChangedAt} /> : label}
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
