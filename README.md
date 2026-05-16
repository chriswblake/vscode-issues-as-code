# Issues as Code

Synchronize GitHub issues to a local `.issues/` folder — edit them as Markdown files and let the extension push changes back to GitHub automatically.

> [!IMPORTANT]
> This project is in early development. Please experiment on a few test repositories before using it on a real project.

## Getting Started

1. Open a workspace that contains a GitHub repository.
2. Sign in to GitHub when prompted (uses VS Code's built-in authentication).
3. Issues are downloaded automatically — no configuration needed.

By default, the extension detects your workspace's GitHub remote and syncs open issues to `.issues/open/`. Each issue becomes a Markdown file with YAML frontmatter for metadata (title, state, labels, assignees).

Edit an issue file and save — your changes are pushed back to GitHub after a short delay.

> [!NOTE]
> This is not yet available on the VS Code Marketplace.

## Features

### Syncing

- **Auto-fetch** on startup and at a configurable interval
- **Auto-push** — edits are pushed to GitHub after a configurable delay, on focus change, or on window change
- **Manual save** (Ctrl+S) pushes immediately, regardless of auto-push settings
- **Smart conflict resolution** — non-conflicting remote changes are auto-accepted; conflicts open a merge editor
- **Create issues** — save a new `.task.md` file in a sync target folder and click 'publish' to add to your repo

### Editing

- **Full frontmatter** — title, state, labels, assignees, and projects all sync as YAML
- **Autocomplete** — IntelliSense for frontmatter fields (labels, assignees, state)
- **Auto-rename** — files rename automatically when the issue title changes on GitHub
- **Auto-reorganize** — files move to the correct folder when sync targets change

### UI

- **Sync state icons** — `A` (new), `M` (modified), `✓` (synced) badges in the Explorer
- **CodeLens actions** — inline "Sync Now", "Publish", and "Pull Changes" buttons on issue files
- **Status bar** — sync summary and API quota on hover; click to refresh
- **API rate limit protection** — automatic pause when quota is low

### Extensibility

- **Multi-repo** — sync issues from any number of repositories
- **Multi-root workspace** — one sync manager per workspace folder
- **Plugin architecture** — sync targets use plugins (e.g. `gh-issues`) for extensibility

## Sync Targets

Sync targets define what to sync and where to store it. Each target specifies a local folder and a plugin configuration.

When no targets are configured (the default), the extension auto-detects your GitHub remote and adds a default target for open issues.

To add more targets, use the **"Issues as Code: Add Sync Target"** command from the command palette to retrieve an included template.

### Example Configuration

```jsonc
// .vscode/settings.json
{
  "issuesAsCode.syncTargets": [
    {
      "filesDir": ".issues/open",
      "naming": "{gh-issues.number}-{gh-issues.title}",
      "gh-issues": {
        "filters": { "repository": "my-org/my-repo", "state": "open" },
      },
    },
    {
      "filesDir": ".issues/closed_10days",
      "naming": "{gh-issues.number}-{gh-issues.title}",
      "gh-issues": {
        "filters": {
          "repository": "my-org/my-repo",
          "state": "closed",
          "created_at": ">{today-10d}",
        },
      },
    },
  ],
}
```

All paths must be relative to the workspace folder. See [docs/configuration.md](docs/configuration.md) for full details on all settings.

## VS Code Commands

| Command                           | Description                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `Issues as Code: Refresh`         | Refreshes sync targets. Shows a picker when multiple targets exist.            |
| `Issues as Code: Add Sync Target` | Adds a new sync target from available templates (e.g. open issues, my issues). |

## Documentation

- [Configuration Reference](docs/configuration.md) — all settings with descriptions and defaults
- [Developer Guide](docs/how-to-develop.md) — setup, debugging, and project structure
