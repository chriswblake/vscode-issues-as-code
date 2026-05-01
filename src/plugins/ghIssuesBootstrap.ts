import * as path from 'path';
import type * as vscodeType from 'vscode';
import type { SyncTarget, RepoInfo } from '../configManager';
import { GhIssuesPlugin } from './ghIssuesPlugin';
import { GitHubClient } from './githubClient';
import { registerPrimaryPlugin, type PrimarySyncPlugin, type PluginBootstrap } from './syncPlugin';

// ---------------------------------------------------------------------------
// Default targets
// ---------------------------------------------------------------------------

/**
 * Builds default sync targets for a detected GitHub repo.
 * Open issues + issues closed in the last 10 days.
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

// ---------------------------------------------------------------------------
// Repo detection
// ---------------------------------------------------------------------------

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
  const httpsMatch = url.match(/https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Creates a PrimarySyncPlugin for a target containing a 'gh-issues' config section.
 * Authenticates with GitHub and returns null if auth fails.
 */
export async function createGhIssuesPlugin(): Promise<PrimarySyncPlugin | null> {
  const client = await GitHubClient.authenticate();
  if (!client) {
    return null;
  }
  const plugin = new GhIssuesPlugin(client);
  registerPrimaryPlugin(plugin);
  return plugin;
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

/** Gets the authenticated GitHub username via VS Code's auth provider. */
export async function getAuthenticatedUsername(): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode') as typeof vscodeType;
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    if (!session) {
      return null;
    }
    return session.account.label;
  } catch {
    return null;
  }
}

/**
 * Checks if a target with matching gh-issues filters already exists in the config.
 */
export function hasDuplicateGhIssuesTarget(
  currentTargets: SyncTarget[],
  predicate: (filters: Record<string, unknown> | undefined) => boolean,
): boolean {
  return currentTargets.some((t) => {
    const ghIssues = t['gh-issues'] as { filters?: Record<string, unknown> } | undefined;
    return predicate(ghIssues?.filters);
  });
}

/**
 * Registers GitHub Issues-specific commands.
 */
