import { FileCode2, Image, TerminalSquare, X } from "lucide-preact";

export interface ResourceTab {
  path: string;
  name: string;
  type: "text" | "image";
  mime: string;
  dirty: boolean;
}

interface ResourceTabBarProps {
  tabs: ResourceTab[];
  activePath?: string;
  onTerminal: () => void;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

export function ResourceTabBar({ tabs, activePath, onTerminal, onActivate, onClose }: ResourceTabBarProps) {
  return (
    <nav class="resource-tabbar" aria-label="Open resources">
      <button class={`resource-tab terminal ${activePath ? "" : "active"}`} onClick={onTerminal}>
        <TerminalSquare size={13} />
        <span>Terminals</span>
      </button>
      {tabs.map((tab) => {
        const Icon = tab.type === "image" ? Image : FileCode2;
        return (
          <button
            key={tab.path}
            class={`resource-tab ${activePath === tab.path ? "active" : ""}`}
            onClick={() => onActivate(tab.path)}
            onAuxClick={(event) => {
              if (event.button === 1) onClose(tab.path);
            }}
            title={tab.path}
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
