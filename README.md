# Issues as Code

Synchronize GitHub issues to a local `.issues/` folder — edit them as Markdown files and let the extension push changes back to GitHub automatically.

## Features

- **Auto-pull** issues on startup and at a configurable interval
- **Debounced push** — edits are pushed to GitHub N seconds after your last save
- **Full frontmatter** — title, state, labels, assignees, and projects all sync
- **Conflict detection** — opens a diff editor with Accept Cloud / Keep Local buttons
- **GitHub Projects v2** — read and write project field values
- **Multi-root workspace** support — one sync manager per folder
- **Date tokens** in sync filters — `{today-10d}` resolves at runtime
- **Auto-folder** — files move to the correct filter folder after each sync
- **Create issues from local files** — save a new `.md` file in `.issues/` to open it on GitHub

## Getting Started

1. **Install** the extension from the VS Code Marketplace.
2. **Open** a workspace that contains a GitHub repository.
3. **Sign in** to GitHub when prompted (uses VS Code's built-in GitHub authentication).
4. Issues matching your configured filters are downloaded to `.issues/` automatically.

## Configuration

All settings have `"scope": "resource"` so they can be set per workspace folder.

| Setting | Type | Default | Description |
|---|---|---|---|
| `issueSync.fileNaming` | `string` | `{issue-num}-{issue-title}` | Template for issue file names |
| `issueSync.autosaveDelay` | `number` | `60` | Seconds to wait after last save before pushing |
| `issueSync.syncFilters` | `array` | see below | Filters defining which issues to sync |
| `issueSync.issuesLocation` | `string` | `{workspaceDir}/.issues` | Root folder for issue files |
| `issueSync.pullInterval` | `number` | `30` | Minutes between automatic pulls |

Default `syncFilters`:
```json
[
  { "name": "open", "query": "is:issue state:open" },
  { "name": "closed_10days", "query": "is:issue closed:>{today-10d}" }
]
```

## How Sync Works

On activation the extension detects the GitHub remote from your workspace's git configuration. It then authenticates via VS Code's GitHub auth provider and pulls issues for every configured filter into sub-folders of `.issues/`. A `FileSystemWatcher` monitors the folder; when you save a file the extension starts a debounce timer and pushes your changes to GitHub after the configured delay. If the cloud version was updated since your last sync, a diff editor opens so you can choose which version to keep. The `.issues/` folder is added to `.gitignore` automatically so it is never committed.

## Documentation

See [docs/how-to-develop.md](docs/how-to-develop.md) for the developer guide.

