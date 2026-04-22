import * as vscode from 'vscode';
import { detectRepo, getConfig, ensureGitignore } from './configManager';
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
      // Push all currently open issue files
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        syncManagers.forEach(m => void m.pushFile(editor.document.uri.fsPath));
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
  const repoInfo = await detectRepo(folder);
  if (!repoInfo) { return; }

  const config = getConfig(folder.uri.fsPath, folder);
  await ensureGitignore(folder.uri.fsPath);

  const client = await GitHubClient.authenticate(repoInfo.owner, repoInfo.repo);
  if (!client) { return; }

  const manager = new SyncManager(client, config, folder, context);
  await manager.start();
  syncManagers.push(manager);
  context.subscriptions.push({ dispose: () => manager.dispose() });
}

export function deactivate(): void {
  syncManagers.forEach(m => m.dispose());
  syncManagers.length = 0;
}
