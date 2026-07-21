import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "../../shared/types";
import { buildTerminalTree } from "./tree";

const terminal = (id: string, workspace: string, name: string): TerminalInfo => ({
  id,
  name,
  workspace,
  path: `${workspace}/${name}`,
  cwd: workspace === "~" ? "/home/test" : workspace,
  shell: "/bin/sh",
  program: "sh",
  color: "#4daafc",
  agent: null,
  createdAt: 0,
  pid: 1,
  status: "running",
  exitCode: null,
  clients: 0,
});

describe("buildTerminalTree", () => {
  it("builds nested categories from terminal paths", () => {
    const tree = buildTerminalTree([
      terminal("api", "~/services/production", "api"),
      terminal("worker", "~/services/production", "worker"),
      terminal("shell", "/tmp/scratch", "shell"),
    ]);

    expect(tree.map((node) => node.name)).toEqual(["/", "~"]);
    expect(tree[1]?.children[0]?.children[0]?.children.map((node) => node.name)).toEqual(["api", "worker"]);
    expect(tree[1]?.children[0]?.children[0]?.children[0]?.terminal?.id).toBe("api");
    expect(tree[1]?.children[0]?.children[0]?.workspaceCwd).toBe("~/services/production");
  });

  it("groups multiple terminals inside one workspace", () => {
    const tree = buildTerminalTree([terminal("one", "~", "terminal 1"), terminal("two", "~", "terminal 2")]);
    expect(tree[0]?.name).toBe("~");
    expect(tree[0]?.workspaceCwd).toBe("/home/test");
    expect(tree[0]?.children.map((node) => node.terminal?.id)).toEqual(["one", "two"]);
  });

  it("keeps duplicate process names as separate terminal leaves", () => {
    const tree = buildTerminalTree([terminal("one", "~", "codex"), terminal("two", "~", "codex")]);
    expect(tree[0]?.children.map((node) => node.terminal?.id)).toEqual(["one", "two"]);
  });
});
