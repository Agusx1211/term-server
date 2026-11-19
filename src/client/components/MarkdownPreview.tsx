import MarkdownIt from "markdown-it";
import { BookOpen, Check, Copy, MessageSquareText, RefreshCw, SquareTerminal, X } from "lucide-preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FileDocument } from "../../shared/types";
import { api, ApiError, type MarkdownReview, type MarkdownComment } from "../lib/api";
import {
  commentCountLabel,
  locatePassage,
  parseMarkdownView,
  passageProblemMessage,
  placeRailEntries,
  type MarkdownView,
  type PassageLocation,
} from "../lib/markdown-review";

// Local documents are untrusted. Keep raw HTML escaped and render image
// descriptions as text without requesting remote or local resources.
const renderer = new MarkdownIt({ html: false });
renderer.renderer.rules.image = (tokens, index) => renderer.utils.escapeHtml(tokens[index]?.content ?? "");
renderer.renderer.rules.link_open = (tokens, index) => {
  const href = String(tokens[index]?.attrGet("href") ?? "");
  if (!/^https?:\/\//i.test(href)) return "<a>";
  return `<a href="${renderer.utils.escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`;
};
// Wide tables scroll inside their own frame instead of squeezing the page.
// The wrapper adds no text, so stored comment offsets stay valid.
renderer.renderer.rules.table_open = (tokens, index, options) =>
  `<div class="md-table">${renderer.renderer.renderToken(tokens, index, options)}`;
renderer.renderer.rules.table_close = (tokens, index, options) =>
  renderer.renderer.renderToken(tokens, index, options).replace("</table>", "</table></div>");

const VIEW_STORAGE_KEY = "term-server:markdown-view";
const WIDE_LAYOUT_MIN_WIDTH = 880;
const OUTLINE_MIN_WIDTH = 1640;
const OUTLINE_MIN_HEADINGS = 3;
const RAIL_GAP = 12;
const MAX_FIELD_BYTES = 8192;
const encoder = new TextEncoder();

function storedView(): MarkdownView {
  try {
    return parseMarkdownView(localStorage.getItem(VIEW_STORAGE_KEY));
  } catch {
    return "review";
  }
}

function renderedText(html: string): string {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html").body.textContent ?? "";
}

interface TextIndex {
  nodes: Text[];
  ends: number[];
}

function indexText(root: Node): TextIndex {
  const nodes: Text[] = [];
  const ends: number[] = [];
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    total += node.textContent?.length ?? 0;
    nodes.push(node as Text);
    ends.push(total);
  }
  return { nodes, ends };
}

