# Changelog

## [pending]

### Changed

- **Plugin-style architecture**: `issuesAsCode.syncTargets` setting now uses `filesDir`, `naming`, and plugin configuration objects (`gh-issues`, `gh-projects`, `tick-tick`) instead of flat `repository_url` / `query` / `location` fields.
- **New sync-state format**: `sync-state.json` replaced by `sync-state.yml`. The new YAML format organises data by plugin section (`gh-issues`, `gh-projects`, `tick-tick`) and cross-references them from a `files` section. Existing `sync-state.json` (v1/v2) files are automatically migrated on load.
- **Namespaced frontmatter**: Task file front-matter now uses plugin namespaces (`gh-issues`, `gh-projects`, `tick-tick`) instead of flat fields.
- **Search API for discovery, REST API for updates**: `pullTarget` now uses the GitHub Issues Search API (`searchIssueNumbers`) to discover matching issues, then calls the REST API (`getIssue`) individually per issue. Removed the combined `listIssues` method from `GitHubClient`.
- **File naming tokens**: Default naming template updated to `{gh-issues.number}-{gh-issues.title}`. Legacy `{issue-num}` and `{issue-title}` tokens are still supported for backwards compatibility.
- `issuesAsCode.syncStatePath` default changed from `sync-state.json` to `sync-state.yml`.
- Added `buildGhIssuesQuery` and `parseOwnerRepo` helpers exported from `configManager`.

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
