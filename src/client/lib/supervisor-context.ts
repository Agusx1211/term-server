import type { TerminalInfo } from "../../shared/types";

/** Whether project-local supervisor instructions remain discoverable from this cwd. */
export function supervisorContextActive(
  terminal: Pick<TerminalInfo, "kind" | "cwd" | "supervisorRoot">,
): boolean {
  if (terminal.kind !== "supervisor") return true;
  const root = terminal.supervisorRoot?.replace(/\/+$/, "");
  if (!root) return false;
  return terminal.cwd === root || terminal.cwd.startsWith(`${root}/`);
}
