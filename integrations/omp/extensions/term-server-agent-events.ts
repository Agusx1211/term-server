import { spawn } from "node:child_process";
import { createSubagentActivityTracker } from "./subagent-activity";

// Minimal, self-contained view of the omp extension API this module uses.
// Kept local so the asset has no build-time dependency on omp's type package.
interface TermServerEventBus {
  on(
    channel: "task:subagent:lifecycle",
    handler: (event: unknown) => void,
  ): () => void;
}

interface TermServerSessionManager {
  getBranch?(): unknown[];
  getEntries?(): unknown[];
}

interface TermServerExtensionContext {
  hasUI?: boolean;
  sessionManager?: TermServerSessionManager;
}

interface AgentEndEvent {
  isTerminal?: boolean;
}

interface MessageEndEvent {
  message?: unknown;
}

interface ToolExecutionStartEvent {
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  intent?: string;
}

interface ToolExecutionEndEvent extends ToolExecutionStartEvent {
  result?: unknown;
  isError?: boolean;
}

type ExtensionHandler<Event> = (
  event: Event,
  context: TermServerExtensionContext,
) => void | Promise<void>;

interface TermServerExtensionApi {
  getSessionName?(): string | undefined | null;
  on(event: "session_start", handler: ExtensionHandler<unknown>): void;
  on(event: "session_switch", handler: ExtensionHandler<unknown>): void;
  on(event: "session_tree", handler: ExtensionHandler<unknown>): void;
  on(event: "agent_start", handler: ExtensionHandler<unknown>): void;
  on(event: "message_end", handler: ExtensionHandler<MessageEndEvent>): void;
  on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
  on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
  on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
  on(event: "session_before_compact", handler: ExtensionHandler<unknown>): void;
  on(event: "session_compact", handler: ExtensionHandler<unknown>): void;
  on(event: "session_shutdown", handler: ExtensionHandler<unknown>): void;
  events: TermServerEventBus;
}

interface PendingReport {
  payload: Record<string, unknown>;
  resolve: () => void;
}

interface TranscriptRecord {
  kind: "message" | "tool_start" | "tool_result" | "status" | "compaction" | "summary" | "marker";
  sourceId?: string;
  timestamp?: number;
  role?: string;
  name?: string;
  text?: string;
  data?: unknown;
  truncated?: boolean;
}

const REPORT_TIMEOUT_MS = 750;
const MAX_PENDING_REPORTS = 256;
const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_TRANSCRIPT_RECORD_BYTES = 240 * 1024;
const MAX_TRANSCRIPT_CHUNK_BYTES = 600 * 1024;

function jsonSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function boundedData(value: unknown): { data: unknown; truncated: boolean } {
  const bytes = jsonSize(value);
  if (bytes <= MAX_TRANSCRIPT_RECORD_BYTES) return { data: value, truncated: false };
  return {
    data: { truncated: true, originalBytes: Number.isFinite(bytes) ? bytes : null },
    truncated: true,
  };
}

function semanticText(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => semanticText(item, depth + 1)).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  for (const key of ["text", "content", "message", "summary", "result", "output", "error", "task"]) {
    const text = semanticText(object[key], depth + 1);
    if (text) return text;
  }
  return "";
}

function numericTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

function messageRecord(message: unknown, sourceId: string): TranscriptRecord | undefined {
  if (!message || typeof message !== "object") return undefined;
  const object = message as Record<string, unknown>;
  const bounded = boundedData(message);
  const text = semanticText(object.content ?? object.text ?? message);
  return {
    kind: "message",
    sourceId,
    timestamp: numericTimestamp(object.timestamp),
    role: typeof object.role === "string" ? object.role : undefined,
    text: text || undefined,
    data: bounded.data,
    truncated: bounded.truncated,
  };
}

