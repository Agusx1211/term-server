export interface FileLinkMatch {
  text: string;
  start: number;
  end: number;
}

interface HoverPreviewTarget {
  key: string;
}

interface HoverPreviewOptions<TTarget extends HoverPreviewTarget, TValue> {
  load: (target: TTarget) => Promise<TValue | undefined>;
  show: (value: TValue, target: TTarget) => void;
  hide: () => void;
}

const fileLinkCandidatePattern = /[^\s'"`<>()[\]{}=]+/g;
const localFileUriPattern = /^file:\/\/(?:localhost\/|\/).+/;
const uriPattern = /^[a-z][a-z0-9+.-]*:\/\//i;
const explicitFilePathPattern = /^(?:\/|~\/|\.\.?\/).+/;
const bareFilenamePattern = /^(?:\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|[^./][^/]*\.(?=[a-z0-9_-]*[a-z])[a-z0-9_-]+)$/i;
const trailingPunctuation = /[.,;:!?]+$/;

function looksLikeFileLink(text: string): boolean {
  if (localFileUriPattern.test(text)) return true;
  if (uriPattern.test(text) || text.startsWith("//")) return false;
  if (explicitFilePathPattern.test(text)) return true;
  return bareFilenamePattern.test(text.slice(text.lastIndexOf("/") + 1));
}

export function findFileLinks(line: string): FileLinkMatch[] {
  const matches: FileLinkMatch[] = [];
  for (const match of line.matchAll(fileLinkCandidatePattern)) {
    const raw = match[0];
    const text = raw.replace(trailingPunctuation, "");
    if (!looksLikeFileLink(text)) continue;
    const start = match.index ?? 0;
    matches.push({ text, start, end: start + text.length });
  }
  return matches;
}

export function imagePreviewPosition(clientX: number, clientY: number, width = 360, height = 280) {
  return {
    left: Math.max(8, Math.min(clientX + 14, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(clientY + 16, window.innerHeight - height - 8)),
  };
}

export function createHoverPreviewController<TTarget extends HoverPreviewTarget, TValue>(
  { load, show, hide }: HoverPreviewOptions<TTarget, TValue>,
) {
  let activeTarget: TTarget | undefined;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let request = 0;

  const clearActive = () => {
    const hadActiveTarget = activeTarget !== undefined;
    request += 1;
    if (hoverTimer !== undefined) clearTimeout(hoverTimer);
    hoverTimer = undefined;
    activeTarget = undefined;
    if (hadActiveTarget) hide();
  };

  const clear = () => {
    if (leaveTimer !== undefined) clearTimeout(leaveTimer);
    leaveTimer = undefined;
    clearActive();
  };

  return {
    hover(target: TTarget) {
      if (leaveTimer !== undefined) clearTimeout(leaveTimer);
      leaveTimer = undefined;
      if (activeTarget?.key === target.key) {
        activeTarget = target;
        return;
      }

      clearActive();
      activeTarget = target;
      const currentRequest = request;
      hoverTimer = setTimeout(() => {
        hoverTimer = undefined;
        void load(target).then((value) => {
          const currentTarget = activeTarget;
          if (currentRequest === request && currentTarget?.key === target.key && value !== undefined) {
            show(value, currentTarget);
          }
        }).catch(() => undefined);
      }, 180);
    },
    leave() {
      if (!activeTarget || leaveTimer !== undefined) return;
      leaveTimer = setTimeout(() => {
        leaveTimer = undefined;
        clearActive();
      });
    },
    clear,
  };
}
