import * as vscode from 'vscode';
import { detectRepo, getConfig, ensureGitignore, defaultSyncTargets, repoInfoFromTarget } from './configManager';
import { GitHubClient } from './githubClient';
import { SyncManager } from './syncManager';

const syncManagers: SyncManager[] = [];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    await activateFolder(folder, context);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('issueSync.pullNow', () => {
      syncManagers.forEach(m => void m.pullAll());
    }),
    vscode.commands.registerCommand('issueSync.pushNow', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const filePath = editor.document.uri.fsPath;
        // Push via the manager that owns this file
        const manager = syncManagers.find(m => m.ownsFile(filePath));
        if (manager) {
          void manager.pushFile(filePath);
        }
      }
    }),
    vscode.commands.registerCommand('issueSync.refresh', () => {
      syncManagers.forEach(m => void m.pullAll());
    })
  );
}

async function activateFolder(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext
): Promise<void> {
  const config = getConfig(folder.uri.fsPath, folder);

  // Use explicitly configured targets; fall back to auto-detected repo with defaults
  let targets = config.syncTargets;
  if (targets.length === 0) {
    const repoInfo = await detectRepo(folder);
    if (!repoInfo) { return; }
    targets = defaultSyncTargets(repoInfo.owner, repoInfo.repo, folder.uri.fsPath);
  }

  await ensureGitignore(folder.uri.fsPath, targets.map(t => t.location));

  for (const target of targets) {
    const repoInfo = repoInfoFromTarget(target);
    if (!repoInfo) {
      console.warn(`[issueSync] Skipping target with unparseable repository_url: ${target.repository_url}`);
      continue;
    }
    const client = await GitHubClient.authenticate(repoInfo.owner, repoInfo.repo);
    if (!client) { continue; }

    const manager = new SyncManager(client, config, target, folder, context);
    await manager.start();
    syncManagers.push(manager);
    context.subscriptions.push({ dispose: () => manager.dispose() });
  }
}

export function deactivate(): void {
  syncManagers.forEach(m => m.dispose());
  syncManagers.length = 0;
}
