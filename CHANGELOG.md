# Changelog

## 0.1.1 - 2026-07-23

First automated release of term-server.

### Added

- A secure browser terminal workspace with persistent PTYs, multi-pane layouts, directory-aware workspaces, file editing, process inspection, agent status, notifications, and an installable PWA.
- Signed self-updates for eligible Linux installations. Release manifests, checksums, archive size, target architecture, safe extraction paths, and the replacement binary identity are verified before installation.
- A private session broker that preserves active terminals and replay history while the HTTPS process updates and restarts.
- Session-scoped editable artifacts for handing multiline messages, prompts, snippets, and images between coding agents and the browser.
- Native PDF previews, byte-range streaming, and direct downloads for text, image, and PDF files.
- Mobile terminal scrollback, a terminal key strip, one-shot Ctrl and Alt modifiers, safe-area support, and live visual viewport sizing.
- Shared terminal sizing across connected devices, with smallest-client sizing by default and an optional focused-device controller.
- Embedded version and source commit details in the CLI, authenticated API, Settings, and status bar.

### Changed

- Mobile terminal gestures now scroll xterm history without moving the browser viewport.
- The internal session broker protocol is version 2 so terminal sizing and focus state pass through the broker consistently.

### Security

- Release manifests and checksum lists are authenticated with Ed25519 signatures from the repository release key.
- Update installation fails closed on missing or invalid signatures, unexpected platforms, size or checksum mismatches, unsafe archive entries, or mismatched binary identity.
- Update checks and installation remain authenticated, origin-checked operations.

### Upgrade notes

- There is no data migration.
- Existing `0.1.0` or earlier installations do not yet have the automatic updater. Rerun the installer to receive this release; eligible installations can use signed automatic updates afterward.
- Development builds using broker protocol 1 cannot hand active sessions to protocol 2. Stop the old term-server and its session broker before starting this release.
