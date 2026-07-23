import type { ArtifactEntry, TerminalInfo } from "../../shared/types";
import type { ResourceTab } from "./resources";

export interface ArtifactDeleteTarget {
  id: string;
  sessionId: string;
  name: string;
  path: string;
}

const sameArtifactOrigin = (
  left: ResourceTab["artifact"],
  right: ResourceTab["artifact"],
) => (
  left?.id === right?.id
  && left?.sessionId === right?.sessionId
  && left?.terminalName === right?.terminalName
  && left?.agentKind === right?.agentKind
);

export function artifactOwnerLabel(
  terminal: TerminalInfo | undefined,
  producer?: string,
): string {
  const terminalName = terminal?.name ?? "Previous terminal";
  const agentKind = producer ?? terminal?.agent?.kind;
  return agentKind ? `${agentKind} · ${terminalName}` : terminalName;
}

export function resourceForArtifact(
  artifact: ArtifactEntry,
  terminal: TerminalInfo | undefined,
): ResourceTab {
  return {
    path: artifact.path,
    name: artifact.name,
    type: artifact.image ? "image" : artifact.pdf ? "pdf" : "text",
    mime: artifact.mime,
    modifiedAt: artifact.modifiedAt,
    dirty: false,
    artifact: {
      id: artifact.id,
      sessionId: artifact.sessionId,
      terminalName: terminal?.name ?? "Previous terminal",
      agentKind: artifact.producer ?? terminal?.agent?.kind,
    },
  };
}

export function reconcileArtifactResources(
  resources: ResourceTab[],
  artifacts: ArtifactEntry[],
  terminals: TerminalInfo[],
): ResourceTab[] {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const artifactsByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const terminalsById = new Map(terminals.map((terminal) => [terminal.id, terminal]));
  let changed = false;
  const next = resources.map((resource) => {
    const artifact = (
      resource.artifact ? artifactsById.get(resource.artifact.id) : undefined
    ) ?? artifactsByPath.get(resource.path);
    if (!artifact) return resource;
    const updated = resourceForArtifact(artifact, terminalsById.get(artifact.sessionId));
    if (
      resource.path === updated.path
      && resource.name === updated.name
      && resource.type === updated.type
      && resource.mime === updated.mime
      && resource.modifiedAt === updated.modifiedAt
      && sameArtifactOrigin(resource.artifact, updated.artifact)
    ) {
      return resource;
    }
    changed = true;
    return { ...updated, dirty: resource.dirty };
  });
  return changed ? next : resources;
}

export function removeArtifactResources(
  resources: ResourceTab[],
  artifact: ArtifactDeleteTarget,
): ResourceTab[] {
  const next = resources.filter((resource) => (
    resource.path !== artifact.path
    && (
      resource.artifact?.id !== artifact.id
      || resource.artifact.sessionId !== artifact.sessionId
    )
  ));
  return next.length === resources.length ? resources : next;
}

export function discoverArtifacts(
  knownIds: Set<string>,
  artifacts: ArtifactEntry[],
): ArtifactEntry[] {
  const discovered = artifacts.filter((artifact) => !knownIds.has(artifact.id));
  for (const artifact of artifacts) knownIds.add(artifact.id);
  return discovered;
}

export function sortArtifactsNewestFirst(artifacts: ArtifactEntry[]): ArtifactEntry[] {
  return [...artifacts].sort((left, right) => (
    right.createdAt - left.createdAt
    || right.modifiedAt - left.modifiedAt
    || left.name.localeCompare(right.name)
  ));
}

export function stableArtifactInventory(
  current: ArtifactEntry[],
  next: ArtifactEntry[],
): ArtifactEntry[] {
  if (current.length !== next.length) return next;
  const unchanged = current.every((artifact, index) => {
    const candidate = next[index];
    return candidate
      && artifact.id === candidate.id
      && artifact.sessionId === candidate.sessionId
      && artifact.path === candidate.path
      && artifact.name === candidate.name
      && artifact.size === candidate.size
      && artifact.createdAt === candidate.createdAt
      && artifact.modifiedAt === candidate.modifiedAt
      && artifact.mime === candidate.mime
      && artifact.image === candidate.image
      && artifact.pdf === candidate.pdf
      && artifact.editable === candidate.editable
      && artifact.producer === candidate.producer;
  });
  return unchanged ? current : next;
}

export function artifactCountsBySession(artifacts: ArtifactEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    counts.set(artifact.sessionId, (counts.get(artifact.sessionId) ?? 0) + 1);
  }
  return counts;
}

export function formatArtifactSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}
