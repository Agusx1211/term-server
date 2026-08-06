import { spawn } from "node:child_process";

// Minimal, self-contained view of the omp extension API this module uses.
// Kept local so the asset has no build-time dependency on omp's type package.
interface TermServerExtensionApi {
  getSessionName?(): string | undefined | null;
  on(event: "agent_start", handler: () => void): void;
  on(event: "tool_execution_start", handler: (event: { toolName?: string }) => void): void;
  on(event: "tool_execution_end", handler: () => void): void;
  on(event: "agent_end", handler: () => void): void;
  on(event: "session_before_compact", handler: () => void): void;
  on(event: "session_compact", handler: () => void): void;
  on(event: "session_shutdown", handler: () => void): void;
}

// Reports coarse lifecycle activity to the private term-server session broker.
// omp already generates a conversation title from the first message, so it is
// forwarded here and term-server reuses it instead of generating its own.
// Sends no prompts, command arguments, or tool output, and is inactive outside
// a term-server session.
export default function termServerAgentEvents(pi: TermServerExtensionApi): void {
  const executable = process.env.TERM_SERVER_EXECUTABLE;
  const ready = (): boolean =>
    Boolean(executable) &&
    Boolean(process.env.TERM_SERVER_SESSION) &&
    Boolean(process.env.TERM_SERVER_BROKER_SOCKET);

  let lastTitle = "";

  function send(event: string, toolName?: string): void {
    if (!ready()) return;

    const payload: Record<string, unknown> = { hook_event_name: event };
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

    try {
      const child = spawn(executable!, ["--agent-event", "omp"], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
      child.unref();
    } catch {
      // Observability must never interfere with the agent loop.
    }
  }

  pi.on("agent_start", () => send("agent_start"));
  pi.on("tool_execution_start", (event: { toolName?: string }) =>
    send("tool_execution_start", event.toolName),
  );
  pi.on("tool_execution_end", () => send("tool_execution_end"));
  pi.on("agent_end", () => send("agent_settled"));
  pi.on("session_before_compact", () => send("session_before_compact"));
  pi.on("session_compact", () => send("session_compact"));
  pi.on("session_shutdown", () => send("session_shutdown"));
}
