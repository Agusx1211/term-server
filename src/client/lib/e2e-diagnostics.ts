
/** The renderer kinds xterm can use for a mounted terminal. */
export type E2ERendererKind = "webgl" | "canvas" | "dom";
export type E2ETerminalKind = "pane" | "preview";
export type E2EConnectionState = "connecting" | "open" | "connected" | "recovering" | "disconnected" | "closed" | "exited";
export type E2ECheckpointResult = "idle" | "sent" | "skipped" | "failed";

export interface E2EViewport {
  readonly cols: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly source?: "proposed" | "desired" | "url" | "sent" | "server";
}

export interface E2ESocketSnapshot {
  readonly generation: number;
  readonly url?: string;
  readonly readyState: number;
  readonly state: E2EConnectionState;
  readonly activeCount: number;
}

export interface E2EStreamSnapshot {
  readonly gridEpoch?: number;
  readonly receivedSequence?: number;
  readonly committedSequence?: number;
  readonly syncMode?: "snapshot" | "resume";
  readonly syncTarget?: number;
}

export interface E2EParserSnapshot {
  readonly pendingWrites: number;
  readonly pendingBytes: number;
}

export interface E2ERenderBacklogSnapshot {
  readonly bytes: number;
  readonly frames: number;
  readonly oldestAgeMs: number;
}

export interface E2EFlowSnapshot {
  readonly controlled: boolean;
  readonly acknowledgedBytes: number;
  readonly pendingAcknowledgementBytes: number;
}

export interface E2ECheckpointSnapshot {
  readonly sequence?: number;
  readonly epoch?: number;
  readonly size: number;
  readonly chunks: number;
  readonly serializationDurationMs: number;
  readonly uploadDurationMs: number;
  readonly result: E2ECheckpointResult;
}

export interface E2ERendererSnapshot {
  readonly kind: E2ERendererKind;
  readonly webglLoadCount: number;
  readonly contextLossCount: number;
  readonly fallbackCount: number;
  readonly renderCount: number;
}

export interface E2EXtermSnapshot {
  readonly activeBuffer: "normal" | "alternate";
  readonly cursorX: number;
  readonly cursorY: number;
  readonly viewportY: number;
  readonly text: string;
  readonly selectionText: string;
}

export interface E2ELifecycleSnapshot {
  readonly mounted: boolean;
  readonly visible: boolean;
  readonly cached: boolean;
  readonly active: boolean;
  readonly focused: boolean;
  readonly acceptingInput: boolean;
}

/** A read-only, serializable snapshot returned to Playwright. */
export interface E2ETerminalSnapshot {
  readonly exitCode?: number;
  readonly terminalId: string;
  readonly paneId: string;
  readonly kind: E2ETerminalKind;
  readonly updatedAt: number;
  readonly cols: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly proposedViewport?: E2EViewport;
  readonly desiredViewport?: E2EViewport;
  readonly urlViewport?: E2EViewport;
  readonly sentViewport?: E2EViewport;
  readonly serverViewport?: E2EViewport;
  readonly socketGeneration: number;
  readonly socketUrl?: string;
  readonly socketReadyState: number;
  readonly socketState: E2EConnectionState;
  readonly activeSocketCount: number;
  readonly gridEpoch?: number;
  readonly receivedSequence?: number;
  readonly committedSequence?: number;
  readonly syncMode?: "snapshot" | "resume";
  readonly syncTarget?: number;
  readonly pendingParserWrites: number;
  readonly pendingParserBytes: number;
  readonly renderBacklogBytes: number;
  readonly renderBacklogFrames: number;
  readonly renderBacklogOldestAgeMs: number;
  readonly flowControlled: boolean;
  readonly flowAcknowledgedBytes: number;
  readonly flowPendingAcknowledgementBytes: number;
  readonly checkpointSequence?: number;
  readonly checkpointEpoch?: number;
  readonly checkpointSize: number;
  readonly checkpointChunks: number;
  readonly checkpointSerializationDurationMs: number;
  readonly checkpointUploadDurationMs: number;
  readonly checkpointResult: E2ECheckpointResult;
  readonly renderer: E2ERendererKind;
  readonly webglLoadCount: number;
  readonly contextLossCount: number;
  readonly fallbackCount: number;
  readonly renderCount: number;
  readonly activeBuffer: "normal" | "alternate";
  readonly cursorX: number;
  readonly cursorY: number;
  readonly viewportY: number;
  readonly text: string;
  readonly selectionText: string;
  readonly mounted: boolean;
  readonly visible: boolean;
  readonly cached: boolean;
  readonly active: boolean;
  readonly focused: boolean;
  readonly acceptingInput: boolean;
  readonly viewport: E2EViewport;
  readonly socket: E2ESocketSnapshot;
  readonly stream: E2EStreamSnapshot;
  readonly parser: E2EParserSnapshot;
  readonly renderBacklog: E2ERenderBacklogSnapshot;
  readonly flow: E2EFlowSnapshot;
  readonly checkpoint: E2ECheckpointSnapshot;
  readonly rendererState: E2ERendererSnapshot;
  readonly xterm: E2EXtermSnapshot;
  readonly lifecycle: E2ELifecycleSnapshot;
}

export type E2ETerminalEventType =
  | "mount"
  | "unmount"
  | "snapshot"
  | "visibility"
  | "active"
  | "focus"
  | "viewport"
  | "size"
  | "socket-created"
  | "socket-open"
  | "socket-message"
  | "socket-close"
  | "socket-stale"
  | "state"
  | "sync"
  | "synced"
  | "exit"
  | "output-received"
  | "parser-commit"
  | "checkpoint"
  | "renderer-load"
  | "renderer-context-loss"
  | "renderer-fallback"
  | "render"
  | "font-load"
  | "input"
  | "error";

export interface E2ETerminalEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: number;
  readonly timestamp: number;
  readonly terminalId: string;
  readonly paneId: string;
  readonly type: E2ETerminalEventType;
  readonly data: Readonly<T>;
  readonly snapshot: E2ETerminalSnapshot;
}

export interface E2EWaitOptions {
  readonly timeout?: number;
  /** Resolve only an event whose id is strictly greater than this floor. */
  readonly afterId?: number;
  readonly signal?: AbortSignal;
}

export type E2ETerminalPredicate = (snapshot: E2ETerminalSnapshot) => boolean;
export type E2EEventPredicate = (event: E2ETerminalEvent) => boolean;

export interface E2ERendererFaultOptions {
  readonly delayMs?: number;
  readonly fail?: boolean;
  readonly message?: string;
}

