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

interface TermServerExtensionContext {
  hasUI?: boolean;
}

interface AgentEndEvent {
  isTerminal?: boolean;
}

type ExtensionHandler<Event> = (
  event: Event,
  context: TermServerExtensionContext,
) => void | Promise<void>;

interface TermServerExtensionApi {
  getSessionName?(): string | undefined | null;
  on(event: "session_start", handler: ExtensionHandler<unknown>): void;
  on(event: "agent_start", handler: ExtensionHandler<unknown>): void;
  on(
    event: "tool_execution_start",
    handler: ExtensionHandler<{ toolName?: string }>,
  ): void;
  on(event: "tool_execution_end", handler: ExtensionHandler<unknown>): void;
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

const REPORT_TIMEOUT_MS = 750;
const MAX_PENDING_REPORTS = 256;
const HEARTBEAT_INTERVAL_MS = 10_000;

// Reports coarse lifecycle activity to the private term-server session broker.
// omp already generates a conversation title from the first message, so it is
// forwarded here and term-server reuses it instead of generating its own.
// Sends no prompts, command arguments, or tool output, and is inactive outside
// a term-server session.
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
  function send(event: string, toolName?: string, prioritize = false): Promise<void> {
    if (shuttingDown || !rootSession || !ready()) return Promise.resolve();

    const payload: Record<string, unknown> = {
      hook_event_name: event,
      sequence: nextSequence(),
    };
    if (toolName) payload.tool_name = toolName;

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

  const tracker = createSubagentActivityTracker((event) => {
    void send(event);
  });

  function isRootContext(context: unknown): context is { hasUI: true } {
    if (
      typeof context !== "object"
      || context === null
      || !("hasUI" in context)
    ) return false;
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
    allowRootSession(context);
  });
  pi.on("agent_start", (_event: unknown, context: TermServerExtensionContext) => {
    if (!allowRootSession(context)) return;
    tracker.onParentStart();
  });
  pi.on(
    "tool_execution_start",
    (event: { toolName?: string }, context: TermServerExtensionContext) => {
      if (!allowRootSession(context)) return;
      void send("tool_execution_start", event.toolName);
    },
  );
  pi.on("tool_execution_end", (_event: unknown, context: TermServerExtensionContext) => {
    if (allowRootSession(context)) void send("tool_execution_end");
  });
  pi.on(
    "agent_end",
    (event: AgentEndEvent, context: TermServerExtensionContext) => {
      if (!allowRootSession(context)) return;
      tracker.onParentEnd(event);
    },
  );
  pi.on(
    "session_before_compact",
    (_event: unknown, context: TermServerExtensionContext) => {
      if (allowRootSession(context)) void send("session_before_compact");
    },
  );
  pi.on("session_compact", (_event: unknown, context: TermServerExtensionContext) => {
    if (allowRootSession(context)) void send("session_compact");
  });
  pi.on(
    "session_shutdown",
    async (_event: unknown, context: TermServerExtensionContext) => {
      const shouldReport = allowRootSession(context);
      stopHeartbeat();
      const closeReport = shouldReport
        ? send("session_shutdown", undefined, true)
        : Promise.resolve();
      shuttingDown = true;
      rootSession = false;
      unsubscribeSubagentLifecycle();
      tracker.shutdown();
      await closeReport;
    },
  );
}
