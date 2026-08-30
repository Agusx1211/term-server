import assert from "node:assert/strict";
import test from "node:test";
import { releaseIdentity } from "./release-channel.mjs";

test("maps release branches to rolling GitHub channels", () => {
  assert.deepEqual(releaseIdentity("refs/heads/main", "1.2.3"), {
    version: "1.2.3",
    channel: "main",
  });
  assert.deepEqual(releaseIdentity("refs/heads/dev", "1.2.3"), {
    version: "1.2.3",
    channel: "beta",
  });
});

test("keeps matching version tags immutable", () => {
  assert.deepEqual(releaseIdentity("refs/tags/v1.2.3", "1.2.3"), {
    version: "1.2.3",
    channel: "v1.2.3",
  });
  assert.throws(
    () => releaseIdentity("refs/tags/v1.2.2", "1.2.3"),
    /does not match Cargo version/,
  );
});

test("rejects refs that must never publish", () => {
  assert.throws(
    () => releaseIdentity("refs/heads/feature", "1.2.3"),
    /unsupported release ref/,
  );
});
