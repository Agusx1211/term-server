export type TerminalSocketCloseCause = "backlog" | "protocol-error" | "timeout";

export const TERMINAL_STREAM_PROTOCOL = 2;

export function addTerminalStreamProtocol(url: URL): URL {
  url.searchParams.set("stream", String(TERMINAL_STREAM_PROTOCOL));
  return url;
}

const CLOSE_DETAILS: Record<TerminalSocketCloseCause, { code: number; reason: string }> = {
  backlog: { code: 4003, reason: "Terminal renderer fell behind" },
  "protocol-error": { code: 4002, reason: "Invalid terminal stream" },
  timeout: { code: 4001, reason: "Terminal connection timed out" },
};

export function closeTerminalSocket(
  socket: Pick<WebSocket, "close">,
  cause: TerminalSocketCloseCause,
): void {
  const { code, reason } = CLOSE_DETAILS[cause];
  socket.close(code, reason);
}
