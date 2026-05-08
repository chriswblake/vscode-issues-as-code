# Changelog

## [pending]

### Added

- **`issuesAsCode.keepGitIgnoreUpdated` setting**: Boolean (default: `true`). Automatically adds sync target folders to `.gitignore`. The sync state file is always gitignored regardless of this setting.
- **Configuration reference docs**: Full settings reference moved to `docs/configuration.md`.

- **"Add Sync Target" command**: A single command palette entry that dynamically loads available sync target presets from all installed plugins. Each preset is prefixed with the plugin name (e.g. "GitHub Issues: Open issues on this repository"). Replaces the three individual "Add Sync Target - ..." commands.
- **Plugin-provided sync target presets**: Plugins now expose their own included configs via `getIncludedConfigs()` on the `PluginBootstrap` interface. Each plugin can mark one config as the default.

### Removed

- **"Publish to Remote" palette command**: Manual publish trigger removed from the command palette. CodeLens inline actions ("Sync Now", "Publish") remain available in the editor.
- **"Pull Remote Changes" palette command**: Manual pull trigger removed from the command palette. CodeLens "Pull Changes" action remains available in the editor.
- **"Add Sync Target - Open issues on this repository" command**: Consolidated into the unified "Add Sync Target" command.
- **"Add Sync Target - My open issues on GitHub" command**: Consolidated into the unified "Add Sync Target" command.
- **"Add Sync Target - My open issues on this repository" command**: Consolidated into the unified "Add Sync Target" command.

### Changed

- **Status bar icon**: The status bar now shows a checklist icon (`$(checklist)`). Hover for a rich tooltip with sync summary and API quota details. Click to refresh targets.
- **Separated rate limit monitoring from UI**: `RateLimitMonitor` now focuses purely on quota tracking and pause/resume logic. Status bar display is handled by the new `StatusBarManager`.
- **Renamed "Refresh All" to "Refresh"**: The command now shows a multi-select picker when multiple sync targets exist, allowing you to choose which targets to refresh. Progress feedback is shown during refresh.

### Removed

- **"Pull Now" command**: Replaced by the Refresh command which provides target selection and progress feedback.
- **"Push Now" command**: Use the "Publish to Remote" command or auto-push instead.
- **"Fetch Now" command**: Replaced by the Refresh command.
- **"Show Sync Summary" command**: The sync summary is now shown as a tooltip when hovering over the status bar icon.

### Added

- **`issuesAsCode.showStatusBarIcon` setting**: Boolean (default: `true`). Controls whether the Issues as Code status bar icon is visible. Window-scoped.
- **Sync summary tooltip**: Hovering over the status bar icon shows total sync targets, tracked issue counts, last/next fetch times per target, and API quota percentages.
- **Fetch time tracking**: Each sync target now tracks when it was last fetched and when the next fetch is scheduled.

### Changed

- **Renamed `pushOnSaveDelay` to `autoPushDelay`**: The setting name now mirrors VS Code's `files.autoSaveDelay` convention. Only applies when `autoPush` is `"afterDelay"`.
- **Manual save always pushes immediately**: When the user explicitly saves (Ctrl+S / File → Save), changes are pushed to the remote immediately without waiting for the delay timer. The existing conflict protection still applies — if the remote has been updated, the push is blocked and the user is prompted to pull first.

### Added

- **`issuesAsCode.autoPush` setting**: Controls when local changes are automatically pushed to the remote. Options: `"afterDelay"` (default, same as previous behavior), `"onFocusChange"` (push when switching away from the file), `"onWindowChange"` (push when VS Code window loses focus), `"off"` (disable auto-push entirely). Mirrors the behavior of VS Code's built-in `files.autoSave` setting.
- **Post-push filter validation**: After pushing changes, the file is re-checked against the target's filter criteria. If it no longer matches (e.g. the issue was closed but the target filters for `state: open`), the file and its state entry are automatically removed and the editor tab is closed.
- **API rate limit monitoring**: A status bar item shows the current GitHub API quota (e.g. "API: 4532/5000"). Clicking it shows detailed quota info per bucket (core, search) including reset times.
- **Automatic sync pause on low quota**: When remaining API quota drops below the configurable threshold (default 5%), automatic syncing pauses until the quota resets. A warning alert is shown. Manual actions (Sync Now, Publish) still work with a confirmation prompt.
- **`issuesAsCode.rateLimitThreshold` setting**: Percentage of API quota remaining that triggers a sync pause (default: 5). Window-scoped.

- **Sync details CodeLens on second line**: The "⟳ Sync Now" button and sync status info now appear on a separate line below the remote reference link, giving clearer visual separation between the URL and sync actions.
- **Push blocked when remote has pending changes**: When the remote has been updated since the last sync, pushing local changes is blocked. An interactive warning prompts the user to pull remote changes first, preventing accidental overwrites.
- **Pull hold-off for modified files**: During periodic pulls, if the local file has been modified and the remote also has changes, remote changes are no longer auto-applied. Instead, they are tracked as pending and surfaced via the "Pull Changes" button.

