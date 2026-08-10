export interface TerminalClipboardShortcutEvent {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault: () => void;
  shiftKey: boolean;
  type: string;
}

export type TerminalClipboardShortcut = "copy" | "paste";

function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function terminalClipboardShortcut(
  event: TerminalClipboardShortcutEvent,
  platform: string,
): TerminalClipboardShortcut | undefined {
  if (!isMacPlatform(platform)) {
    if (
      event.code === "Insert"
      && !event.altKey
      && !event.metaKey
      && event.ctrlKey !== event.shiftKey
    ) return event.ctrlKey ? "copy" : "paste";
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
  } else if (!event.metaKey || event.altKey || event.ctrlKey) {
    return;
  }

  if (event.code === "KeyC") return "copy";
  if (event.code === "KeyV") return "paste";
}

/**
 * Stops xterm from encoding native clipboard shortcuts as terminal input.
 * Copy is dispatched synchronously through xterm's DOM listener. Paste keeps
 * the browser default so xterm receives the resulting ClipboardEvent.
 */
export function handleTerminalClipboardShortcut(
  event: TerminalClipboardShortcutEvent,
  platform: string,
  copy: () => void,
): boolean {
  const shortcut = terminalClipboardShortcut(event, platform);
  if (!shortcut) return true;
  if (event.type !== "keydown") return false;
  if (shortcut === "copy") {
    event.preventDefault();
    copy();
  }
  return false;
}

export interface TerminalClipboardApi {
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
}

const CLIPBOARD_CONTEXT_NOTICE = "Clipboard access requires HTTPS or localhost";
const CLIPBOARD_PERMISSION_NOTICE = "Clipboard permission was denied";

export async function readTerminalOsc52Clipboard(
  clipboard: TerminalClipboardApi | undefined,
  onNotice: (message: string) => void,
): Promise<string> {
  if (!clipboard?.readText) {
    onNotice(CLIPBOARD_CONTEXT_NOTICE);
    return "";
  }
  try {
    return await clipboard.readText();
  } catch {
    onNotice(CLIPBOARD_PERMISSION_NOTICE);
    return "";
  }
}

export async function writeTerminalOsc52Clipboard(
  text: string,
  clipboard: TerminalClipboardApi | undefined,
  onNotice: (message: string) => void,
): Promise<void> {
  if (!clipboard?.writeText) {
    onNotice(CLIPBOARD_CONTEXT_NOTICE);
    return;
  }
  try {
    await clipboard.writeText(text);
  } catch {
    onNotice(CLIPBOARD_PERMISSION_NOTICE);
  }
}

export async function copyTerminalSelection(
  selection: string | undefined,
  clipboard: TerminalClipboardApi | undefined,
  onNotice: (message: string) => void,
): Promise<void> {
  if (!selection) {
    onNotice("Select terminal text before copying");
    return;
  }
  if (!clipboard?.writeText) {
    onNotice(CLIPBOARD_CONTEXT_NOTICE);
    return;
  }
  try {
    await clipboard.writeText(selection);
    onNotice("Copied selection");
  } catch {
    onNotice(CLIPBOARD_PERMISSION_NOTICE);
  }
}

export async function pasteTerminalClipboard(
  clipboard: TerminalClipboardApi | undefined,
  paste: (text: string) => void,
  focus: () => void,
  onNotice: (message: string) => void,
): Promise<void> {
  if (!clipboard?.readText) {
    onNotice(CLIPBOARD_CONTEXT_NOTICE);
    focus();
    return;
  }
  try {
    paste(await clipboard.readText());
  } catch {
    onNotice(CLIPBOARD_PERMISSION_NOTICE);
  }
}
