import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  getConfig,
  ensureGitignore,
  type SyncTarget,
  type AutoPushMode,
} from "./configManager";
import {
  SyncOrchestrator,
  switchEditorToRenamedFile,
  type RefreshResult,
  type PushEventInfo,
} from "./syncOrchestrator";
import { hasConflictMarkers } from "./diffHelpers";
import {
  reconcileTargetChanges, //
} from "./targetReconciliation";
import {
  SyncStateStore, //
  type RemoteIssueInfo,
} from "./syncStateStore";
import {
  readIssueFile, //
  type IssueFrontmatter,
} from "./fileManager";
import { FileDecorator } from "./fileDecorator";
import { SyncCodeLensProvider } from "./syncCodeLensProvider";
import { RateLimitMonitor } from "./rateLimitMonitor";
import {
  StatusBarManager,
  type SyncSummary,
  type SyncTargetSummary,
} from "./statusBarManager";
import {
  initializePlugins,
  registerPluginCommands,
  registerPluginProviders,
  detectDefaultTargets,
  persistDefaultTargets,
  getAllIncludedConfigs,
  type IncludedConfigItem,
} from "./plugins/loader";
import { getPrimaryPlugin, getPrimaryPluginIds } from "./pluginRegistry";
import type { PrimarySyncPlugin, ManagedPluginTarget } from "./pluginTypes";

const syncManagers: SyncOrchestrator[] = [];
let decorationProvider: FileDecorator | undefined;
let codeLensProvider: SyncCodeLensProvider | undefined;
let rateLimitMonitor: RateLimitMonitor | undefined;
let statusBarManager: StatusBarManager | undefined;
const syncChangeUnsubscribers: (() => void)[] = [];
const pushChangeUnsubscribers: (() => void)[] = [];
const targetChangeListeners: (() => void)[] = [];

// Serializes reinitializations so rapid config-change events don't overlap.
// Each call is chained after the previous one; all callers await the same chain tail.
let reinitializeChain: Promise<void> = Promise.resolve();

// Delays reinitialize after a config change so mid-edit partial values are ignored.
const CONFIG_CHANGE_DEBOUNCE_MS = 3000;
let configChangeDebounceTimer: NodeJS.Timeout | null = null;

/** Resolves the autoPush mode for a file by finding its owning manager. */
function getAutoPushMode(filePath: string): AutoPushMode | undefined {
  const manager = syncManagers.find((m) => m.ownsFile(filePath));
  return manager?.config.autoPush;
}

/**
 * After a successful push, propagates the server-normalized content to sibling
 * copies of the same issue in other sync targets, including updated sync state.
 */