export interface E2ESocketCloseOptions {
  readonly generation?: number;
  readonly code?: number;
  readonly reason?: string;
  readonly abrupt?: boolean;
}

export interface E2ESocketEventOptions {
  readonly generation?: number;
  readonly type?: "message" | "open" | "close" | "error";
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
}

export interface E2EDiagnosticsControls {
  readonly font: {
    delay(): void;
    release(): void;
    reset(): void;
  };
  readonly renderer: {
    delayWebGL(terminalId: string, delayMs: number): void;
    failWebGL(terminalId: string, options?: { readonly message?: string }): void;
    loseContext(terminalId: string): void;
    reset(terminalId?: string): void;
  };
  readonly socket: {
    close(terminalId: string, options?: E2ESocketCloseOptions): void;
    setProtocolVersion(terminalId: string, version?: number): void;
    deliverStaleEvent(terminalId: string, options?: E2ESocketEventOptions): void;
    reset(terminalId?: string): void;
  };
  readonly delayWebGL: (terminalId: string, delayMs: number) => void;
  readonly failWebGL: (terminalId: string, options?: { readonly message?: string }) => void;
  readonly loseContext: (terminalId: string) => void;
  readonly closeSocket: (terminalId: string, options?: E2ESocketCloseOptions) => void;
  readonly deliverStaleSocketEvent: (terminalId: string, options?: E2ESocketEventOptions) => void;
}

export interface E2ETerminalDiagnosticsApi {
  readonly version: 1;
  readonly terminal: (terminalId: string, paneId?: string) => E2ETerminalSnapshot | undefined;
  readonly terminals: () => readonly E2ETerminalSnapshot[];
  readonly events: (terminalId?: string, paneId?: string) => readonly E2ETerminalEvent[];
  readonly waitForTerminal: (
    terminalId: string,
    predicate?: E2ETerminalPredicate | Partial<E2ETerminalSnapshot>,
    options?: E2EWaitOptions,
  ) => Promise<E2ETerminalSnapshot>;
  readonly waitForEvent: {
    (terminalId: string, predicate?: E2EEventPredicate | E2ETerminalEventType, options?: E2EWaitOptions): Promise<E2ETerminalEvent>;
    (predicate?: E2EEventPredicate | E2ETerminalEventType, options?: E2EWaitOptions): Promise<E2ETerminalEvent>;
  };
  readonly controls: E2EDiagnosticsControls;
}

export interface E2ETerminalRegistration {
  readonly terminalId: string;
  readonly paneId: string;
  readonly kind?: E2ETerminalKind;
}

export interface E2ETerminalDiagnosticsHandle {
  readonly terminalId: string;
  readonly paneId: string;
  update(patch: Partial<E2ETerminalSnapshot>): void;
  updateXterm(terminal: unknown): void;
  record<T extends Record<string, unknown>>(type: E2ETerminalEventType, data?: T): void;
  beforeRendererLoad(): Promise<void>;
  rendererLoaded(kind?: E2ERendererKind): void;
  rendererFallback(reason?: string): void;
  rendererContextLost(): void;
  registerContextLossControl(callback: () => void): () => void;
  rendererRendered(): void;
  socketCreated(socket: WebSocket, url: string): number;
  socketProtocolVersion(): number | undefined;
  socketOpened(socket: WebSocket): void;
  socketMessage(socket: WebSocket, data?: unknown): void;
  socketClosed(socket: WebSocket): void;
  socketState(state: E2EConnectionState): void;
  outputReceived(sequence: number, bytes: number): void;
  parserState(pendingWrites: number, pendingBytes: number): void;
  streamState(stream: Partial<E2EStreamSnapshot>): void;
  renderBacklog(backlog: Partial<E2ERenderBacklogSnapshot>): void;
  flowState(flow: Partial<E2EFlowSnapshot>): void;
  checkpointState(checkpoint: Partial<E2ECheckpointSnapshot>): void;
  dispose(): void;
}

interface InternalRendererFault {
  delayMs: number;
  fail: boolean;
  message: string;
  loseContext: boolean;
}

interface InternalSocketEntry {
  readonly generation: number;
  readonly socket: WebSocket;
  readonly url: string;
  active: boolean;
}

interface InternalEntry {
  readonly registration: E2ETerminalRegistration;
  snapshot: MutableSnapshot;
  events: E2ETerminalEvent[];
  listeners: Set<() => void>;
  sockets: InternalSocketEntry[];
  rendererFault: InternalRendererFault;
  protocolVersion?: number;
  contextLossControl?: () => void;
  contextLossCallback?: () => void;
}

interface MutableSnapshot {
  terminalId: string;
  exitCode?: number;
  paneId: string;
  kind: E2ETerminalKind;
  updatedAt: number;
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
  proposedViewport?: E2EViewport;
  desiredViewport?: E2EViewport;
  urlViewport?: E2EViewport;
  sentViewport?: E2EViewport;
  serverViewport?: E2EViewport;
  socketGeneration: number;
  socketUrl?: string;
  socketReadyState: number;
  socketState: E2EConnectionState;
  activeSocketCount: number;
  gridEpoch?: number;
  receivedSequence?: number;
  committedSequence?: number;
  syncMode?: "snapshot" | "resume";
  syncTarget?: number;
  pendingParserWrites: number;
  pendingParserBytes: number;
  renderBacklogBytes: number;
  renderBacklogFrames: number;
  renderBacklogOldestAgeMs: number;
  flowControlled: boolean;
  flowAcknowledgedBytes: number;
  flowPendingAcknowledgementBytes: number;
  checkpointSequence?: number;
  checkpointEpoch?: number;
  checkpointSize: number;
  checkpointChunks: number;
  checkpointSerializationDurationMs: number;
  checkpointUploadDurationMs: number;
  checkpointResult: E2ECheckpointResult;
  renderer: E2ERendererKind;
  webglLoadCount: number;
  contextLossCount: number;
  fallbackCount: number;
  renderCount: number;
  activeBuffer: "normal" | "alternate";
  cursorX: number;
  cursorY: number;
  viewportY: number;
  text: string;
  selectionText: string;
  mounted: boolean;
  visible: boolean;
  cached: boolean;
  active: boolean;
  focused: boolean;
  acceptingInput: boolean;
  viewport: E2EViewport;
  socket: E2ESocketSnapshot;
  stream: E2EStreamSnapshot;
  parser: E2EParserSnapshot;
  renderBacklog: E2ERenderBacklogSnapshot;
  flow: E2EFlowSnapshot;
  checkpoint: E2ECheckpointSnapshot;
  rendererState: E2ERendererSnapshot;
  xterm: E2EXtermSnapshot;
  lifecycle: E2ELifecycleSnapshot;
}

