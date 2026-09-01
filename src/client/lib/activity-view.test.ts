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

  it("keeps identities when the poll reports the same terminals", () => {
    const current = [terminal({ id: "one" }), terminal({ id: "two" })];
    const polled = [terminal({ id: "one" }), terminal({ id: "two" })];
    const merged = mergeTerminalActivityViews(polled, current);

    expect(merged).toBe(current);
    expect(merged[0]).toBe(current[0]);
    expect(merged[1]).toBe(current[1]);
  });

  it("keeps identities when only the merged watermark differs in key order", () => {
    // `withActivityView` rebuilds the object with a spread, so a terminal whose
    // watermark was merged earlier can carry its keys in a different order.
    const current = [withActivityView(
      terminal({ id: "one", activityViewed: undefined }),
      { agentCompletedAt: 20, commandCompletedAt: 30 },
    )];
    const merged = mergeTerminalActivityViews(
      [terminal({ id: "one", activityViewed: { agentCompletedAt: 20, commandCompletedAt: 30 } })],
      current,
    );

    expect(merged).toBe(current);
  });

  it("replaces only the terminals that actually changed", () => {
    const current = [terminal({ id: "one" }), terminal({ id: "two" })];
    const merged = mergeTerminalActivityViews(
      [terminal({ id: "one" }), terminal({ id: "two", name: "renamed" })],
      current,
    );

    expect(merged).not.toBe(current);
    expect(merged[0]).toBe(current[0]);
    expect(merged[1]).not.toBe(current[1]);
    expect(merged[1]?.name).toBe("renamed");
  });

  it("returns a new list when a terminal appears or disappears", () => {
    const current = [terminal({ id: "one" })];
    const added = mergeTerminalActivityViews(
      [terminal({ id: "one" }), terminal({ id: "two" })],
      current,
    );
    expect(added).not.toBe(current);
    expect(added).toHaveLength(2);
    expect(mergeTerminalActivityViews([], current)).toEqual([]);
  });

  it("returns a new list when the terminals are reordered", () => {
    const current = [terminal({ id: "one" }), terminal({ id: "two" })];
    const merged = mergeTerminalActivityViews(
      [terminal({ id: "two" }), terminal({ id: "one" })],
      current,
    );

    expect(merged).not.toBe(current);
    expect(merged[0]).toBe(current[1]);
    expect(merged[1]).toBe(current[0]);
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
