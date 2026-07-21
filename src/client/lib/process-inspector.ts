import type { ProcessActivityEvent, ProcessRecord } from "../../shared/types";

export interface ProcessTreeItem {
  process: ProcessRecord;
  children: ProcessTreeItem[];
}

export function buildRunningProcessTree(processes: ProcessRecord[]): ProcessTreeItem[] {
  const running = processes.filter((process) => process.status === "running");
  const items = new Map(running.map((process) => [process.id, { process, children: [] as ProcessTreeItem[] }]));
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

export function mergeProcessActivity(
  current: ProcessActivityEvent[],
  incoming: ProcessActivityEvent[],
  reset: boolean,
  limit = 512,
): ProcessActivityEvent[] {
  const events = new Map<number, ProcessActivityEvent>();
  if (!reset) {
    for (const event of current) events.set(event.sequence, event);
  }
  for (const event of incoming) events.set(event.sequence, event);
  return [...events.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-limit);
}
