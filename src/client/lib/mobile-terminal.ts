export interface TerminalModifiers {
  alt: boolean;
  ctrl: boolean;
}

export const NO_TERMINAL_MODIFIERS: TerminalModifiers = {
  alt: false,
  ctrl: false,
};

const ARROW_SEQUENCE = /^\u001b\[([ABCD])$/;

export function transformTerminalInput(data: string, modifiers: TerminalModifiers): string {
  if (!modifiers.alt && !modifiers.ctrl) return data;

  const arrow = ARROW_SEQUENCE.exec(data);
  if (arrow) {
    const modifierCode = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
    return `\u001b[1;${modifierCode}${arrow[1]}`;
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

export function consumeScrollPixels(
  remainder: number,
  delta: number,
  rowHeight: number,
): { lines: number; remainder: number } {
  const pixels = remainder + delta;
  const height = Math.max(1, rowHeight);
  const lines = Math.trunc(pixels / height);
  return { lines, remainder: pixels - lines * height };
}

interface TouchScrollableTerminal {
  scrollLines(lines: number): void;
}

interface TouchScrollState {
  pointerId: number;
  startX: number;
  startY: number;
  lastY: number;
  lastTime: number;
  velocity: number;
  axis?: "horizontal" | "vertical";
}

const ACTIVATION_DISTANCE = 6;
const MIN_MOMENTUM_VELOCITY = 0.025;
const MOMENTUM_FRICTION = 0.006;

export function installTerminalTouchScroll(
  element: HTMLElement,
  terminal: TouchScrollableTerminal,
  rowHeight: () => number,
): () => void {
  const view = element.ownerDocument.defaultView ?? window;
  let state: TouchScrollState | undefined;
  let remainder = 0;
  let momentumFrame = 0;
  let momentumVelocity = 0;
  let momentumTime = 0;

  const scrollPixels = (pixels: number) => {
    const consumed = consumeScrollPixels(remainder, pixels, rowHeight());
    remainder = consumed.remainder;
    if (consumed.lines) terminal.scrollLines(consumed.lines);
  };

  const stopMomentum = () => {
    if (momentumFrame) view.cancelAnimationFrame(momentumFrame);
    momentumFrame = 0;
  };

  const continueMomentum = (time: number) => {
    const elapsed = Math.min(32, time - momentumTime);
    momentumTime = time;
    scrollPixels(momentumVelocity * elapsed);
    momentumVelocity *= Math.exp(-MOMENTUM_FRICTION * elapsed);
    if (Math.abs(momentumVelocity) >= MIN_MOMENTUM_VELOCITY) {
      momentumFrame = view.requestAnimationFrame(continueMomentum);
    } else {
      momentumFrame = 0;
      remainder = 0;
    }
  };

  const startMomentum = (velocity: number) => {
    stopMomentum();
    momentumVelocity = Math.max(-3, Math.min(3, velocity));
    if (Math.abs(momentumVelocity) < MIN_MOMENTUM_VELOCITY) {
      remainder = 0;
      return;
    }
    momentumTime = view.performance.now();
    momentumFrame = view.requestAnimationFrame(continueMomentum);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    stopMomentum();
    remainder = 0;
    state = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      lastTime: event.timeStamp,
      velocity: 0,
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!state || event.pointerId !== state.pointerId) return;
    if (!state.axis) {
      const horizontalDistance = Math.abs(event.clientX - state.startX);
      const verticalDistance = Math.abs(event.clientY - state.startY);
      if (Math.max(horizontalDistance, verticalDistance) < ACTIVATION_DISTANCE) return;
      state.axis = verticalDistance >= horizontalDistance ? "vertical" : "horizontal";
      if (state.axis === "horizontal") return;
      try {
        element.setPointerCapture?.(event.pointerId);
      } catch {
        // A browser may cancel a touch between the move event and pointer capture.
      }
      state.lastY = state.startY;
    }
    if (state.axis !== "vertical") return;

    event.preventDefault();
    const now = event.timeStamp;
    const pixels = state.lastY - event.clientY;
    const elapsed = Math.max(1, now - state.lastTime);
    const velocity = pixels / elapsed;
    state.velocity = state.velocity * 0.65 + velocity * 0.35;
    state.lastY = event.clientY;
    state.lastTime = now;
    scrollPixels(pixels);
  };

  const finishPointer = (event: PointerEvent, momentum: boolean) => {
    if (!state || event.pointerId !== state.pointerId) return;
    const velocity = state.axis === "vertical" ? state.velocity : 0;
    state = undefined;
    try {
      if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer can already be released when the browser cancels a gesture.
    }
    if (momentum) startMomentum(velocity);
    else remainder = 0;
  };

  const onPointerUp = (event: PointerEvent) => finishPointer(event, true);
  const onPointerCancel = (event: PointerEvent) => finishPointer(event, false);

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerCancel);

  return () => {
    stopMomentum();
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerUp);
    element.removeEventListener("pointercancel", onPointerCancel);
  };
}
