import type { TerminalInfo } from "../../shared/types";

export function documentTitle(terminals: TerminalInfo[]): string {
  const runningAgents = terminals.filter((terminal) => terminal.agent?.status === "working").length;
  return `(${runningAgents}) term-server`;
}
