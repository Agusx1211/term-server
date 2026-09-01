export interface ArtifactOrigin {
  id: string;
  sessionId: string;
  terminalName: string;
  agentKind?: string;
}

export interface ResourceTab {
  path: string;
  name: string;
  type: "text" | "image" | "pdf";
  mime: string;
  modifiedAt: number;
  dirty: boolean;
  artifact?: ArtifactOrigin;
}

/** Revision of a resource tab: its path plus the modification time it points at. */
export function resourceRevision(tab: Pick<ResourceTab, "path" | "modifiedAt">): string {
  return `${tab.path} ${tab.modifiedAt}`;
}

/** Revisions an open document already holds, so they are never refetched. */
export interface ResourceRevisionsHeld {
  /** The revision the buffer was last filled from. */
  loaded: string;
  /** The revision our own save produced; the poll reports it moments later. */
  saved: string;
}

/**
 * Whether an open text document has to refetch its content.
 *
 * Unsaved edits always win, the revision already in the buffer is never
 * refetched (saving flips `dirty`, which must not reload the editor), and
 * neither is the revision our own save just wrote. Anything else is an
 * external rewrite and has to replace the buffer.
 */
export function shouldReloadResource(
  tab: Pick<ResourceTab, "path" | "modifiedAt" | "dirty">,
  held: ResourceRevisionsHeld,
): boolean {
  if (tab.dirty) return false;
  const revision = resourceRevision(tab);
  return held.loaded !== revision && held.saved !== revision;
}
