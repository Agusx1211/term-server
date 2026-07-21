import { describe, expect, it } from "vitest";
import type { ProcessRecord } from "../../shared/types";
import { buildProcessTree } from "./process-inspector";

const process = (id: string, pid: number, parentId: string | null): ProcessRecord => ({
  id,
  pid,
  parentId,
  command: id,
  arguments: [id],
  cwd: "/tmp",
  foreground: id === "child",
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
});
