import { describe, expect, it } from "vitest";
import type { ArtifactEntry, TerminalInfo } from "../../shared/types";
import {
  artifactCountsBySession,
  artifactOwnerLabel,
  discoverArtifacts,
  formatArtifactSize,
  reconcileArtifactResources,
  resourceForArtifact,
  sortArtifactsNewestFirst,
  stableArtifactInventory,
} from "./artifacts";
import type { ResourceTab } from "./resources";

const artifact = (overrides: Partial<ArtifactEntry> = {}): ArtifactEntry => ({
  id: "artifact-1",
  sessionId: "session-1",
  path: "/tmp/artifacts/session-1/artifact-1/message.md",
  name: "message.md",
  kind: "file",
  size: 12,
  createdAt: 100,
  modifiedAt: 120,
  mime: "text/markdown",
  image: false,
  pdf: false,
  editable: true,
  ...overrides,
});

const terminal = (overrides: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: "session-1",
  name: "artifact-work",
  workspace: "~/term-server",
  path: "~/term-server/artifact-work",
  cwd: "/work/term-server",
  shell: "/bin/bash",
  program: "codex",
  color: "#123456",
  agent: {
    kind: "codex",
    status: "idle",
    statusChangedAt: 1,
    startedAt: 1,
    revision: 1,
    summary: null,
  },
  createdAt: 1,
  pid: 10,
  status: "running",
  exitCode: null,
  clients: 1,
  ...overrides,
});

describe("artifact resources", () => {
  it("keeps the inventory separate from closed resource tabs", () => {
    expect(reconcileArtifactResources([], [artifact()], [terminal()])).toEqual([]);
  });

  it("refreshes metadata for an artifact that is already open", () => {
    const open = resourceForArtifact(artifact(), terminal());
    const resources: ResourceTab[] = [{ ...open, dirty: true }];
    const nextArtifact = artifact({ modifiedAt: 200, size: 24 });
    const nextTerminal = terminal({ name: "renamed-agent" });

    expect(reconcileArtifactResources(resources, [nextArtifact], [nextTerminal])).toEqual([
      expect.objectContaining({
        modifiedAt: 200,
        dirty: true,
        artifact: expect.objectContaining({ terminalName: "renamed-agent" }),
      }),
    ]);
  });

  it("connects an already-open artifact path without opening a new tab", () => {
    const openFile: ResourceTab = {
      path: artifact().path,
      name: "message.md",
      type: "text",
      mime: "text/markdown",
      modifiedAt: 120,
      dirty: false,
    };
    const next = reconcileArtifactResources([openFile], [artifact()], [terminal()]);
    expect(next).toHaveLength(1);
    expect(next[0]?.artifact).toEqual(expect.objectContaining({
      id: "artifact-1",
      sessionId: "session-1",
      agentKind: "codex",
    }));
  });

  it("preserves the recorded producer when the terminal later runs another agent", () => {
    const currentTerminal = terminal({
      agent: {
        ...terminal().agent!,
        kind: "claude",
      },
    });
    const recorded = artifact({ producer: "codex" });
    expect(resourceForArtifact(recorded, currentTerminal).artifact?.agentKind).toBe("codex");
    expect(artifactOwnerLabel(currentTerminal, recorded.producer)).toBe("codex · artifact-work");
  });

  it("announces each artifact only once even if it temporarily disappears", () => {
    const known = new Set<string>();
    expect(discoverArtifacts(known, [artifact()])).toHaveLength(1);
    expect(discoverArtifacts(known, [])).toEqual([]);
    expect(discoverArtifacts(known, [artifact()])).toEqual([]);
  });

  it("groups and orders artifacts by their originating session", () => {
    const artifacts = [
      artifact(),
      artifact({ id: "artifact-2", sessionId: "session-2", createdAt: 300 }),
      artifact({ id: "artifact-3", createdAt: 200 }),
    ];
    expect(sortArtifactsNewestFirst(artifacts).map((entry) => entry.id)).toEqual([
      "artifact-2",
      "artifact-3",
      "artifact-1",
    ]);
    expect(artifactCountsBySession(artifacts)).toEqual(new Map([
      ["session-1", 2],
      ["session-2", 1],
    ]));
  });

  it("formats compact file sizes", () => {
    expect(formatArtifactSize(999)).toBe("999 B");
    expect(formatArtifactSize(1_500)).toBe("1.5 KB");
    expect(formatArtifactSize(2_500_000)).toBe("2.5 MB");
  });

  it("keeps an unchanged inventory referentially stable", () => {
    const current = [artifact()];
    expect(stableArtifactInventory(current, [artifact()])).toBe(current);
    expect(stableArtifactInventory(current, [artifact({ modifiedAt: 200 })])).not.toBe(current);
  });
});
