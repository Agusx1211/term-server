export type TerminalSocketCloseCause = "backlog" | "protocol-error" | "timeout" | "parser-stall";

// 3 added output acknowledgements. The server refuses older protocols outright
// rather than attach a browser that will never acknowledge what it is sent.
export const TERMINAL_STREAM_PROTOCOL = 3;

export function addTerminalStreamProtocol(url: URL): URL {
  url.searchParams.set("stream", String(TERMINAL_STREAM_PROTOCOL));
  return url;
}

/**
 * How many closes before `synced` are written off as ordinary reconnection
 * churn. Past this the pane asks the server why, but it never stops retrying:
 * every cause of a pre-sync close except a genuine version mismatch heals on
 * its own, and a pane that gave up would stay dead until a manual reload.
 */
export const TERMINAL_SOCKET_PRE_SYNC_FAILURE_LIMIT = 4;

/** How often the pane may re-ask the server why its stream will not start. */
export const TERMINAL_SOCKET_PROTOCOL_PROBE_INTERVAL_MS = 30_000;

export class TerminalSocketFailureTracker {
  private failures = 0;

  /** True once the failures are too many to be ordinary churn. */
  recordBeforeReady(): boolean {
    this.failures += 1;
    return this.failures >= TERMINAL_SOCKET_PRE_SYNC_FAILURE_LIMIT;
  }

  reset(): void {
    this.failures = 0;
  }

  get count(): number {
    return this.failures;
  }
}

export type TerminalServerReachability = "offline" | "unreachable" | "signed-out" | "reachable";

/**
 * Why a terminal stream keeps failing before it syncs.
 *
 * The server rejects a stale stream protocol with 426 *before* the WebSocket
 * upgrade, so the browser only ever sees a 1006 close with no `open` event —
 * byte for byte what a stopped server, a suspended laptop or a wifi-to-LTE hop
 * produces. Guessing "out of date" from the close alone turned every few
 * seconds of lost connectivity into a permanently dead pane, so the pane asks
 * the server directly instead: only a server that answers, and still knows this
 * browser, proves that the browser is the stale party.
 */
export async function probeTerminalServerReachability(
  session: () => Promise<{ authenticated: boolean }>,
  online = true,
): Promise<TerminalServerReachability> {
  if (!online) return "offline";
  try {
    const { authenticated } = await session();
    return authenticated ? "reachable" : "signed-out";
  } catch {
    return "unreachable";
  }
}

/** Only a reachable, still-authenticated server makes "reload the page" the right advice. */
export function isTerminalProtocolMismatch(reachability: TerminalServerReachability): boolean {
  return reachability === "reachable";
}

const CLOSE_DETAILS: Record<TerminalSocketCloseCause, { code: number; reason: string }> = {
  backlog: { code: 4003, reason: "Terminal renderer fell behind" },
  "protocol-error": { code: 4002, reason: "Invalid terminal stream" },
  timeout: { code: 4001, reason: "Terminal connection timed out" },
  "parser-stall": { code: 4004, reason: "Terminal parser stalled" },
};

export function closeTerminalSocket(
  socket: Pick<WebSocket, "close">,
  cause: TerminalSocketCloseCause,
): void {
  const { code, reason } = CLOSE_DETAILS[cause];
  socket.close(code, reason);
}
