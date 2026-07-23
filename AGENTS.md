# Development and release workflow

All regular pull requests must target `dev`. Do not open feature, fix, dependency, or maintenance pull requests directly against `main`, and do not push changes directly to `main`.

`main` is the release branch. The only pull request that should target `main` is a release pull request from `dev`. Merging `dev` into `main` triggers the release automation, which builds and signs the release artifacts and publishes the metadata consumed by the installer and automatic updater. Treat every `dev` → `main` merge as an immediate production release.

Before opening or merging a release pull request:

- Update `CHANGELOG.md` with a dated entry for the release. Summarize user-visible features, fixes, security changes, breaking changes, and any required upgrade or migration steps. Do not release with an empty or placeholder changelog entry.
- Bump the release version consistently in `Cargo.toml`, `Cargo.lock`, `package.json`, and `package-lock.json`.
- Make sure the release pull request contains only the changes intended for that release and clearly summarizes the changelog entry.
- Run `npm ci` and `npm run check`, and ensure all required CI checks pass.
- Confirm that the release is safe for automatic installation. Once merged, published artifacts may be offered to running term-server installations.

Do not manually create or move release tags, publish replacement artifacts, or edit release metadata as part of the normal flow; the release automation owns those steps. Manual intervention is reserved for an explicitly coordinated recovery.