/** Index of the first text node whose end is at or after `target`. */
function firstEndingAtOrAfter(index: TextIndex, target: number): number {
  let low = 0;
  let high = index.ends.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (index.ends[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low < index.ends.length ? low : -1;
}

function rangeAt(index: TextIndex, start: number, length: number): Range | undefined {
  const first = firstEndingAtOrAfter(index, start + 1);
  const last = firstEndingAtOrAfter(index, start + length);
  if (first < 0 || last < 0 || length <= 0) return undefined;
  const firstNode = index.nodes[first]!;
  const lastNode = index.nodes[last]!;
  const range = document.createRange();
  range.setStart(firstNode, start - (index.ends[first]! - firstNode.length));
  range.setEnd(lastNode, start + length - (index.ends[last]! - lastNode.length));
  return range;
}

function textOffset(index: TextIndex, node: Node, offset: number): number | undefined {
  const position = index.nodes.indexOf(node as Text);
  return position < 0 ? undefined : index.ends[position]! - (node as Text).length + offset;
}

// Highlight names are global, so every open preview contributes its ranges to
// one shared set per kind.
type HighlightKind = "comments" | "focus" | "draft";
type HighlightSets = Record<HighlightKind, Range[]>;
const highlightOwners = new Map<object, HighlightSets>();
const highlightPriority: Record<HighlightKind, number> = { comments: 0, focus: 1, draft: 2 };

function publishHighlights() {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight !== "function") return;
  for (const kind of Object.keys(highlightPriority) as HighlightKind[]) {
    const ranges = [...highlightOwners.values()].flatMap((sets) => sets[kind]);
    const name = `markdown-${kind}`;
    if (!ranges.length) {
      CSS.highlights.delete(name);
      continue;
    }
    const highlight = new Highlight(...ranges);
    highlight.priority = highlightPriority[kind];
    CSS.highlights.set(name, highlight);
  }
}

function setHighlights(owner: object, sets: HighlightSets | undefined) {
  if (sets) highlightOwners.set(owner, sets);
  else if (!highlightOwners.delete(owner)) return;
  publishHighlights();
}

const shortcutLabel = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
  ? "⌘ Enter to post"
  : "Ctrl+Enter to post";

interface PlacedComment {
  comment: MarkdownComment;
  index: number;
  location: PassageLocation;
}

interface MarkdownPreviewProps {
  visible: boolean;
  file: FileDocument;
  content: string;
  dirty: boolean;
  reloadSource: () => void;
  reviewTarget?: string;
  onPasteReview: (path: string) => void;
}

export function MarkdownPreview({ visible, file, content, dirty, reloadSource, reviewTarget, onPasteReview }: MarkdownPreviewProps) {
  const root = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const highlightOwner = useRef({});
  const programmaticSelection = useRef<string>();
  const sizeObserver = useRef<ResizeObserver>();
  const layoutFrame = useRef(0);
  const [view, setView] = useState<MarkdownView>(storedView);
  const [wide, setWide] = useState(false);
  const [roomy, setRoomy] = useState(false);
  const [outline, setOutline] = useState<Array<{ level: number; text: string }>>([]);
  const [section, setSection] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [quote, setQuote] = useState("");
  const [offset, setOffset] = useState(0);
  const pendingId = useRef<string>();
  const [quoteVersion, setQuoteVersion] = useState("");
  const [body, setBody] = useState("");
  const [review, setReview] = useState<MarkdownReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [activeId, setActiveId] = useState<string>();
  const [hoverId, setHoverId] = useState<string>();
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => renderer.render(content), [content]);
  const text = useMemo(() => renderedText(html), [html]);
  const reviewing = view === "review";

  const comments = review?.comments ?? [];
  const placed = useMemo<PlacedComment[]>(() => comments
    .map((comment, index) => ({ comment, index, location: locatePassage(comment, text, file.version, dirty) }))
    .sort((left, right) => (
      ("start" in left.location ? left.location.start : -1) - ("start" in right.location ? right.location.start : -1)
      || left.index - right.index
    )), [comments, text, file.version, dirty]);
  const draftLocation = quote ? locatePassage({ offset, version: quoteVersion, quote }, text, file.version, dirty) : undefined;
  const stale = Boolean(quote) && quoteVersion !== file.version;
  const tooLong = encoder.encode(quote).length > MAX_FIELD_BYTES || encoder.encode(body).length > MAX_FIELD_BYTES;
  const canPost = !busy && !dirty && !stale && !tooLong && Boolean(quote) && Boolean(body.trim());

  // Fresh values for document-level listeners registered once per visibility.
  const live = useRef({ view, version: file.version, quote, body, canPost });
  live.current = { view, version: file.version, quote, body, canPost };

  useEffect(() => {
    let current = true;
    void api.markdownReview(file.path).then((result) => {
      if (current) { setReview(result); setError(""); }
    }).catch((reason) => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [file.path, refresh]);

  const clearDraft = () => {
    setQuote("");
    setBody("");
    setQuoteVersion("");
    pendingId.current = undefined;
  };

  const captureSelection = (fromUser: boolean) => {
    const container = article.current;
    const selection = window.getSelection();
    if (!container || !selection || live.current.view !== "review") return;
    if (selection.isCollapsed || !selection.rangeCount) return;
    if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0);
    const selected = range.toString();
    if (!selected.trim()) return;
    const before = range.cloneRange();
    before.selectNodeContents(container);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const signature = `${start}\u0000${selected}`;
    // Showing a passage selects it; that alone must not retarget the draft.
    if (!fromUser && programmaticSelection.current === signature) return;
    programmaticSelection.current = undefined;
    setOffset(start);
    setQuote(selected);
    setQuoteVersion(live.current.version);
    setActiveId(undefined);
    pendingId.current = undefined;
  };

  useEffect(() => {
    if (!visible) return;
    const onSelectionChange = () => captureSelection(false);
    // With a fresh selection, typing starts the comment.
    const onKeyDown = (event: KeyboardEvent) => {
      const field = input.current;
      const { quote: selected, body: draft, view: current } = live.current;
      if (!field || !selected || draft || current !== "review" || event.defaultPrevented) return;
      if (!root.current?.getClientRects().length) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, a, [contenteditable]")) return;
      if (!root.current?.contains(target) && target !== document.body) return;
      if (event.key === "Enter") {
        event.preventDefault();
        field.focus();
      } else if (event.key.length === 1 && event.key !== " ") {
        field.focus();
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [visible]);

  const onArticlePointerUp = () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      captureSelection(true);
      return;
    }
    if (!reviewing || !article.current || !selection?.anchorNode) return;
    // A plain click opens the comment under it and puts away an empty draft.
    const position = textOffset(indexText(article.current), selection.anchorNode, selection.anchorOffset);
    const hit = position === undefined ? undefined : [...placed].reverse().find(({ comment, location }) => (
      "start" in location && position >= location.start && position < location.start + comment.quote.length
    ));
    setActiveId(hit?.comment.id);
    if (hit && !wide) setDrawerOpen(true);
    if (quote && !body.trim()) clearDraft();
  };

  const scrollToPassage = (range: Range) => {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  };

  const passageRange = (comment: MarkdownComment): Range | string => {
    const container = article.current;
    if (!container) return passageProblemMessage.preview;
    const location = locatePassage(comment, container.textContent ?? "", file.version, dirty);
    if ("problem" in location) return passageProblemMessage[location.problem];
    const range = rangeAt(indexText(container), location.start, comment.quote.length);
    return range && range.toString() === comment.quote ? range : passageProblemMessage.preview;
  };

  const showPassage = (comment: MarkdownComment) => {
    setActiveId(comment.id);
    const range = passageRange(comment);
    if (typeof range === "string") {
      setError(range);
      return;
    }
    setError("");
    const before = document.createRange();
    before.selectNodeContents(article.current!);
    before.setEnd(range.startContainer, range.startOffset);
    programmaticSelection.current = `${before.toString().length}\u0000${comment.quote}`;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!wide) setDrawerOpen(false);
    scrollToPassage(range);
  };

  const activate = (comment: MarkdownComment) => {
    setActiveId(comment.id);
    const range = passageRange(comment);
    const frame = scroller.current?.getBoundingClientRect();
    if (typeof range === "string" || !frame) return;
    const rect = range.getBoundingClientRect();
    if (rect.top < frame.top || rect.bottom > frame.bottom) scrollToPassage(range);
  };

  const post = async () => {
    setBusy(true);
    try {
      const id = pendingId.current ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("");
      pendingId.current = id;
      setReview(await api.addMarkdownComment(file.path, { id, offset, version: quoteVersion, quote, body: body.trim() }));
      clearDraft();
      setActiveId(id);
      setError("");
      const selection = window.getSelection();
      if (selection?.anchorNode && article.current?.contains(selection.anchorNode)) selection.removeAllRanges();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        reloadSource();
        setQuoteVersion("");
      } else {
        setError(String(reason));
      }
    }
    finally { setBusy(false); }
  };

  const chooseView = (next: MarkdownView) => {
    setView(next);
    setDrawerOpen(false);
    setHoverId(undefined);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // The choice still applies for this session.
    }
  };

  const copyReviewPath = () => {
    if (!review) return;
    if (!navigator.clipboard) {
      setError("Select the review path to copy it.");
      return;
    }
    void navigator.clipboard.writeText(review.path).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => setError("Clipboard access was denied"));
  };

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width <= 0) return;
      setWide(width >= WIDE_LAYOUT_MIN_WIDTH);
      setRoomy(width >= OUTLINE_MIN_WIDTH);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Place highlights and stack the comment rail beside the passages.
  const layout = useRef<() => void>(() => undefined);
  layout.current = () => {
    const container = article.current;
    const rail = track.current;
    if (!visible || !reviewing || !container) {
      setHighlights(highlightOwner.current, undefined);
      root.current?.style.removeProperty("--md-sheet");
      return;
    }
    const index = indexText(container);
    const railTop = rail?.getBoundingClientRect().top ?? 0;
    const desired = new Map<string, number>();
    const sets: HighlightSets = { comments: [], focus: [], draft: [] };
    const anchor = (key: string, start: number, passage: string, kind: HighlightKind) => {
      const range = rangeAt(index, start, passage.length);
      if (!range || range.toString() !== passage) return;
      sets[kind].push(range);
      if (key === activeId || key === hoverId) sets.focus.push(range);
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      desired.set(key, rect.top - railTop - 6);
    };
    for (const { comment, location } of placed) {
      if ("start" in location) anchor(comment.id, location.start, comment.quote, "comments");
    }
    if (draftLocation && "start" in draftLocation) anchor("draft", draftLocation.start, quote, "draft");
    setHighlights(highlightOwner.current, sets);

    if (!rail) return;
    const items = Array.from(rail.children) as HTMLElement[];
    sizeObserver.current?.observe(container);
    for (const item of items) sizeObserver.current?.observe(item);
    const sheet = rail.parentElement;
    if (!wide) {
      // Leave room to scroll the page's end above the comment sheet.
      rail.style.height = "";
      for (const item of items) item.style.top = "";
      if (sheet) sizeObserver.current?.observe(sheet);
      root.current?.style.setProperty("--md-sheet", `${sheet?.offsetHeight ?? 0}px`);
      return;
    }
    root.current?.style.removeProperty("--md-sheet");
    const entries = items.map((item) => ({
      key: item.dataset.key ?? "",
      desired: desired.get(item.dataset.key ?? "") ?? 0,
      height: item.offsetHeight,
    }));
    const tops = placeRailEntries(entries, quote ? "draft" : activeId, RAIL_GAP);
    let bottom = 0;
    for (const item of items) {
      const top = tops.get(item.dataset.key ?? "") ?? 0;
      item.style.top = `${top}px`;
      bottom = Math.max(bottom, top + item.offsetHeight);
    }
    rail.style.height = `${bottom}px`;
  };

  useEffect(() => {
    const schedule = () => {
      if (layoutFrame.current) return;
      layoutFrame.current = requestAnimationFrame(() => {
        layoutFrame.current = 0;
        layout.current();
      });
    };
    sizeObserver.current = new ResizeObserver(schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      sizeObserver.current?.disconnect();
      cancelAnimationFrame(layoutFrame.current);
      setHighlights(highlightOwner.current, undefined);
    };
  }, []);

  useLayoutEffect(() => layout.current(), [
    html, placed, quote, offset, quoteVersion, activeId, hoverId, wide, view, visible, drawerOpen, dirty, file.version,
  ]);

  // Long documents get an outline when the pane has room beside the page.
  const headings = () => Array.from(article.current?.querySelectorAll<HTMLElement>("h1, h2, h3") ?? []);
  useLayoutEffect(() => {
    const next = headings().map((heading) => ({ level: Number(heading.tagName.slice(1)), text: heading.textContent?.trim() ?? "" }));
    setOutline((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }, [html]);
  const showOutline = roomy && outline.length >= OUTLINE_MIN_HEADINGS;

  useEffect(() => {
    const element = scroller.current;
    if (!element || !visible || !showOutline) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const limit = element.getBoundingClientRect().top + 96;
      let current = 0;
      headings().forEach((heading, index) => {
        if (heading.getBoundingClientRect().top <= limit) current = index;
      });
      setSection(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [visible, showOutline, outline]);

  const goToHeading = (index: number) => {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    headings()[index]?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  };

  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight + 2, 280)}px`;
  }, [body, quote, view, wide]);

  const countLabel = commentCountLabel(comments.length);
  const railClass = [
    "md-rail",
    drawerOpen ? "open" : "",
    quote ? "drafting" : "",
  ].filter(Boolean).join(" ");

  return <div
    ref={root}
    class={`markdown-preview ${wide ? "wide" : "narrow"} view-${view} ${showOutline ? "with-outline" : ""}`}
    hidden={!visible}
  >
    <div class="md-toolbar">
      <div class="md-views" role="group" aria-label="Document view">
        <button class={reviewing ? "active" : ""} aria-pressed={reviewing} onClick={() => chooseView("review")}>
          <MessageSquareText size={13} aria-hidden="true" />
          <span>Review</span>
        </button>
        <button class={reviewing ? "" : "active"} aria-pressed={!reviewing} onClick={() => chooseView("read")}>
          <BookOpen size={13} aria-hidden="true" />
          <span>Read</span>
        </button>
      </div>
      {reviewing && wide && <span class="md-count">{countLabel}</span>}
      {reviewing && !wide && <button class="md-count" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(!drawerOpen)}>
        {countLabel}
      </button>}
      {!reviewing && comments.length > 0 && <button class="md-count" onClick={() => chooseView("review")}>
        {countLabel}
      </button>}
      <span class="md-toolbar-spacer" />
      {reviewing && review && comments.length > 0 && <>
        <button class="md-tool" onClick={copyReviewPath} title={review.path}>
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span class="md-tool-label">{copied ? "Copied" : "Copy review path"}</span>
        </button>
        {reviewTarget && <button class="md-tool" onClick={() => onPasteReview(review.path)} title={review.path}>
          <SquareTerminal size={13} aria-hidden="true" />
          <span class="md-tool-label">Paste path in {reviewTarget}</span>
        </button>}
      </>}
      <button
        class="md-tool md-icon"
        aria-label="Refresh review"
        title="Reload the document and its comments"
        disabled={busy}
        onClick={() => { reloadSource(); setRefresh(refresh + 1); }}
      >
        <RefreshCw size={13} aria-hidden="true" />
      </button>
    </div>
    {reviewing && dirty && <p class="md-notice" role="status">
      Previewing unsaved edits. Save your edits before adding a comment.
    </p>}
    {error && <div class="md-notice md-error">
      <p role="alert">{error}</p>
      <button class="md-notice-dismiss" aria-label="Dismiss message" onClick={() => setError("")}>
        <X size={13} aria-hidden="true" />
      </button>
    </div>}
    <div class="md-scroller" ref={scroller}>
      <div class="md-layout">
        {showOutline && <nav class="md-outline" aria-label="Document outline">
          <p>Contents</p>
          <ol>
            {outline.map((entry, index) => <li key={index} class={`level-${entry.level}`}>
              <button aria-current={index === section ? "location" : undefined} onClick={() => goToHeading(index)}>
                {entry.text}
              </button>
            </li>)}
          </ol>
        </nav>}
        <article
          ref={article}
          class="md-page"
          onPointerUp={onArticlePointerUp}
          onKeyUp={() => captureSelection(true)}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {reviewing && <section class={railClass} aria-label="Markdown comments">
          {!wide && <header class="md-rail-header">
            <strong>{countLabel}</strong>
            <button class="md-tool md-icon" aria-label="Close comments" onClick={() => setDrawerOpen(false)}>
              <X size={15} aria-hidden="true" />
            </button>
          </header>}
          <div class="md-track" ref={track}>
            {quote && <div class="md-composer" data-key="draft">
              <p class="md-quote" title={quote}>{quote}</p>
              <textarea
                ref={input}
                aria-label="Comment"
                placeholder="Add a comment"
                rows={2}
                value={body}
                maxLength={MAX_FIELD_BYTES}
                onInput={(event) => { pendingId.current = undefined; setBody(event.currentTarget.value); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    if (canPost) void post();
                  } else if (event.key === "Escape" && !body.trim()) {
                    event.preventDefault();
                    clearDraft();
                  }
                }}
              />
              {stale && <p class="md-note">The document changed. Select the passage again to post your comment.</p>}
              {tooLong && <p class="md-note">Comments and passages are limited to 8 KB. Select a shorter passage or trim the comment.</p>}
              <div class="md-composer-actions">
                <span class="md-hint">{shortcutLabel}</span>
                <button class="md-button" onClick={clearDraft}>{body.trim() ? "Discard" : "Cancel"}</button>
                <button class="md-button primary" disabled={!canPost} onClick={() => void post()}>Add comment</button>
              </div>
            </div>}
            {!quote && comments.length === 0 && <p class="md-rail-hint" data-key="hint">
              Select a passage to comment on it.
            </p>}
            {placed.map(({ comment, location }) => {
              const earlier = comment.version !== file.version || dirty;
              const classes = [
                "markdown-comment",
                "md-card",
                comment.id === activeId ? "active" : "",
                "problem" in location ? "detached" : "",
              ].filter(Boolean).join(" ");
              return <div
                key={comment.id}
                data-key={comment.id}
                class={classes}
                onClick={(event) => {
                  if (!(event.target as HTMLElement).closest("button")) activate(comment);
                }}
                onMouseEnter={() => setHoverId(comment.id)}
                onMouseLeave={() => setHoverId((current) => current === comment.id ? undefined : current)}
              >
                <p class="md-quote" title={comment.quote}>{comment.quote}</p>
                <p class="md-card-body">{comment.body}</p>
                <div class="md-card-meta">
                  {earlier && <span class="md-badge">From an earlier revision</span>}
                  {"problem" in location && <span class="md-badge md-badge-warn">Passage not found</span>}
                  <button class="md-link" onClick={() => showPassage(comment)}>Show passage</button>
                </div>
              </div>;
            })}
          </div>
          {review && comments.length > 0 && <p class="md-rail-footer">
            Review file <code title={review.path}>{review.path}</code>
          </p>}
        </section>}
      </div>
    </div>
  </div>;
}
