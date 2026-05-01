import * as vscode from 'vscode';
import * as path from 'path';
import { detectRepo, getConfig, ensureGitignore, defaultSyncTargets, repoInfoFromTarget, type SyncTarget } from './configManager';
import { GitHubClient } from './githubClient';
import { SyncManager, reconcileTargetChanges } from './syncManager';
import { SyncStateManager } from './syncStateManager';
import { IssueDecorationProvider } from './issueDecorationProvider';
import { PublishCodeLensProvider } from './publishCodeLensProvider';
import { GhIssuesPlugin } from './plugins/ghIssuesPlugin';
import { registerPrimaryPlugin, type PrimarySyncPlugin } from './plugins/syncPlugin';

const syncManagers: SyncManager[] = [];
let decorationProvider: IssueDecorationProvider | undefined;
let codeLensProvider: PublishCodeLensProvider | undefined;

// Serializes reinitializations so rapid config-change events don't overlap.
// Each call is chained after the previous one; all callers await the same chain tail.
let reinitializeChain: Promise<void> = Promise.resolve();

// Delays reinitialize after a config change so mid-edit partial values are ignored.
const CONFIG_CHANGE_DEBOUNCE_MS = 3000;
let configChangeDebounceTimer: NodeJS.Timeout | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerProviders(context);
  await reinitializeAllFolders(context);
  registerCommands(context);
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

function registerProviders(context: vscode.ExtensionContext): void {
  // File decoration provider (sync state badges)
  decorationProvider = new IssueDecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

  // CodeLens provider for unpublished files
  codeLensProvider = new PublishCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file', language: 'markdown' }, codeLensProvider),
  );

  // Track unsaved editor changes to show M badge immediately
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const filePath = event.document.uri.fsPath;
      if (event.document.isDirty) {
        decorationProvider?.markDirty(filePath);
      } else {
        decorationProvider?.clearDirty(filePath);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      decorationProvider?.clearDirty(document.uri.fsPath);
    }),
  );
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

