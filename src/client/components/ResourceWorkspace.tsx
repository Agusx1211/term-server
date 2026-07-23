import { useEffect, useRef, useState } from "preact/hooks";
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState, StateEffect } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  Bot,
  Copy,
  Download,
  FileCode2,
  FileText,
  Image,
  LoaderCircle,
  PackageOpen,
  Save,
  WrapText,
} from "lucide-preact";
import type { FileDocument } from "../../shared/types";
import { api } from "../lib/api";
import type { ResourceTab } from "../lib/resources";
import type { ThemeName } from "./TerminalPane";

const LINE_WRAPPING_STORAGE_KEY = "term-server:editor-line-wrapping";

interface ResourceDocumentsProps {
  tabs: ResourceTab[];
  activePath?: string;
  theme: ThemeName;
  onDirty: (path: string, dirty: boolean) => void;
  onNotice: (message: string) => void;
  onOpenArtifactSession: (sessionId: string) => void;
}

export function ResourceDocuments({
  tabs,
  activePath,
  theme,
  onDirty,
  onNotice,
  onOpenArtifactSession,
}: ResourceDocumentsProps) {
  const [lineWrapping, setLineWrapping] = useState(
    () => localStorage.getItem(LINE_WRAPPING_STORAGE_KEY) !== "false",
  );
  const toggleLineWrapping = () => {
    setLineWrapping((current) => {
      const next = !current;
      localStorage.setItem(LINE_WRAPPING_STORAGE_KEY, String(next));
      return next;
    });
  };

  return (
    <div class={`resource-documents ${activePath ? "visible" : ""}`} aria-hidden={!activePath}>
      {tabs.map((tab) => (
        <div key={tab.path} class={`resource-document ${activePath === tab.path ? "active" : "cached"}`}>
          {tab.type === "image" ? (
            <ImageDocument tab={tab} onOpenArtifactSession={onOpenArtifactSession} />
          ) : tab.type === "pdf" ? (
            <PdfDocument tab={tab} onOpenArtifactSession={onOpenArtifactSession} />
          ) : (
            <TextDocument
              tab={tab}
              theme={theme}
              lineWrapping={lineWrapping}
              onToggleLineWrapping={toggleLineWrapping}
              onDirty={onDirty}
              onNotice={onNotice}
              onOpenArtifactSession={onOpenArtifactSession}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export default ResourceDocuments;

function ImageDocument({
  tab,
  onOpenArtifactSession,
}: {
  tab: ResourceTab;
  onOpenArtifactSession: (sessionId: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const isArtifact = Boolean(tab.artifact);
  const Icon = isArtifact ? PackageOpen : Image;
  useEffect(() => setFailed(false), [tab.modifiedAt]);
  return (
    <section class={`image-document ${isArtifact ? "artifact-document" : ""}`}>
      <header class="resource-document-header">
        <Icon size={14} />
        <span>{isArtifact ? tab.name : tab.path}</span>
        <ArtifactOriginAction tab={tab} onOpen={onOpenArtifactSession} />
        <em>{isArtifact ? "Artifact" : tab.mime}</em>
        <DownloadAction tab={tab} />
      </header>
      <div class="image-canvas">
        {failed ? (
          <div class="resource-error">Unable to render this image.</div>
        ) : (
          <img
            src={`${api.previewFileUrl({ path: tab.path })}&version=${tab.modifiedAt}`}
            alt={tab.name}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </section>
  );
}

function PdfDocument({
  tab,
  onOpenArtifactSession,
}: {
  tab: ResourceTab;
  onOpenArtifactSession: (sessionId: string) => void;
}) {
  const isArtifact = Boolean(tab.artifact);
  return (
    <section class={`pdf-document ${isArtifact ? "artifact-document" : ""}`}>
      <header class="resource-document-header">
        {isArtifact ? <PackageOpen size={14} /> : <FileText size={14} />}
        <span>{isArtifact ? tab.name : tab.path}</span>
        <ArtifactOriginAction tab={tab} onOpen={onOpenArtifactSession} />
        <em>{isArtifact ? "Artifact · PDF" : tab.mime}</em>
        <DownloadAction tab={tab} />
      </header>
      <iframe
        class="pdf-preview"
        src={api.previewFileUrl({ path: tab.path })}
        title={`PDF preview of ${tab.name}`}
      />
    </section>
  );
}

function DownloadAction({ tab }: { tab: ResourceTab }) {
  return (
    <a
      class="resource-editor-action resource-download"
      href={api.downloadFileUrl({ path: tab.path })}
      download={tab.name}
      aria-label={`Download ${tab.name}`}
      title={`Download ${tab.name}`}
    >
      <Download size={13} />
      <span>Download</span>
    </a>
  );
}

interface TextDocumentProps {
  tab: ResourceTab;
  theme: ThemeName;
  lineWrapping: boolean;
  onToggleLineWrapping: () => void;
  onDirty: (path: string, dirty: boolean) => void;
  onNotice: (message: string) => void;
  onOpenArtifactSession: (sessionId: string) => void;
}

function TextDocument({
  tab,
  theme,
  lineWrapping,
  onToggleLineWrapping,
  onDirty,
  onNotice,
  onOpenArtifactSession,
}: TextDocumentProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>();
  const lineWrappingConfig = useRef(new Compartment());
  const content = useRef("");
  const savedContent = useRef("");
  const version = useRef("");
  const saveCurrent = useRef<() => Promise<void>>(async () => undefined);
  const [document, setDocument] = useState<FileDocument>();
  const [language, setLanguage] = useState("Plain Text");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const isArtifact = Boolean(tab.artifact);

  useEffect(() => {
    if (tab.dirty) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void api.readFile({ path: tab.path }).then((next) => {
      if (cancelled) return;
      content.current = next.content;
      savedContent.current = next.content;
      version.current = next.version;
      setDocument(next);
      setLoading(false);
    }).catch((reason) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : "Unable to open file");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [tab.path, tab.modifiedAt, tab.dirty]);

  const save = async () => {
    if (!document || saving) return;
    setSaving(true);
    setError("");
    try {
      const saved = await api.saveFile({
        path: tab.path,
        content: content.current,
        version: version.current,
      });
      version.current = saved.version;
      savedContent.current = content.current;
      setDocument(saved);
      onDirty(tab.path, false);
      onNotice(`Saved ${tab.name}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Unable to save file";
      setError(message);
      onNotice(message);
    } finally {
      setSaving(false);
    }
  };
  saveCurrent.current = save;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content.current);
      onNotice(`Copied ${tab.name}`);
    } catch {
      onNotice("Clipboard access was denied");
    }
  };

  useEffect(() => {
    if (!host.current || !document) return;
    const startContent = content.current;
    const description = LanguageDescription.matchFilename(languages, tab.name);
    setLanguage(description?.name ?? "Plain Text");
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: startContent,
        extensions: [
          basicSetup,
          ...(theme === "dark" ? [oneDark] : []),
          lineWrappingConfig.current.of(lineWrapping ? EditorView.lineWrapping : []),
          EditorView.theme({
            "&": {
              height: "100%",
              backgroundColor: isArtifact ? "var(--artifact-surface)" : "var(--editor)",
              color: "var(--foreground)",
            },
            ".cm-scroller": { fontFamily: "SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace", fontSize: "12.5px", lineHeight: "1.48" },
            ".cm-gutters": {
              backgroundColor: isArtifact ? "var(--artifact-surface-raised)" : "var(--panel)",
              color: "var(--subtle)",
              borderRight: `1px solid ${isArtifact ? "color-mix(in srgb, var(--artifact) 35%, var(--border))" : "var(--border)"}`,
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: `color-mix(in srgb, ${isArtifact ? "var(--artifact)" : "var(--accent)"} 7%, transparent)`,
            },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            content.current = update.state.doc.toString();
            onDirty(tab.path, content.current !== savedContent.current);
          }),
          EditorView.domEventHandlers({
            keydown(event) {
              if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void saveCurrent.current();
                return true;
              }
              return false;
            },
          }),
        ],
      }),
    });
    editor.current = view;
    if (description) {
      void description.load().then((support) => {
        if (editor.current === view) view.dispatch({ effects: StateEffect.appendConfig.of(support) });
      }).catch(() => setLanguage("Plain Text"));
    }
    return () => {
      content.current = view.state.doc.toString();
      view.destroy();
      if (editor.current === view) editor.current = undefined;
    };
  }, [document?.path, tab.name, tab.path, isArtifact, theme]);

  useEffect(() => {
    editor.current?.dispatch({
      effects: lineWrappingConfig.current.reconfigure(lineWrapping ? EditorView.lineWrapping : []),
    });
  }, [lineWrapping]);

  return (
    <section class={`text-document ${isArtifact ? "artifact-document" : ""}`}>
      <header class="resource-document-header">
        {isArtifact ? <PackageOpen size={14} /> : <FileCode2 size={14} />}
        <span>{isArtifact ? tab.name : tab.path}</span>
        <ArtifactOriginAction tab={tab} onOpen={onOpenArtifactSession} />
        <em>{isArtifact ? `Artifact · ${language}` : language}</em>
        <DownloadAction tab={tab} />
        <button
          class="resource-editor-action resource-copy"
          onClick={() => void copy()}
          disabled={loading}
          aria-label={`Copy ${tab.name}`}
          title={`Copy ${tab.name}`}
        >
          <Copy size={13} />
          <span>Copy</span>
        </button>
        <button
          class={`resource-editor-action resource-wrap ${lineWrapping ? "active" : ""}`}
          onClick={onToggleLineWrapping}
          aria-label={`${lineWrapping ? "Disable" : "Enable"} line wrapping`}
          aria-pressed={lineWrapping}
          title={`${lineWrapping ? "Disable" : "Enable"} line wrapping`}
        >
          <WrapText size={13} />
          <span>Wrap</span>
        </button>
        <button
          class="resource-editor-action resource-save"
          onClick={() => void save()}
          disabled={loading || saving || !tab.dirty}
        >
          {saving ? <LoaderCircle class="spin" size={13} /> : <Save size={13} />}
          Save
        </button>
      </header>
      <div class="text-document-body">
        {error && <div key="error" class="resource-error">{error}</div>}
        {loading ? (
          <div key="loading" class="resource-loading"><LoaderCircle class="spin" size={16} /> Loading {tab.name}…</div>
        ) : (
          <div key="editor" ref={host} class="code-editor" />
        )}
      </div>
    </section>
  );
}

function ArtifactOriginAction({
  tab,
  onOpen,
}: {
  tab: ResourceTab;
  onOpen: (sessionId: string) => void;
}) {
  if (!tab.artifact) return null;
  const label = tab.artifact.agentKind
    ? `${tab.artifact.agentKind} · ${tab.artifact.terminalName}`
    : tab.artifact.terminalName;
  return (
    <button
      class="artifact-origin"
      onClick={() => onOpen(tab.artifact!.sessionId)}
      title={`Return to ${label}`}
    >
      <Bot size={12} />
      <span>{label}</span>
    </button>
  );
}
