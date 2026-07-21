export const SIDEBAR_WIDTH_STORAGE_KEY = "term-server:sidebar-width";
export const DEFAULT_SIDEBAR_WIDTH = 270;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 560;
export const MIN_EDITOR_WIDTH = 320;

export function maxSidebarWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth)) return MAX_SIDEBAR_WIDTH;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, viewportWidth - MIN_EDITOR_WIDTH));
}

export function clampSidebarWidth(width: number, viewportWidth = Number.POSITIVE_INFINITY): number {
  const value = Number.isFinite(width) ? width : DEFAULT_SIDEBAR_WIDTH;
  return Math.round(Math.min(maxSidebarWidth(viewportWidth), Math.max(MIN_SIDEBAR_WIDTH, value)));
}

export function parseSidebarWidth(value: string | null): number {
  if (value === null || value.trim() === "") return DEFAULT_SIDEBAR_WIDTH;
  return clampSidebarWidth(Number(value));
}
