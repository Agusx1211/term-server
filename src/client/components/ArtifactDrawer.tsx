import { useEffect, useState } from "preact/hooks";
import {
  Bot,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  Image,
  LoaderCircle,
  PackageOpen,
  X,
} from "lucide-preact";
import type { ArtifactEntry, FileDocument, TerminalInfo } from "../../shared/types";
import { api } from "../lib/api";
import { artifactOwnerLabel, formatArtifactSize } from "../lib/artifacts";

interface ArtifactDrawerProps {
  terminal: TerminalInfo;
  artifacts: ArtifactEntry[];
  onClose: () => void;
  onOpen: (artifact: ArtifactEntry) => void;
  onNotice: (message: string) => void;
}

const artifactIcon = (artifact: ArtifactEntry) => (
  artifact.image ? Image : artifact.pdf ? FileText : FileCode2
);

const artifactTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const artifactDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const artifactTime = (timestamp: number) => artifactTimeFormatter.format(timestamp);
const artifactDateTime = (timestamp: number) => artifactDateTimeFormatter.format(timestamp);

export function ArtifactDrawer({
  terminal,
  artifacts,
  onClose,
  onOpen,
  onNotice,
}: ArtifactDrawerProps) {
  const [selectedId, setSelectedId] = useState(artifacts[0]?.id);
  const latestId = artifacts[0]?.id;

  useEffect(() => {
    if (latestId) setSelectedId(latestId);
  }, [latestId]);

  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0];
  const owner = artifactOwnerLabel(terminal, selected?.producer);
  const producers = new Set(artifacts.flatMap((artifact) => (
    artifact.producer ? [artifact.producer] : []
  )));
  const drawerTitle = producers.size === 1
    ? `${[...producers][0]} artifacts`
    : terminal.agent
      ? `${terminal.agent.kind} artifacts`
      : "Terminal artifacts";

  return (
    <aside
      class="artifact-drawer"
      aria-label={`Artifacts from ${owner}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header class="artifact-drawer-header">
        <span class="artifact-drawer-mark"><PackageOpen size={16} /></span>
        <span class="artifact-drawer-heading">
          <strong>{drawerTitle}</strong>
          <small>{terminal.name} · {artifacts.length} {artifacts.length === 1 ? "handoff" : "handoffs"}</small>
        </span>
        <button class="pane-action" onClick={onClose} aria-label="Close artifact sidebar" title="Close artifact sidebar">
          <X size={15} />
        </button>
      </header>
      <div class="artifact-drawer-context">
        {selected?.producer || terminal.agent ? <Bot size={12} /> : <PackageOpen size={12} />}
        <span>
          {selected?.producer
            ? `Created by ${selected.producer} in ${terminal.name}.`
            : "Created in this session, kept next to the agent that made it."}
        </span>
      </div>
      <div class="artifact-drawer-list" role="listbox" aria-label="Session artifacts">
        {artifacts.map((artifact) => {
          const Icon = artifactIcon(artifact);
          return (
            <button
              key={artifact.id}
              class={`artifact-list-item ${selected?.id === artifact.id ? "active" : ""}`}
              onClick={() => setSelectedId(artifact.id)}
              role="option"
              aria-selected={selected?.id === artifact.id}
              title={`${artifact.name}\nCreated ${artifactDateTime(artifact.createdAt)}`}
            >
              <span class="artifact-list-icon"><Icon size={14} /></span>
              <span class="artifact-list-copy">
                <strong>{artifact.name}</strong>
                <small>{formatArtifactSize(artifact.size)} · {artifactTime(artifact.createdAt)}</small>
              </span>
            </button>
          );
        })}
      </div>
      {selected && (
        <ArtifactInlinePreview
          key={selected.id}
          artifact={selected}
          onOpen={() => onOpen(selected)}
          onNotice={onNotice}
        />
      )}
    </aside>
  );
}

interface ArtifactInlinePreviewProps {
  artifact: ArtifactEntry;
  onOpen: () => void;
  onNotice: (message: string) => void;
}

function ArtifactInlinePreview({ artifact, onOpen, onNotice }: ArtifactInlinePreviewProps) {
  const [document, setDocument] = useState<FileDocument>();
  const [loading, setLoading] = useState(artifact.editable);
  const [error, setError] = useState("");
  const Icon = artifactIcon(artifact);

  useEffect(() => {
    if (!artifact.editable) {
      setDocument(undefined);
      setLoading(false);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    void api.readFile({ path: artifact.path }).then((next) => {
      if (cancelled) return;
      setDocument(next);
      setLoading(false);
    }).catch((reason) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : "Unable to load artifact");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [artifact.path, artifact.modifiedAt, artifact.editable]);

  const copy = async () => {
    if (!document) return;
    try {
      await navigator.clipboard.writeText(document.content);
      onNotice(`Copied ${artifact.name}`);
    } catch {
      onNotice("Clipboard access was denied");
    }
  };

  const previewContent = document?.content.slice(0, 20_000) ?? "";
  const previewTruncated = (document?.content.length ?? 0) > previewContent.length;

  return (
    <section class="artifact-inline">
      <header class="artifact-inline-header">
        <Icon size={14} />
        <span>
          <strong>{artifact.name}</strong>
          <small>Updated {artifactDateTime(artifact.modifiedAt)}</small>
        </span>
        <button class="artifact-inline-action primary" onClick={onOpen} title="Open full editor">
          <ExternalLink size={13} /> <span>Open</span>
        </button>
        {document && (
          <button class="artifact-inline-action" onClick={() => void copy()} title={`Copy ${artifact.name}`}>
            <Copy size={13} /> <span>Copy</span>
          </button>
        )}
        <a
          class="artifact-inline-action"
          href={api.downloadFileUrl({ path: artifact.path })}
          download={artifact.name}
          title={`Download ${artifact.name}`}
        >
          <Download size={13} /> <span>Download</span>
        </a>
      </header>
      <div class="artifact-inline-body">
        {loading ? (
          <div class="artifact-inline-state"><LoaderCircle class="spin" size={16} /> Loading preview…</div>
        ) : error ? (
          <div class="artifact-inline-state error">{error}</div>
        ) : artifact.image ? (
          <img
            src={`${api.previewFileUrl({ path: artifact.path })}&version=${artifact.modifiedAt}`}
            alt={artifact.name}
            onError={() => setError("Unable to render image preview")}
          />
        ) : artifact.pdf ? (
          <iframe
            src={api.previewFileUrl({ path: artifact.path })}
            title={`Inline preview of ${artifact.name}`}
          />
        ) : document ? (
          <pre>{previewContent || "(Empty artifact)"}{previewTruncated ? "\n\n… Preview truncated. Open the artifact to see the rest." : ""}</pre>
        ) : (
          <div class="artifact-inline-state">
            This file type cannot be shown inline. Open it for the full preview.
          </div>
        )}
      </div>
    </section>
  );
}
