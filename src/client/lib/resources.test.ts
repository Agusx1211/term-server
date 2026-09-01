import { describe, expect, it } from "vitest";
import {
  resourceRevision,
  shouldReloadResource,
  type ResourceRevisionsHeld,
  type ResourceTab,
} from "./resources";

const tab = (overrides: Partial<ResourceTab> = {}): ResourceTab => ({
  path: "/workspace/notes.md",
  name: "notes.md",
  type: "text",
  mime: "text/markdown",
  modifiedAt: 1_000,
  dirty: false,
  ...overrides,
});

const held = (overrides: Partial<ResourceRevisionsHeld> = {}): ResourceRevisionsHeld => ({
  loaded: "",
  saved: "",
  ...overrides,
});

describe("resource reloads", () => {
  it("loads a document that has never been fetched", () => {
    expect(shouldReloadResource(tab(), held())).toBe(true);
  });

  it("does not reload the revision already in the buffer", () => {
    const open = tab();
    expect(shouldReloadResource(open, held({ loaded: resourceRevision(open) }))).toBe(false);
  });

  it("does not reload after saving, when dirty flips back to false", () => {
    // `save()` marks the tab clean, which re-runs the reload effect with the
    // same revision. Refetching there used to swap the editor host out of the
    // DOM and leave the pane blank.
    const open = tab({ dirty: true });
    const revisions = held({ loaded: resourceRevision(open) });
    expect(shouldReloadResource(open, revisions)).toBe(false);
    expect(shouldReloadResource({ ...open, dirty: false }, revisions)).toBe(false);
  });

  it("does not reload when the artifact poll reports the save we just made", () => {
    const open = tab();
    const saved = resourceRevision({ path: open.path, modifiedAt: 2_000 });
    expect(shouldReloadResource({ ...open, modifiedAt: 2_000 }, held({
      loaded: resourceRevision(open),
      saved,
    }))).toBe(false);
  });

  it("reloads an external rewrite of a clean document", () => {
    const open = tab();
    expect(shouldReloadResource({ ...open, modifiedAt: 3_000 }, held({
      loaded: resourceRevision(open),
      saved: resourceRevision({ path: open.path, modifiedAt: 2_000 }),
    }))).toBe(true);
  });

  it("keeps unsaved edits when the file is rewritten on disk", () => {
    const open = tab({ dirty: true });
    expect(shouldReloadResource({ ...open, modifiedAt: 3_000 }, held({
      loaded: resourceRevision(open),
    }))).toBe(false);
  });

  it("separates revisions of different paths", () => {
    expect(resourceRevision(tab())).not.toBe(resourceRevision(tab({ path: "/other.md" })));
  });
});
