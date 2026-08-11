import HeadlessModule from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

export const Terminal: typeof HeadlessTerminal = HeadlessModule.Terminal;
export type Terminal = HeadlessTerminal;
