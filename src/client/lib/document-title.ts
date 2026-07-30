import type { TerminalInfo } from "../../shared/types";

export function documentTitle(terminals: TerminalInfo[]): string {
  const runningTasks = terminals.filter((terminal) => (
    terminal.agent?.status === "working" || terminal.command?.status === "running"
  )).length;
  return `(${runningTasks}) term-server`;
}
