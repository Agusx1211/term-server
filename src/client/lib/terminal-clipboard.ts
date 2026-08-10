export interface TerminalCopyShortcutEvent {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  type: string;
}

export function isTerminalCopyShortcut(
  event: TerminalCopyShortcutEvent,
  platform: string,
): boolean {
  return event.type === "keydown"
    && event.code === "KeyC"
    && event.ctrlKey
    && event.shiftKey
    && !event.altKey
    && !event.metaKey
    && !/Mac|iPhone|iPad|iPod/i.test(platform);
}

export interface TerminalClipboardApi {
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
}

const CLIPBOARD_CONTEXT_NOTICE = "Clipboard access requires HTTPS or localhost";
const CLIPBOARD_PERMISSION_NOTICE = "Clipboard permission was denied";

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