const MAX_EVENTS = 512;
const MAX_XTERM_TEXT_LENGTH = 1_000_000;
const MAX_EVENT_XTERM_TEXT_LENGTH = 64_000;
type XtermBufferLine = {
  translateToString(trimRight?: boolean): string;
};

type XtermActiveBuffer = {
  length?: number;
  getLine?: (index: number) => XtermBufferLine | undefined;
};

/** Capture the newest bounded xterm lines so diagnostics retain the visible tail. */
export function captureXtermTailText(active: XtermActiveBuffer, rows?: number): string {
  const length = Math.max(0, active.length ?? rows ?? 0);
  const lowerBound = Math.max(0, length - 20_000);
  const lines: string[] = [];
  let textLength = 0;
  for (let index = length - 1; index >= lowerBound && textLength < MAX_XTERM_TEXT_LENGTH; index -= 1) {
    const line = active.getLine?.(index);
    if (!line) continue;
    const lineText = line.translateToString(true);
    lines.push(lineText);
    textLength += lineText.length + (lines.length > 1 ? 1 : 0);
  }
  let text = lines.reverse().join("\n");
  if (text.length > MAX_XTERM_TEXT_LENGTH) text = text.slice(-MAX_XTERM_TEXT_LENGTH);
  return text;
}
const EVICTABLE_EVENT_TYPES: Partial<Record<E2ETerminalEventType, true>> = {
  render: true,
  viewport: true,
  snapshot: true,
  "socket-message": true,
  "output-received": true,
  "parser-commit": true,
};
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const E2E_ENABLED = import.meta.env.VITE_E2E === "true";
const entries = new Map<string, InternalEntry>();
const rendererFaults = new Map<string, InternalRendererFault>();
const listeners = new Set<() => void>();
let nextEventId = 1;
let installedApi: E2ETerminalDiagnosticsApi | undefined;
let fontLoadGate: Promise<void> | undefined;
let releaseFontLoadGate: (() => void) | undefined;
let fontLoadDelayed = false;

function delayFontLoad(): void {
  if (fontLoadDelayed) return;
  fontLoadDelayed = true;
  fontLoadGate = new Promise<void>((resolve) => {
    releaseFontLoadGate = resolve;
  });
}

function releaseFontLoad(): void {
  fontLoadDelayed = false;
  const release = releaseFontLoadGate;
  releaseFontLoadGate = undefined;
  fontLoadGate = undefined;
  release?.();
}

/** Hold the E2E font completion path; normal builds always resolve immediately. */
export function waitForE2EFontLoad(): Promise<void> {
  if (!E2E_ENABLED || typeof window === "undefined" || !fontLoadDelayed) return Promise.resolve();
  return fontLoadGate ?? Promise.resolve();
}

function blankViewport(): E2EViewport {
  return { cols: 0, rows: 0, pixelWidth: 0, pixelHeight: 0 };
}

function blankSnapshot(registration: E2ETerminalRegistration): MutableSnapshot {
  const viewport = blankViewport();
  const socket: E2ESocketSnapshot = {
    generation: 0,
    readyState: WebSocket.CLOSED,
    state: "closed",
    activeCount: 0,
  };
  const stream: E2EStreamSnapshot = {};
  const parser: E2EParserSnapshot = { pendingWrites: 0, pendingBytes: 0 };
  const renderBacklog: E2ERenderBacklogSnapshot = { bytes: 0, frames: 0, oldestAgeMs: 0 };
  const flow: E2EFlowSnapshot = { controlled: false, acknowledgedBytes: 0, pendingAcknowledgementBytes: 0 };
  const checkpoint: E2ECheckpointSnapshot = {
    size: 0,
    chunks: 0,
    serializationDurationMs: 0,
    uploadDurationMs: 0,
    result: "idle",
  };
  const rendererState: E2ERendererSnapshot = {
    kind: "canvas",
    webglLoadCount: 0,
    contextLossCount: 0,
    fallbackCount: 0,
    renderCount: 0,
  };
  const xterm: E2EXtermSnapshot = {
    activeBuffer: "normal",
    cursorX: 0,
    cursorY: 0,
    viewportY: 0,
    text: "",
    selectionText: "",
  };
  const lifecycle: E2ELifecycleSnapshot = {
    mounted: true,
    visible: false,
    cached: true,
    active: false,
    focused: false,
    acceptingInput: false,
  };
  return {
    terminalId: registration.terminalId,
    paneId: registration.paneId,
    kind: registration.kind ?? "pane",
    updatedAt: Date.now(),
    exitCode: undefined,
    cols: 0,
    rows: 0,
    pixelWidth: 0,
    pixelHeight: 0,
    proposedViewport: undefined,
    desiredViewport: undefined,
    urlViewport: undefined,
    sentViewport: undefined,
    serverViewport: undefined,
    socketGeneration: socket.generation,
    socketUrl: undefined,
    socketReadyState: socket.readyState,
    socketState: socket.state,
    activeSocketCount: socket.activeCount,
    gridEpoch: undefined,
    receivedSequence: undefined,
    committedSequence: undefined,
    syncMode: undefined,
    syncTarget: undefined,
    pendingParserWrites: parser.pendingWrites,
    pendingParserBytes: parser.pendingBytes,
    renderBacklogBytes: renderBacklog.bytes,
    renderBacklogFrames: renderBacklog.frames,
    renderBacklogOldestAgeMs: renderBacklog.oldestAgeMs,
    flowControlled: flow.controlled,
    flowAcknowledgedBytes: flow.acknowledgedBytes,
    flowPendingAcknowledgementBytes: flow.pendingAcknowledgementBytes,
    checkpointSize: checkpoint.size,
    checkpointChunks: checkpoint.chunks,
    checkpointSerializationDurationMs: checkpoint.serializationDurationMs,
    checkpointUploadDurationMs: checkpoint.uploadDurationMs,
    checkpointResult: checkpoint.result,
    checkpointSequence: undefined,
    checkpointEpoch: undefined,
    renderer: rendererState.kind,
    webglLoadCount: rendererState.webglLoadCount,
    contextLossCount: rendererState.contextLossCount,
    fallbackCount: rendererState.fallbackCount,
    renderCount: rendererState.renderCount,
    activeBuffer: xterm.activeBuffer,
    cursorX: xterm.cursorX,
    cursorY: xterm.cursorY,
    viewportY: xterm.viewportY,
    text: xterm.text,
    selectionText: xterm.selectionText,
    mounted: lifecycle.mounted,
    visible: lifecycle.visible,
    cached: lifecycle.cached,
    active: lifecycle.active,
    focused: lifecycle.focused,
    acceptingInput: lifecycle.acceptingInput,
    viewport,
    socket,
    stream,
    parser,
    renderBacklog,
    flow,
    checkpoint,
    rendererState,
    xterm,
    lifecycle,
  };
}

