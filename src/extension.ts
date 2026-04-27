import * as vscode from 'vscode';
import * as path from 'path';
import { detectRepo, getConfig, ensureGitignore, defaultSyncTargets, repoInfoFromTarget } from './configManager';
import { GitHubClient } from './githubClient';
import { SyncManager } from './syncManager';
import { SyncStateManager } from './syncStateManager';

const syncManagers: SyncManager[] = [];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await reinitializeAllFolders(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('issueSync.pullNow', async () => {
      if (syncManagers.length === 0) {
        await reinitializeAllFolders(context);
      }
      if (syncManagers.length === 0) {
        void vscode.window.showWarningMessage('No sync targets are active for this workspace. Configure issueSync.syncTargets or open a folder with a GitHub remote.');
        return;
      }
      syncManagers.forEach((m) => void m.pullAll());
    }),
    vscode.commands.registerCommand('issueSync.pushNow', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const filePath = editor.document.uri.fsPath;
        // Push via the manager that owns this file
        const manager = syncManagers.find((m) => m.ownsFile(filePath));
        if (manager) {
          void manager.pushFile(filePath);
        }
      }
    }),
    vscode.commands.registerCommand('issueSync.refresh', async () => {
      if (syncManagers.length === 0) {
        await reinitializeAllFolders(context);
      }
      if (syncManagers.length === 0) {
        void vscode.window.showWarningMessage('No sync targets are active for this workspace. Configure issueSync.syncTargets or open a folder with a GitHub remote.');
        return;
      }
      syncManagers.forEach((m) => void m.pullAll());
    }),
    vscode.commands.registerCommand('issueSync.addOpenIssuesDefaultConfig', async () => {
      const folder = getActiveWorkspaceFolder();
      if (!folder) {
        void vscode.window.showErrorMessage('No workspace folder is open.');
        return;
      }

      const repoInfo = await detectRepo(folder);
      if (!repoInfo) {
        void vscode.window.showErrorMessage('Could not detect a GitHub repository from this workspace folder.');
        return;
      }

      const cfg = vscode.workspace.getConfiguration('issueSync', folder.uri);
      const currentTargets = cfg.get<Array<{ repository_url: string; query: string; location: string }>>('syncTargets') ?? [];

      const repositoryUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}`;
      const openIssuesTarget = {
        repository_url: repositoryUrl,
        query: 'is:issue state:open',
        location: '{workspaceDir}/.issues/open',
      };

      const hasOpenTarget = currentTargets.some((t) => t.repository_url === repositoryUrl && t.query.trim() === openIssuesTarget.query);

      if (hasOpenTarget) {
        void vscode.window.showInformationMessage(`Open issues sync target already exists for ${repoInfo.owner}/${repoInfo.repo}.`);
        return;
      }

      await cfg.update('syncTargets', [...currentTargets, openIssuesTarget], vscode.ConfigurationTarget.WorkspaceFolder);

      await reinitializeAllFolders(context);

      void vscode.window.showInformationMessage(`Added default open issues sync target for ${repoInfo.owner}/${repoInfo.repo}.`);
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('issueSync')) {
        await reinitializeAllFolders(context);
      }
    }),
  );
}

async function reinitializeAllFolders(context: vscode.ExtensionContext): Promise<void> {
  syncManagers.forEach((m) => m.dispose());
  syncManagers.length = 0;

  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    await activateFolder(folder, context);
  }
}

function getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
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

async function activateFolder(folder: vscode.WorkspaceFolder, context: vscode.ExtensionContext): Promise<void> {
  const config = getConfig(folder.uri.fsPath, folder);

  // Use explicitly configured targets; fall back to auto-detected repo with defaults
  let targets = config.syncTargets;
  if (targets.length === 0) {
    const repoInfo = await detectRepo(folder);
    if (!repoInfo) {
      return;
    }
    targets = defaultSyncTargets(repoInfo.owner, repoInfo.repo, folder.uri.fsPath);
  }

  await ensureGitignore(folder.uri.fsPath, [...targets.map((t) => t.location), config.syncStatePath]);
  await applyFilesExclude(folder, config);

  const stateManager = new SyncStateManager(config.syncStatePath);
  await stateManager.load();
  stateManager.watchForDeletion();
  context.subscriptions.push({ dispose: () => stateManager.dispose() });

  for (const target of targets) {
    const repoInfo = repoInfoFromTarget(target);
    if (!repoInfo) {
      console.warn(`[issueSync] Skipping target with unparseable repository_url: ${target.repository_url}`);
      continue;
    }
    const client = await GitHubClient.authenticate(repoInfo.owner, repoInfo.repo);
    if (!client) {
      continue;
    }

    const manager = new SyncManager(client, config, target, folder, context, stateManager);
    await manager.start();
    syncManagers.push(manager);
    context.subscriptions.push({ dispose: () => manager.dispose() });
  }
}

export function deactivate(): void {
  syncManagers.forEach((m) => m.dispose());
  syncManagers.length = 0;
}

/**
 * Adds or removes the sync state file from VS Code's files.exclude setting
 * based on the showSyncState configuration.
 */
async function applyFilesExclude(folder: vscode.WorkspaceFolder, config: import('./configManager').IssueConfig): Promise<void> {
  const relPath = path.relative(folder.uri.fsPath, config.syncStatePath);
  if (relPath.startsWith('..')) {
    return; // Sync state file is outside workspace — skip
  }

  const filesConfig = vscode.workspace.getConfiguration('files', folder.uri);
  // Use inspect() to read only the folder-level value, not the merged global defaults
  const folderExclude = { ...(filesConfig.inspect<Record<string, boolean>>('exclude')?.workspaceFolderValue ?? {}) };

  if (config.showSyncState) {
    delete folderExclude[relPath];
  } else {
    folderExclude[relPath] = true;
  }

  await filesConfig.update('exclude', folderExclude, vscode.ConfigurationTarget.WorkspaceFolder);
}
