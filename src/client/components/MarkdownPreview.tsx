import MarkdownIt from "markdown-it";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FileDocument } from "../../shared/types";
import { api, ApiError, type MarkdownReview, type MarkdownComment } from "../lib/api";

// Local documents are untrusted. Keep raw HTML escaped and render image
// descriptions as text without requesting remote or local resources.
const renderer = new MarkdownIt({ html: false });
renderer.renderer.rules.image = (tokens, index) => renderer.utils.escapeHtml(tokens[index]?.content ?? "");
renderer.renderer.rules.link_open = (tokens, index) => {
  const href = String(tokens[index]?.attrGet("href") ?? "");
  if (!/^https?:\/\//i.test(href)) return "<a>";
  return `<a href="${renderer.utils.escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`;
};

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
  const article = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [quote, setQuote] = useState("");
  const [offset, setOffset] = useState(0);
  const pendingId = useRef<string>();
  const [quoteVersion, setQuoteVersion] = useState("");
  const [body, setBody] = useState("");
  const [review, setReview] = useState<MarkdownReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const html = useMemo(() => renderer.render(content), [content]);

  useEffect(() => {
    let current = true;
    void api.markdownReview(file.path).then((result) => {
      if (current) { setReview(result); setError(""); }
    }).catch((reason) => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [file.path, refresh]);

  const captureSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !article.current?.contains(selection.anchorNode)
      || !article.current.contains(selection.focusNode)) return;
    const text = selection.rangeCount ? selection.getRangeAt(0).toString() : "";
    if (text.trim() && selection.rangeCount) {
      const before = selection.getRangeAt(0).cloneRange();
      before.selectNodeContents(article.current);
      const range = selection.getRangeAt(0);
      before.setEnd(range.startContainer, range.startOffset);
      setOffset(before.toString().length);
      setQuote(text);
      setQuoteVersion(file.version);
      pendingId.current = undefined;
    }
  };

  useEffect(() => {
    if (!visible) return;
    document.addEventListener("selectionchange", captureSelection);
    return () => document.removeEventListener("selectionchange", captureSelection);
  }, [visible, file.version]);

  const showPassage = (comment: MarkdownComment) => {
    const root = article.current;
    if (!root) return;
    let start = comment.offset;
    if (comment.version !== file.version || dirty) {
      const text = root.textContent ?? "";
      start = text.indexOf(comment.quote);
      if (start < 0 || text.indexOf(comment.quote, start + 1) >= 0) {
        setError("This passage changed or appears more than once in the current revision.");
        return;
      }
    }
    const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0;
    let started = false;
    for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
      const end = offset + (node.textContent?.length ?? 0);
      if (!started && start < end) {
        range.setStart(node, start - offset);
        started = true;
      }
      const target = start + comment.quote.length;
      if (started && target <= end) {
        range.setEnd(node, target - offset);
        if (range.toString() === comment.quote) {
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          range.startContainer.parentElement?.scrollIntoView({ block: "center" });
          return;
        }
        break;
      }
      offset = end;
    }
    setError("The quoted passage could not be located in this preview.");
  };

  const post = async () => {
    setBusy(true);
    try {
      const id = pendingId.current ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("");
      pendingId.current = id;
      setReview(await api.addMarkdownComment(file.path, { id, offset, version: quoteVersion, quote, body: body.trim() }));
      pendingId.current = undefined;
      setQuote("");
      setBody("");
      setError("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        reloadSource();
        setQuoteVersion("");
        setError("The document changed. Select the passage again to post your comment.");
      } else {
        setError(String(reason));
      }
    }
    finally { setBusy(false); }
  };

  return <div class="markdown-preview" hidden={!visible}>
    {quote && <button class="markdown-jump" onClick={() => input.current?.focus()}>Comment on selection</button>}
    <article ref={article} onPointerUp={captureSelection} onKeyUp={captureSelection}
      dangerouslySetInnerHTML={{ __html: html }} />
    <section aria-label="Markdown comments">
      <h3>Comments</h3>
      <button onClick={() => { reloadSource(); setRefresh(refresh + 1); }} disabled={busy}>Refresh review</button>
      {review?.comments.map((comment) => <div key={comment.id} class="markdown-comment">
        <blockquote>{comment.quote}</blockquote>
        {(comment.version !== file.version || dirty) && <small>From an earlier revision</small>}
        <button onClick={() => showPassage(comment)}>Show passage</button>
        <p>{comment.body}</p>
      </div>)}
      {quote ? <blockquote>{quote}</blockquote> : <p>Select text in the preview to comment.</p>}
      <textarea ref={input} aria-label="Comment" value={body} maxLength={8192}
        onInput={(event) => { pendingId.current = undefined; setBody(event.currentTarget.value); }} />
      {quote && quoteVersion !== file.version && <p>The document changed. Select the passage again.</p>}
      {dirty && <p>Save your edits before adding a comment.</p>}
      <button disabled={busy || dirty || quoteVersion !== file.version || !quote || !body.trim()} onClick={() => void post()}>Add comment</button>
      {error && <p role="alert">{error}</p>}
      {review && review.comments.length > 0 && <p>Share this review file with your terminal collaborator<br />
        <code>{review.path}</code> <button onClick={() => {
          if (navigator.clipboard) {
            void navigator.clipboard.writeText(review.path).catch(() => setError("Clipboard access was denied"));
          } else {
            setError("Select the review path to copy it.");
          }
        }}>Copy review path</button>
        {reviewTarget && <button onClick={() => onPasteReview(review.path)}>Paste path in {reviewTarget}</button>}</p>}
    </section>
  </div>;
}
