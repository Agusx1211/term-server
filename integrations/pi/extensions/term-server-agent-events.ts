import { spawn } from "node:child_process";

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

interface PiSessionManager {
  getBranch?(): unknown[];
  getEntries?(): unknown[];
}

interface PiExtensionContext {
  sessionManager?: PiSessionManager;
}

interface PiExtensionApi {
  on<Event>(
    event: string,
    handler: (event: Event, context: PiExtensionContext) => void | Promise<void>,
  ): void;
}

interface PendingReport {
  payload: Record<string, unknown>;
  resolve: () => void;
}

const MAX_RECORD_BYTES = 240 * 1024;
const SNAPSHOT_CHUNK_RECORDS = 24;
const REPORT_TIMEOUT_MS = 750;
const MAX_PENDING_REPORTS = 256;
let semanticSequence = 0;

function bounded(value: unknown): { data: unknown; truncated: boolean } {
  try {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") <= MAX_RECORD_BYTES) {
      return { data: value, truncated: false };
    }
    return {
      data: { truncated: true, originalBytes: Buffer.byteLength(encoded, "utf8") },
      truncated: true,
    };
  } catch {
    return { data: { truncated: true, unserializable: true }, truncated: true };
  }
}

function text(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => text(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  for (const key of ["text", "content", "message", "summary", "result", "output", "error", "task"]) {
    const found = text(object[key], depth + 1);
    if (found) return found;
  }
  return "";
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function messageRecord(message: unknown, sourceId: string): TranscriptRecord | undefined {
  if (!message || typeof message !== "object") return undefined;
  const object = message as Record<string, unknown>;
  const payload = bounded(message);
  return {
    kind: "message",
    sourceId,
    timestamp: timestamp(object.timestamp),
    role: typeof object.role === "string" ? object.role : undefined,
    text: text(object.content ?? object.text ?? message) || undefined,
    data: payload.data,
    truncated: payload.truncated,
  };
}

function snapshotRecord(entry: unknown): TranscriptRecord | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const object = entry as Record<string, unknown>;
  const type = typeof object.type === "string" ? object.type : "";
  const sourceId = typeof object.id === "string" ? object.id : undefined;
  if (type === "message") return messageRecord(object.message, sourceId ?? `message:${semanticSequence++}`);
  if (type === "compaction" || type === "branch_summary") {
    const payload = bounded(object);
    return {
      kind: type === "compaction" ? "compaction" : "summary",
      sourceId,
      timestamp: timestamp(object.timestamp),
      text: text(object.summary) || undefined,
      data: payload.data,
      truncated: payload.truncated,
    };
  }
  if (type === "session_init" && typeof object.task === "string") {
    return {
      kind: "message",
      sourceId,
      timestamp: timestamp(object.timestamp),
      role: "user",
      text: object.task,
    };
  }
  if (type === "reset_boundary") {
    return { kind: "marker", sourceId, timestamp: timestamp(object.timestamp), text: "context reset" };
  }
  return undefined;
}

export default function termServerAgentEvents(pi: PiExtensionApi): void {
  const executable = process.env.TERM_SERVER_EXECUTABLE;
  const ready = (): boolean =>
    Boolean(executable)
    && Boolean(process.env.TERM_SERVER_SESSION)
    && Boolean(process.env.TERM_SERVER_BROKER_SOCKET);
  const pendingReports: PendingReport[] = [];
  let forwarderActive = false;

  function forward(payload: Record<string, unknown>): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (!executable) {
      resolve();
      return promise;
    }
    let finished = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve();
    };
    try {
      const child = spawn(executable, ["--agent-event", "pi"], {
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
    void forward(report.payload).then(() => {
      forwarderActive = false;
      report.resolve();
      pumpReports();
    });
  }

  function emit(event: string, details: Record<string, unknown> = {}): Promise<void> {
    if (!ready()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    if (pendingReports.length >= MAX_PENDING_REPORTS) pendingReports.shift()?.resolve();
    pendingReports.push({
      payload: { hook_event_name: event, ...details },
      resolve,
    });
    pumpReports();
    return promise;
  }

  async function emitSnapshot(context: PiExtensionContext): Promise<void> {
    const entries = context.sessionManager?.getBranch?.()
      ?? context.sessionManager?.getEntries?.()
      ?? [];
    const records = entries.flatMap((entry) => {
      const record = snapshotRecord(entry);
      return record ? [record] : [];
    });
    if (records.length === 0) {
      await emit("transcript_snapshot", { transcriptReset: true, transcript: [] });
      return;
    }
    const chunks = Array.from(
      { length: Math.ceil(records.length / SNAPSHOT_CHUNK_RECORDS) },
      (_unused, index) => records.slice(
        index * SNAPSHOT_CHUNK_RECORDS,
        (index + 1) * SNAPSHOT_CHUNK_RECORDS,
      ),
    );
    await Promise.all(chunks.map((chunk, index) => emit("transcript_snapshot", {
      transcriptReset: index === 0,
      transcript: chunk,
    })));
  }

  pi.on<unknown>("session_start", (_event, context) => emitSnapshot(context));
  pi.on<unknown>("session_switch", (_event, context) => emitSnapshot(context));
  pi.on<unknown>("session_tree", (_event, context) => emitSnapshot(context));
  pi.on<unknown>("agent_start", () => emit("agent_start"));
  pi.on<{ message?: unknown }>("message_end", (event) => {
    const record = messageRecord(event.message, `live-message:${semanticSequence++}`);
    return record ? emit("message_end", { transcript: [record] }) : undefined;
  });
  pi.on<{ toolCallId?: string; toolName?: string; args?: unknown; intent?: string }>(
    "tool_execution_start",
    (event) => emit("tool_execution_start", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: bounded(event.args).data,
      intent: event.intent,
    }),
  );
  pi.on<{ toolCallId?: string; toolName?: string; result?: unknown; isError?: boolean }>(
    "tool_execution_end",
    (event) => emit("tool_execution_end", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: bounded(event.result).data,
      isError: event.isError,
    }),
  );
  pi.on<unknown>("agent_settled", () => emit("agent_settled"));
  pi.on<unknown>("session_before_compact", () => emit("session_before_compact"));
  pi.on<unknown>("session_compact", () => emit("session_compact"));
  pi.on<unknown>("session_shutdown", () => emit("session_shutdown"));
}
