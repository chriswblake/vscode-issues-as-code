# Changelog

## [pending]

### Added
- `issueSync.enable_experimental_projects` setting (default: `false`) to gate GitHub Projects v2 metadata sync. Requires reloading VS Code to take effect.

### Changed
- GitHub Projects v2 logic extracted into a standalone `projectsSync.ts` module (`ProjectsSyncPlugin` class). The module is only loaded at runtime when `enable_experimental_projects` is `true`.

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
