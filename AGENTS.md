# Development and release workflow

## Protect the term-server instance hosting your agent

Agents working in this repository are often running inside the production
term-server instance on the same machine. Never start a development or test
term-server with the default data directory. A second instance will connect to
the production session broker, and stopping that development process (including
with Ctrl-C) will shut down the shared broker and terminate the terminals
hosting this agent and other active work.

Always give every development or test server an isolated
`TERM_SERVER_DATA_DIR`, in addition to using a non-production port. For example:

```bash
TERM_SERVER_DATA_DIR="$(mktemp -d)" \
TERM_SERVER_PASSWORD=development \
  cargo run -- --no-https --host 0.0.0.0 --port 8100 --client-dir dist/client
```

Keep the temporary directory for as long as the development server is running.
Do not point development commands at `~/.local/share/term-server` or omit
`TERM_SERVER_DATA_DIR`.

All regular pull requests must target `dev`. Do not open feature, fix, dependency, or maintenance pull requests directly against `main`, and do not push changes directly to `main`.

`main` is the release branch. The only pull request that should target `main` is a release pull request from `dev`. Merging `dev` into `main` triggers the release automation, which builds and signs the release artifacts and publishes the metadata consumed by the installer and automatic updater. Treat every `dev` → `main` merge as an immediate production release.

Before opening or merging a release pull request:

- Update `CHANGELOG.md` with a dated entry for the release. Summarize user-visible features, fixes, security changes, breaking changes, and any required upgrade or migration steps. Do not release with an empty or placeholder changelog entry.
- Bump the release version consistently in `Cargo.toml`, `Cargo.lock`, `package.json`, and `package-lock.json`.
- Make sure the release pull request contains only the changes intended for that release and clearly summarizes the changelog entry.
- Run `npm ci` and `npm run check`, and ensure all required CI checks pass.
- Confirm that the release is safe for automatic installation. Once merged, published artifacts may be offered to running term-server installations.

Do not manually create or move release tags, publish replacement artifacts, or edit release metadata as part of the normal flow; the release automation owns those steps. Manual intervention is reserved for an explicitly coordinated recovery.