function cloneViewport(viewport: E2EViewport | undefined): E2EViewport | undefined {
  return viewport ? { ...viewport } : undefined;
}

function cloneSnapshot(snapshot: MutableSnapshot, maximumTextLength?: number): E2ETerminalSnapshot {
  const proposedViewport = cloneViewport(snapshot.proposedViewport);
  const desiredViewport = cloneViewport(snapshot.desiredViewport);
  const urlViewport = cloneViewport(snapshot.urlViewport);
  const sentViewport = cloneViewport(snapshot.sentViewport);
  const serverViewport = cloneViewport(snapshot.serverViewport);
  const text = maximumTextLength === undefined || snapshot.text.length <= maximumTextLength
    ? snapshot.text
    : maximumTextLength <= 0
      ? ""
      : snapshot.text.slice(-maximumTextLength);
  const xterm = { ...snapshot.xterm, text };
  return {
    ...snapshot,
    text,
    proposedViewport,
    desiredViewport,
    urlViewport,
    sentViewport,
    serverViewport,
    viewport: { ...snapshot.viewport },
    socket: { ...snapshot.socket },
    stream: { ...snapshot.stream },
    parser: { ...snapshot.parser },
    renderBacklog: { ...snapshot.renderBacklog },
    flow: { ...snapshot.flow },
    checkpoint: { ...snapshot.checkpoint },
    rendererState: { ...snapshot.rendererState },
    xterm,
    lifecycle: { ...snapshot.lifecycle },
  };
}

function cloneEvent(event: E2ETerminalEvent): E2ETerminalEvent {
  return {
    ...event,
    data: { ...event.data },
    snapshot: cloneSnapshot(event.snapshot as MutableSnapshot, MAX_EVENT_XTERM_TEXT_LENGTH),
  };
}


function notify(entry?: InternalEntry): void {
  if (entry) {
    for (const listener of entry.listeners) {
      try {
        listener();
      } catch {
        // A rejected diagnostic wait must never escape into terminal lifecycle code.
      }
    }
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A rejected diagnostic wait must never escape into terminal lifecycle code.
    }
  }
}

function recordInternal<T extends Record<string, unknown>>(
  entry: InternalEntry,
  type: E2ETerminalEventType,
  data: T = {} as T,
): void {
  entry.snapshot.updatedAt = Date.now();
  const event: E2ETerminalEvent<T> = {
    id: nextEventId++,
    timestamp: entry.snapshot.updatedAt,
    terminalId: entry.registration.terminalId,
    paneId: entry.registration.paneId,
    type,
    data,
    snapshot: cloneSnapshot(entry.snapshot, MAX_EVENT_XTERM_TEXT_LENGTH),
  };
  entry.events.push(event as E2ETerminalEvent);
  if (entry.events.length > MAX_EVENTS) {
    const evictable = entry.events.findIndex((candidate) => EVICTABLE_EVENT_TYPES[candidate.type] === true);
    entry.events.splice(evictable >= 0 ? evictable : 0, 1);
  }
  notify(entry);
}

function setPatch(entry: InternalEntry, patch: Partial<E2ETerminalSnapshot>): void {
  const mutable = patch as Partial<MutableSnapshot>;
  for (const [key, value] of Object.entries(mutable)) {
    if (value !== undefined && key in entry.snapshot && key !== "updatedAt") {
      (entry.snapshot as unknown as Record<string, unknown>)[key] = value;
    }
  }
  const viewport = entry.snapshot.serverViewport ?? entry.snapshot.sentViewport ?? entry.snapshot.desiredViewport ?? entry.snapshot.proposedViewport;
  if (viewport) {
    entry.snapshot.viewport = { ...viewport };
    entry.snapshot.cols = viewport.cols;
    entry.snapshot.rows = viewport.rows;
    entry.snapshot.pixelWidth = viewport.pixelWidth;
    entry.snapshot.pixelHeight = viewport.pixelHeight;
  }
  entry.snapshot.socket = {
    generation: entry.snapshot.socketGeneration,
    url: entry.snapshot.socketUrl,
    readyState: entry.snapshot.socketReadyState,
    state: entry.snapshot.socketState,
    activeCount: entry.snapshot.activeSocketCount,
  };
  entry.snapshot.stream = {
    gridEpoch: entry.snapshot.gridEpoch,
    receivedSequence: entry.snapshot.receivedSequence,
    committedSequence: entry.snapshot.committedSequence,
    syncMode: entry.snapshot.syncMode,
    syncTarget: entry.snapshot.syncTarget,
  };
  entry.snapshot.parser = {
    pendingWrites: entry.snapshot.pendingParserWrites,
    pendingBytes: entry.snapshot.pendingParserBytes,
  };
  entry.snapshot.renderBacklog = {
    bytes: entry.snapshot.renderBacklogBytes,
    frames: entry.snapshot.renderBacklogFrames,
    oldestAgeMs: entry.snapshot.renderBacklogOldestAgeMs,
  };
  entry.snapshot.flow = {
    controlled: entry.snapshot.flowControlled,
    acknowledgedBytes: entry.snapshot.flowAcknowledgedBytes,
    pendingAcknowledgementBytes: entry.snapshot.flowPendingAcknowledgementBytes,
  };
  entry.snapshot.checkpoint = {
    sequence: entry.snapshot.checkpointSequence,
    epoch: entry.snapshot.checkpointEpoch,
    size: entry.snapshot.checkpointSize,
    chunks: entry.snapshot.checkpointChunks,
    serializationDurationMs: entry.snapshot.checkpointSerializationDurationMs,
    uploadDurationMs: entry.snapshot.checkpointUploadDurationMs,
    result: entry.snapshot.checkpointResult,
  };
  entry.snapshot.rendererState = {
    kind: entry.snapshot.renderer,
    webglLoadCount: entry.snapshot.webglLoadCount,
    contextLossCount: entry.snapshot.contextLossCount,
    fallbackCount: entry.snapshot.fallbackCount,
    renderCount: entry.snapshot.renderCount,
  };
  entry.snapshot.xterm = {
    activeBuffer: entry.snapshot.activeBuffer,
    cursorX: entry.snapshot.cursorX,
    cursorY: entry.snapshot.cursorY,
    viewportY: entry.snapshot.viewportY,
    text: entry.snapshot.text,
    selectionText: entry.snapshot.selectionText,
  };
  entry.snapshot.lifecycle = {
    mounted: entry.snapshot.mounted,
    visible: entry.snapshot.visible,
    cached: entry.snapshot.cached,
    active: entry.snapshot.active,
    focused: entry.snapshot.focused,
    acceptingInput: entry.snapshot.acceptingInput,
  };
  entry.snapshot.updatedAt = Date.now();
  notify(entry);
}
const MAX_RETAINED_CLOSED_SOCKETS = 1;

