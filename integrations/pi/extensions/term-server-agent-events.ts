import { spawn } from "node:child_process";

function emit(event: string, toolName?: string): void {
  const executable = process.env.TERM_SERVER_EXECUTABLE;
  if (
    !executable
    || !process.env.TERM_SERVER_SESSION
    || !process.env.TERM_SERVER_BROKER_SOCKET
  ) return;

  try {
    const child = spawn(executable, ["--agent-event", "pi"], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ hook_event_name: event, tool_name: toolName }));
    child.unref();
  } catch {
    // Observability must never interfere with the agent loop.
  }
}

export default function termServerAgentEvents(pi: any): void {
  pi.on("agent_start", () => emit("agent_start"));
  pi.on("tool_execution_start", (event: { toolName?: string }) => {
    emit("tool_execution_start", event.toolName);
  });
  pi.on("tool_execution_end", () => emit("tool_execution_end"));
  pi.on("agent_settled", () => emit("agent_settled"));
  pi.on("session_before_compact", () => emit("session_before_compact"));
  pi.on("session_compact", () => emit("session_compact"));
  pi.on("session_shutdown", () => emit("session_shutdown"));
}
