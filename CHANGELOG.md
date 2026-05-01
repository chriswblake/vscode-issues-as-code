# Changelog

## [pending]

### Changed

- **Plugin architecture refactor**: Sync logic is now decoupled from specific services via a plugin system. Each remote service (GitHub Issues, GitHub Projects, TickTick) is implemented as an isolated plugin under `src/plugins/`.
- **New plugin types**: `PrimarySyncPlugin` (owns file body and creation — e.g. gh-issues) and `MetadataPlugin` (enriches frontmatter — e.g. gh-projects) replace the previous monolithic approach.
- **SyncManager is now generic**: No longer contains GitHub-specific logic. Delegates pull/push operations to the configured plugin. Conflict markers say "Remote" instead of "GitHub".
- **GitHubClient is repo-free**: Methods accept owner/repo as parameters, enabling cross-repository operations.
- **configManager cleaned up**: Plugin-specific types and query builders moved into their respective plugin files. Generic `SyncTarget` interface uses an index signature for plugin configs.
- **New file behavior**: New files created in sync target folders are no longer auto-pushed. A CodeLens "Publish" button appears instead, giving users explicit control.
- **Cross-repo safety**: File lookup uses full `owner/repo/number` keys to prevent collisions when multiple repositories share issue numbers.

### Added

- **Command: "Issues as Code: Add setting - My issues on GitHub"** — Adds a cross-repo sync target for ALL issues assigned to the authenticated user across GitHub.
- **Command: "Issues as Code: Add setting - My issues on this repository"** — Adds a sync target for the authenticated user's open issues on the detected workspace repository.
- **Command: "Issues as Code: Publish to Remote"** — Explicitly publishes a local file to the configured remote service.
- **CodeLens provider**: Shows a "▶ Publish to [service]" button on unpublished markdown files inside sync target folders.
- **Plugin files**: `src/plugins/ghIssuesPlugin.ts`, `src/plugins/ghProjectsPlugin.ts`, `src/plugins/tickTickPlugin.ts`, `src/plugins/syncPlugin.ts`.

### Removed

- `src/projectsSync.ts` — Replaced by `src/plugins/ghProjectsPlugin.ts`.
- `issueMatchesFilter` removed from `fileManager.ts` — Now lives in the gh-issues plugin as `matchesFilter`.
- `inferNewIssueTitle` removed from `syncManager.ts` — Now handled by `GhIssuesPlugin.inferTitle`.
- Dead `limit` config option removed from package.json schema.

## [0.1.0] - 2026-04-22

## [0.1.0] - 2026-04-22

### Added

- Initial release of Issues as Code
- Sync GitHub issues to local `.issues/` folder
- Automatic pull on startup and configurable interval
- Debounced push on file save
- Conflict detection with diff editor
- GitHub Projects v2 support
- Multi-root workspace support
- Date token resolution in sync filters (`{today-Nd}`)
- Auto-move files to correct folder after sync
- Create new GitHub issues from local `.md` files
