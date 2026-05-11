# Configuration Reference

All settings use the `issuesAsCode.*` prefix. Most settings are resource-scoped (can be set per workspace folder). Exceptions are noted below.

## Interface

| Setting                          | Type      | Default                                                  | Description                                                                                       |
| -------------------------------- | --------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `issuesAsCode.showSyncIcons`     | `object`  | `{ newIssue: true, modified: true, synchronized: true }` | Controls which sync status badges appear on issue files in the Explorer.                          |
| `issuesAsCode.showStatusBarIcon` | `boolean` | `true`                                                   | Show the Issues as Code status bar icon. Hover for sync summary and API quota. **Window-scoped.** |

## Sync Behavior

| Setting                          | Type      | Default      | Description                                                                                                                                                                                      |
| -------------------------------- | --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `issuesAsCode.syncTargets`       | `array`   | `[]`         | List of sync targets. Each entry defines a local folder and plugin configuration. When empty, the extension auto-detects the GitHub remote and adds a default open-issues target.                |
| `issuesAsCode.autoFetchInterval` | `number`  | `30`         | Minutes between automatic fetches from the remote. Fetching checks for remote changes and stores them locally without applying to files.                                                         |
| `issuesAsCode.autoPullOnFetch`   | `boolean` | `false`      | Automatically apply remote changes to local files after fetching, as long as there are no conflicting local modifications.                                                                       |
| `issuesAsCode.autoPush`          | `string`  | `afterDelay` | Controls when local changes are automatically pushed. Options: `afterDelay`, `onFocusChange`, `onWindowChange`, `off`. Manual saves (Ctrl+S) always push immediately regardless of this setting. |
| `issuesAsCode.autoPushDelay`     | `number`  | `60000`      | Milliseconds to wait after last save before pushing. Only used when `autoPush` is `afterDelay`.                                                                                                  |

## Sync Targets

Each entry in `issuesAsCode.syncTargets` is an object with these properties:

| Property    | Type      | Required | Description                                                                                                                        |
| ----------- | --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `filesDir`  | `string`  | Yes      | Local folder path where synced files are stored. Must be relative to the workspace folder.                                         |
| `readOnly`  | `boolean` | No       | When `true`, files are updated from remote but local changes are never pushed. Files are made read-only on disk. Default: `false`. |
| `gh-issues` | `object`  | No       | GitHub Issues plugin configuration (see below).                                                                                    |

## Plugin: `gh-issues`

### Issues Search Filters

Use the `filters` property to define what issues are synchronized locally.

| Filter       | Type                 | Description                                                                               |
| ------------ | -------------------- | ----------------------------------------------------------------------------------------- |
| `naming`     | `string`             | Template for file names. Use variables like `{gh-issues.number}` and `{gh-issues.title}`. |
| `repository` | `string`             | GitHub repository in `owner/repo` format, e.g. `my-org/my-repo`.                          |
| `state`      | `string`             | Issue state: `open` or `closed`.                                                          |
| `assignee`   | `string`             | Filter by assignee login.                                                                 |
| `author`     | `string`             | Filter by author login.                                                                   |
| `label`      | `string \| string[]` | Filter by one or more labels.                                                             |
| `created_at` | `string`             | Filter by creation date. Supports `{today-Nd}` tokens, e.g. `>{today-10d}`.               |

## Example: Multi-Repository Setup

The following example synchronizes issues from 2 repositories. It shows:

- open issues for the `frontend` repo
- open issues for the `backend` repo
- recently closed issues for the `frontend` repo

```jsonc
{
  "issuesAsCode.syncTargets": [
    {
      "filesDir": ".issues/frontend/open",
      "naming": "{gh-issues.number}-{gh-issues.title}",
      "gh-issues": {
        "filters": {
          "repository": "my-org/frontend",
          "state": "open",
        },
      },
    },
    {
      "filesDir": ".issues/backend/open",
      "naming": "{gh-issues.number}-{gh-issues.title}",
      "gh-issues": {
        "filters": {
          "repository": "my-org/backend",
          "state": "open",
        },
      },
    },
    {
      "filesDir": ".issues/frontend/recent",
      "naming": "{gh-issues.number}-{gh-issues.title}",
      "readOnly": true,
      "gh-issues": {
        "filters": {
          "repository": "my-org/frontend",
          "state": "closed",
          "closed_at": ">{today-10d}",
        },
      },
    },
  ],
}
```

## Miscellaneous

| Setting                             | Type      | Default                  | Description                                                                                                                                                                                                                         |
| ----------------------------------- | --------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuesAsCode.keepGitIgnoreUpdated` | `boolean` | `true`                   | Automatically add sync target folders to `.gitignore` to prevent synced files from being committed. The sync state file is always gitignored regardless of this setting.                                                            |
| `issuesAsCode.showSyncState`        | `boolean` | `false`                  | Show the sync state file in the VS Code Explorer. When false, the file is hidden via `files.exclude`.                                                                                                                               |
| `issuesAsCode.syncStatePath`        | `string`  | `.issues/sync-state.yml` | Path to the sync state file that tracks per-issue timestamps. Must be relative to the workspace folder. This file is machine-local and always gitignored.                                                                           |
| `issuesAsCode.rateLimitThreshold`   | `number`  | `5`                      | API quota percentage remaining that triggers an automatic sync pause. When remaining quota drops to this threshold, syncing pauses until the quota resets. Manual actions still work with a confirmation prompt. **Window-scoped.** |

<!-- | `issuesAsCode.enable_experimental_projects` | `boolean` | `false`                  | Enable experimental GitHub Projects v2 metadata sync. Requires reloading VS Code.                                                                                                                                                   | -->
