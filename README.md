# Issues as Code

Synchronize GitHub issues to a local `.issues/` folder — edit them as Markdown files and let the extension push changes back to GitHub automatically.

> [!IMPORTANT]
> This project was vibe coded. Please experiment on a few test repositories before working on a real project.

## Features

- **Auto-pull** issues on startup and at a configurable interval
- **Debounced push** — edits are pushed to GitHub N seconds after your last save
- **Full frontmatter** — title, state, labels, assignees, and projects all sync
- **Smart conflict resolution** — simple remote-wins changes are auto-accepted; complex conflicts open a standard merge editor
- **GitHub Projects v2** — read and write project field values
- **Multi-org / multi-repo** — sync issues from any number of organizations and repositories simultaneously
- **Multi-root workspace** support — one sync manager per folder
- **Date tokens** in sync targets — `{today-10d}` resolves at runtime
- **Create issues from local files** — save a new `.md` file in a configured location to open it on GitHub
- **Auto-rename files** — issue files are renamed automatically when the title changes on GitHub
- **Auto-reorganize files** — files are moved to the correct folder when `syncTargets` are updated
- **Sync state icons** — A / M / ✓ badges in the Explorer show new, modified, and synchronized issues
- **Sync notifications** — progress notifications during pull and push operations
- **Dedicated sync state file** — sync metadata is stored in a separate `sync-state.yml` rather than in issue frontmatter

## Getting Started

> [!NOTE]
> This is not yet available on the VS Code Marketplace.
> It will be added after more rigorous testing.

<!-- 1. **Install** the extension from the VS Code Marketplace. -->
<!-- 2. **Open** a workspace that contains a GitHub repository. -->
<!-- 3. **Sign in** to GitHub when prompted (uses VS Code's built-in GitHub authentication). -->
<!-- 4. Issues matching your configured targets are downloaded automatically. -->
   <!-- - If no `issuesAsCode.syncTargets` are configured, the extension auto-detects the workspace repository and uses sensible defaults (open issues + issues closed in the last 10 days). -->

## Configuration

All settings have `"scope": "resource"` so they can be set per workspace folder.

| Setting                        | Type      | Default                                                  | Description                                                   |
| ------------------------------ | --------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| `issuesAsCode.fileNaming`      | `string`  | `{issue-num}-{issue-title}`                              | Template for issue file names                                 |
| `issuesAsCode.pushOnSaveDelay` | `number`  | `60`                                                     | Seconds to wait after last save before pushing                |
| `issuesAsCode.syncTargets`     | `array`   | `[]`                                                     | Repositories and queries to sync (see below)                  |
| `issuesAsCode.pullInterval`    | `number`  | `30`                                                     | Minutes between automatic pulls                               |
| `issuesAsCode.syncStatePath`   | `string`  | `.issues/sync-state.yml`                                 | Path to the local sync state file (machine-local, gitignored) |
| `issuesAsCode.showSyncState`   | `boolean` | `false`                                                  | Show the sync state file in the VS Code Explorer              |
| `issuesAsCode.showSyncIcons`   | `object`  | `{ newIssue: true, modified: true, synchronized: true }` | Controls which sync status badges appear on issue files       |

### `issuesAsCode.syncTargets`

Each entry defines one repository + query + local folder combination:

```json
[
  {
    "repository_url": "https://github.com/my-org/my-repo",
    "query": "is:issue state:open",
    "location": ".issues/my-repo/open"
  },
  {
    "repository_url": "https://github.com/my-org/my-repo",
    "query": "is:issue closed:>{today-10d}",
    "location": ".issues/my-repo/closed_10days"
  },
  {
    "repository_url": "https://github.com/another-org/another-repo",
    "query": "is:issue state:open",
    "location": ".issues/another-repo/open"
  }
]
```

Paths must be relative to the current workspace folder; absolute paths are not allowed. The `query` field supports the full GitHub issue search syntax and the `{today-Nd}` date token.

When `syncTargets` is empty (the default) the extension falls back to auto-detecting the repository from the workspace git remote and creates two targets: open issues and issues closed in the last 10 days, stored under `.issues/open` and `.issues/closed_10days`.

## How Sync Works

On activation the extension reads `issuesAsCode.syncTargets` and creates one sync manager per entry. Each manager authenticates via VS Code's GitHub auth provider, pulls issues matching its query into its configured `location` folder, and starts a `FileSystemWatcher` over that folder. When you save a file the extension starts a debounce timer and pushes your changes to the correct repository after the configured delay.

If the remote version was updated since your last sync, simple non-conflicting changes are auto-accepted from the remote. If both sides changed the same content, a standard merge editor opens so you can resolve the conflict manually. Every configured location's top-level directory is added to `.gitignore` automatically.

Sync state (last-synced timestamps) is stored in a dedicated `sync-state.yml` file rather than in issue frontmatter. This file is machine-local and is automatically gitignored. File names are updated automatically when an issue's title changes on GitHub, and files are moved to the correct folder if `syncTargets` are modified.

## Commands

- `Issues as Code: Pull Now` — pulls all configured targets immediately.
- `Issues as Code: Push Now` — pushes the currently open issue file.
- `Issues as Code: Refresh All` — refreshes all configured targets.
- `Issues as Code: Add Open Issues Default Config` — detects the current repository and appends a default open-issues target to `issuesAsCode.syncTargets` for the active workspace folder.

## Documentation

See [docs/how-to-develop.md](docs/how-to-develop.md) for the developer guide.
