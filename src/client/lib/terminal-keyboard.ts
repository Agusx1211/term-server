/**
 * On-screen keyboard control for terminal panes on touch devices.
 *
 * A browser raises the virtual keyboard when an editable element gains focus
 * inside a user gesture and lowers it when that element blurs, but focus alone
 * does not say whether the keyboard is on screen: pane activation, stream
 * sync, and visibility restore focus xterm's textarea from code, which on iOS
 * focuses without raising the keyboard, and Android's back button lowers the
 * keyboard while leaving the textarea focused. The visual viewport is the
 * missing signal: the keyboard is the only thing that takes a large share of
 * its height without changing its width. The helpers below derive the
 * keyboard state from both, decide what counts as a tap on the terminal
 * (xterm 6's touch gesture handler cancels the tap's compatibility mouse
 * events, so nothing else focuses the terminal on a touch), and hold the
 * user's explicit dismissal so no automatic refocus reopens a keyboard they
 * just closed.
 */

export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Share of the tallest viewport seen at the current width below which the
 * keyboard is assumed to be on screen. Browser chrome collapsing or expanding
 * moves the viewport by well under a fifth; a keyboard takes over a third on
 * phones and tablets alike.
 */
export const KEYBOARD_VIEWPORT_RATIO = 0.8;

/**
 * The reference viewport for keyboard detection: the tallest height seen at
 * the current width. A width change (rotation, split view, pinch zoom) starts
 * over, since a portrait baseline would flag every landscape viewport as a
 * keyboard. The keyboard only ever shrinks the viewport, so the maximum is
 * never taken from a keyboard-covered sample.
 */
export function nextViewportBaseline(
  baseline: ViewportSize | undefined,
  sample: ViewportSize,
): ViewportSize {
  if (!baseline || baseline.width !== sample.width) return sample;
  return sample.height > baseline.height ? sample : baseline;
}

export function keyboardCoversViewport(
  baseline: ViewportSize | undefined,
  sample: ViewportSize,
): boolean {
  if (!baseline || baseline.width !== sample.width || baseline.height <= 0) return false;
  return sample.height < baseline.height * KEYBOARD_VIEWPORT_RATIO;
}

/** Tracks the visual viewport across every pane; the keyboard is page-global. */
export class KeyboardViewportTracker {
  private baseline?: ViewportSize;

  /** Records a viewport sample and reports whether the keyboard covers it. */
  observe(sample: ViewportSize): boolean {
    this.baseline = nextViewportBaseline(this.baseline, sample);
    return keyboardCoversViewport(this.baseline, sample);
  }
}

export interface KeyboardSignals {
  /** xterm's textarea holds focus. */
  focused: boolean;
  /** The browser exposes a visual viewport to measure. */
  viewportKnown: boolean;
  /** The visual viewport is shrunk the way a keyboard shrinks it. */
  viewportCovered: boolean;
}

/**
 * Whether the keyboard is on screen. Without a visual viewport to measure
 * (older browsers, test environments), focus is the only signal available.
 */
export function keyboardVisible(signals: KeyboardSignals): boolean {
  if (!signals.focused) return false;
  return signals.viewportKnown ? signals.viewportCovered : true;
}

export interface KeyboardDismissal {
  /**
   * The user hid the keyboard and nothing automatic may bring it back until
   * they ask for it again by tapping the terminal or the keyboard button.
   */
  dismissed: boolean;
}

/** Shared by every pane so a keyboard hidden in one terminal stays hidden while switching panes. */
export const sharedKeyboardDismissal: KeyboardDismissal = { dismissed: false };

export const sharedKeyboardViewport = new KeyboardViewportTracker();

export interface PointerSample {
  id: number;
  type: string;
  x: number;
  y: number;
  time: number;
}

/** xterm's own gesture thresholds, so a touch is either a tap or a scroll for both. */
export const TAP_MAX_DISTANCE_PX = 30;
export const TAP_MAX_DURATION_MS = 700;

/**
 * Recognises a single-finger tap from pointer events. Mouse pointers are
 * ignored because xterm already focuses on mousedown; a second finger turns
 * the touch into a pinch or two-finger scroll rather than a tap.
 */
export class TouchTapTracker {
  private start?: PointerSample;
  private activePointers = 0;

  down(sample: PointerSample): void {
    if (sample.type === "mouse") return;
    this.activePointers += 1;
    this.start = this.activePointers === 1 ? sample : undefined;
  }

  /** Returns true when the pointer that went down here lifted as a tap. */
  up(sample: PointerSample): boolean {
    if (sample.type === "mouse") return false;
    this.activePointers = Math.max(0, this.activePointers - 1);
    const start = this.start;
    this.start = undefined;
    if (!start || start.id !== sample.id) return false;
    return Math.abs(sample.x - start.x) <= TAP_MAX_DISTANCE_PX
      && Math.abs(sample.y - start.y) <= TAP_MAX_DISTANCE_PX
      && sample.time - start.time <= TAP_MAX_DURATION_MS;
  }

  cancel(sample: PointerSample): void {
    if (sample.type === "mouse") return;
    this.activePointers = Math.max(0, this.activePointers - 1);
    this.start = undefined;
  }
}