function snapshotRecord(entry: unknown): TranscriptRecord | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const object = entry as Record<string, unknown>;
  const type = typeof object.type === "string" ? object.type : "";
  const sourceId = typeof object.id === "string" ? object.id : undefined;
  const timestamp = numericTimestamp(object.timestamp);
  if (type === "message") return messageRecord(object.message, sourceId ?? `message:${timestamp ?? 0}`);
  if (type === "custom_message") {
    const bounded = boundedData({
      customType: object.customType,
      content: object.content,
      details: object.details,
      attribution: object.attribution,
    });
    return {
      kind: "message",
      sourceId,
      timestamp,
      role: "custom",
      name: typeof object.customType === "string" ? object.customType : undefined,
      text: semanticText(object.content) || undefined,
      data: bounded.data,
      truncated: bounded.truncated,
    };
  }
  if (type === "compaction" || type === "branch_summary") {
    const bounded = boundedData(object);
    return {
      kind: type === "compaction" ? "compaction" : "summary",
      sourceId,
      timestamp,
      text: semanticText(object.summary) || undefined,
      data: bounded.data,
      truncated: bounded.truncated,
    };
  }
  if (type === "session_init" && typeof object.task === "string") {
    return {
      kind: "message",
      sourceId,
      timestamp,
      role: "user",
      name: typeof object.agent === "string" ? object.agent : undefined,
      text: object.task,
      data: {
        tools: Array.isArray(object.tools) ? object.tools : [],
        modelRole: object.modelRole,
        resolvedModel: object.resolvedModel,
      },
    };
  }
  if (type === "reset_boundary") {
    return { kind: "marker", sourceId, timestamp, text: "context reset" };
  }
  return undefined;
}

