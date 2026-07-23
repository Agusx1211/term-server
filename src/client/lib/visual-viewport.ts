const cssPixels = (value: number) => `${Math.round(value * 100) / 100}px`;

export function installVisualViewportCssVars(
  root = document.documentElement,
  view = window,
): () => void {
  const viewport = view.visualViewport;
  const sync = () => {
    root.style.setProperty("--visual-viewport-width", cssPixels(viewport?.width ?? view.innerWidth));
    root.style.setProperty("--visual-viewport-height", cssPixels(viewport?.height ?? view.innerHeight));
    root.style.setProperty("--visual-viewport-left", cssPixels(viewport?.offsetLeft ?? 0));
    root.style.setProperty("--visual-viewport-top", cssPixels(viewport?.offsetTop ?? 0));
  };

  sync();
  viewport?.addEventListener("resize", sync);
  viewport?.addEventListener("scroll", sync);
  view.addEventListener("orientationchange", sync);

  return () => {
    viewport?.removeEventListener("resize", sync);
    viewport?.removeEventListener("scroll", sync);
    view.removeEventListener("orientationchange", sync);
  };
}
