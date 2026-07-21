import type { TerminalInfo } from "../../shared/types";

export interface TerminalTreeNode {
  key: string;
  name: string;
  path: string;
  terminal?: TerminalInfo;
  workspaceCwd?: string;
  color?: string;
  children: TerminalTreeNode[];
}

interface MutableNode {
  key: string;
  name: string;
  path: string;
  terminal?: TerminalInfo;
  workspaceCwd?: string;
  color?: string;
  children: Map<string, MutableNode>;
}

export function buildTerminalTree(terminals: TerminalInfo[]): TerminalTreeNode[] {
  const roots = new Map<string, MutableNode>();
  for (const terminal of terminals) {
    const workspaceSegments = terminal.workspace.startsWith("/")
      ? ["/", ...terminal.workspace.slice(1).split("/").filter(Boolean)]
      : terminal.workspace.split("/").filter(Boolean);
    const segments = [...workspaceSegments, terminal.name];
    let children = roots;
    let currentPath = "";
    segments.forEach((segment, index) => {
      currentPath = segment === "/" ? "/" : currentPath === "/" ? `/${segment}` : currentPath ? `${currentPath}/${segment}` : segment;
      const leaf = index === segments.length - 1;
      const mapKey = leaf ? `terminal:${terminal.id}` : `segment:${segment}`;
      let node = children.get(mapKey);
      if (!node) {
        node = { key: mapKey, name: segment, path: currentPath, children: new Map() };
        children.set(mapKey, node);
      }
      if (index === workspaceSegments.length - 1) {
        node.workspaceCwd = terminal.cwd;
        node.color = terminal.color;
      }
      if (leaf) node.terminal = terminal;
      children = node.children;
    });
  }

  const freeze = (nodes: Map<string, MutableNode>): TerminalTreeNode[] =>
    [...nodes.values()]
      .sort((left, right) => {
        const leftFolder = left.children.size > 0;
        const rightFolder = right.children.size > 0;
        return leftFolder === rightFolder ? left.name.localeCompare(right.name) : leftFolder ? -1 : 1;
      })
      .map((node) => ({
        key: node.key,
        name: node.name,
        path: node.path,
        terminal: node.terminal,
        workspaceCwd: node.workspaceCwd,
        color: node.color,
        children: freeze(node.children),
      }));
  return freeze(roots);
}
