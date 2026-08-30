import { pathToFileURL } from "node:url";

export function releaseIdentity(ref, version) {
  if (!version) throw new Error("release version is required");
  if (ref === "refs/heads/main") return { version, channel: "main" };
  if (ref === "refs/heads/dev") return { version, channel: "beta" };
  if (ref.startsWith("refs/tags/")) {
    const channel = ref.slice("refs/tags/".length);
    if (channel !== `v${version}`) {
      throw new Error(`tag ${channel} does not match Cargo version ${version}`);
    }
    return { version, channel };
  }
  throw new Error(`unsupported release ref: ${ref}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { version, channel } = releaseIdentity(process.argv[2] ?? "", process.argv[3] ?? "");
    process.stdout.write(`version=${version}\nchannel=${channel}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
