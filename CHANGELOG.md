# Changelog

## Pending

### Bug Fixes

- **Issues matching multiple sync targets now appear in all matching folders.** Previously, if an issue matched more than one sync target, it would only show in the last one processed. Each target now independently tracks its own copy.
- **Local edits propagate to sibling copies on save.** When the same issue exists in multiple sync targets and you edit one copy, saving it immediately updates the other copies locally — no internet required.

## [0.2.0] - 2026-05-11

This release focuses on making syncing safer, smarter, and easier to understand at a glance.

### Conflict protection — your edits are safe

When you and someone else edit the same issue at the same time, Issues as Code now handles it gracefully instead of silently overwriting either side.

- **Push is blocked when the remote has newer changes.** If someone updated the issue on GitHub since your last sync, you'll be prompted to pull their changes first before yours can be sent.
- **Auto-pull is paused when you have local edits.** If you've made local changes and the remote also has updates, the extension won't auto-apply them. Instead, a **⬇ Pull Changes** button appears in the editor so you can pull when you're ready.
- **See who changed the issue and when.** The sync details line in the editor shows the last time the remote was modified and who made the change (e.g. "Remote was last modified at 2:30 PM by @user123").
- **Stale files are cleaned up automatically.** After syncing, any local file whose issue no longer matches the sync target's filter (e.g. an issue was closed and your filter only shows open issues) is automatically removed.

### Control when changes are sent

You now have more control over when your local edits are pushed to GitHub.

- **New `issuesAsCode.autoPush` setting** with four modes:
  - `afterDelay` — push automatically a few seconds after you stop typing (default)
  - `onFocusChange` — push when you switch to a different file
  - `onWindowChange` — push when VS Code loses focus
  - `off` — never push automatically; use the **⟳ Sync Now** button in the editor
- **Ctrl+S always pushes immediately**, regardless of the auto-push mode.
- **Files are auto-removed after push if they no longer match the filter.** For example, if you close an issue and your sync target only tracks open issues, the file disappears from your local folder automatically.
- **New `issuesAsCode.autoPullOnFetch` setting** — when enabled, remote changes are automatically applied to local files after fetching, as long as there are no conflicting local edits. Off by default.

### Status bar — sync at a glance

A status bar icon and panel provide more information without getting in the way.

- A **checklist icon** (✓) is shown in the status bar. Click it to refresh your sync targets.
- **Hover over the icon** to see a rich summary: how many issues are tracked per target, when each target was last fetched, when the next fetch is scheduled, and your current GitHub API usage.
- **New `issuesAsCode.showStatusBarIcon` setting** — hide the icon if you prefer a cleaner status bar.

### GitHub API rate limit protection

If your GitHub API quota gets low, the extension now protects you automatically.

- The status bar tooltip shows current API usage.
- **Auto-sync pauses** when remaining quota drops below 5% (configurable). A warning is shown, and syncing resumes automatically when the quota resets.
- Manual actions like **Sync Now** and **Publish** still work during a pause, with a confirmation prompt.
- **New `issuesAsCode.rateLimitThreshold` setting** — set the percentage at which auto-sync pauses (default: 5%).

### Simpler command palette

The command palette has been cleaned up. Most day-to-day actions are now done directly in the editor via CodeLens buttons.

- **"Add Sync Target"** — one command that shows all available presets from installed plugins (e.g. "GitHub Issues: Open issues on this repository").
- **"Refresh"** — when you have multiple sync targets, a picker lets you choose which ones to refresh. A progress indicator is shown while refreshing.
- Day-to-day actions (publish, pull, sync) are done via buttons in the editor rather than the command palette.

### Editor improvements

- **IntelliSense in frontmatter** — when editing the YAML header of a task file, you get auto-complete suggestions for `state` (open/closed), `labels`, and `assignees` (fetched from GitHub and cached for 5 minutes).
- **Publish button for new files** — files you create in a sync target folder aren't pushed automatically. A **▶ Publish** CodeLens button appears so you decide when to send it to GitHub.
- **Sync Now button on modified files** — when a file has local changes that haven't been pushed yet, a **⟳ Sync Now** button appears in the editor.

### Read-only sync targets

- Add `readOnly: true` to any sync target to make its files read-only. The files are updated from the remote but your local edits are never pushed. A 🔒 icon appears in the Explorer instead of the usual sync badge.

### Setup improvements

- **Auto-setup on first install** — if a GitHub remote is detected and no sync targets are configured, a default "open issues on this repository" target is added automatically.
- **Sync target folders are gitignored automatically** — new `issuesAsCode.keepGitIgnoreUpdated` setting (default: `true`). The sync state file is always gitignored regardless of this setting.
- **Settings reference** — full documentation for all settings is now at `docs/configuration.md`.

## [0.1.0] - 2026-04-22

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
