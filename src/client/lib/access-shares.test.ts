import { describe, expect, it } from "vitest";
import type { SecretShare } from "../../shared/types";
import { orderShares, shareOutcome, untilTime } from "./access-shares";

function share(overrides: Partial<SecretShare>): SecretShare {
  return {
    id: "share",
    name: "TOKEN",
    description: null,
    agent: "omp",
    state: "pending",
    createdAt: 0,
    expiresAt: 0,
    viewedAt: null,
    resolvedAt: null,
    waiters: 1,
    ...overrides,
  };
}

describe("shared secret ordering", () => {
  it("keeps pending offers first in arrival order and history newest first", () => {
    const ordered = orderShares([
      share({ id: "old-viewed", state: "viewed", createdAt: 10 }),
      share({ id: "second-pending", createdAt: 30 }),
      share({ id: "new-expired", state: "expired", createdAt: 40 }),
      share({ id: "first-pending", createdAt: 20 }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual([
      "first-pending",
      "second-pending",
      "new-expired",
      "old-viewed",
    ]);
  });

  it("does not mutate the snapshot list", () => {
    const shares = [share({ id: "b", createdAt: 2 }), share({ id: "a", createdAt: 1 })];
    orderShares(shares);
    expect(shares.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});

describe("shared secret copy", () => {
  it("explains every resolved state and stays silent while pending", () => {
    expect(shareOutcome({ state: "pending" })).toBe("");
    expect(shareOutcome({ state: "viewed" })).toMatch(/once/);
    expect(shareOutcome({ state: "dismissed" })).toMatch(/agent was told/);
    expect(shareOutcome({ state: "expired" })).toMatch(/share it again/);
  });

  it("formats the time left before a share expires", () => {
    const now = 1_000_000;
    expect(untilTime(now - 5_000, now)).toBe("now");
    expect(untilTime(now + 45_000, now)).toBe("in 45s");
    expect(untilTime(now + 59 * 60_000, now)).toBe("in 59m");
    expect(untilTime(now + 3 * 3_600_000, now)).toBe("in 3h");
    expect(untilTime(now + 2 * 86_400_000, now)).toBe("in 2d");
  });
});