### Added

- **"⬇ Pull Changes" CodeLens button**: When the remote has pending changes that haven't been applied locally, a "Pull Changes" button appears on the sync details line with a tooltip: "There are pending changes on the remote."
- **Remote status info in CodeLens**: The sync details line shows when the remote was last modified (e.g., "Remote was last modified at 2:30 PM by @user123.").
- **Command: "Issues as Code: Pull Remote Changes"** (`issuesAsCode.pullFile`) — Explicitly pulls remote changes for the current file, applying them locally (with conflict markers if both sides changed).
- **`last_modified_by` tracking**: `RemoteIssueInfo` now supports an optional `last_modified_by` field for plugins to populate.
- **`hasPendingRemoteChanges` helper**: `SyncStateManager` exposes a method to detect whether the remote has been updated more recently than the last local sync.
- **`issuesAsCode.autoPullOnFetch` setting**: When enabled, automatically applies remote changes to local task files after fetching, as long as there are no local modifications that would conflict. Defaults to `false`.

## [previous]

### Changed

- **Plugin architecture refactor**: Sync logic is now decoupled from specific services via a plugin system. Each remote service (GitHub Issues, GitHub Projects, TickTick) is implemented as an isolated plugin under `src/plugins/`.
- **New plugin types**: `PrimarySyncPlugin` (owns file body and creation — e.g. gh-issues) and `MetadataPlugin` (enriches frontmatter — e.g. gh-projects) replace the previous monolithic approach.
- **SyncManager is now generic**: No longer contains GitHub-specific logic. Delegates pull/push operations to the configured plugin. Conflict markers say "Remote" instead of "GitHub".
- **GitHubClient is repo-free**: Methods accept owner/repo as parameters, enabling cross-repository operations.
- **configManager cleaned up**: Plugin-specific types and query builders moved into their respective plugin files. Generic `SyncTarget` interface uses an index signature for plugin configs.
- **New file behavior**: New files created in sync target folders are no longer auto-pushed. A CodeLens "Publish" button appears instead, giving users explicit control.
- **Cross-repo safety**: File lookup uses full `owner/repo/number` keys to prevent collisions when multiple repositories share issue numbers.
- **Stale file cleanup**: After each pull, task files whose remote item no longer matches the target's filter are automatically deleted and their sync state entries removed. This keeps the local folder and sync state in sync with the remote.
- **CodeLens positioning**: The issue URL and publish/sync CodeLens buttons now appear above the plugin's section in the front matter (e.g. above `gh-issues:`) rather than at the top of the file.
- **Command renamed**: "Issues as Code: Add setting - My issues on GitHub" → "Issues as Code: Add setting - My open issues on GitHub". Now uses folder `.issues/github/me` and includes a `state: open` filter.
- **Command renamed**: "Issues as Code: Add setting - My issues on this repository" → "Issues as Code: Add setting - My open issues on this repository". Now uses folder `.issues/open`.

### Added

- **Command: "Issues as Code: Add Sync Target - Open issues on this repository"** — Adds a sync target for all open issues on the detected workspace repository. Replaces the previous "Add Open Issues Default Config" command.
- **Auto-add default sync target**: When no sync targets are configured and a GitHub remote is detected, the extension automatically adds an open-issues sync target to workspace settings on first activation.
- **Command: "Issues as Code: Add setting - My open issues on GitHub"** — Adds a cross-repo sync target for open issues assigned to the authenticated user across GitHub.
- **Command: "Issues as Code: Add setting - My open issues on this repository"** — Adds a sync target for the authenticated user's open issues on the detected workspace repository.
- **Command: "Issues as Code: Publish to Remote"** — Explicitly publishes a local file to the configured remote service.
- **CodeLens provider**: Shows a "▶ Publish to [service]" button on unpublished markdown files inside sync target folders.
- **"⟳ Sync Now" CodeLens**: When a published file has been modified (saved but not yet pushed), a "⟳ Sync Now" button appears next to the remote reference link to trigger an immediate push.
- **`readOnly` sync target option**: Set `readOnly: true` on a sync target to make files read-only. Files are updated from remote but local changes are never pushed. Local edits are automatically overwritten on the next pull. Files are made read-only on disk (chmod 444) to discourage accidental edits. A 🔏 icon is shown in the Explorer instead of the usual sync status badge. Supported on Linux, macOS, and Windows.
- **Frontmatter completion provider**: Provides IntelliSense completions inside the YAML front matter of task files. Supports `state` (open/closed), `labels` (fetched from GitHub), and `assignees` (fetched from GitHub contributors). Results are cached per repository for 5 minutes.
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