function transcriptChunks(records: TranscriptRecord[]): TranscriptRecord[][] {
  const chunks: TranscriptRecord[][] = [];
  let current: TranscriptRecord[] = [];
  let currentBytes = 2;
  for (const record of records) {
    const bytes = jsonSize(record) + 1;
    if (current.length > 0 && currentBytes + bytes > MAX_TRANSCRIPT_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(record);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Reports lifecycle plus a bounded semantic transcript to the private
// term-server session broker. It is inactive outside a term-server session.
export default function termServerAgentEvents(pi: TermServerExtensionApi): void {
  const executable = process.env.TERM_SERVER_EXECUTABLE;
  const ready = (): boolean =>
    Boolean(executable)
    && Boolean(process.env.TERM_SERVER_SESSION)
    && Boolean(process.env.TERM_SERVER_BROKER_SOCKET);

  let rootSession = false;
  let shuttingDown = false;
  let lastTitle = "";
  let lastSequence = Date.now();
  let semanticSequence = 0;
  let heartbeat: NodeJS.Timeout | undefined;
  let forwarderActive = false;
  const pendingReports: PendingReport[] = [];

  function nextSequence(): number {
    lastSequence = Math.max(Date.now(), lastSequence + 1);
    return lastSequence;
  }

  function forward(payload: Record<string, unknown>): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    let finished = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      resolve();
    };

    try {
      const child = spawn(executable!, ["--agent-event", "omp"], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      child.once("error", finish);
      child.once("exit", finish);
      child.once("close", finish);
      child.stdin.once("error", () => {});
      timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // The child may have exited between the timeout and kill.
        }
        finish();
      }, REPORT_TIMEOUT_MS);
      timeout.unref?.();
      child.stdin.end(JSON.stringify(payload));
      child.unref();
    } catch {
      finish();
    }
    return promise;
  }

  function pumpReports(): void {
    if (forwarderActive) return;
    const report = pendingReports.shift();
    if (!report) return;

    forwarderActive = true;
    void forward(report.payload)
      .catch(() => {})
      .then(() => {
        forwarderActive = false;
        report.resolve();
        pumpReports();
      });
  }

  function send(
    event: string,
    details: Record<string, unknown> = {},
    prioritize = false,
  ): Promise<void> {
    if (shuttingDown || !rootSession || !ready()) return Promise.resolve();

    const payload: Record<string, unknown> = {
      ...details,
      hook_event_name: event,
      sequence: nextSequence(),
    };
    try {
      const title = String(pi.getSessionName?.() ?? "").trim();
      if (title && title !== lastTitle) {
        lastTitle = title;
        payload.title = title;
      }
    } catch {
      // getSessionName is best-effort; never break the agent loop.
    }

    const { promise, resolve } = Promise.withResolvers<void>();
    const report = { payload, resolve };
    if (prioritize) {
      for (const pending of pendingReports.splice(0)) pending.resolve();
      pendingReports.unshift(report);
    } else {
      if (pendingReports.length >= MAX_PENDING_REPORTS) pendingReports.shift()?.resolve();
      pendingReports.push(report);
    }
    pumpReports();
    return promise;
  }

  async function sendSnapshot(context: TermServerExtensionContext): Promise<void> {
    const entries = context.sessionManager?.getBranch?.()
      ?? context.sessionManager?.getEntries?.()
      ?? [];
    const records = entries.flatMap((entry) => {
      const record = snapshotRecord(entry);
      return record ? [record] : [];
    });
    const chunks = transcriptChunks(records);
    if (chunks.length === 0) {
      await send("transcript_snapshot", { transcriptReset: true, transcript: [] });
      return;
    }
    await Promise.all(chunks.map((chunk, index) => send("transcript_snapshot", {
      transcriptReset: index === 0,
      transcript: chunk,
    })));
  }

  const tracker = createSubagentActivityTracker((event) => {
    void send(event);
  });

  function isRootContext(context: unknown): context is TermServerExtensionContext & { hasUI: true } {
    if (typeof context !== "object" || context === null || !("hasUI" in context)) return false;
    return context.hasUI === true;
  }

  function allowRootSession(context: unknown): boolean {
    if (context !== undefined && !isRootContext(context)) return false;
    if (!rootSession) {
      if (!isRootContext(context)) return false;
      rootSession = true;
      if (heartbeat === undefined) {
        heartbeat = setInterval(() => {
          if (rootSession && tracker.hasActiveWork()) void send("agent_start");
        }, HEARTBEAT_INTERVAL_MS);
        heartbeat.unref?.();
      }
    }
    return true;
  }

  function stopHeartbeat(): void {
    if (heartbeat === undefined) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  }

  const unsubscribeSubagentLifecycle = pi.events.on(
    "task:subagent:lifecycle",
    (event: unknown) => {
      if (rootSession && !shuttingDown) tracker.onSubagentLifecycle(event);
    },
  );

  pi.on("session_start", (_event: unknown, context: TermServerExtensionContext) => {
    if (allowRootSession(context)) void sendSnapshot(context);
  });
  pi.on("session_switch", (_event: unknown, context: TermServerExtensionContext) => {
    if (allowRootSession(context)) void sendSnapshot(context);
  });
  pi.on("session_tree", (_event: unknown, context: TermServerExtensionContext) => {
    if (allowRootSession(context)) void sendSnapshot(context);
  });
  pi.on("agent_start", (_event: unknown, context: TermServerExtensionContext) => {
    if (!allowRootSession(context)) return;
    tracker.onParentStart();
  });
  pi.on("message_end", (event: MessageEndEvent, context: TermServerExtensionContext) => {
    if (!allowRootSession(context)) return;
    const record = messageRecord(event.message, `live-message:${semanticSequence++}`);
    if (record) void send("message_end", { transcript: [record] });
  });
  pi.on("tool_execution_start", (event: ToolExecutionStartEvent, context: TermServerExtensionContext) => {
    if (!allowRootSession(context)) return;
    void send("tool_execution_start", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: boundedData(event.args).data,
      intent: event.intent,
    });
  });
  pi.on("tool_execution_end", (event: ToolExecutionEndEvent, context: TermServerExtensionContext) => {
    if (!allowRootSession(context)) return;
    void send("tool_execution_end", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: boundedData(event.result).data,
      isError: event.isError,
    });
  });
  pi.on("agent_end", (event: AgentEndEvent, context: TermServerExtensionContext) => {
    if (!allowRootSession(context)) return;
    tracker.onParentEnd(event);
  });
  pi.on("session_before_compact", (_event: unknown, context: TermServerExtensionContext) => {
    if (allowRootSession(context)) void send("session_before_compact");
  });
  pi.on("session_compact", (_event: unknown, context: TermServerExtensionContext) => {
    if (allowRootSession(context)) void send("session_compact");
  });
  pi.on("session_shutdown", async (_event: unknown, context: TermServerExtensionContext) => {
    const shouldReport = allowRootSession(context);
    stopHeartbeat();
    const closeReport = shouldReport
      ? send("session_shutdown", {}, true)
      : Promise.resolve();
    shuttingDown = true;
    rootSession = false;
    unsubscribeSubagentLifecycle();
    tracker.shutdown();
    await closeReport;
  });
}
