# Changelog

## [pending]

### Added

- GitHub Projects v2 logic extracted into a standalone `projectsSync.ts` module (`ProjectsSyncPlugin` class). The module is only loaded at runtime when `enable_experimental_projects` is `true`.
- Add `issuesAsCode.enable_experimental_projects` setting (default: `false`) to gate GitHub Projects v2 metadata sync. Requires reloading VS Code to take effect.
- Add `issuesAsCode.showSyncState` setting to show or hide the sync state file in the VS Code Explorer
- Add `issuesAsCode.showSyncIcons` setting with A / M / ✓ badges on issue files in the Explorer
- Smart conflict resolution — simple remote-wins changes are auto-accepted; complex conflicts open a merge editor
- Dedicated `sync-state.json` file to track sync metadata — removed from issue frontmatter
- `issuesAsCode.syncStatePath` setting to configure the location of the sync state file
- Rename issue files when the title changes on GitHub
- Auto-reorganize issue files when `syncTargets` configuration is modified
- Progress notifications for pull and push sync commands
- Add command `Issues as Code: Add Open Issues Default Config` to quickly add a default sync target
- Devcontainer configuration for Codespaces support
- `repository_owner` and `name` fields replaced by `repository_url` in `syncTargets` entries
- File names no longer require issue number.

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
