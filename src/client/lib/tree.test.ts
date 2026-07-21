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

    expect(tree.map((node) => node.name)).toEqual(["/tmp/scratch", "~/services/production"]);
    expect(tree[1]?.children.map((node) => node.name)).toEqual(["api", "worker"]);
    expect(tree[1]?.children[0]?.terminal?.id).toBe("api");
    expect(tree[1]?.workspaceCwd).toBe("~/services/production");
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

  it("compacts single-child workspace paths", () => {
    const tree = buildTerminalTree([terminal("shell", "~/path/a/b/c", "shell")]);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      name: "~/path/a/b/c",
      path: "~/path/a/b/c",
      workspaceCwd: "~/path/a/b/c",
    });
    expect(tree[0]?.children[0]?.terminal?.id).toBe("shell");
  });

  it("stops compaction where a workspace owns terminals or branches", () => {
    const tree = buildTerminalTree([
      terminal("parent", "~/path/a/b", "parent"),
      terminal("child-c", "~/path/a/b/c", "child-c"),
      terminal("child-d", "~/path/a/b/d", "child-d"),
    ]);

    expect(tree[0]).toMatchObject({ name: "~/path/a/b", path: "~/path/a/b", workspaceCwd: "~/path/a/b" });
    expect(tree[0]?.children.map((node) => node.name)).toEqual(["c", "d", "parent"]);
    expect(tree[0]?.children[0]?.path).toBe("~/path/a/b/c");
    expect(tree[0]?.children[1]?.path).toBe("~/path/a/b/d");
  });
});
