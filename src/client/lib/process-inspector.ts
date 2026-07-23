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

export function formatCpuUsage(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  if (percent >= 100) return `${Math.round(percent)}%`;
  return `${percent.toFixed(1)}%`;
}

export function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const precision = exponent >= 2 && value < 100 ? 1 : 0;
  return `${value.toFixed(precision)} ${units[exponent]}`;
}
