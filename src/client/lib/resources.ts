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
