/**
 * Structural comparison for the small JSON payloads the polling loops receive.
 *
 * The workspace poll rebuilds terminal and broker objects every 1.5 s. Handing
 * those fresh objects to state would re-render every mounted pane even when the
 * server reported no change, so the merge helpers compare structurally and keep
 * the previous object when nothing moved. Key order is ignored because merged
 * objects are rebuilt with spreads, which can reorder optional fields.
 */
export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || !left || !right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => structurallyEqual(entry, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => structurallyEqual(leftRecord[key], rightRecord[key]));
}
