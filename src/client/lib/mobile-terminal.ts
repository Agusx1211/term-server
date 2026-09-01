export interface TerminalModifiers {
  alt: boolean;
  ctrl: boolean;
}

export const NO_TERMINAL_MODIFIERS: TerminalModifiers = {
  alt: false,
  ctrl: false,
};

const ARROW_SEQUENCE = /^\u001b\[([ABCD])$/;
const KITTY_CSI_U_SEQUENCE = /^\u001b\[([0-9:]+(?:;[0-9:]*){0,2})u$/;
const KITTY_DISAMBIGUATE_ESCAPE_CODES = 1;
const KITTY_REPORT_EVENT_TYPES = 2;
const KITTY_REPORT_ALL_KEYS = 8;
const KITTY_REPORT_ASSOCIATED_TEXT = 16;

export function transformTerminalInput(
  data: string,
  modifiers: TerminalModifiers,
  kittyKeyboardFlags = 0,
): string {
  const modifierBits = (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  const kittyModifier = modifierBits + 1;

  if (kittyKeyboardFlags > 0) {
    if (modifierBits > 0 && KITTY_CSI_U_SEQUENCE.test(data)) {
      return addKittyModifiers(data, modifierBits);
    }
    const disambiguates = (kittyKeyboardFlags & (
      KITTY_DISAMBIGUATE_ESCAPE_CODES | KITTY_REPORT_EVENT_TYPES | KITTY_REPORT_ALL_KEYS
    )) !== 0;
    if (data === "\u001b" && disambiguates) {
      return `\u001b[27${modifierBits ? `;${kittyModifier}` : ""}u`;
    }
    if (data === "\t" && (
      (kittyKeyboardFlags & KITTY_REPORT_ALL_KEYS) !== 0
      || modifierBits > 0 && disambiguates
    )) {
      return `\u001b[9${modifierBits ? `;${kittyModifier}` : ""}u`;
    }
    const characters = [...data];
    if (modifierBits > 0 && characters.length === 1) {
      const textCode = characters[0]!.codePointAt(0)!;
      const keyCode = textCode >= 65 && textCode <= 90 ? textCode + 32 : textCode;
      const associatedText = (kittyKeyboardFlags & KITTY_REPORT_ASSOCIATED_TEXT) !== 0
        && !modifiers.ctrl
        ? `;${textCode}`
        : "";
      return `\u001b[${keyCode};${kittyModifier}${associatedText}u`;
    }
  }

  if (modifierBits === 0) return data;

  const arrow = ARROW_SEQUENCE.exec(data);
  if (arrow) {
    return `\u001b[1;${kittyModifier}${arrow[1]}`;
  }

  let transformed = data;
  if (modifiers.ctrl && data.length === 1) {
    const code = data.toLocaleUpperCase().charCodeAt(0);
    if (code === 32 || code === 64) transformed = "\u0000";
    else if (code >= 65 && code <= 95) transformed = String.fromCharCode(code & 31);
    else if (code === 63) transformed = "\u007f";
  }
  return modifiers.alt ? `\u001b${transformed}` : transformed;
}

function addKittyModifiers(data: string, modifierBits: number): string {
  const fields = data.slice(2, -1).split(";");
  const [encoded = "1", eventType] = (fields[1] ?? "1").split(":", 2);
  const existing = Math.max(1, Number.parseInt(encoded || "1", 10)) - 1;
  fields[1] = `${(existing | modifierBits) + 1}${eventType ? `:${eventType}` : ""}`;
  return `\u001b[${fields.join(";")}u`;
}
