import * as fs from 'fs';
import * as path from 'path';

export interface SyncTarget {
  repository_url: string;
  query: string;
  /** Absolute path to the folder where issue files for this target are stored. */
  location: string;
}

export interface RepoInfo {
  owner: string;
  repo: string;
}

export interface ShowSyncIconsConfig {
  newIssue: boolean;
  modified: boolean;
  synchronized: boolean;
}

export interface IssueConfig {
  fileNaming: string;
  autosaveDelay: number;
  syncTargets: SyncTarget[];
  pullInterval: number;
  syncStatePath: string;
  showSyncState: boolean;
  showSyncIcons: ShowSyncIconsConfig;
  enableExperimentalProjects: boolean;
}

/**
 * Replaces `{today-Nd}` tokens with ISO date strings (YYYY-MM-DD).
 * Example: "closed:>{today-10d}" → "closed:>2026-04-12"
 */
export function resolveQuery(query: string): string {
  return query.replace(/\{today-(\d+)d\}/g, (_, n) => {
    const d = new Date();
    d.setDate(d.getDate() - parseInt(n, 10));
    return d.toISOString().slice(0, 10);
  });
}

/**
 * Returns all configuration values for a workspace folder.
 * Accepts explicit values for testability.
 */
export function getConfig(workspaceFolderPath: string, vscodeWorkspaceFolder?: unknown): IssueConfig {
  // When running in VS Code context, read from workspace configuration
  if (vscodeWorkspaceFolder !== undefined) {
    // Dynamic import to avoid hard dependency on vscode in unit tests
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const vscode = require('vscode') as typeof import('vscode');
      const uri = (vscodeWorkspaceFolder as { uri: import('vscode').Uri }).uri;
      const cfg = vscode.workspace.getConfiguration('issueSync', uri);

      const rawTargets = cfg.get<SyncTarget[]>('syncTargets') ?? [];
      const syncTargets = rawTargets.map((t) => ({
        ...t,
        location: t.location.replace('{workspaceDir}', workspaceFolderPath),
      }));

      const rawSyncStatePath = cfg.get<string>('syncStatePath') ?? '{workspaceDir}/.issues/sync-state.json';
      const syncStatePath = rawSyncStatePath.replace('{workspaceDir}', workspaceFolderPath);

      const rawShowSyncIcons = cfg.get<Partial<ShowSyncIconsConfig>>('showSyncIcons') ?? {};

      return {
        fileNaming: cfg.get<string>('fileNaming') ?? '{issue-num}-{issue-title}',
        autosaveDelay: cfg.get<number>('autosaveDelay') ?? 60,
        syncTargets,
        pullInterval: cfg.get<number>('pullInterval') ?? 30,
        syncStatePath,
        showSyncState: cfg.get<boolean>('showSyncState') ?? false,
        showSyncIcons: {
          newIssue: rawShowSyncIcons.newIssue ?? true,
          modified: rawShowSyncIcons.modified ?? true,
          synchronized: rawShowSyncIcons.synchronized ?? true,
        },
        enableExperimentalProjects: cfg.get<boolean>('enable_experimental_projects') ?? false,
      };
    } catch {
      // Fall through to defaults
    }
  }

  // Default config used in tests or when vscode is unavailable
  return {
    fileNaming: '{issue-num}-{issue-title}',
    autosaveDelay: 60,
    syncTargets: [],
    pullInterval: 30,
    syncStatePath: path.join(workspaceFolderPath, '.issues', 'sync-state.json'),
    showSyncState: false,
    showSyncIcons: { newIssue: true, modified: true, synchronized: true },
    enableExperimentalProjects: false,
  };
}

/**
 * Builds default sync targets for a detected repo, mirroring the old default
 * syncFilters behaviour (open issues + issues closed in the last 10 days).
 */
export function defaultSyncTargets(owner: string, repo: string, workspaceFolderPath: string): SyncTarget[] {
  const issuesBase = path.join(workspaceFolderPath, '.issues');
  const repositoryUrl = `https://github.com/${owner}/${repo}`;
  return [
    {
      repository_url: repositoryUrl,
      query: 'is:issue state:open',
      location: path.join(issuesBase, 'open'),
    },
    {
      repository_url: repositoryUrl,
      query: 'is:issue closed:>{today-10d}',
      location: path.join(issuesBase, 'closed_10days'),
    },
  ];
}

/**
 * Extracts owner/repo from a SyncTarget's repository_url.
 * Returns null if the URL cannot be parsed.
 */
export function repoInfoFromTarget(target: SyncTarget): RepoInfo | null {
  return parseGitHubUrl(target.repository_url);
}

/**
 * Detects GitHub repo from git remote using vscode.git extension API.
 */
export async function detectRepo(workspaceFolder: { uri: { fsPath: string } }): Promise<RepoInfo | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
    if (!gitExtension) {
      return null;
    }

    const api = gitExtension.getAPI(1);
    if (!api) {
      return null;
    }

    const repo = api.repositories.find((r: { rootUri: { fsPath: string } }) => workspaceFolder.uri.fsPath.startsWith(r.rootUri.fsPath));
    if (!repo) {
      return null;
    }

    const remotes: Array<{ name: string; fetchUrl?: string; pushUrl?: string }> = repo.state.remotes ?? [];
    if (remotes.length === 0) {
      return null;
    }

    // Prefer "origin", fall back to first remote
    const remote = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    const url = remote.fetchUrl ?? remote.pushUrl ?? '';

    return parseGitHubUrl(url);
  } catch {
    return null;
  }
}

/**
 * Parses a GitHub remote URL (HTTPS or SSH) and returns owner/repo.
 */
export function parseGitHubUrl(url: string): RepoInfo | null {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/**
 * Ensures each issue-location directory (or its closest ancestor inside the
 * workspace) is present in the workspace `.gitignore`.
 */
export async function ensureGitignore(workspaceRoot: string, locations: string[]): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');

  // Build the set of gitignore entries — use the path relative to the workspace root.
  // If the location is outside the workspace we skip it.
  const entries = new Set<string>();
  for (const loc of locations) {
    const rel = path.relative(workspaceRoot, loc);
    if (rel.startsWith('..')) {
      continue;
    } // outside workspace
    // Take the top-level segment so that e.g. ".issues/open" → ".issues/"
    const topLevel = rel.split(path.sep)[0];
    entries.add(topLevel + '/');
  }

  if (entries.size === 0) {
    return;
  }

  let content = '';
  try {
    content = await fs.promises.readFile(gitignorePath, 'utf8');
  } catch {
    // File doesn't exist yet; we'll create it
  }

  const lines = content.split('\n').map((l) => l.trim());
  const toAdd = [...entries].filter((e) => !lines.includes(e));
  if (toAdd.length === 0) {
    return;
  }

  const suffix = content.endsWith('\n') || content === '' ? '' : '\n';
  await fs.promises.writeFile(gitignorePath, content + suffix + toAdd.join('\n') + '\n', 'utf8');
}