async function propagateToSiblings(
  info: PushEventInfo,
  sourceManager: SyncOrchestrator,
): Promise<void> {
  const siblingPaths = sourceManager.stateManager.findAllFilesByPluginKey(
    info.pluginId,
    info.remoteKey,
  );
  if (siblingPaths.length <= 1) {
    return;
  }

  let frontmatter: IssueFrontmatter;
  let body: string;
  try {
    const parsed = await readIssueFile(info.filePath);
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch {
    return;
  }

  const pluginData = sourceManager.stateManager.getPluginData(
    info.filePath,
    info.pluginId,
  );
  if (!pluginData) {
    return;
  }

  const remoteInfo = pluginData as unknown as RemoteIssueInfo;

  for (const siblingPath of siblingPaths) {
    if (siblingPath === info.filePath) {
      continue;
    }

    const siblingManager = syncManagers.find((m) => m.ownsFile(siblingPath));
    if (!siblingManager) {
      continue;
    }

    try {
      await siblingManager.propagateFromSibling(
        siblingPath,
        frontmatter,
        body,
        remoteInfo,
        info.remoteKey,
      );
    } catch (err) {
      console.error(
        `[issuesAsCode] sibling propagation failed for "${siblingPath}":`,
        err,
      );
    }
  }
}

/**
 * Propagates local file edits to sibling copies in other sync targets.
 * Works without internet — copies raw file content and updates local_written_at
 * so the siblings aren't flagged as locally modified or conflict.
 */
async function propagateLocalEditsToSiblings(
  filePath: string,
  sourceManager: SyncOrchestrator,
): Promise<void> {
  const remoteKey = sourceManager.stateManager.getRemoteKey(
    filePath,
    sourceManager.plugin.id,
  );
  if (!remoteKey) {
    return;
  }

  const siblingPaths = sourceManager.stateManager.findAllFilesByPluginKey(
    sourceManager.plugin.id,
    remoteKey,
  );
  if (siblingPaths.length <= 1) {
    return;
  }

  // Read the saved file's raw content
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf8");
  } catch {
    return;
  }

  // Skip propagation if the file has unresolved conflict markers
  if (hasConflictMarkers(content)) {
    return;
  }

  for (const siblingPath of siblingPaths) {
    if (siblingPath === filePath) {
      continue;
    }

    const siblingManager = syncManagers.find((m) => m.ownsFile(siblingPath));
    if (!siblingManager) {
      continue;
    }

    try {
      await siblingManager.propagateLocalEdit(siblingPath, content);
    } catch (err) {
      console.error(
        `[issuesAsCode] local sibling propagation failed for "${siblingPath}":`,
        err,
      );
    }
  }
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  registerProviders(context);
  await reinitializeAllFolders(context);
  registerCommands(context);
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

function registerProviders(context: vscode.ExtensionContext): void {
  // File decoration provider (sync state badges)
  decorationProvider = new FileDecorator();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider),
  );

  // CodeLens provider for unpublished files
  codeLensProvider = new SyncCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { scheme: "file", language: "markdown" },
        { scheme: "file", language: "task-md" },
      ],
      codeLensProvider,
    ),
  );

  // Rate limit monitor (pause logic)
  rateLimitMonitor = new RateLimitMonitor();
  context.subscriptions.push({ dispose: () => rateLimitMonitor?.dispose() });

  // Status bar manager (icon + tooltip + panel)
  statusBarManager = new StatusBarManager();
  statusBarManager.createStatusBar(context, "issuesAsCode.refresh");
  context.subscriptions.push({ dispose: () => statusBarManager?.dispose() });

  // Update status bar when rate limit state changes
  const unsubscribeRateLimit = rateLimitMonitor.onDidChange(() => {
    refreshStatusBarSummary();
  });
  context.subscriptions.push({ dispose: unsubscribeRateLimit });

  // Let plugins register their own VS Code providers
  registerPluginProviders({
    extensionContext: context,
    rateLimitMonitor,
    getTargets: () => getPluginTargets(),
    onDidChangeTargets: (listener) => {
      targetChangeListeners.push(listener);
      return () => {
        const idx = targetChangeListeners.indexOf(listener);
        if (idx >= 0) {
          targetChangeListeners.splice(idx, 1);
        }
      };
    },
  });

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

  // ---------------------------------------------------------------------------
  // Push triggers: manual save, focus change, window change
  // ---------------------------------------------------------------------------

  // Track save reasons so onDidSave can distinguish manual from auto saves
  const lastSaveReason = new Map<string, vscode.TextDocumentSaveReason>();

  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((event) => {
      lastSaveReason.set(event.document.uri.fsPath, event.reason);
    }),
  );

  // Manual save → push immediately (regardless of autoPush setting)
  // All saves → propagate local edits to sibling copies in other targets
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const filePath = document.uri.fsPath;
      const reason = lastSaveReason.get(filePath);
      lastSaveReason.delete(filePath);

      const manager = syncManagers.find((m) => m.ownsFile(filePath));
      if (!manager) {
        return;
      }

      if (reason === vscode.TextDocumentSaveReason.Manual) {
        void manager.pushNowIfPublished(filePath);
      }

      // Propagate to sibling copies (works offline, no push required)
      void propagateLocalEditsToSiblings(filePath, manager);
    }),
  );

  // Focus change → push previously active file (when autoPush is "onFocusChange")
  let previousActiveFilePath: string | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const fileToFlush = previousActiveFilePath;
      previousActiveFilePath = editor?.document.uri.fsPath;

      if (!fileToFlush) {
        return;
      }
      const manager = syncManagers.find((m) => m.ownsFile(fileToFlush));
      if (manager && getAutoPushMode(fileToFlush) === "onFocusChange") {
        void manager.pushNowIfPublished(fileToFlush);
      }
    }),
  );

  // Window change → push all modified managed files (when autoPush is "onWindowChange")
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        return;
      }
      for (const manager of syncManagers) {
        if (manager.config.autoPush !== "onWindowChange") {
          continue;
        }
        const entries = manager.stateManager.getFilesUnderLocation(
          manager.target.filesDir,
        );
        for (const [filePath] of entries) {
          void manager.pushNowIfPublished(filePath);
        }
      }
    }),
  );

  // Fetch remote state when a task file is opened
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      const filePath = document.uri.fsPath;
      if (!filePath.endsWith(".task.md")) {
        return;
      }
      const manager = syncManagers.find((m) => m.ownsFile(filePath));
      if (manager) {
        void manager.fetchFile(filePath);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("issuesAsCode.refresh", async () => {
      // Ensure managers exist; reinitialize counts as the first pull
      let justInitialized = false;
      if (syncManagers.length === 0) {
        await reinitializeAllFolders(context);
        justInitialized = true;
      }
      if (syncManagers.length === 0) {
        void vscode.window.showWarningMessage(
          "No sync targets are active for this workspace. Configure issuesAsCode.syncTargets in your settings.",
        );
        return;
      }

      // Reinitialize already pulled all targets — skip the redundant pull
      if (justInitialized) {
        void vscode.window.showInformationMessage(
          "Issues as Code: Targets initialized and refreshed.",
        );
        return;
      }

      // Select which targets to refresh
      let managersToRefresh: SyncOrchestrator[];
      if (syncManagers.length === 1) {
        managersToRefresh = syncManagers;
      } else {
        const items = syncManagers.map((m) => ({
          label: m.displayName,
          picked: true,
          manager: m,
        }));
        const selected = await vscode.window.showQuickPick(items, {
          title: "Issues as Code: Refresh",
          placeHolder: "Select sync targets to refresh",
          canPickMany: true,
        });
        if (!selected || selected.length === 0) {
          return;
        }
        managersToRefresh = selected.map((s) => s.manager);
      }

      // Run refresh with progress indicator
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Issues as Code: Refreshing…",
        },
        async () => {
          const results = await Promise.allSettled(
            managersToRefresh.map((m) => m.refresh()),
          );

          // Summarize results
          const settled = results
            .filter(
              (r): r is PromiseFulfilledResult<RefreshResult> =>
                r.status === "fulfilled",
            )
            .map((r) => r.value);

          const succeeded = settled.filter((r) => r.status === "success");
          const skipped = settled.filter((r) => r.status === "skipped");
          const failed = settled.filter((r) => r.status === "error");

          if (failed.length > 0) {
            const names = failed.map((r) => r.name).join(", ");
            void vscode.window.showErrorMessage(`Refresh failed for: ${names}`);
          } else if (skipped.length > 0 && succeeded.length === 0) {
            void vscode.window.showWarningMessage(
              "Refresh skipped — API rate limit is paused.",
            );
          }
        },
      );
    }),
    vscode.commands.registerCommand("issuesAsCode.addSyncTarget", async () => {
      const folder = getActiveWorkspaceFolder();
      if (!folder) {
        void vscode.window.showErrorMessage("No workspace folder is open.");
        return;
      }

      // Collect available preset configs from all plugins
      const items = await getAllIncludedConfigs(folder);
      if (items.length === 0) {
        void vscode.window.showWarningMessage(
          "No sync target presets are available. Check your authentication and workspace configuration.",
        );
        return;
      }

      // Build QuickPick items, prefixed by plugin name
      const pickItems = items.map((item) => ({
        label: `${item.pluginDisplayName}: ${item.config.label}`,
        description: item.config.description,
        item,
      }));

      const selected = await vscode.window.showQuickPick(pickItems, {
        title: "Issues as Code: Add Sync Target",
        placeHolder: "Select a sync target preset to add",
      });
      if (!selected) {
        return;
      }

      // Check for duplicates
      const cfg = vscode.workspace.getConfiguration("issuesAsCode", folder.uri);
      const currentTargets = cfg.get<SyncTarget[]>("syncTargets") ?? [];
      if (selected.item.config.isDuplicate(currentTargets)) {
        void vscode.window.showInformationMessage(
          `A matching "${selected.item.config.label}" sync target already exists.`,
        );
        return;
      }

      // Add the target to workspace settings
      await cfg.update(
        "syncTargets",
        [...currentTargets, selected.item.config.target],
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
      await reinitializeAllFolders(context);
      void vscode.window.showInformationMessage(
        `Added sync target: ${selected.item.config.label}.`,
      );
    }),

    // Internal commands (used by CodeLens, not exposed in the command palette)
    vscode.commands.registerCommand(
      "issuesAsCode.publishFile",
      async (uri?: vscode.Uri) => {
        const resolved = resolveFileManager(uri, "publish");
        if (!resolved) {
          return;
        }

        try {
          const newPath = await resolved.manager.pushFile(resolved.filePath, {
            interactive: true,
          });
          if (newPath) {
            await switchEditorToRenamedFile(resolved.filePath, newPath);
          }
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to publish file: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "issuesAsCode.pullFile",
      async (uri?: vscode.Uri) => {
        const resolved = resolveFileManager(uri, "pull");
        if (!resolved) {
          return;
        }

        try {
          await resolved.manager.pullFile(resolved.filePath);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to pull file: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("issuesAsCode")) {
        if (configChangeDebounceTimer) {
          clearTimeout(configChangeDebounceTimer);
        }
        configChangeDebounceTimer = setTimeout(() => {
          configChangeDebounceTimer = null;
          void reinitializeAllFolders(context);
        }, CONFIG_CHANGE_DEBOUNCE_MS);
      }

      // Update rate limit threshold without full reinitialize
      if (event.affectsConfiguration("issuesAsCode.rateLimitThreshold")) {
        const cfg = vscode.workspace.getConfiguration("issuesAsCode");
        const threshold = cfg.get<number>("rateLimitThreshold") ?? 5;
        rateLimitMonitor?.setThreshold(threshold);
      }

      // Update status bar visibility without full reinitialize
      if (event.affectsConfiguration("issuesAsCode.showStatusBarIcon")) {
        const cfg = vscode.workspace.getConfiguration("issuesAsCode");
        const visible = cfg.get<boolean>("showStatusBarIcon") ?? true;
        statusBarManager?.setVisible(visible);
      }
    }),
  );

  // Plugin-specific commands
  registerPluginCommands(context, () => reinitializeAllFolders(context));
}

// ---------------------------------------------------------------------------
// Workspace folder helper
// ---------------------------------------------------------------------------

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

/**
 * Resolves the target file and its owning SyncOrchestrator from a command invocation.
 * Shows a warning and returns null when no file is open or the file is unmanaged.
 */
function resolveFileManager(
  uri: vscode.Uri | undefined, //
  action: string,
): { filePath: string; manager: SyncOrchestrator } | null {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    void vscode.window.showWarningMessage(`No file is open to ${action}.`);
    return null;
  }

  const filePath = targetUri.fsPath;
  const manager = syncManagers.find((m) => m.ownsFile(filePath));
  if (!manager) {
    void vscode.window.showWarningMessage(
      "This file is not inside a managed sync target folder.",
    );
    return null;
  }

  return { filePath, manager };
}

