#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [artifactDirectory = "artifacts", channel, version, commit] = process.argv.slice(2);
if (!channel || !version || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
  console.error("usage: release-metadata.mjs <artifact-directory> <channel> <version> <40-character-commit>");
  process.exit(1);
}
if (!/^[A-Za-z0-9._-]+$/.test(channel)) {
  console.error(`invalid release channel: ${channel}`);
  process.exit(1);
}

const targets = new Map([
  ["term-server-linux-x86_64.tar.gz", "x86_64-unknown-linux-gnu"],
  ["term-server-linux-aarch64.tar.gz", "aarch64-unknown-linux-gnu"],
]);
const names = (await readdir(artifactDirectory))
  .filter((name) => targets.has(name))
  .sort();
if (names.length !== targets.size) {
  console.error(`expected ${targets.size} Linux release archives, found ${names.length}`);
  process.exit(1);
}

const artifacts = [];
const checksums = [];
for (const name of names) {
  const path = join(artifactDirectory, name);
  const [contents, details] = await Promise.all([readFile(path), stat(path)]);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  artifacts.push({ target: targets.get(name), name, sha256, size: details.size });
  checksums.push(`${sha256}  ${name}`);
}

const manifest = {
  schemaVersion: 1,
  channel,
  version,
  commit,
  publishedAt: new Date().toISOString(),
  artifacts,
};
await Promise.all([
  writeFile(join(artifactDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`),
  writeFile(join(artifactDirectory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
]);
