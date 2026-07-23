import { FileCode2, FileText, Image, PackageOpen, Settings, TerminalSquare, X } from "lucide-preact";
import type { ResourceTab } from "../lib/resources";

interface ResourceTabBarProps {
  tabs: ResourceTab[];
  activePath?: string;
  settingsOpen: boolean;
  settingsActive: boolean;
  onTerminal: () => void;
  onSettings: () => void;
  onCloseSettings: () => void;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

export function ResourceTabBar({
  tabs,
  activePath,
  settingsOpen,
  settingsActive,
  onTerminal,
  onSettings,
  onCloseSettings,
  onActivate,
  onClose,
}: ResourceTabBarProps) {
  return (
    <nav class="resource-tabbar" aria-label="Open resources">
      <button class={`resource-tab terminal ${activePath || settingsActive ? "" : "active"}`} onClick={onTerminal}>
        <TerminalSquare size={13} />
        <span>Terminals</span>
      </button>
      {settingsOpen && (
        <button
          class={`resource-tab settings ${settingsActive ? "active" : ""}`}
          onClick={onSettings}
          onAuxClick={(event) => {
            if (event.button === 1) onCloseSettings();
          }}
        >
          <Settings size={13} />
          <span>Settings</span>
          <span
            class="resource-tab-close"
            role="button"
            aria-label="Close Settings"
            onClick={(event) => {
              event.stopPropagation();
              onCloseSettings();
            }}
          >
            <X size={12} />
          </span>
        </button>
      )}
      {tabs.map((tab) => {
        const Icon = tab.artifact
          ? PackageOpen
          : tab.type === "image"
            ? Image
            : tab.type === "pdf"
              ? FileText
              : FileCode2;
        return (
          <button
            key={tab.path}
            class={`resource-tab ${tab.artifact ? "artifact" : ""} ${activePath === tab.path ? "active" : ""}`}
            onClick={() => onActivate(tab.path)}
            onAuxClick={(event) => {
              if (event.button === 1) onClose(tab.path);
            }}
            title={tab.artifact
              ? `Artifact from ${tab.artifact.agentKind ? `${tab.artifact.agentKind} · ` : ""}${tab.artifact.terminalName}\n${tab.path}`
              : tab.path}
          >
            <Icon size={13} />
            <span>{tab.name}</span>
            {tab.dirty && <i class="resource-dirty" aria-label="Unsaved changes" />}
            <span
              class="resource-tab-close"
              role="button"
              aria-label={`Close ${tab.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.path);
              }}
            >
              <X size={12} />
            </span>
          </button>
        );
      })}
    </nav>
  );
}
