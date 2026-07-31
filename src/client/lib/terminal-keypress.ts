const DUPLICATE_KEYPRESS_WINDOW_MS = 100;

function keyIdentity(event: KeyboardEvent): string {
  return event.code || event.key;
}

export class TerminalKeypressGuard {
  private keydown?: { event: KeyboardEvent; handled: boolean };

  shouldProcess(event: KeyboardEvent): boolean {
    if (event.type === "keydown") {
      this.keydown = { event, handled: false };
      return true;
    }
    if (event.type !== "keypress" || !this.keydown?.handled) return true;

    // Some Linux input stacks dispatch keypress even after xterm handles and
    // prevents the matching keydown. Let xterm handle either event, never both.
    const elapsed = event.timeStamp - this.keydown.event.timeStamp;
    return keyIdentity(event) !== keyIdentity(this.keydown.event)
      || elapsed < 0
      || elapsed > DUPLICATE_KEYPRESS_WINDOW_MS;
  }

  markHandled(event: KeyboardEvent): void {
    if (event.type === "keydown" && this.keydown?.event === event) {
      this.keydown.handled = true;
    }
  }
}
