import { useEffect, useMemo, useState } from "preact/hooks";
import {
  ChevronDown,
  ChevronRight,
  ListTree,
  Radio,
  TerminalSquare,
  X,
} from "lucide-preact";
import type { ProcessRecord } from "../../shared/types";
import { api } from "../lib/api";
import { buildProcessTree, type ProcessTreeItem } from "../lib/process-inspector";

interface ProcessInspectorProps {
  terminalId: string;
  onClose: () => void;
}

export function ProcessInspector({ terminalId, onClose }: ProcessInspectorProps) {
  const [processes, setProcesses] = useState<ProcessRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const processTree = useMemo(() => buildProcessTree(processes), [processes]);

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    setProcesses([]);
    setLoading(true);
    setError("");

    const refresh = async () => {
      try {
        const snapshot = await api.terminalProcesses(terminalId);
        if (disposed) return;
        setProcesses(snapshot.processes);
        setError(snapshot.supported ? "" : "Process inspection is available on Linux hosts.");
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : "Unable to load processes");
      } finally {
        if (!disposed) {
          setLoading(false);
          timer = window.setTimeout(refresh, 1500);
        }
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [terminalId]);

  return (
    <aside class="process-inspector" aria-label="Terminal process inspector" onPointerDown={(event) => event.stopPropagation()}>
      <header class="process-inspector-header">
        <span class="process-inspector-title"><ListTree size={15} /> Processes</span>
        <span class="process-live-label"><Radio size={10} /> live</span>
        <button class="pane-action" onClick={onClose} aria-label="Close process inspector" title="Close process inspector">
          <X size={15} />
        </button>
      </header>
      <div class="process-inspector-note">
        Live descendants from the host process table. Command input and output are not captured.
      </div>
      <div class="process-inspector-scroll">
        {error && <div class="process-inspector-error">{error}</div>}
        <section class="process-section">
          <div class="process-section-heading">
            <span>Now</span><span>{processes.length}</span>
          </div>
          {loading && !processTree.length ? (
            <div class="process-empty">Reading the process tree…</div>
          ) : processTree.length ? (
            <div class="process-tree">
              {processTree.map((item) => (
                <ProcessTreeRow
                  key={item.process.id}
                  item={item}
                  depth={0}
                />
              ))}
            </div>
          ) : (
            <div class="process-empty">No running processes observed.</div>
          )}
        </section>
      </div>
    </aside>
  );
}

function ProcessTreeRow({
  item,
  depth,
}: {
  item: ProcessTreeItem;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <>
      <div class="process-tree-line">
        {item.children.length ? (
          <button class="process-expand" onClick={() => setExpanded((current) => !current)} aria-label={expanded ? "Collapse children" : "Expand children"}>
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : <span class="process-expand-placeholder" />}
        <ProcessRow
          process={item.process}
          depth={depth}
        />
      </div>
      {expanded && item.children.map((child) => (
        <ProcessTreeRow
          key={child.process.id}
          item={child}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

function ProcessRow({
  process,
  depth,
}: {
  process: ProcessRecord;
  depth: number;
}) {
  const commandLine = process.arguments.length ? process.arguments.join(" ") : process.command;
  return (
    <div
      class="process-row"
      style={{ "--process-depth": depth }}
      title={`${commandLine}${process.cwd ? `\n${process.cwd}` : ""}`}
    >
      <span class={`process-state ${process.foreground ? "foreground" : ""}`}>
        <TerminalSquare size={13} />
      </span>
      <span class="process-copy">
        <span class="process-command">{process.command}</span>
        <span class="process-commandline">{commandLine}</span>
      </span>
      <span class="process-pid">{process.pid}</span>
      {process.foreground && <span class="process-foreground">FG</span>}
    </div>
  );
}
