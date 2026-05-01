import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig, ensureGitignore, type SyncTarget } from './configManager';
import { SyncManager, reconcileTargetChanges } from './syncManager';
import { SyncStateManager } from './syncStateManager';
import { IssueDecorationProvider } from './issueDecorationProvider';
import { PublishCodeLensProvider } from './publishCodeLensProvider';
import { initializePlugins, registerPluginCommands, detectDefaultTargets } from './plugins/loader';
import { getPrimaryPlugin, getPrimaryPluginIds, type PrimarySyncPlugin } from './plugins/syncPlugin';

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

  // Plugin-specific commands
  registerPluginCommands(context, () => reinitializeAllFolders(context));
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

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
        const detected = await detectDefaultTargets(folder);
        if (detected) {
          newTargets = detected;
        }
      }
      await reconcileTargetChanges(old.targets, newTargets, old.stateManager);
    }

    await activateFolder(folder, context);
  }
}

/**
 * Resolves a PrimarySyncPlugin for a target by inspecting which registered
 * plugin IDs have a config section in the target.
 */
function resolvePluginForTarget(target: SyncTarget): PrimarySyncPlugin | null {
  // Check registered plugin IDs
  for (const pluginId of getPrimaryPluginIds()) {
    if (target[pluginId] !== undefined) {
      const plugin = getPrimaryPlugin(pluginId);
      if (plugin) {
        return plugin;
      }
    }
  }
  return null;
}

async function activateFolder(folder: vscode.WorkspaceFolder, context: vscode.ExtensionContext): Promise<void> {
  const config = getConfig(folder.uri.fsPath, folder);

  // Use explicitly configured targets; fall back to plugin-detected defaults
  let targets = config.syncTargets;
  if (targets.length === 0) {
    const detected = await detectDefaultTargets(folder);
    if (!detected) {
      return;
    }
    targets = detected;
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

  // Ensure plugins are initialized (authenticate once per activation)
  if (getPrimaryPluginIds().length === 0) {
    const initialized = await initializePlugins();
    if (initialized.length === 0) {
      console.warn('[issuesAsCode] No plugins could be initialized');
      return;
    }
  }

  for (const target of targets) {
    const plugin = resolvePluginForTarget(target);
    if (!plugin) {
      console.warn(`[issuesAsCode] No plugin found for target: ${JSON.stringify(target)}`);
      continue;
    }

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
      displayName: m.plugin.displayName,
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
    return;
  }

  const filesConfig = vscode.workspace.getConfiguration('files', folder.uri);
  const folderExclude = { ...(filesConfig.inspect<Record<string, boolean>>('exclude')?.workspaceFolderValue ?? {}) };

  if (config.showSyncState) {
    delete folderExclude[relPath];
  } else {
    folderExclude[relPath] = true;
  }

  await filesConfig.update('exclude', folderExclude, vscode.ConfigurationTarget.WorkspaceFolder);
}