function pruneClosedSockets(entry: InternalEntry): void {
  let retainedClosedGeneration: number | undefined;
  for (let index = entry.sockets.length - 1; index >= 0; index -= 1) {
    const candidate = entry.sockets[index];
    if (candidate && !candidate.active) {
      retainedClosedGeneration = candidate.generation;
      break;
    }
  }
  if (retainedClosedGeneration === undefined) return;
  entry.sockets = entry.sockets.filter((candidate) => (
    candidate.active
    || candidate.generation >= retainedClosedGeneration - (MAX_RETAINED_CLOSED_SOCKETS - 1)
  ));
}

function socketMessageBytes(data: unknown): number | undefined {
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return undefined;
}


function findEntry(terminalId: string, paneId?: string): InternalEntry | undefined {
  if (paneId) return entries.get(paneId)?.registration.terminalId === terminalId ? entries.get(paneId) : undefined;
  let retainedPane: InternalEntry | undefined;
  let mountedPreview: InternalEntry | undefined;
  let retainedPreview: InternalEntry | undefined;
  for (const entry of entries.values()) {
    if (entry.registration.terminalId !== terminalId) continue;
    if (entry.registration.kind !== "preview") {
      if (entry.snapshot.mounted) return entry;
      retainedPane ??= entry;
    } else if (entry.snapshot.mounted) {
      mountedPreview ??= entry;
    } else {
      retainedPreview ??= entry;
    }
  }
  return retainedPane ?? mountedPreview ?? retainedPreview;
}

const EVENT_TYPES: Record<E2ETerminalEventType, true> = {
  mount: true,
  unmount: true,
  snapshot: true,
  visibility: true,
  active: true,
  focus: true,
  viewport: true,
  size: true,
  "socket-created": true,
  "socket-open": true,
  "socket-message": true,
  "socket-close": true,
  "socket-stale": true,
  state: true,
  sync: true,
  synced: true,
  exit: true,
  "output-received": true,
  "parser-commit": true,
  checkpoint: true,
  "renderer-load": true,
  "renderer-context-loss": true,
  "renderer-fallback": true,
  render: true,
  "font-load": true,
  input: true,
  error: true,
};

function isEventType(value: unknown): value is E2ETerminalEventType {
  return typeof value === "string" && EVENT_TYPES[value as E2ETerminalEventType] === true;
}

function isWaitOptions(value: unknown): value is E2EWaitOptions {
  return value !== null && typeof value === "object"
    && ("timeout" in value || "afterId" in value || "signal" in value);
}

/** Return the event floor for a wait started against an existing event list. */
export function initialEventCursor(
  events: readonly Pick<E2ETerminalEvent, "id">[],
  afterId?: number,
): number {
  if (afterId !== undefined) {
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      throw new Error(`afterId must be a non-negative safe integer, received ${String(afterId)}`);
    }
    return afterId;
  }
  return events.reduce((cursor, event) => Math.max(cursor, event.id), 0);
}

/** Select the first matching event after a caller's floor. */
export function firstEventAfter<T extends { readonly id: number }>(
  events: readonly T[],
  afterId: number,
  predicate: (event: T) => boolean,
): T | undefined {
  return [...events]
    .sort((left, right) => left.id - right.id)
    .find((event) => event.id > afterId && predicate(event));
}

function normalizeEventType(value: E2ETerminalEventType | E2EEventPredicate | undefined): E2EEventPredicate {
  if (typeof value === "function") return value;
  if (typeof value === "string") return (event) => event.type === value;
  return () => true;
}

function normalizeWaitTimeout(options: E2EWaitOptions | undefined): number {
  const timeout = options?.timeout;
  return Number.isFinite(timeout) && timeout !== undefined && timeout >= 0 ? timeout : DEFAULT_WAIT_TIMEOUT_MS;
}

function abortError(): Error {
  return new DOMException("E2E diagnostic wait aborted", "AbortError");
}

