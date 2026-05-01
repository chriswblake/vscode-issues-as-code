import * as fs from 'fs';
import * as path from 'path';

export interface SyncTarget {
  /** Absolute path to the folder where synced files for this target are stored. */
  filesDir: string;
  /** Template for file names. Uses tokens like {gh-issues.number} and {gh-issues.title}. */
  naming?: string;
  /** Plugin configurations keyed by plugin ID. */
  [pluginId: string]: unknown;
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
  pushOnSaveDelay: number;
  syncTargets: SyncTarget[];
  pullInterval: number;
  syncStatePath: string;
  showSyncState: boolean;
  showSyncIcons: ShowSyncIconsConfig;
  enableExperimentalProjects: boolean;
}

const DEFAULT_SYNC_STATE_PATH = '.issues/sync-state.yml';

export function resolveWorkspacePath(rawPath: string, workspaceFolderPath: string): string {
  if (path.isAbsolute(rawPath)) {
    throw new Error('Absolute paths are not allowed in issuesAsCode configuration. Use a path relative to the workspace folder.');
  }

  return path.resolve(workspaceFolderPath, rawPath);
}

function resolveSyncTargets(rawTargets: SyncTarget[], workspaceFolderPath: string): SyncTarget[] {
  return rawTargets.map((t) => ({
    ...t,
    filesDir: resolveWorkspacePath(t.filesDir, workspaceFolderPath),
  }));
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
      const cfg = vscode.workspace.getConfiguration('issuesAsCode', uri);

      const rawTargets = cfg.get<SyncTarget[]>('syncTargets') ?? [];
      const syncTargets = resolveSyncTargets(rawTargets, workspaceFolderPath);

      const rawSyncStatePath = cfg.get<string>('syncStatePath') ?? DEFAULT_SYNC_STATE_PATH;
      const syncStatePath = resolveWorkspacePath(rawSyncStatePath, workspaceFolderPath);

      const rawShowSyncIcons = cfg.get<Partial<ShowSyncIconsConfig>>('showSyncIcons') ?? {};

      return {
        fileNaming: cfg.get<string>('fileNaming') ?? '{issue-num}-{issue-title}',
        pushOnSaveDelay: cfg.get<number>('pushOnSaveDelay') ?? 60,
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
    pushOnSaveDelay: 60,
    syncTargets: [],
    pullInterval: 30,
    syncStatePath: path.join(workspaceFolderPath, '.issues', 'sync-state.yml'),
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
  const repository = `${owner}/${repo}`;
  return [
    {
      filesDir: path.join(issuesBase, 'open'),
      naming: '{gh-issues.number}-{gh-issues.title}',
      'gh-issues': {
        filters: { repository, state: 'open' },
      },
    },
    {
      filesDir: path.join(issuesBase, 'closed_10days'),
      naming: '{gh-issues.number}-{gh-issues.title}',
      'gh-issues': {
        filters: { repository, state: 'closed', created_at: '>{today-10d}' },
      },
    },
  ];
}

/**
 * Extracts owner/repo from a SyncTarget's gh-issues.filters.repository field.
 * Returns null if the field is missing or cannot be parsed.
 */
export function repoInfoFromTarget(target: SyncTarget): RepoInfo | null {
  const ghIssues = target['gh-issues'] as { filters?: { repository?: string } } | undefined;
  const repository = ghIssues?.filters?.repository;
  if (!repository) {
    return null;
  }
  return parseOwnerRepo(repository);
}

/**
 * Parses an "owner/repo" string into a RepoInfo object.
 * Returns null if the string does not match the expected format.
 */
export function parseOwnerRepo(repository: string): RepoInfo | null {
  const match = repository.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    return null;
  }
  return { owner: match[1], repo: match[2] };
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
