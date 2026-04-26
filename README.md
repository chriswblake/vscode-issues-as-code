# Issues as Code

Synchronize GitHub issues to a local `.issues/` folder — edit them as Markdown files and let the extension push changes back to GitHub automatically.

## Features

- **Auto-pull** issues on startup and at a configurable interval
- **Debounced push** — edits are pushed to GitHub N seconds after your last save
- **Full frontmatter** — title, state, labels, assignees, and projects all sync
- **Conflict detection** — opens a diff editor with Accept Cloud / Keep Local buttons
- **GitHub Projects v2** — read and write project field values
- **Multi-org / multi-repo** — sync issues from any number of organizations and repositories simultaneously
- **Multi-root workspace** support — one sync manager per folder
- **Date tokens** in sync targets — `{today-10d}` resolves at runtime
- **Create issues from local files** — save a new `.md` file in a configured location to open it on GitHub

## Getting Started

1. **Install** the extension from the VS Code Marketplace.
2. **Open** a workspace that contains a GitHub repository.
3. **Sign in** to GitHub when prompted (uses VS Code's built-in GitHub authentication).
4. Issues matching your configured targets are downloaded automatically.
   - If no `issueSync.syncTargets` are configured, the extension auto-detects the workspace repository and uses sensible defaults (open issues + issues closed in the last 10 days).

## Configuration

All settings have `"scope": "resource"` so they can be set per workspace folder.

| Setting | Type | Default | Description |
|---|---|---|---|
| `issueSync.fileNaming` | `string` | `{issue-num}-{issue-title}` | Template for issue file names |
| `issueSync.autosaveDelay` | `number` | `60` | Seconds to wait after last save before pushing |
| `issueSync.syncTargets` | `array` | `[]` | Repositories and queries to sync (see below) |
| `issueSync.pullInterval` | `number` | `30` | Minutes between automatic pulls |

### `issueSync.syncTargets`

Each entry defines one repository + query + local folder combination:

```json
[
  {
    "repository_url": "https://github.com/my-org/my-repo",
    "query": "is:issue state:open",
    "location": "{workspaceDir}/.issues/my-repo/open"
  },
  {
    "repository_url": "https://github.com/my-org/my-repo",
    "query": "is:issue closed:>{today-10d}",
    "location": "{workspaceDir}/.issues/my-repo/closed_10days"
  },
  {
    "repository_url": "https://github.com/another-org/another-repo",
    "query": "is:issue state:open",
    "location": "{workspaceDir}/.issues/another-repo/open"
  }
]
```

Use `{workspaceDir}` as a placeholder for the workspace root folder. The `query` field supports the full GitHub issue search syntax and the `{today-Nd}` date token.

When `syncTargets` is empty (the default) the extension falls back to auto-detecting the repository from the workspace git remote and creates two targets: open issues and issues closed in the last 10 days, stored under `{workspaceDir}/.issues/open` and `{workspaceDir}/.issues/closed_10days`.

## How Sync Works

On activation the extension reads `issueSync.syncTargets` and creates one sync manager per entry. Each manager authenticates via VS Code's GitHub auth provider, pulls issues matching its query into its configured `location` folder, and starts a `FileSystemWatcher` over that folder. When you save a file the extension starts a debounce timer and pushes your changes to the correct repository after the configured delay. If the cloud version was updated since your last sync, a diff editor opens so you can choose which version to keep. Every configured location's top-level directory is added to `.gitignore` automatically.

## Documentation

See [docs/how-to-develop.md](docs/how-to-develop.md) for the developer guide.

