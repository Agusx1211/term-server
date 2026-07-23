import { describe, expect, it } from "vitest";
import type { ProcessRecord } from "../../shared/types";
import { buildProcessTree, formatCpuUsage, formatMemory } from "./process-inspector";

const process = (id: string, pid: number, parentId: string | null): ProcessRecord => ({
  id,
  pid,
  parentId,
  command: id,
  arguments: [id],
  cwd: "/tmp",
  foreground: id === "child",
  cpuPercent: 12.34,
  memoryBytes: 12 * 1024 * 1024,
});

describe("process inspector helpers", () => {
  it("builds the live process hierarchy", () => {
    const tree = buildProcessTree([
      process("shell", 10, null),
      process("child", 11, "shell"),
    ]);
    expect(tree.map((item) => item.process.id)).toEqual(["shell"]);
    expect(tree[0]?.children.map((item) => item.process.id)).toEqual(["child"]);
  });

  it("formats compact resource usage", () => {
    expect(formatCpuUsage(12.34)).toBe("12.3%");
    expect(formatCpuUsage(0.04)).toBe("<0.1%");
    expect(formatCpuUsage(125.6)).toBe("126%");
    expect(formatMemory(1536)).toBe("2 KB");
    expect(formatMemory(12.5 * 1024 * 1024)).toBe("12.5 MB");
  });
});