// ---------------------------------------------------------------------------
// Status bar sync summary
// ---------------------------------------------------------------------------

/** Builds a SyncSummary snapshot from current state and pushes it to the status bar. */
function refreshStatusBarSummary(): void {
  if (!statusBarManager || !rateLimitMonitor) {
    return;
  }

  const targets: SyncTargetSummary[] = syncManagers.map((m) => ({
    name: m.displayName,
    trackedIssueCount: m.trackedIssueCount,
    lastFetchTime: m.lastFetchTime,
    nextFetchTime: m.nextFetchTime,
  }));

  const summary: SyncSummary = {
    targets,
    rateLimits: rateLimitMonitor.getBucketInfo(),
    isPaused: rateLimitMonitor.isPaused,
    pauseReason: rateLimitMonitor.pauseReason,
  };

  statusBarManager.update(summary);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function reinitializeAllFolders(
  context: vscode.ExtensionContext,
): Promise<void> {
  reinitializeChain = reinitializeChain
    .catch(() => {
      /* ignore errors from prior run */
    })
    .then(() => doReinitializeAllFolders(context));
  return reinitializeChain;
}

async function doReinitializeAllFolders(
  context: vscode.ExtensionContext,
): Promise<void> {
  // Capture old targets and the shared state manager per folder before tearing down
  const oldStateByFolder = new Map<
    string,
    { targets: SyncTarget[]; stateManager: SyncStateStore }
  >();
  for (const manager of syncManagers) {
    const fsPath = manager.workspaceFolderFsPath;
    if (!oldStateByFolder.has(fsPath)) {
      oldStateByFolder.set(fsPath, {
        targets: [],
        stateManager: manager.stateManager,
      });
    }
    oldStateByFolder.get(fsPath)!.targets.push(manager.target);
  }

  syncManagers.forEach((m) => m.dispose());
  syncManagers.length = 0;

  // Clear old sync change listeners
  for (const unsub of syncChangeUnsubscribers) {
    unsub();
  }
  syncChangeUnsubscribers.length = 0;

  // Clear old push change listeners
  for (const unsub of pushChangeUnsubscribers) {
    unsub();
  }
  pushChangeUnsubscribers.length = 0;

  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    // Reconcile moved/removed targets before starting new managers
    const old = oldStateByFolder.get(folder.uri.fsPath);
    if (old && old.targets.length > 0) {
      const newConfig = getConfig(folder.uri.fsPath, folder);
      let newTargets = newConfig.syncTargets;
      if (newTargets.length === 0) {
        const persisted = await persistDefaultTargets(folder);
        if (persisted) {
          const refreshed = getConfig(folder.uri.fsPath, folder);
          newTargets = refreshed.syncTargets;
        }
        if (newTargets.length === 0) {
          const detected = await detectDefaultTargets(folder);
          if (detected) {
            newTargets = detected;
          }
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

async function activateFolder(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
): Promise<void> {
  const config = getConfig(folder.uri.fsPath, folder);

  const targets = await resolveActiveTargets(folder, config);
  if (!targets) {
    return;
  }

  await ensureGitignoreEntries(folder, config, targets);
  rateLimitMonitor?.setThreshold(config.rateLimitThreshold);

  const stateManager = await createLoadedStateManager(config, context);
  await removeOrphanedStateEntries(stateManager, targets);

  if (!(await ensurePluginsInitialized())) {
    return;
  }

  await startManagersForTargets(
    targets, //
    config,
    folder,
    context,
    stateManager,
  );

  updateDecorationProvider(config);
  updateCodeLensProvider();
  notifyTargetChangeListeners();
  statusBarManager?.setVisible(config.showStatusBarIcon);
  refreshStatusBarSummary();
}

// ---------------------------------------------------------------------------
// activateFolder helpers
// ---------------------------------------------------------------------------

/** Resolves sync targets from config, persisted defaults, or detected defaults. */
async function resolveActiveTargets(
  folder: vscode.WorkspaceFolder,
  config: import("./configManager").IssueConfig,
): Promise<SyncTarget[] | null> {
  if (config.syncTargets.length > 0) {
    return config.syncTargets;
  }

  // Persist open-issues target to workspace settings for first-time setup
  const persisted = await persistDefaultTargets(folder);
  if (persisted) {
    const refreshed = getConfig(folder.uri.fsPath, folder);
    if (refreshed.syncTargets.length > 0) {
      return refreshed.syncTargets;
    }
  }

  // Fall back to ephemeral detected defaults
  return detectDefaultTargets(folder);
}

/** Adds sync state file and target folders to .gitignore as needed. */
async function ensureGitignoreEntries(
  folder: vscode.WorkspaceFolder,
  config: import("./configManager").IssueConfig,
  targets: SyncTarget[],
): Promise<void> {
  await ensureGitignore(folder.uri.fsPath, [config.syncStatePath]);
  if (config.keepGitIgnoreUpdated) {
    await ensureGitignore(
      folder.uri.fsPath,
      targets.map((t) => t.filesDir),
    );
  }
  await applyFilesExclude(folder, config);
}

/** Creates a SyncStateStore, loads from disk, and wires up decoration refresh. */
async function createLoadedStateManager(
  config: import("./configManager").IssueConfig,
  context: vscode.ExtensionContext,
): Promise<SyncStateStore> {
  const stateManager = new SyncStateStore(config.syncStatePath);
  await stateManager.load();
  stateManager.watchForDeletion();
  context.subscriptions.push({ dispose: () => stateManager.dispose() });

  const unsubscribe = stateManager.onDidChange((filePath) => {
    decorationProvider?.clearDirty(filePath);
    decorationProvider?.refresh(filePath);
    codeLensProvider?.refresh();
  });
  context.subscriptions.push({ dispose: unsubscribe });

  return stateManager;
}

/** Removes state entries for files no longer under any active target. */
async function removeOrphanedStateEntries(
  stateManager: SyncStateStore,
  targets: SyncTarget[],
): Promise<void> {
  const activeLocations = new Set(targets.map((t) => t.filesDir));
  for (const filePath of stateManager.getKnownFilePaths()) {
    const isActive = [...activeLocations].some((loc) =>
      filePath.startsWith(loc + path.sep),
    );
    if (!isActive) {
      await stateManager.deleteEntry(filePath);
    }
  }
}

/** Ensures at least one plugin is initialized. Returns false if none could initialize. */
async function ensurePluginsInitialized(): Promise<boolean> {
  if (getPrimaryPluginIds().length > 0) {
    return true;
  }
  const initialized = await initializePlugins();
  if (initialized.length === 0) {
    console.warn("[issuesAsCode] No plugins could be initialized");
    return false;
  }
  return true;
}

/** Creates and starts a SyncOrchestrator for each target, subscribing to events. */
async function startManagersForTargets(
  targets: SyncTarget[],
  config: import("./configManager").IssueConfig,
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  stateManager: SyncStateStore,
): Promise<void> {
  for (const target of targets) {
    const plugin = resolvePluginForTarget(target);
    if (!plugin) {
      console.warn(
        `[issuesAsCode] No plugin found for target: ${JSON.stringify(target)}`,
      );
      continue;
    }

    const manager = new SyncOrchestrator(
      plugin,
      config,
      target,
      folder,
      context,
      stateManager,
      rateLimitMonitor,
    );
    await manager.start();
    syncManagers.push(manager);
    context.subscriptions.push({ dispose: () => manager.dispose() });

    const unsubscribeSyncChange = manager.onSyncChange(() => {
      refreshStatusBarSummary();
    });
    syncChangeUnsubscribers.push(unsubscribeSyncChange);

    const unsubscribePush = manager.onDidPush((info) => {
      void propagateToSiblings(info, manager);
    });
    pushChangeUnsubscribers.push(unsubscribePush);
  }
}

/** Updates the decoration provider with all active managed locations and config. */
function updateDecorationProvider(
  config: import("./configManager").IssueConfig,
): void {
  if (!decorationProvider) {
    return;
  }
  const locations = syncManagers.map((m) => ({
    location: m.target.filesDir,
    pluginId: m.plugin.id,
    stateManager: m.stateManager,
    readOnly: m.target.readOnly,
  }));
  decorationProvider.update(locations, config.showSyncIcons);
}

/** Updates the CodeLens provider with managed targets. */
function updateCodeLensProvider(): void {
  if (!codeLensProvider) {
    return;
  }
  const codeLensTargets = syncManagers.map((m) => ({
    filesDir: m.target.filesDir,
    pluginId: m.plugin.id,
    displayName: m.plugin.displayName,
    stateManager: m.stateManager,
    readOnly: m.target.readOnly,
  }));
  codeLensProvider.update(codeLensTargets);
}

/** Notifies registered listeners that targets have changed. */
function notifyTargetChangeListeners(): void {
  for (const listener of targetChangeListeners) {
    try {
      listener();
    } catch {
      // Ignore listener errors
    }
  }
}

/** Returns current managed targets for plugin provider consumption. */
function getPluginTargets(): ManagedPluginTarget[] {
  return syncManagers.map((m) => {
    const pluginConfig =
      (m.target[m.plugin.id] as Record<string, unknown>) ?? {};
    return {
      filesDir: m.target.filesDir,
      pluginId: m.plugin.id,
      pluginConfig,
      stateManager: m.stateManager,
      readOnly: m.target.readOnly,
    };
  });
}

export function deactivate(): void {
  syncManagers.forEach((m) => m.dispose());
  syncManagers.length = 0;
  rateLimitMonitor?.dispose();
  rateLimitMonitor = undefined;
  statusBarManager?.dispose();
  statusBarManager = undefined;
}

/**
 * Adds or removes the sync state file from VS Code's files.exclude setting
 * based on the showSyncState configuration.
 */
async function applyFilesExclude(
  folder: vscode.WorkspaceFolder,
  config: import("./configManager").IssueConfig,
): Promise<void> {
  const relPath = path.relative(folder.uri.fsPath, config.syncStatePath);
  if (relPath.startsWith("..")) {
    return;
  }

  const filesConfig = vscode.workspace.getConfiguration("files", folder.uri);
  const folderExclude = {
    ...(filesConfig.inspect<Record<string, boolean>>("exclude")
      ?.workspaceFolderValue ?? {}),
  };

  if (config.showSyncState) {
    delete folderExclude[relPath];
  } else {
    folderExclude[relPath] = true;
  }

  await filesConfig.update(
    "exclude",
    folderExclude,
    vscode.ConfigurationTarget.WorkspaceFolder,
  );
}