function waitUntil<T>(
  subscribe: (notify: () => void) => () => void,
  current: () => T | undefined,
  options?: E2EWaitOptions,
): Promise<T> {
  if (options?.signal?.aborted) return Promise.reject(abortError());
  let immediate: T | undefined;
  try {
    immediate = current();
  } catch (error) {
    return Promise.reject(error);
  }
  if (immediate !== undefined) return Promise.resolve(immediate);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: number | undefined;
    let unsubscribe: (() => void) | undefined;
    let subscribed = false;
    let cleanupBeforeSubscribe = false;
    const cleanup = () => {
      const dispose = unsubscribe;
      unsubscribe = undefined;
      if (dispose) {
        try {
          dispose();
        } catch {
          // Cleanup failures must not escape the terminal lifecycle callback.
        }
      } else if (!subscribed) {
        cleanupBeforeSubscribe = true;
      }
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      options?.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const onNotify = () => {
      try {
        const value = current();
        if (value !== undefined) finish(() => resolve(value));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    if (options?.signal?.aborted) {
      onAbort();
      return;
    }
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = normalizeWaitTimeout(options);
    timer = window.setTimeout(() => finish(() => reject(new Error(`Timed out after ${timeout}ms waiting for terminal diagnostics`))), timeout);
    try {
      const dispose = subscribe(onNotify);
      subscribed = true;
      if (cleanupBeforeSubscribe) {
        try {
          dispose();
        } catch {
          // Cleanup failures must not escape the terminal lifecycle callback.
        }
      } else {
        unsubscribe = dispose;
      }
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    if (!settled) onNotify();
  });
}

function installApi(): E2ETerminalDiagnosticsApi | undefined {
  if (!E2E_ENABLED || typeof window === "undefined") return undefined;
  if (installedApi) return installedApi;

  const controls: E2EDiagnosticsControls = {
    font: {
      delay() {
        delayFontLoad();
      },
      release() {
        releaseFontLoad();
      },
      reset() {
        releaseFontLoad();
      },
    },
    renderer: {
      delayWebGL(terminalId, delayMs) {
        const fault = rendererFaults.get(terminalId) ?? { delayMs: 0, fail: false, message: "WebGL load failed", loseContext: false };
        fault.delayMs = Math.max(0, Math.floor(Number.isFinite(delayMs) ? delayMs : 0));
        fault.fail = false;
        rendererFaults.set(terminalId, fault);
        for (const entry of entries.values()) {
          if (entry.registration.terminalId === terminalId) entry.rendererFault = fault;
        }
      },
      failWebGL(terminalId, options = {}) {
        const fault = rendererFaults.get(terminalId) ?? { delayMs: 0, fail: false, message: "WebGL load failed", loseContext: false };
        fault.fail = true;
        fault.message = options.message ?? "WebGL load failed (E2E fault)";
        rendererFaults.set(terminalId, fault);
        for (const entry of entries.values()) {
          if (entry.registration.terminalId === terminalId) entry.rendererFault = fault;
        }
      },
      loseContext(terminalId) {
        const fault = rendererFaults.get(terminalId) ?? { delayMs: 0, fail: false, message: "WebGL load failed", loseContext: false };
        fault.loseContext = true;
        rendererFaults.set(terminalId, fault);
        const entry = findEntry(terminalId);
        const trigger = entry?.contextLossControl;
        if (trigger) {
          fault.loseContext = false;
          trigger();
          return;
        }
        if (entry && entry.snapshot.contextLossCount > 0) {
          fault.loseContext = false;
          return;
        }
        if (entry && entry.snapshot.webglLoadCount > 0 && entry.snapshot.renderer !== "webgl") {
          fault.loseContext = false;
          throw new Error("WEBGL_lose_context is unavailable for the active WebGL renderer");
        }
      },
      reset(terminalId) {
        if (terminalId) {
          rendererFaults.delete(terminalId);
          for (const entry of entries.values()) {
            if (entry.registration.terminalId === terminalId) {
              entry.rendererFault = { delayMs: 0, fail: false, message: "WebGL load failed", loseContext: false };
            }
          }
        } else {
          rendererFaults.clear();
          for (const entry of entries.values()) {
            entry.rendererFault = { delayMs: 0, fail: false, message: "WebGL load failed", loseContext: false };
          }
        }
      },
    },
    socket: {
      close(terminalId, options = {}) {
        const entry = findEntry(terminalId);
        if (!entry) return;
        const target = options.generation === undefined
          ? entry.sockets.findLast((candidate) => candidate.active) ?? entry.sockets.at(-1)
          : entry.sockets.find((candidate) => candidate.generation === options.generation);
        if (!target) return;
        const code = options.code ?? 1000;
        const reason = options.reason ?? "E2E socket close";
        if (options.abrupt || code === 1006) {
          target.socket.dispatchEvent(new CloseEvent("close", { code: 1006, reason, wasClean: false }));
          if (target.socket.readyState !== WebSocket.CLOSED) target.socket.close();
        } else {
          target.socket.close(code, reason);
        }
      },
      setProtocolVersion(terminalId, version) {
        const entry = findEntry(terminalId);
        if (!entry) return;
        entry.protocolVersion = version === undefined
          ? undefined
          : Number.isInteger(version) ? version : undefined;
      },
      deliverStaleEvent(terminalId, options = {}) {
        const entry = findEntry(terminalId);
        if (!entry) return;
        const currentGeneration = entry.snapshot.socketGeneration;
        const target = options.generation === undefined
          ? entry.sockets.find((candidate) => candidate.generation < currentGeneration)
          : entry.sockets.find((candidate) => candidate.generation === options.generation);
        if (!target) return;
        const wasActive = target.active;
        const stale = target.generation < currentGeneration;
        const eventType = options.type ?? (options.data === undefined ? "open" : "message");
        if (eventType === "message") {
          target.socket.dispatchEvent(new MessageEvent("message", { data: options.data ?? "{}" }));
        } else if (eventType === "close") {
          target.socket.dispatchEvent(new CloseEvent("close", {
            code: options.code ?? 1006,
            reason: options.reason ?? "E2E stale close",
            wasClean: false,
          }));
        } else {
          target.socket.dispatchEvent(new Event(eventType));
        }
        if (stale && (eventType !== "close" || !wasActive || target.active)) {
          recordInternal(entry, "socket-stale", { generation: target.generation });
        }
      },
      reset(terminalId) {
        const targets = terminalId ? [findEntry(terminalId)] : [...entries.values()];
        for (const entry of targets) {
          if (!entry) continue;
          for (const socket of entry.sockets) {
            if (socket.active) socket.socket.close(1000, "E2E reset");
          }
        }
      },
    },
    delayWebGL: (terminalId, delayMs) => controls.renderer.delayWebGL(terminalId, delayMs),
    failWebGL: (terminalId, options) => controls.renderer.failWebGL(terminalId, options),
    loseContext: (terminalId) => controls.renderer.loseContext(terminalId),
    closeSocket: (terminalId, options) => controls.socket.close(terminalId, options),
    deliverStaleSocketEvent: (terminalId, options) => controls.socket.deliverStaleEvent(terminalId, options),
  };
  installedApi = Object.freeze({
    version: 1 as const,
    terminal(terminalId: string, paneId?: string) {
      const entry = findEntry(terminalId, paneId);
      return entry ? cloneSnapshot(entry.snapshot) : undefined;
    },
    terminals() {
      return [...entries.values()].map((entry) => cloneSnapshot(entry.snapshot));
    },
    events(terminalId?: string, paneId?: string) {
      const selected = terminalId
        ? [findEntry(terminalId, paneId)].filter((entry): entry is InternalEntry => Boolean(entry))
        : [...entries.values()];
      return selected.flatMap((entry) => entry.events.map(cloneEvent));
    },
    waitForTerminal(
      terminalId: string,
      predicateOrOptions?: E2ETerminalPredicate | Partial<E2ETerminalSnapshot> | E2EWaitOptions,
      maybeOptions?: E2EWaitOptions,
    ) {
      const expected = predicateOrOptions !== null
        && typeof predicateOrOptions === "object"
        && !isWaitOptions(predicateOrOptions)
        ? predicateOrOptions
        : undefined;
      const predicate = typeof predicateOrOptions === "function"
        ? predicateOrOptions
        : expected
          ? (snapshot: E2ETerminalSnapshot) => Object.entries(expected).every(([key, value]) => (snapshot as unknown as Record<string, unknown>)[key] === value)
          : () => true;
      const options = typeof predicateOrOptions === "function" || expected !== undefined
        ? maybeOptions
        : maybeOptions ?? (isWaitOptions(predicateOrOptions) ? predicateOrOptions : undefined);
      return waitUntil(
        (onNotify) => {
          const entry = findEntry(terminalId);
          if (!entry) {
            listeners.add(onNotify);
            return () => listeners.delete(onNotify);
          }
          entry.listeners.add(onNotify);
          return () => entry.listeners.delete(onNotify);
        },
        () => {
          const snapshot = installedApi?.terminal(terminalId);
          return snapshot && predicate(snapshot) ? snapshot : undefined;
        },
        options,
      );
    },
    waitForEvent(...args: unknown[]) {
      let terminalId: string | undefined;
      let predicateOrType: E2EEventPredicate | E2ETerminalEventType | undefined;
      let options: E2EWaitOptions | undefined;
      const first = args[0];
      const second = args[1];
      const terminalOverload = typeof first === "string"
        && !isEventType(first)
        && (args.length > 1 || entries.has(first));
      if (terminalOverload) {
        terminalId = first;
        if (isWaitOptions(second) && args.length < 3) {
          options = second;
        } else {
          predicateOrType = second as E2EEventPredicate | E2ETerminalEventType | undefined;
          options = args[2] as E2EWaitOptions | undefined;
        }
      } else if (isWaitOptions(first)) {
        options = first;
      } else {
        predicateOrType = first as E2EEventPredicate | E2ETerminalEventType | undefined;
        options = (args[2] ?? second) as E2EWaitOptions | undefined;
      }
      const predicate = normalizeEventType(predicateOrType);
      const selectEvents = () => {
        const selected = terminalId ? [findEntry(terminalId)].filter((entry): entry is InternalEntry => Boolean(entry)) : [...entries.values()];
        return selected.flatMap((entry) => entry.events);
      };
      let cursor = initialEventCursor(selectEvents(), options?.afterId);
      const current = () => {
        const events = selectEvents();
        const next = firstEventAfter(events, cursor, predicate);
        if (next) {
          cursor = next.id;
          return cloneEvent(next);
        }
        return undefined;
      };
      return waitUntil(
        (onNotify) => {
          listeners.add(onNotify);
          return () => listeners.delete(onNotify);
        },
        current,
        options,
      );
    },
    controls,
  });
  window.__TERM_SERVER_E2E__ = installedApi;
  return installedApi;
}

const NOOP_HANDLE: E2ETerminalDiagnosticsHandle = {
  terminalId: "",
  paneId: "",
  update: () => undefined,
  updateXterm: () => undefined,
  record: () => undefined,
  beforeRendererLoad: async () => undefined,
  rendererLoaded: () => undefined,
  rendererFallback: () => undefined,
  rendererContextLost: () => undefined,
  registerContextLossControl: () => () => undefined,
  rendererRendered: () => undefined,
  socketCreated: () => 0,
  socketProtocolVersion: () => undefined,
  socketOpened: () => undefined,
  socketMessage: () => undefined,
  socketClosed: () => undefined,
  socketState: () => undefined,
  outputReceived: () => undefined,
  parserState: () => undefined,
  streamState: () => undefined,
  renderBacklog: () => undefined,
  flowState: () => undefined,
  checkpointState: () => undefined,
  dispose: () => undefined,
};

/** Install and return the E2E-only browser API. Normal builds return undefined. */
export function installE2EDiagnostics(): E2ETerminalDiagnosticsApi | undefined {
  return installApi();
}

/** Register one mounted pane or preview with the E2E diagnostics registry. */
export function registerE2ETerminal(registration: E2ETerminalRegistration): E2ETerminalDiagnosticsHandle {
  if (!E2E_ENABLED || typeof window === "undefined") return NOOP_HANDLE;
  installApi();
  const existing = entries.get(registration.paneId);
  if (existing) {
    existing.snapshot.mounted = true;
    setPatch(existing, { mounted: true });
    return makeHandle(existing);
  }
  const entry: InternalEntry = {
    registration: { ...registration, kind: registration.kind ?? "pane" },
    snapshot: blankSnapshot(registration),
    events: [],
    listeners: new Set(),
    sockets: [],
    rendererFault: rendererFaults.get(registration.terminalId) ?? { delayMs: 0, fail: false, message: "WebGL load failed", loseContext: false },
  };
  entries.set(registration.paneId, entry);
  recordInternal(entry, "mount");
  return makeHandle(entry);
}

function makeHandle(entry: InternalEntry): E2ETerminalDiagnosticsHandle {
  let disposed = false;
  const handle: E2ETerminalDiagnosticsHandle = {
    terminalId: entry.registration.terminalId,
    paneId: entry.registration.paneId,
    update(patch) {
      if (disposed) return;
      setPatch(entry, patch);
    },
    updateXterm(terminal) {
      if (disposed) return;
      const value = terminal as {
        cols?: number;
        rows?: number;
        buffer?: { active?: { type?: "normal" | "alternate"; cursorX?: number; cursorY?: number; viewportY?: number; length?: number; getLine?: (index: number) => { isWrapped?: boolean; translateToString(trimRight?: boolean): string } | undefined } };
        getSelection?: () => string;
      };
      const active = value.buffer?.active;
      if (!active) return;
      const text = captureXtermTailText(active, value.rows);
      setPatch(entry, {
        cols: value.cols ?? entry.snapshot.cols,
        rows: value.rows ?? entry.snapshot.rows,
        activeBuffer: active.type ?? "normal",
        cursorX: active.cursorX ?? 0,
        cursorY: active.cursorY ?? 0,
        viewportY: active.viewportY ?? 0,
        text,
        selectionText: value.getSelection?.() ?? "",
      });
    },
    record(type, data) {
      if (disposed) return;
      recordInternal(entry, type, data);
    },
    async beforeRendererLoad() {
      if (disposed) return;
      entry.snapshot.webglLoadCount += 1;
      setPatch(entry, {});
      const fault = entry.rendererFault;
      if (fault.delayMs > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, fault.delayMs));
      if (fault.fail) throw new Error(fault.message);
    },
    rendererLoaded(kind = "webgl") {
      if (disposed) return;
      entry.snapshot.renderer = kind;
      setPatch(entry, {});
      recordInternal(entry, "renderer-load", { kind });
      if (entry.rendererFault.loseContext) {
        entry.rendererFault.loseContext = false;
        entry.contextLossControl?.();
      }
    },
    rendererFallback(reason = "fallback") {
      if (disposed) return;
      entry.snapshot.fallbackCount += 1;
      entry.snapshot.renderer = "canvas";
      setPatch(entry, {});
      recordInternal(entry, "renderer-fallback", { reason });
    },
    rendererContextLost() {
      if (disposed) return;
      entry.snapshot.contextLossCount += 1;
      entry.snapshot.fallbackCount += 1;
      entry.snapshot.renderer = "canvas";
      setPatch(entry, {});
      recordInternal(entry, "renderer-context-loss");
      recordInternal(entry, "renderer-fallback", { reason: "context-loss" });
    },
    registerContextLossControl(callback) {
      if (disposed) return () => undefined;
      const previous = entry.contextLossControl;
      entry.contextLossControl = callback;
      return () => {
        if (entry.contextLossControl === callback) entry.contextLossControl = previous;
      };
    },
    rendererRendered() {
      if (disposed) return;
      entry.snapshot.renderCount += 1;
      setPatch(entry, {});
      recordInternal(entry, "render");
    },
    socketCreated(socket, url) {
      if (disposed) return 0;
      const generation = entry.snapshot.socketGeneration + 1;
      entry.sockets.push({ generation, socket, url, active: true });
      pruneClosedSockets(entry);
      entry.snapshot.socketGeneration = generation;
      entry.snapshot.socketUrl = url;
      entry.snapshot.socketReadyState = socket.readyState;
      entry.snapshot.socketState = "connecting";
      entry.snapshot.activeSocketCount = entry.sockets.filter((candidate) => candidate.active).length;
      setPatch(entry, {});
      recordInternal(entry, "socket-created", { generation, url });
      return generation;
    },
    socketProtocolVersion() {
      return entry.protocolVersion;
    },
    socketOpened(socket) {
      if (disposed) return;
      const target = entry.sockets.find((candidate) => candidate.socket === socket);
      if (!target) return;
      entry.snapshot.socketReadyState = socket.readyState;
      entry.snapshot.socketState = "open";
      setPatch(entry, {});
      recordInternal(entry, "socket-open", { generation: target.generation });
    },
    socketMessage(socket, data) {
      if (disposed) return;
      const target = entry.sockets.find((candidate) => candidate.socket === socket);
      if (!target) return;
      entry.snapshot.socketReadyState = socket.readyState;
      setPatch(entry, {});
      const bytes = socketMessageBytes(data);
      recordInternal(entry, "socket-message", bytes === undefined
        ? { generation: target.generation }
        : { generation: target.generation, bytes });
    },
    socketClosed(socket) {
      if (disposed) return;
      const target = entry.sockets.find((candidate) => candidate.socket === socket);
      if (!target || !target.active) return;
      target.active = false;
      entry.snapshot.activeSocketCount = entry.sockets.filter((candidate) => candidate.active).length;
      const stale = entry.snapshot.socketGeneration !== target.generation;
      if (!stale) {
        entry.snapshot.socketReadyState = WebSocket.CLOSED;
        if (entry.snapshot.socketState !== "exited") entry.snapshot.socketState = "closed";
      }
      pruneClosedSockets(entry);
      setPatch(entry, {});
      recordInternal(entry, stale ? "socket-stale" : "socket-close", { generation: target.generation });
    },
    socketState(state) {
      if (disposed) return;
      entry.snapshot.socketState = state;
      setPatch(entry, {});
      recordInternal(entry, "state", { state });
    },
    outputReceived(sequence, bytes) {
      if (disposed) return;
      entry.snapshot.receivedSequence = sequence;
      setPatch(entry, {});
      recordInternal(entry, "output-received", { sequence, bytes });
    },
    parserState(pendingWrites, pendingBytes) {
      if (disposed) return;
      entry.snapshot.pendingParserWrites = Math.max(0, pendingWrites);
      entry.snapshot.pendingParserBytes = Math.max(0, pendingBytes);
      setPatch(entry, {});
      recordInternal(entry, "snapshot", {
        pendingParserWrites: pendingWrites,
        pendingParserBytes: pendingBytes,
      });
    },
    streamState(stream) {
      if (disposed) return;
      if ("gridEpoch" in stream) entry.snapshot.gridEpoch = stream.gridEpoch;
      if ("receivedSequence" in stream) entry.snapshot.receivedSequence = stream.receivedSequence;
      if ("committedSequence" in stream) entry.snapshot.committedSequence = stream.committedSequence;
      if ("syncMode" in stream) entry.snapshot.syncMode = stream.syncMode;
      if ("syncTarget" in stream) entry.snapshot.syncTarget = stream.syncTarget;
      setPatch(entry, {});
      recordInternal(entry, "snapshot", { stream: { ...stream } });
    },
    renderBacklog(backlog) {
      if (disposed) return;
      setPatch(entry, {
        renderBacklogBytes: backlog.bytes,
        renderBacklogFrames: backlog.frames,
        renderBacklogOldestAgeMs: backlog.oldestAgeMs,
      });
    },
    flowState(flow) {
      if (disposed) return;
      setPatch(entry, {
        flowControlled: flow.controlled,
        flowAcknowledgedBytes: flow.acknowledgedBytes,
        flowPendingAcknowledgementBytes: flow.pendingAcknowledgementBytes,
      });
    },
    checkpointState(checkpoint) {
      if (disposed) return;
      setPatch(entry, {
        checkpointSequence: checkpoint.sequence,
        checkpointEpoch: checkpoint.epoch,
        checkpointSize: checkpoint.size,
        checkpointChunks: checkpoint.chunks,
        checkpointSerializationDurationMs: checkpoint.serializationDurationMs,
        checkpointUploadDurationMs: checkpoint.uploadDurationMs,
        checkpointResult: checkpoint.result,
      });
      recordInternal(entry, "checkpoint", { ...checkpoint });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      entry.contextLossControl = undefined;
      entry.snapshot.mounted = false;
      entry.snapshot.visible = false;
      entry.snapshot.cached = true;
      entry.snapshot.active = false;
      entry.snapshot.focused = false;
      entry.snapshot.acceptingInput = false;
      for (const socket of entry.sockets) socket.active = false;
      entry.snapshot.activeSocketCount = 0;
      setPatch(entry, {});
      recordInternal(entry, "unmount");
      entries.delete(entry.registration.paneId);
      notify();
    },
  };
  entry.contextLossCallback = () => handle.rendererContextLost();
  return handle;
}

/** Type declaration for the browser-only global installed in E2E builds. */
declare global {
  interface ImportMetaEnv {
    readonly VITE_E2E?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
  interface Window {
    __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
  }
}

if (E2E_ENABLED) installApi();
