import type { TerminalControlSummary, TerminalExposure } from "../../shared/types";

export type TerminalControlBadgeKind = "controller" | "read" | "write";

export interface TerminalControlBadge {
  kind: TerminalControlBadgeKind;
  label: string;
  title: string;
}

/** The control roles a terminal holds, most powerful first, for always-visible badges. */
export function terminalControlBadges(
  control: TerminalControlSummary | undefined,
): TerminalControlBadge[] {
  if (!control) return [];
  const badges: TerminalControlBadge[] = [];
  if (control.controller) {
    badges.push({
      kind: "controller",
      label: "Controls terminals",
      title: "Agents in this terminal can read and drive the terminals you share",
    });
  }
  if (control.exposure !== "off") {
    badges.push({
      kind: control.exposure,
      label: exposureLabel(control.exposure),
      title: control.exposure === "write"
        ? "Controlling terminals can read this terminal and type into it"
        : "Controlling terminals can read this terminal but not type into it",
    });
  }
  return badges;
}

export function exposureLabel(exposure: TerminalExposure): string {
  switch (exposure) {
    case "off":
      return "Not shared";
    case "read":
      return "Shared · read";
    case "write":
      return "Shared · read & write";
  }
}
