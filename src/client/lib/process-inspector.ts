import type { ProcessRecord } from "../../shared/types";

export interface ProcessTreeItem {
  process: ProcessRecord;
  children: ProcessTreeItem[];
}

export function buildProcessTree(processes: ProcessRecord[]): ProcessTreeItem[] {
  const items = new Map(processes.map((process) => [process.id, { process, children: [] as ProcessTreeItem[] }]));
  const roots: ProcessTreeItem[] = [];
  for (const item of items.values()) {
    const parent = item.process.parentId ? items.get(item.process.parentId) : undefined;
    if (parent && parent !== item) parent.children.push(item);
    else roots.push(item);
  }
  const sort = (values: ProcessTreeItem[]) => {
    values.sort((left, right) =>
      Number(right.process.foreground) - Number(left.process.foreground) || left.process.pid - right.process.pid,
    );
    for (const value of values) sort(value.children);
  };
  sort(roots);
  return roots;
}
