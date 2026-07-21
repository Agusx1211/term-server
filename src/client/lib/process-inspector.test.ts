import { describe, expect, it } from "vitest";
import type { ProcessActivityEvent, ProcessRecord } from "../../shared/types";
import { buildRunningProcessTree, mergeProcessActivity } from "./process-inspector";

const process = (id: string, pid: number, parentId: string | null, status: "running" | "exited" = "running"): ProcessRecord => ({
  id,
  pid,
  parentPid: 1,
  parentId,
  processGroup: pid,
  command: id,
  arguments: [id],
  cwd: "/tmp",
  state: "S",
  status,
  foreground: id === "child",
  observedAt: 1,
  lastSeenAt: 2,
  endedAt: status === "exited" ? 2 : null,
  cpuTicks: 0,
});

const activity = (sequence: number, text: string): ProcessActivityEvent => ({
  sequence,
  timestamp: sequence,
  kind: "output",
  processGroup: 10,
  text,
  bytes: text.length,
  hidden: false,
  truncated: false,
});

describe("process inspector helpers", () => {
  it("builds the live hierarchy and omits historical processes", () => {
    const tree = buildRunningProcessTree([
      process("shell", 10, null),
      process("child", 11, "shell"),
      process("old", 12, "shell", "exited"),
    ]);
    expect(tree.map((item) => item.process.id)).toEqual(["shell"]);
    expect(tree[0]?.children.map((item) => item.process.id)).toEqual(["child"]);
  });

  it("refreshes a coalesced tail event without duplicating it", () => {
    expect(mergeProcessActivity([activity(1, "a")], [activity(1, "ab"), activity(2, "c")], false))
      .toEqual([activity(1, "ab"), activity(2, "c")]);
    expect(mergeProcessActivity([activity(1, "a")], [activity(3, "fresh")], true))
      .toEqual([activity(3, "fresh")]);
  });
});
