export type DropPosition = "left" | "right" | "top" | "bottom" | "center";
export type SplitDirection = "horizontal" | "vertical";

export type PaneLayout =
  | { type: "leaf"; id: string }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      first: PaneLayout;
      second: PaneLayout;
    };

export interface PaneRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TERMINAL_DRAG_TYPE = "application/x-term-server-terminal";

export function configureTerminalDrag(
  transfer: DataTransfer,
  id: string,
  label: string,
  effectAllowed: "move" | "copyMove",
) {
  transfer.effectAllowed = effectAllowed;
  transfer.setData(TERMINAL_DRAG_TYPE, id);
  transfer.setData("text/plain", id);

  const dragImage = document.createElement("div");
  dragImage.className = "terminal-drag-image";
  dragImage.textContent = label;
  document.body.append(dragImage);
  transfer.setDragImage(dragImage, 12, 12);
  window.setTimeout(() => dragImage.remove(), 0);
}

export const paneLeaf = (id: string): PaneLayout => ({ type: "leaf", id });

export function paneIds(layout: PaneLayout | null): string[] {
  if (!layout) return [];
  if (layout.type === "leaf") return [layout.id];
  return [...paneIds(layout.first), ...paneIds(layout.second)];
}

export function paneRects(layout: PaneLayout | null): PaneRect[] {
  if (!layout) return [];
  const rectangles: PaneRect[] = [];
  const visit = (node: PaneLayout, x: number, y: number, width: number, height: number) => {
    if (node.type === "leaf") {
      rectangles.push({ id: node.id, x, y, width, height });
      return;
    }
    const ratio = Math.min(0.85, Math.max(0.15, node.ratio));
    if (node.direction === "horizontal") {
      const firstWidth = width * ratio;
      visit(node.first, x, y, firstWidth, height);
      visit(node.second, x + firstWidth, y, width - firstWidth, height);
    } else {
      const firstHeight = height * ratio;
      visit(node.first, x, y, width, firstHeight);
      visit(node.second, x, y + firstHeight, width, height - firstHeight);
    }
  };
  visit(layout, 0, 0, 1, 1);
  return rectangles;
}

export function layoutFromIds(ids: string[]): PaneLayout | null {
  return ids.reduce<PaneLayout | null>((layout, id) => insertBalanced(layout, id), null);
}

export function insertBalanced(layout: PaneLayout | null, id: string): PaneLayout {
  if (!layout) return paneLeaf(id);
  if (paneIds(layout).includes(id)) return layout;
  const largest = paneRects(layout).reduce((best, rectangle) =>
    rectangle.width * rectangle.height > best.width * best.height ? rectangle : best,
  );
  const position: DropPosition = largest.width >= largest.height ? "right" : "bottom";
  return splitAt(layout, largest.id, id, position);
}

export function arrangeLayout(
  layout: PaneLayout | null,
  sourceId: string,
  targetId: string,
  position: DropPosition,
  maximumPanes: number,
): PaneLayout | undefined {
  if (!layout || !paneIds(layout).includes(targetId)) return undefined;
  if (sourceId === targetId) return layout;

  const visibleIds = paneIds(layout);
  const sourceVisible = visibleIds.includes(sourceId);
  if (position === "center") {
    return sourceVisible ? swapPanes(layout, sourceId, targetId) : replacePane(layout, targetId, sourceId);
  }
  if (!sourceVisible && visibleIds.length >= maximumPanes) return undefined;

  const withoutSource = sourceVisible ? removePane(layout, sourceId) : layout;
  if (!withoutSource) return undefined;
  return splitAt(withoutSource, targetId, sourceId, position);
}

export function removePane(layout: PaneLayout | null, id: string): PaneLayout | null {
  if (!layout) return null;
  if (layout.type === "leaf") return layout.id === id ? null : layout;
  const first = removePane(layout.first, id);
  const second = removePane(layout.second, id);
  if (!first) return second;
  if (!second) return first;
  if (first === layout.first && second === layout.second) return layout;
  return { ...layout, first, second };
}

export function pruneLayout(layout: PaneLayout | null, available: Set<string>): PaneLayout | null {
  if (!layout) return null;
  if (layout.type === "leaf") return available.has(layout.id) ? layout : null;
  const first = pruneLayout(layout.first, available);
  const second = pruneLayout(layout.second, available);
  if (!first) return second;
  if (!second) return first;
  if (first === layout.first && second === layout.second) return layout;
  return { ...layout, first, second };
}

export function isPaneLayout(value: unknown): value is PaneLayout {
  const seen = new Set<string>();
  const check = (node: unknown): node is PaneLayout => {
    if (!node || typeof node !== "object") return false;
    const candidate = node as Partial<PaneLayout>;
    if (candidate.type === "leaf") {
      if (typeof candidate.id !== "string" || !candidate.id || seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return true;
    }
    if (candidate.type !== "split") return false;
    const split = candidate as Partial<Extract<PaneLayout, { type: "split" }>>;
    return (
      (split.direction === "horizontal" || split.direction === "vertical") &&
      typeof split.ratio === "number" &&
      Number.isFinite(split.ratio) &&
      split.ratio >= 0.15 &&
      split.ratio <= 0.85 &&
      check(split.first) &&
      check(split.second)
    );
  };
  return check(value);
}

function splitAt(layout: PaneLayout, targetId: string, sourceId: string, position: DropPosition): PaneLayout {
  if (layout.type === "leaf") {
    if (layout.id !== targetId) return layout;
    const source = paneLeaf(sourceId);
    const direction: SplitDirection = position === "left" || position === "right" ? "horizontal" : "vertical";
    const sourceFirst = position === "left" || position === "top";
    return {
      type: "split",
      direction,
      ratio: 0.5,
      first: sourceFirst ? source : layout,
      second: sourceFirst ? layout : source,
    };
  }
  const first = splitAt(layout.first, targetId, sourceId, position);
  if (first !== layout.first) return { ...layout, first };
  const second = splitAt(layout.second, targetId, sourceId, position);
  return second === layout.second ? layout : { ...layout, second };
}

function replacePane(layout: PaneLayout, targetId: string, sourceId: string): PaneLayout {
  if (layout.type === "leaf") return layout.id === targetId ? paneLeaf(sourceId) : layout;
  const first = replacePane(layout.first, targetId, sourceId);
  const second = replacePane(layout.second, targetId, sourceId);
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

function swapPanes(layout: PaneLayout, firstId: string, secondId: string): PaneLayout {
  if (layout.type === "leaf") {
    if (layout.id === firstId) return paneLeaf(secondId);
    if (layout.id === secondId) return paneLeaf(firstId);
    return layout;
  }
  const first = swapPanes(layout.first, firstId, secondId);
  const second = swapPanes(layout.second, firstId, secondId);
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

export function reconcileMounted(
  mounted: string[],
  visible: string[],
  available: Set<string>,
  limit: number,
): string[] {
  const protectedIds = new Set(visible);
  const next = mounted.filter((id) => available.has(id) && !protectedIds.has(id));
  for (const id of visible) {
    if (available.has(id)) next.push(id);
  }

  while (next.length > limit) {
    const inactiveIndex = next.findIndex((id) => !protectedIds.has(id));
    if (inactiveIndex < 0) break;
    next.splice(inactiveIndex, 1);
  }
  return next;
}
