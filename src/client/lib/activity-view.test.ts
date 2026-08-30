import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "../../shared/types";
import {
  activityView,
  currentActivityViewUpdate,
  legacyActivityViewUpdate,
  mergeActivityViews,
  mergeTerminalActivityViews,
  withActivityView,
} from "./activity-view";

const terminal = (overrides: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: "one",
  kind: "regular",
  name: "shell",
  workspace: "workspace",
  path: "workspace/shell",
  cwd: "/workspace",
  shell: "/bin/sh",
  program: "sh",
  color: "#123456",
  agent: {
    kind: "codex",
    status: "idle",
    statusChangedAt: 20,
    startedAt: 10,
    revision: 4,
    completedAt: 20,
    summary: null,
  },
  command: {
    name: "backup",
    status: "completed",
    statusChangedAt: 30,
    startedAt: 10,
    completedAt: 30,
  },
  createdAt: 1,
  pid: 10,
  status: "running",
  exitCode: null,
  clients: 1,
  activityViewed: {
    agentCompletedAt: 15,
    commandCompletedAt: 25,
  },
  ...overrides,
});

describe("server-synced activity views", () => {
  it("defaults broker terminal messages to unseen watermarks", () => {
    expect(activityView(terminal({ activityViewed: undefined }))).toEqual({
      agentCompletedAt: 0,
      commandCompletedAt: 0,
    });
  });

  it("requests only the currently unseen completion watermarks", () => {
    expect(currentActivityViewUpdate(terminal())).toEqual({
      agentCompletedAt: 20,
      commandCompletedAt: 30,
    });
    expect(currentActivityViewUpdate(withActivityView(terminal(), {
      agentCompletedAt: 20,
      commandCompletedAt: 30,
    }))).toBeNull();
  });

  it("merges stale device and response state monotonically", () => {
    expect(mergeActivityViews(
      { agentCompletedAt: 70, commandCompletedAt: 20 },
      { agentCompletedAt: 50, commandCompletedAt: 30 },
    )).toEqual({
      agentCompletedAt: 70,
      commandCompletedAt: 30,
    });
    expect(mergeTerminalActivityViews(
      [terminal({
        activityViewed: { agentCompletedAt: 50, commandCompletedAt: 30 },
      })],
      [terminal({
        activityViewed: { agentCompletedAt: 70, commandCompletedAt: 20 },
      })],
    )[0]?.activityViewed).toEqual({
      agentCompletedAt: 70,
      commandCompletedAt: 30,
    });
    expect(withActivityView(
      terminal({ activityViewed: undefined }),
      { agentCompletedAt: 70, commandCompletedAt: 30 },
    ).activityViewed).toEqual({
      agentCompletedAt: 70,
      commandCompletedAt: 30,
    });
  });

  it("migrates only legacy browser watermarks newer than the server", () => {
    expect(legacyActivityViewUpdate(
      terminal(),
      { one: 4 },
      { one: 20 },
    )).toEqual({ agentCompletedAt: 20 });
    expect(legacyActivityViewUpdate(
      terminal(),
      { one: 2 },
      { one: 25 },
    )).toBeNull();
    expect(legacyActivityViewUpdate(
      terminal({ agent: null, command: null }),
      { one: 50 },
      { one: 50 },
    )).toBeNull();
  });
});