export function registerGhIssuesCommands(
  context: vscodeType.ExtensionContext,
  reinitialize: () => Promise<void>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode') as typeof vscodeType;

  context.subscriptions.push(
    vscode.commands.registerCommand('issuesAsCode.addOpenIssuesDefaultConfig', async () => {
      const { folder, repoInfo } = await requireWorkspaceRepo();
      if (!folder || !repoInfo) {
        return;
      }

      const repository = `${repoInfo.owner}/${repoInfo.repo}`;
      const target: SyncTarget = {
        filesDir: '.issues/open',
        naming: '{gh-issues.number}-{gh-issues.title}',
        'gh-issues': { filters: { repository, state: 'open' } },
      };

      const cfg = vscode.workspace.getConfiguration('issuesAsCode', folder.uri);
      const currentTargets = cfg.get<SyncTarget[]>('syncTargets') ?? [];
      if (hasDuplicateGhIssuesTarget(currentTargets, (f) => f?.repository === repository && f?.state === 'open')) {
        void vscode.window.showInformationMessage(`Open issues sync target already exists for ${repository}.`);
        return;
      }

      await cfg.update('syncTargets', [...currentTargets, target], vscode.ConfigurationTarget.WorkspaceFolder);
      await reinitialize();
      void vscode.window.showInformationMessage(`Added default open issues sync target for ${repository}.`);
    }),

    vscode.commands.registerCommand('issuesAsCode.addMyIssuesOnGitHub', async () => {
      const folder = getActiveWorkspaceFolder();
      if (!folder) {
        void vscode.window.showErrorMessage('No workspace folder is open.');
        return;
      }

      const username = await getAuthenticatedUsername();
      if (!username) {
        void vscode.window.showErrorMessage('Could not authenticate with GitHub. Please sign in.');
        return;
      }

      const target: SyncTarget = {
        filesDir: '.issues/my-issues',
        naming: '{gh-issues.number}-{gh-issues.title}',
        'gh-issues': { filters: { assignee: username } },
      };

      const cfg = vscode.workspace.getConfiguration('issuesAsCode', folder.uri);
      const currentTargets = cfg.get<SyncTarget[]>('syncTargets') ?? [];
      if (hasDuplicateGhIssuesTarget(currentTargets, (f) => f?.assignee === username && !f?.state)) {
        void vscode.window.showInformationMessage(`"My issues on GitHub" sync target already exists for ${username}.`);
        return;
      }

      await cfg.update('syncTargets', [...currentTargets, target], vscode.ConfigurationTarget.WorkspaceFolder);
      await reinitialize();
      void vscode.window.showInformationMessage(`Added "My issues on GitHub" sync target for ${username}.`);
    }),

    vscode.commands.registerCommand('issuesAsCode.addMyIssuesOnThisRepo', async () => {
      const { folder, repoInfo } = await requireWorkspaceRepo();
      if (!folder || !repoInfo) {
        return;
      }

      const username = await getAuthenticatedUsername();
      if (!username) {
        void vscode.window.showErrorMessage('Could not authenticate with GitHub. Please sign in.');
        return;
      }

      const repository = `${repoInfo.owner}/${repoInfo.repo}`;
      const target: SyncTarget = {
        filesDir: `.issues/${repoInfo.repo}-my-issues`,
        naming: '{gh-issues.number}-{gh-issues.title}',
        'gh-issues': { filters: { repository, assignee: username, state: 'open' } },
      };

      const cfg = vscode.workspace.getConfiguration('issuesAsCode', folder.uri);
      const currentTargets = cfg.get<SyncTarget[]>('syncTargets') ?? [];
      if (hasDuplicateGhIssuesTarget(currentTargets, (f) => f?.repository === repository && f?.assignee === username)) {
        void vscode.window.showInformationMessage(`"My issues on this repository" sync target already exists for ${username} on ${repository}.`);
        return;
      }

      await cfg.update('syncTargets', [...currentTargets, target], vscode.ConfigurationTarget.WorkspaceFolder);
      await reinitialize();
      void vscode.window.showInformationMessage(`Added "My issues on this repository" sync target for ${username} on ${repository}.`);
    }),
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getActiveWorkspaceFolder(): vscodeType.WorkspaceFolder | undefined {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode') as typeof vscodeType;
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder;
    }
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders[0];
}

async function requireWorkspaceRepo(): Promise<{ folder?: vscodeType.WorkspaceFolder; repoInfo?: RepoInfo }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode') as typeof vscodeType;
  const folder = getActiveWorkspaceFolder();
  if (!folder) {
    void vscode.window.showErrorMessage('No workspace folder is open.');
    return {};
  }
  const repoInfo = await detectRepo(folder);
  if (!repoInfo) {
    void vscode.window.showErrorMessage('Could not detect a GitHub repository from this workspace folder.');
    return { folder };
  }
  return { folder, repoInfo };
}

// ---------------------------------------------------------------------------
// Bootstrap export — standard interface for dynamic plugin loading
// ---------------------------------------------------------------------------

export const bootstrap: PluginBootstrap = {
  pluginId: 'gh-issues',

  async initialize(): Promise<boolean> {
    const plugin = await createGhIssuesPlugin();
    return plugin !== null;
  },

  registerCommands(
    context: { subscriptions: { dispose(): void }[] },
    reinitialize: () => Promise<void>,
  ): void {
    registerGhIssuesCommands(context as vscodeType.ExtensionContext, reinitialize);
  },

  async detectDefaults(workspaceFolder: { uri: { fsPath: string } }): Promise<SyncTarget[] | null> {
    const repoInfo = await detectRepo(workspaceFolder);
    if (!repoInfo) {
      return null;
    }
    return defaultSyncTargets(repoInfo.owner, repoInfo.repo, workspaceFolder.uri.fsPath);
  },
};
