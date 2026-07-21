import { useEffect, useRef, useState } from "preact/hooks";
import {
  ArrowUp,
  File,
  FileCode2,
  Folder,
  Image,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-preact";
import type { DirectoryListing, FileEntry } from "../../shared/types";
import { api } from "../lib/api";

interface FileExplorerProps {
  initialRoot: string;
  onOpen: (entry: FileEntry) => void;
}

export function FileExplorer({ initialRoot, onOpen }: FileExplorerProps) {
  const [location, setLocation] = useState(initialRoot || "~");
  const [pathInput, setPathInput] = useState(initialRoot || "~");
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState<DirectoryListing>();
  const [results, setResults] = useState<FileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState("");
  const directoryRequest = useRef(0);
  const searchRequest = useRef(0);

  const loadDirectory = (path: string) => {
    const sequence = ++directoryRequest.current;
    setDirectoryLoading(true);
    setError("");
    void api.listFiles({ path }).then((next) => {
      if (sequence !== directoryRequest.current) return;
      setLocation(next.path);
      setPathInput(next.path);
      setListing(next);
      setResults([]);
      setTruncated(next.truncated);
      setDirectoryLoading(false);
    }).catch((reason) => {
      if (sequence !== directoryRequest.current) return;
      setError(reason instanceof Error ? reason.message : "Unable to list directory");
      setDirectoryLoading(false);
    });
  };

  useEffect(() => {
    loadDirectory(location);
  }, []);

  useEffect(() => {
    const sequence = ++searchRequest.current;
    const needle = query.trim();
    if (!needle) {
      setResults([]);
      setTruncated(listing?.truncated ?? false);
      setSearchLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      setError("");
      void api.searchFiles(location, needle).then((next) => {
        if (sequence !== searchRequest.current) return;
        setResults(next.entries);
        setTruncated(next.truncated);
        setSearchLoading(false);
      }).catch((reason) => {
        if (sequence !== searchRequest.current) return;
        setError(reason instanceof Error ? reason.message : "Unable to search files");
        setSearchLoading(false);
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [query, location]);

  const loading = directoryLoading || searchLoading;
  const entries = query.trim() ? results : listing?.entries ?? [];
  const open = (entry: FileEntry) => {
    if (entry.kind === "directory") {
      setQuery("");
      loadDirectory(entry.path);
    } else {
      onOpen(entry);
    }
  };

  return (
    <section class="file-explorer" aria-label="File explorer">
      <form
        class="file-location"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery("");
          loadDirectory(pathInput);
        }}
      >
        <button
          type="button"
          onClick={() => listing?.parent && loadDirectory(listing.parent)}
          disabled={!listing?.parent}
          aria-label="Parent directory"
          title="Parent directory"
        >
          <ArrowUp size={14} />
        </button>
        <input value={pathInput} onInput={(event) => setPathInput(event.currentTarget.value)} aria-label="Explorer directory" />
        <button type="button" onClick={() => loadDirectory(location)} aria-label="Refresh directory" title="Refresh">
          <RefreshCw size={13} />
        </button>
      </form>
      <div class="file-search">
        <Search size={13} />
        <input
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search files by name"
          aria-label="Search files by name"
        />
        {loading ? <LoaderCircle class="spin" size={13} /> : query && (
          <button onClick={() => setQuery("")} aria-label="Clear file search"><X size={12} /></button>
        )}
      </div>
      <div class="file-results">
        {entries.map((entry) => (
          <button key={entry.path} class="file-result" onClick={() => open(entry)} title={entry.path}>
            <FileIcon entry={entry} />
            <span>
              <b>{entry.name}</b>
              <small>{query ? relativePath(entry.path, location) : entry.kind === "directory" ? "Folder" : fileSize(entry.size)}</small>
            </span>
          </button>
        ))}
        {!loading && !entries.length && (
          <div class="file-empty">{error || (query ? "No matching files" : "This directory is empty")}</div>
        )}
      </div>
      {truncated && <div class="file-truncated">Showing the first results. Narrow the search to see more.</div>}
    </section>
  );
}

function FileIcon({ entry }: { entry: FileEntry }) {
  if (entry.kind === "directory") return <Folder class="directory" size={15} />;
  if (entry.image) return <Image class="image" size={15} />;
  if (entry.editable) return <FileCode2 class="code" size={15} />;
  return <File size={15} />;
}

function relativePath(path: string, root: string) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function fileSize(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
