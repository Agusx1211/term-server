import { describe, expect, it } from "vitest";
import { installVisualViewportCssVars } from "./visual-viewport";

class FakeVisualViewport extends EventTarget {
  width = 390;
  height = 664;
  offsetLeft = 0;
  offsetTop = 0;
}

describe("visual viewport sizing", () => {
  it("keeps CSS viewport variables in sync and removes listeners on cleanup", () => {
    const properties = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
      },
    } as unknown as HTMLElement;
    const viewport = new FakeVisualViewport();
    const view = new EventTarget() as Window & typeof globalThis;
    Object.assign(view, { innerWidth: 844, innerHeight: 390, visualViewport: viewport });

    const dispose = installVisualViewportCssVars(root, view);
    expect(properties.get("--visual-viewport-width")).toBe("390px");
    expect(properties.get("--visual-viewport-height")).toBe("664px");

    viewport.height = 390.25;
    viewport.offsetTop = 102.5;
    viewport.dispatchEvent(new Event("resize"));
    expect(properties.get("--visual-viewport-height")).toBe("390.25px");
    expect(properties.get("--visual-viewport-top")).toBe("102.5px");

    dispose();
    viewport.height = 300;
    viewport.dispatchEvent(new Event("resize"));
    expect(properties.get("--visual-viewport-height")).toBe("390.25px");
  });
});
