import { describe, expect, it } from "vitest";
import {
  KeyboardViewportTracker,
  TouchTapTracker,
  keyboardCoversViewport,
  keyboardVisible,
  nextViewportBaseline,
  type PointerSample,
} from "./terminal-keyboard";

const PORTRAIT = { width: 390, height: 844 };
const PORTRAIT_KEYBOARD = { width: 390, height: 500 };
const LANDSCAPE = { width: 844, height: 390 };

describe("keyboard viewport detection", () => {
  it("keeps the tallest viewport seen at one width as the baseline", () => {
    let baseline = nextViewportBaseline(undefined, PORTRAIT_KEYBOARD);
    expect(baseline).toEqual(PORTRAIT_KEYBOARD);
    baseline = nextViewportBaseline(baseline, PORTRAIT);
    expect(baseline).toEqual(PORTRAIT);
    baseline = nextViewportBaseline(baseline, PORTRAIT_KEYBOARD);
    expect(baseline).toEqual(PORTRAIT);
  });

  it("starts over when the viewport width changes", () => {
    const baseline = nextViewportBaseline(PORTRAIT, LANDSCAPE);
    expect(baseline).toEqual(LANDSCAPE);
    expect(keyboardCoversViewport(PORTRAIT, LANDSCAPE)).toBe(false);
  });

  it("treats a large height loss as the keyboard and browser chrome as noise", () => {
    expect(keyboardCoversViewport(PORTRAIT, PORTRAIT_KEYBOARD)).toBe(true);
    expect(keyboardCoversViewport(PORTRAIT, { width: 390, height: 780 })).toBe(false);
    expect(keyboardCoversViewport(PORTRAIT, PORTRAIT)).toBe(false);
    expect(keyboardCoversViewport(undefined, PORTRAIT_KEYBOARD)).toBe(false);
  });

  it("detects the keyboard through a shared tracker across open and close cycles", () => {
    const tracker = new KeyboardViewportTracker();
    expect(tracker.observe(PORTRAIT)).toBe(false);
    expect(tracker.observe(PORTRAIT_KEYBOARD)).toBe(true);
    expect(tracker.observe(PORTRAIT)).toBe(false);
    expect(tracker.observe(LANDSCAPE)).toBe(false);
    expect(tracker.observe({ width: 844, height: 200 })).toBe(true);
  });

  it("recovers when the first sample was taken under an open keyboard", () => {
    const tracker = new KeyboardViewportTracker();
    expect(tracker.observe(PORTRAIT_KEYBOARD)).toBe(false);
    expect(tracker.observe(PORTRAIT)).toBe(false);
    expect(tracker.observe(PORTRAIT_KEYBOARD)).toBe(true);
  });
});

describe("keyboardVisible", () => {
  it("requires focus and, when measurable, a covered viewport", () => {
    expect(keyboardVisible({ focused: true, viewportKnown: true, viewportCovered: true })).toBe(true);
    expect(keyboardVisible({ focused: true, viewportKnown: true, viewportCovered: false })).toBe(false);
    expect(keyboardVisible({ focused: false, viewportKnown: true, viewportCovered: true })).toBe(false);
  });

  it("falls back to focus without a visual viewport", () => {
    expect(keyboardVisible({ focused: true, viewportKnown: false, viewportCovered: false })).toBe(true);
    expect(keyboardVisible({ focused: false, viewportKnown: false, viewportCovered: false })).toBe(false);
  });
});

describe("TouchTapTracker", () => {
  const touch = (id: number, x: number, y: number, time: number): PointerSample => (
    { id, type: "touch", x, y, time }
  );

  it("recognises a short still touch as a tap", () => {
    const tracker = new TouchTapTracker();
    tracker.down(touch(1, 100, 200, 0));
    expect(tracker.up(touch(1, 110, 190, 150))).toBe(true);
  });

  it("rejects drags, long presses, and mouse clicks", () => {
    const tracker = new TouchTapTracker();
    tracker.down(touch(1, 100, 200, 0));
    expect(tracker.up(touch(1, 100, 260, 150))).toBe(false);
    tracker.down(touch(2, 100, 200, 1000));
    expect(tracker.up(touch(2, 100, 200, 1900))).toBe(false);
    tracker.down({ id: 3, type: "mouse", x: 0, y: 0, time: 2000 });
    expect(tracker.up({ id: 3, type: "mouse", x: 0, y: 0, time: 2010 })).toBe(false);
    tracker.down({ id: 4, type: "pen", x: 5, y: 5, time: 3000 });
    expect(tracker.up({ id: 4, type: "pen", x: 5, y: 5, time: 3050 })).toBe(true);
  });

  it("does not treat a second finger as a tap", () => {
    const tracker = new TouchTapTracker();
    tracker.down(touch(1, 100, 200, 0));
    tracker.down(touch(2, 160, 200, 20));
    expect(tracker.up(touch(2, 160, 200, 120))).toBe(false);
    expect(tracker.up(touch(1, 100, 200, 130))).toBe(false);
    tracker.down(touch(3, 100, 200, 500));
    expect(tracker.up(touch(3, 100, 200, 600))).toBe(true);
  });

  it("forgets a cancelled pointer", () => {
    const tracker = new TouchTapTracker();
    tracker.down(touch(1, 100, 200, 0));
    tracker.cancel(touch(1, 100, 200, 50));
    expect(tracker.up(touch(1, 100, 200, 100))).toBe(false);
    tracker.down(touch(2, 100, 200, 500));
    expect(tracker.up(touch(2, 100, 200, 600))).toBe(true);
  });
});
