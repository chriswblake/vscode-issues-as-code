import * as fs from 'fs';
import * as path from 'path';

export interface IssueFilter {
  name: string;
  query: string;
}

export interface RepoInfo {
  owner: string;
  repo: string;
}

export interface IssueConfig {
  fileNaming: string;
  autosaveDelay: number;
  syncFilters: IssueFilter[];
  issuesLocation: string;
  pullInterval: number;
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
      const issuesLocation = (cfg.get<string>('issuesLocation') ?? '{workspaceDir}/.issues')
        .replace('{workspaceDir}', workspaceFolderPath);
      return {
        fileNaming: cfg.get<string>('fileNaming') ?? '{issue-num}-{issue-title}',
        autosaveDelay: cfg.get<number>('autosaveDelay') ?? 60,
        syncFilters: cfg.get<IssueFilter[]>('syncFilters') ?? defaultFilters(),
        issuesLocation,
        pullInterval: cfg.get<number>('pullInterval') ?? 30,
      };
    } catch {
      // Fall through to defaults
    }
  }

  // Default config used in tests or when vscode is unavailable
  return {
    fileNaming: '{issue-num}-{issue-title}',
    autosaveDelay: 60,
    syncFilters: defaultFilters(),
    issuesLocation: path.join(workspaceFolderPath, '.issues'),
    pullInterval: 30,
  };
}

function defaultFilters(): IssueFilter[] {
  return [
    { name: 'open', query: 'is:issue state:open' },
    { name: 'closed_10days', query: 'is:issue closed:>{today-10d}' },
  ];
}

/**
 * Detects GitHub repo from git remote using vscode.git extension API.
 */
export async function detectRepo(workspaceFolder: { uri: { fsPath: string } }): Promise<RepoInfo | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
    if (!gitExtension) { return null; }

    const api = gitExtension.getAPI(1);
    if (!api) { return null; }

    const repo = api.repositories.find(
      (r: { rootUri: { fsPath: string } }) => workspaceFolder.uri.fsPath.startsWith(r.rootUri.fsPath)
    );
    if (!repo) { return null; }

    const remotes: Array<{ name: string; fetchUrl?: string; pushUrl?: string }> = repo.state.remotes ?? [];
    if (remotes.length === 0) { return null; }

    // Prefer "origin", fall back to first remote
    const remote = remotes.find(r => r.name === 'origin') ?? remotes[0];
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
 * Ensures `.issues/` is present in the workspace `.gitignore`.
 */
export async function ensureGitignore(workspaceRoot: string): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  const entry = '.issues/';

  let content = '';
  try {
    content = await fs.promises.readFile(gitignorePath, 'utf8');
  } catch {
    // File doesn't exist yet; we'll create it
  }

  const lines = content.split('\n').map(l => l.trim());
  if (!lines.includes(entry)) {
    const newContent = content.endsWith('\n') || content === ''
      ? content + entry + '\n'
      : content + '\n' + entry + '\n';
    await fs.promises.writeFile(gitignorePath, newContent, 'utf8');
  }
}
