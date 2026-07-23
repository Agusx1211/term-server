export const CONFIRM_TERMINAL_KILLS_STORAGE_KEY = "term-server:confirm-terminal-kills";

export function parseConfirmTerminalKills(value: string | null): boolean {
  return value !== "false";
}

export function terminalKillAllowed(
  path: string,
  confirmationEnabled: boolean,
  requestConfirmation: (message: string) => boolean = globalThis.confirm,
): boolean {
  return !confirmationEnabled
    || requestConfirmation(`Kill and remove “${path}”? The process and its scrollback will be lost.`);
}