function registerCommands(context: vscode.ExtensionContext): void {
  async function ensureManagersAndPull(): Promise<void> {
    if (syncManagers.length === 0) {
      await reinitializeAllFolders(context);
    }
    if (syncManagers.length === 0) {
      void vscode.window.showWarningMessage('No sync targets are active for this workspace. Configure issuesAsCode.syncTargets or open a folder with a GitHub remote.');
      return;
    }
    syncManagers.forEach((m) => void m.pullAll());
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('issuesAsCode.pullNow', ensureManagersAndPull),
    vscode.commands.registerCommand('issuesAsCode.pushNow', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const filePath = editor.document.uri.fsPath;
        const manager = syncManagers.find((m) => m.ownsFile(filePath));
        if (manager) {
          void manager.pushFile(filePath);
        }
      }
    }),
    vscode.commands.registerCommand('issuesAsCode.refresh', ensureManagersAndPull),
    vscode.commands.registerCommand('issuesAsCode.publishFile', async (uri?: vscode.Uri) => {
      const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!fileUri) {
        void vscode.window.showWarningMessage('No file is open to publish.');
        return;
      }

      const filePath = fileUri.fsPath;
      const manager = syncManagers.find((m) => m.ownsFile(filePath));
      if (!manager) {
        void vscode.window.showWarningMessage('This file is not inside a managed sync target folder.');
        return;
      }

      try {
        await manager.pushFile(filePath);
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to publish file: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
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

      const isDuplicate = await hasDuplicateTarget(folder, (ghFilters) =>
        ghFilters?.repository === repository && ghFilters?.state === 'open',
      );
      if (isDuplicate) {
        void vscode.window.showInformationMessage(`Open issues sync target already exists for ${repository}.`);
        return;
      }

      await appendSyncTarget(folder, target, context);
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

      const isDuplicate = await hasDuplicateTarget(folder, (ghFilters) =>
        ghFilters?.assignee === username && !ghFilters?.state,
      );
      if (isDuplicate) {
        void vscode.window.showInformationMessage(`"My issues on GitHub" sync target already exists for ${username}.`);
        return;
      }

      await appendSyncTarget(folder, target, context);
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

      const isDuplicate = await hasDuplicateTarget(folder, (ghFilters) =>
        ghFilters?.repository === repository && ghFilters?.assignee === username,
      );
      if (isDuplicate) {
        void vscode.window.showInformationMessage(`"My issues on this repository" sync target already exists for ${username} on ${repository}.`);
        return;
      }

      await appendSyncTarget(folder, target, context);
      void vscode.window.showInformationMessage(`Added "My issues on this repository" sync target for ${username} on ${repository}.`);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('issuesAsCode')) {
        if (configChangeDebounceTimer) {
          clearTimeout(configChangeDebounceTimer);
        }
        configChangeDebounceTimer = setTimeout(() => {
          configChangeDebounceTimer = null;
          void reinitializeAllFolders(context);
        }, CONFIG_CHANGE_DEBOUNCE_MS);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

/** Resolves workspace folder + repo info, showing errors if either is missing. */
async function requireWorkspaceRepo(): Promise<{ folder?: vscode.WorkspaceFolder; repoInfo?: { owner: string; repo: string } }> {
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

/** Checks if a target with matching gh-issues filters already exists. */
async function hasDuplicateTarget(
  folder: vscode.WorkspaceFolder, //
  predicate: (filters: Record<string, unknown> | undefined) => boolean,
): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('issuesAsCode', folder.uri);
  const currentTargets = cfg.get<SyncTarget[]>('syncTargets') ?? [];
  return currentTargets.some((t) => {
    const ghIssues = t['gh-issues'] as { filters?: Record<string, unknown> } | undefined;
    return predicate(ghIssues?.filters);
  });
}

/** Appends a sync target to the workspace config and reinitializes. */
async function appendSyncTarget(
  folder: vscode.WorkspaceFolder, //
  target: SyncTarget,
  context: vscode.ExtensionContext,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('issuesAsCode', folder.uri);
  const currentTargets = cfg.get<SyncTarget[]>('syncTargets') ?? [];
  await cfg.update('syncTargets', [...currentTargets, target], vscode.ConfigurationTarget.WorkspaceFolder);
  await reinitializeAllFolders(context);
}

async function reinitializeAllFolders(context: vscode.ExtensionContext): Promise<void> {
  reinitializeChain = reinitializeChain
    .catch(() => {
      /* ignore errors from prior run */
    })
    .then(() => doReinitializeAllFolders(context));
  return reinitializeChain;
}

async function doReinitializeAllFolders(context: vscode.ExtensionContext): Promise<void> {
  // Capture old targets and the shared state manager per folder before tearing down
  const oldStateByFolder = new Map<string, { targets: SyncTarget[]; stateManager: SyncStateManager }>();
  for (const manager of syncManagers) {
    const fsPath = manager.workspaceFolderFsPath;
    if (!oldStateByFolder.has(fsPath)) {
      oldStateByFolder.set(fsPath, { targets: [], stateManager: manager.stateManager });
    }
    oldStateByFolder.get(fsPath)!.targets.push(manager.target);
  }

  syncManagers.forEach((m) => m.dispose());
  syncManagers.length = 0;

  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    // Reconcile moved/removed targets before starting new managers
    const old = oldStateByFolder.get(folder.uri.fsPath);
    if (old && old.targets.length > 0) {
      const newConfig = getConfig(folder.uri.fsPath, folder);
      let newTargets = newConfig.syncTargets;
      if (newTargets.length === 0) {
        const repoInfo = await detectRepo(folder);
        if (repoInfo) {
          newTargets = defaultSyncTargets(repoInfo.owner, repoInfo.repo, folder.uri.fsPath);
        }
      }
      await reconcileTargetChanges(old.targets, newTargets, old.stateManager);
    }

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

/** Gets the authenticated GitHub username via VS Code's auth provider. */
async function getAuthenticatedUsername(): Promise<string | null> {
  try {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    if (!session) {
      return null;
    }
    // The session.account.label is the GitHub username
    return session.account.label;
  } catch {
    return null;
  }
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

  await ensureGitignore(folder.uri.fsPath, [...targets.map((t) => t.filesDir), config.syncStatePath]);
  await applyFilesExclude(folder, config);

  const stateManager = new SyncStateManager(config.syncStatePath);
  await stateManager.load();
  stateManager.watchForDeletion();
  context.subscriptions.push({ dispose: () => stateManager.dispose() });

  // Refresh file decorations and clear dirty state when sync confirms a match
  const unsubscribeDecorations = stateManager.onDidChange((filePath) => {
    decorationProvider?.clearDirty(filePath);
    decorationProvider?.refresh(filePath);
  });
  context.subscriptions.push({ dispose: unsubscribeDecorations });

  // Remove state entries for files no longer under any active target location
  const activeLocations = new Set(targets.map((t) => t.filesDir));
  for (const filePath of stateManager.getKnownFilePaths()) {
    const isActive = [...activeLocations].some((loc) => filePath.startsWith(loc + path.sep));
    if (!isActive) {
      await stateManager.deleteEntry(filePath);
    }
  }

  // Authenticate once — GitHubClient is no longer repo-scoped
  const client = await GitHubClient.authenticate();
  if (!client) {
    console.warn('[issuesAsCode] Failed to authenticate with GitHub');
    return;
  }

  for (const target of targets) {
    // Validate the target has a gh-issues section (repository is optional for cross-repo)
    const ghIssues = target['gh-issues'] as Record<string, unknown> | undefined;
    if (!ghIssues) {
      console.warn(`[issuesAsCode] Skipping target without a plugin config: ${JSON.stringify(target)}`);
      continue;
    }

    // Create the appropriate plugin instance and register it
    const plugin: PrimarySyncPlugin = new GhIssuesPlugin(client);
    registerPrimaryPlugin(plugin);

    const manager = new SyncManager(plugin, config, target, folder, context, stateManager);
    await manager.start();
    syncManagers.push(manager);
    context.subscriptions.push({ dispose: () => manager.dispose() });
  }

  // Update decoration provider with all active managed locations and config
  if (decorationProvider) {
    const locations = syncManagers.map((m) => ({ location: m.target.filesDir, stateManager: m.stateManager }));
    decorationProvider.update(locations, config.showSyncIcons);
  }

  // Update CodeLens provider with managed targets
  if (codeLensProvider) {
    const codeLensTargets = syncManagers.map((m) => ({
      filesDir: m.target.filesDir,
      pluginId: m.plugin.id,
    }));
    codeLensProvider.update(codeLensTargets);
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
