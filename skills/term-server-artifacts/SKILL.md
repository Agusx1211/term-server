---
name: term-server-artifacts
description: Create session-scoped, filesystem-backed artifacts for editable handoffs. Use whenever output is meant to be copied or reused and spans multiple lines, including messages, review comments, prompts, configuration, commands, and prose, or when the user asks for an editable artifact. Do not use for ordinary source edits in the current workspace or for concise answers that are easier to read inline.
---

# Term Server Artifacts

Turn multiline handoff content into an editable temporary file instead of reproducing it in the response. Term Server discovers artifacts made inside its terminal sessions and shows them in the originating terminal's artifact sidebar, where the user can preview them inline or open a full editor. Other terminals can use the printed file URI or absolute path.

## Create an artifact

Resolve `scripts/create_artifact.py` relative to this `SKILL.md`, then run it with a short descriptive filename and the content on standard input:

```bash
python3 <absolute-skill-directory>/scripts/create_artifact.py --producer codex --name review-comment.md <<'ARTIFACT'
The multiline content goes here.
ARTIFACT
```

Use the file extension that best describes the content. Use `--from-file <path>` to import an existing text or image file without loading it into the command, or `--content <text>` when the execution tool can pass a multiline argument safely.

Pass the current agent name with `--producer` so Term Server can preserve the exact artifact origin even if the terminal later runs another agent.

The helper prints two values:

1. A complete `file://` URI.
2. The complete absolute filesystem path.

Include both returned values verbatim in the response, with a short label. Do not repeat the artifact body inline. Never shorten the path or construct it manually.

## Continue across turns

Retain the absolute path in conversation context. When the user says they edited the artifact, read that same path again before reviewing or revising it. Update the existing file when continuing the same handoff; create another artifact only when the user asks for a separate version.

Treat artifacts as temporary and potentially sensitive:

- Do not place secrets in an artifact unless the user explicitly requests it.
- Do not move an artifact into the project or commit it unless the user asks.
- Mention that `/tmp` content is ephemeral when persistence matters.
