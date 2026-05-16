import * as path from "path";
import * as fs from "fs";
import type * as vscodeType from "vscode";
import {
  readIssueFile, //
  writeIssueFile,
  serializeIssueFile,
  type IssueFrontmatter,
} from "./fileManager";
import { type SyncTarget, type IssueConfig } from "./configManager";
import { SyncStateStore, type RemoteIssueInfo } from "./syncStateStore";
import { type PrimarySyncPlugin, type PullItem } from "./pluginTypes";
import { type RateLimitMonitor } from "./rateLimitMonitor";
import {
  classifyDiff, //
  generateConflictContent,
  hasConflictMarkers,
} from "./diffHelpers";
import { isLocalFileModified } from "./fileModification";
import {
  makeFileReadOnly, //
  makeFileWritable,
} from "./filePermissions";

/** Result of a single target refresh operation. */
export type RefreshResult =
  | { status: "success"; name: string }
  | { status: "skipped"; name: string }
  | { status: "error"; name: string; error: string };

/** Info emitted after a successful push. */
export interface PushEventInfo {
  filePath: string;
  remoteKey: string;
  pluginId: string;
}

// Lazy vscode import so unit tests can stub it out
function vscode(): typeof vscodeType {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("vscode");
}

/**
 * Closes the editor tab showing the old file and opens the new (renamed) file.
 * Called when a push results in a filename change.
 */
export async function switchEditorToRenamedFile(
  oldPath: string,
  newPath: string,
): Promise<void> {
  const vs = vscode();
  const oldUri = vs.Uri.file(oldPath);
  const newUri = vs.Uri.file(newPath);

  const tabToClose = vs.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (tab) =>
        tab.input instanceof vs.TabInputText &&
        tab.input.uri.fsPath === oldUri.fsPath,
    );
  if (tabToClose) {
    await vs.window.tabGroups.close(tabToClose);
  }

  const doc = await vs.workspace.openTextDocument(newUri);
  await vs.window.showTextDocument(doc);
}

export class SyncOrchestrator {
  private suppressedUris = new Map<string, number>();
  private extensionWriteMtimeMs = new Map<string, number>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private pullTimer: NodeJS.Timeout | null = null;
  private watcher: vscodeType.FileSystemWatcher | null = null;
  private isDisposed = false;
  private _lastFetchTime: Date | null = null;
  private _nextFetchTime: Date | null = null;
  private syncChangeListeners: (() => void)[] = [];
  private pushListeners: ((info: PushEventInfo) => void)[] = [];

  constructor(
    readonly plugin: PrimarySyncPlugin,
    readonly config: IssueConfig,
    readonly target: SyncTarget,
    private workspaceFolder: vscodeType.WorkspaceFolder,
    private context: vscodeType.ExtensionContext,
    readonly stateManager: SyncStateStore,
    private rateLimitMonitor?: RateLimitMonitor,
  ) {}

  get workspaceFolderFsPath(): string {
    return this.workspaceFolder.uri.fsPath;
  }

  /** When the last successful fetch completed. */
  get lastFetchTime(): Date | null {
    return this._lastFetchTime;
  }

  /** When the next scheduled fetch is expected. */
  get nextFetchTime(): Date | null {
    return this._nextFetchTime;
  }

  /** Number of tracked issues under this target. */
  get trackedIssueCount(): number {
    return this.stateManager.getFilesUnderLocation(this.target.filesDir).size;
  }

  /** Display name for this target (relative path from workspace). */
  get displayName(): string {
    return path.relative(this.workspaceFolder.uri.fsPath, this.target.filesDir);
  }

  /** Returns the plugin config section for this target, or undefined if missing. */
  private getPluginConfig(): Record<string, unknown> | undefined {
    return this.target[this.plugin.id] as Record<string, unknown> | undefined;
  }

  /** Builds a PluginContext for passing to plugin methods. */
  private buildPluginContext(): import("./pluginTypes").PluginContext {
    return {
      workspaceFolderPath: this.workspaceFolder.uri.fsPath,
      stateManager: this.stateManager,
    };
  }

  /** Register a listener for sync state changes. */
  onSyncChange(listener: () => void): () => void {
    this.syncChangeListeners.push(listener);
    return () => {
      this.syncChangeListeners = this.syncChangeListeners.filter(
        (l) => l !== listener,
      );
    };
  }

  /** Register a listener for successful push events. Returns an unsubscribe function. */
  onDidPush(listener: (info: PushEventInfo) => void): () => void {
    this.pushListeners.push(listener);
    return () => {
      this.pushListeners = this.pushListeners.filter((l) => l !== listener);
    };
  }

  /** Returns true if the given file path is managed by this sync manager. */
  ownsFile(filePath: string): boolean {
    const base = this.target.filesDir;
    return filePath === base || filePath.startsWith(base + path.sep);
  }

  /** Start the sync manager: setup file watcher and pull timer. */
  async start(): Promise<void> {
    const vs = vscode();
    const locationRelative = path.relative(
      this.workspaceFolder.uri.fsPath, //
      this.target.filesDir,
    );

    this.watcher = vs.workspace.createFileSystemWatcher(
      new vs.RelativePattern(
        this.workspaceFolder, //
        `${locationRelative}/**/*.task.md`,
      ),
    );

    this.watcher.onDidChange((uri) => this.onFileChanged(uri));
    this.watcher.onDidCreate((uri) => this.handleNewFile(uri));

    this.context.subscriptions.push(this.watcher);

    // Start periodic pull
    const intervalMs = this.config.autoFetchInterval * 60 * 1000;
    this._nextFetchTime = new Date(Date.now() + intervalMs);
    this.pullTimer = setInterval(() => {
      void this.refresh();
      this._nextFetchTime = new Date(Date.now() + intervalMs);
    }, intervalMs);

    // Initial refresh on activation
    await this.refresh();
  }

  /** Stop: dispose watcher, clear timers. */
  dispose(): void {
    this.isDisposed = true;
    this.watcher?.dispose();
    this.watcher = null;

    if (this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.extensionWriteMtimeMs.clear();
    this.syncChangeListeners = [];
    this.pushListeners = [];
  }

  private notifySyncChange(): void {
    for (const listener of this.syncChangeListeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors
      }
    }
  }

  private notifyPush(info: PushEventInfo): void {
    for (const listener of this.pushListeners) {
      try {
        listener(info);
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Pull all remote items and return a structured result.
   * Safe for both interactive (command) and background (timer) use.
   */
  async refresh(): Promise<RefreshResult> {
    if (this.rateLimitMonitor?.isPaused) {
      console.log(
        `[issuesAsCode] refresh skipped — rate limit paused: ${this.rateLimitMonitor.pauseReason}`,
      );
      return { status: "skipped", name: this.displayName };
    }

    try {
      await this.pullTarget();
      this._lastFetchTime = new Date();
      this.notifySyncChange();
      return { status: "success", name: this.displayName };
    } catch (err) {
      console.error(
        `[issuesAsCode] pullTarget "${this.target.filesDir}" failed:`, //
        err,
      );
      return {
        status: "error",
        name: this.displayName,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Pull remote items for this target using the configured plugin.
   * The plugin handles discovery and fetching; the sync manager handles
   * file writing, conflict detection, and state management.
   */
  async pullTarget(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const pluginConfig = this.getPluginConfig();
    if (!pluginConfig) {
      return;
    }

    const context = this.buildPluginContext();

    let items = await this.plugin.pull(pluginConfig, context);

    // Validate pulled items against target config to filter out non-matching items.
    // This ensures orphaned entries are not created if the plugin returns unexpected results.
    items = this.plugin.validatePulledItems(items, pluginConfig);

    const naming = this.target.naming ?? this.plugin.defaultFileName;
    const pulledRemoteKeys = new Set(items.map((i) => i.remoteKey));

    for (const item of items) {
      if (this.isDisposed) {
        return;
      }

      const expectedFileName =
        this.plugin.buildFileName(item.namingTokens, naming) + ".task.md";
      const expectedPath = path.join(this.target.filesDir, expectedFileName);

      // Look for existing file tracking this remote item (by unique remoteKey)
      let existingPath = this.findExistingFileByKey(item.remoteKey);

      // Fallback: plugin-specific heuristic for files not yet in sync state
      if (!existingPath) {
        existingPath = await this.plugin.findExistingFile(
          this.target.filesDir,
          item.remoteKey,
          naming,
        );
      }

      if (existingPath !== null && existingPath !== expectedPath) {
        // Title changed remotely — write to new path and remove old file
        await this.writePullItemSuppressed(expectedPath, item);
        await this.unlinkSuppressed(existingPath);
      } else {
        await this.pullItem(existingPath ?? expectedPath, item);
      }
    }

    // Remove stale entries: files in state under this target that are no longer returned by the remote.
    // This keeps the sync state and task files in sync with the remote.
    await this.cleanStaleEntries(pulledRemoteKeys);
  }

  /** Removes state entries and task files that no longer exist in the latest remote pull. */
  private async cleanStaleEntries(
    pulledRemoteKeys: Set<string>,
  ): Promise<void> {
    const stateEntries = this.stateManager.getFilesUnderLocation(
      this.target.filesDir,
    );
    for (const [filePath, entry] of stateEntries) {
      const pluginRef = entry.plugins?.[this.plugin.id];
      if (!pluginRef) {
        continue;
      }

      // Remove if not in the latest pulled set
      if (!pulledRemoteKeys.has(pluginRef.key)) {
        await this.unlinkSuppressed(filePath);
        continue;
      }

      // Also validate that the entry still matches the target config.
      // This removes orphaned entries if the filter criteria no longer applies.
      const pluginConfig = this.getPluginConfig();
      if (
        pluginConfig &&
        !(await this.entryMatchesTargetConfig(filePath, pluginConfig))
      ) {
        await this.unlinkSuppressed(filePath);
      }
    }
  }

  /** Finds an existing file by its remoteKey in the sync state, scoped to this target's directory. */
  private findExistingFileByKey(remoteKey: string): string | null {
    return (
      this.stateManager.findFileByPluginKeyUnderLocation(
        this.plugin.id, //
        remoteKey,
        this.target.filesDir,
      ) ?? null
    );
  }

  /**
   * Checks if a file's content matches the target config criteria.
   * Delegates to the plugin for config-specific validation logic.
   */
  private async entryMatchesTargetConfig(
    filePath: string,
    pluginConfig: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const { frontmatter } = await readIssueFile(filePath);
      const stateEntry = this.stateManager.getEntry(filePath);
      const pluginRef = stateEntry?.plugins?.[this.plugin.id];
      const syncedAt = pluginRef?.synced_at;

      return this.plugin.fileMatchesTargetConfig(
        frontmatter,
        pluginConfig,
        syncedAt,
      );
    } catch {
      // If file can't be read, consider it invalid
      return false;
    }
  }

  /** Fetch a single item: update tracking state without applying to disk (unless file is new). */
  private async pullItem(localPath: string, item: PullItem): Promise<void> {
    const localExists = await fs.promises.access(localPath).then(
      () => true,
      () => false,
    );
    if (!localExists) {
      // New file from remote — create locally
      await this.writePullItemSuppressed(localPath, item);
      return;
    }

    // Skip if the user is currently resolving a merge conflict
    if (!this.target.readOnly) {
      const localContent = await fs.promises.readFile(localPath, "utf8");
      if (hasConflictMarkers(localContent)) {
        return;
      }
    }

    // readOnly: always overwrite local with remote — local changes are discarded
    if (this.target.readOnly) {
      await this.writePullItemSuppressed(localPath, item);
      return;
    }

    if (
      !isConflict(
        item.remoteInfo.updated_at,
        this.stateManager.getSyncedAt(localPath),
      )
    ) {
      // Cloud hasn't changed since last sync — nothing to do
      return;
    }

    // Remote has changed — track as pending without applying to disk
    await this.stateManager.updatePluginDataOnly(
      localPath,
      item.remoteInfo,
      this.plugin.id,
      item.remoteKey,
    );

    // Auto-pull if enabled and local file hasn't been modified
    if (this.config.autoPullOnFetch) {
      const stateEntry = this.stateManager.getEntry(localPath);
      if (!isLocalFileModified(localPath, stateEntry)) {
        await this.pullFile(localPath);
      }
    }
  }

  /**
   * Fetch remote state for a single file without applying changes.
   * Updates pluginData so the CodeLens can show current remote status.
   */
  async fetchFile(filePath: string): Promise<void> {
    const pluginConfig = this.getPluginConfig();
    if (!pluginConfig) {
      return;
    }

    const stateEntry = this.stateManager.getEntry(filePath);
    const pluginRef = stateEntry?.plugins?.[this.plugin.id];
    if (!pluginRef?.key) {
      return;
    }

    const context = this.buildPluginContext();

    try {
      const items = await this.plugin.pull(pluginConfig, context);
      const cloudItem = items.find((i) => i.remoteKey === pluginRef.key);
      if (!cloudItem) {
        return;
      }

      // If remote is unchanged since last sync, nothing to do
      if (
        !isConflict(
          cloudItem.remoteInfo.updated_at,
          this.stateManager.getSyncedAt(filePath),
        )
      ) {
        return;
      }

      // Remote has changes — update plugin data to surface in UI
      await this.stateManager.updatePluginDataOnly(
        filePath,
        cloudItem.remoteInfo,
        this.plugin.id,
        cloudItem.remoteKey,
      );

      // Auto-pull if enabled and local file hasn't been modified
      if (this.config.autoPullOnFetch) {
        const stateEntry = this.stateManager.getEntry(filePath);
        if (!isLocalFileModified(filePath, stateEntry)) {
          await this.pullFile(filePath);
        }
      }
    } catch (err) {
      console.error(`[issuesAsCode] fetchFile "${filePath}" failed:`, err);
    }
  }

  /**
   * Explicitly pull a single file from the remote.
   * Fetches the latest remote state and applies it locally (with conflict markers if needed).
   */
  async pullFile(filePath: string): Promise<void> {
    const pluginConfig = this.getPluginConfig();
    if (!pluginConfig) {
      return;
    }

    const stateEntry = this.stateManager.getEntry(filePath);
    const pluginRef = stateEntry?.plugins?.[this.plugin.id];
    if (!pluginRef?.key) {
      return;
    }

    const context = this.buildPluginContext();

    const items = await this.plugin.pull(pluginConfig, context);
    const cloudItem = items.find((i) => i.remoteKey === pluginRef.key);
    if (!cloudItem) {
      return;
    }

    // Apply remote changes, using conflict markers if local also has changes
    const localContent = await fs.promises.readFile(filePath, "utf8");
    const cloudFrontmatter: IssueFrontmatter = {
      [this.plugin.id]: cloudItem.frontmatter,
    };
    const cloudContent = serializeIssueFile(cloudFrontmatter, cloudItem.body);
    const kind = classifyDiff(localContent, cloudContent);

    if (kind === "identical") {
      await this.stateManager.setSyncedAt(
        filePath,
        cloudItem.remoteInfo,
        this.plugin.id,
        cloudItem.remoteKey,
      );
      return;
    }

    if (kind === "mixed" && isLocalFileModified(filePath, stateEntry)) {
      await this.writeConflictMarkers(
        filePath,
        localContent,
        cloudContent,
        cloudItem.remoteInfo,
        cloudItem.remoteKey,
      );
    } else {
      await this.writePullItemSuppressed(filePath, cloudItem);
    }
  }

  /** Push a single file to the remote service via the plugin. */
  async pushFile(
    filePath: string,
    options: { interactive?: boolean } = {},
  ): Promise<string | undefined> {
    if (!(await this.confirmRateLimitForPush(options.interactive))) {
      return undefined;
    }

    const raw = await fs.promises.readFile(filePath, "utf8");
    if (hasConflictMarkers(raw)) {
      return undefined;
    }

    const { frontmatter, body } = await readIssueFile(filePath);
    const pluginConfig = this.getPluginConfig();
    if (!pluginConfig) {
      return undefined;
    }

    const stateEntry = this.stateManager.getEntry(filePath);
    const remoteId = this.plugin.getRemoteId(frontmatter, stateEntry);
    const context = this.buildPluginContext();

    // For existing items, check for remote conflicts before pushing
    let existingRemoteKey: string | undefined;
    if (remoteId !== undefined) {
      existingRemoteKey = this.plugin.getRemoteKey(
        frontmatter,
        pluginConfig,
        stateEntry,
      );
      const blocked = await this.stopPushIfRemoteChanged(
        filePath,
        pluginConfig,
        context,
        existingRemoteKey,
        options.interactive,
      );
      if (blocked) {
        return undefined;
      }
    }

    // Infer title for new files
    if (remoteId === undefined) {
      this.setInferredTitle(filePath, frontmatter, body);
    }

    const result = await this.plugin.push(
      frontmatter,
      body,
      pluginConfig,
      context,
      existingRemoteKey,
    );

    return this.applyPushResult(filePath, frontmatter, pluginConfig, result);
  }

  /** Returns false if rate limit blocks the push. Shows confirmation when interactive. */
  private async confirmRateLimitForPush(
    interactive?: boolean,
  ): Promise<boolean> {
    if (!this.rateLimitMonitor?.isPaused) {
      return true;
    }
    if (interactive) {
      const choice = await vscode().window.showWarningMessage(
        `API rate limit is low (${this.rateLimitMonitor.pauseReason}). Push anyway?`,
        "Push Anyway",
        "Cancel",
      );
      return choice === "Push Anyway";
    }
    return false;
  }

  /**
   * Checks if the remote has changed since last sync and blocks the push if so.
   * Updates plugin data so CodeLens shows "Pull Changes" when blocked.
   */
  private async stopPushIfRemoteChanged(
    filePath: string,
    pluginConfig: Record<string, unknown>,
    context: import("./pluginTypes").PluginContext,
    existingRemoteKey: string | undefined,
    interactive?: boolean,
  ): Promise<boolean> {
    const items = await this.plugin.pull(pluginConfig, context);
    const cloudItem = existingRemoteKey
      ? items.find((i) => i.remoteKey === existingRemoteKey)
      : undefined;

    if (
      !cloudItem ||
      !isConflict(
        cloudItem.remoteInfo.updated_at,
        this.stateManager.getSyncedAt(filePath),
      )
    ) {
      return false;
    }

    await this.stateManager.updatePluginDataOnly(
      filePath,
      cloudItem.remoteInfo,
      this.plugin.id,
      cloudItem.remoteKey,
    );

    if (interactive) {
      void vscode().window.showWarningMessage(
        `Cannot push: the remote has been updated since your last sync. Please pull remote changes first.`,
      );
    }
    return true;
  }

  /** Sets an inferred title on the frontmatter for new files. */
  private setInferredTitle(
    filePath: string,
    frontmatter: IssueFrontmatter,
    body: string,
  ): void {
    const title = this.plugin.inferTitle(filePath, frontmatter, body);
    if (frontmatter[this.plugin.id]) {
      (frontmatter[this.plugin.id] as Record<string, unknown>).title = title;
    } else {
      (frontmatter as Record<string, unknown>)[this.plugin.id] = { title };
    }
  }

  /** Writes the push result to disk, cleans up old files, and validates against target config. */
  private async applyPushResult(
    filePath: string,
    frontmatter: IssueFrontmatter,
    pluginConfig: Record<string, unknown>,
    result: import("./pluginTypes").PushResult,
  ): Promise<string | undefined> {
    const naming = this.target.naming ?? this.plugin.defaultFileName;
    const expectedFileName =
      this.plugin.buildFileName(result.namingTokens, naming) + ".task.md";
    const expectedPath = path.join(this.target.filesDir, expectedFileName);

    const updatedFrontmatter: IssueFrontmatter = {
      ...frontmatter,
      [this.plugin.id]: result.frontmatter,
    };

    await this.writeFileSuppressed(
      expectedPath,
      updatedFrontmatter,
      result.body,
      result.remoteInfo,
      result.remoteKey,
    );

    if (expectedPath !== filePath) {
      await this.unlinkSuppressed(filePath);
    }

    // Remove file if it no longer matches the target query (e.g. closed issue in open-only target)
    if (!(await this.entryMatchesTargetConfig(expectedPath, pluginConfig))) {
      await this.closeEditorTab(expectedPath);
      await this.unlinkSuppressed(expectedPath);
      return undefined;
    }

    this.notifyPush({
      filePath: expectedPath,
      remoteKey: result.remoteKey,
      pluginId: this.plugin.id,
    });

    return expectedPath !== filePath ? expectedPath : undefined;
  }

  /** Closes the editor tab for a file path without opening a replacement. */
  private async closeEditorTab(filePath: string): Promise<void> {
    const vs = vscode();
    const uri = vs.Uri.file(filePath);
    const tab = vs.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (t) =>
          t.input instanceof vs.TabInputText &&
          t.input.uri.fsPath === uri.fsPath,
      );
    if (tab) {
      await vs.window.tabGroups.close(tab);
    }
  }

  /** Debounced push — called from file watcher on changes to existing files. */
  debouncedPush(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.pushFile(filePath)
        .then((newPath) => {
          if (newPath) {
            void switchEditorToRenamedFile(filePath, newPath);
          }
        })
        .catch((err) => {
          console.error(`[issuesAsCode] push failed for "${filePath}":`, err);
          const message = err instanceof Error ? err.message : "Unknown error";
          void vscode().window.showErrorMessage(
            `Issue sync push failed for ${path.basename(filePath)}: ${message}`,
          );
        });
    }, this.config.autoPushDelay);

    this.debounceTimers.set(filePath, timer);
  }

  /** Cancel any scheduled debounce push for a file (e.g. when an immediate push supersedes it). */
  cancelScheduledPush(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(filePath);
    }
  }

  /**
   * Push immediately if the file is already published (has a remote ID).
   * Cancels any pending debounced push for the same file.
   * Returns true if a push was attempted.
   */
  async pushNowIfPublished(filePath: string): Promise<boolean> {
    if (this.target.readOnly) {
      return false;
    }

    try {
      const { frontmatter } = await readIssueFile(filePath);
      const stateEntry = this.stateManager.getEntry(filePath);
      if (this.plugin.getRemoteId(frontmatter, stateEntry) === undefined) {
        return false;
      }
    } catch {
      return false;
    }

    this.cancelScheduledPush(filePath);

    try {
      const newPath = await this.pushFile(filePath);
      if (newPath) {
        void switchEditorToRenamedFile(filePath, newPath);
      }
    } catch (err) {
      console.error(`[issuesAsCode] push failed for "${filePath}":`, err);
      const message = err instanceof Error ? err.message : "Unknown error";
      void vscode().window.showErrorMessage(
        `Issue sync push failed for ${path.basename(filePath)}: ${message}`,
      );
    }
    return true;
  }

  /** Increment or decrement ref-count for a suppressed URI. */
  suppress(filePath: string, delta: number): void {
    const current = this.suppressedUris.get(filePath) ?? 0;
    const next = current + delta;
    if (next <= 0) {
      this.suppressedUris.delete(filePath);
    } else {
      this.suppressedUris.set(filePath, next);
    }
  }

  /** Returns true if file-change events for this path are currently suppressed. */
  isSuppressed(filePath: string): boolean {
    return (this.suppressedUris.get(filePath) ?? 0) > 0;
  }

  /** Writes merge conflict markers into localPath and advances the sync timestamp. */
  private async writeConflictMarkers(
    localPath: string, //
    localContent: string,
    cloudContent: string,
    remoteInfo: RemoteIssueInfo,
    remoteKey: string,
  ): Promise<void> {
    const conflictContent = generateConflictContent(localContent, cloudContent);
    this.suppress(localPath, 1);
    try {
      await fs.promises.writeFile(localPath, conflictContent, "utf8");
      await this.markExtensionWrite(localPath);
      await this.stateManager.setSyncedAt(
        localPath,
        remoteInfo,
        this.plugin.id,
        remoteKey,
      );
    } finally {
      this.suppress(localPath, -1);
    }

    void vscode().window.showWarningMessage(
      `${path.basename(localPath)} has conflicting changes. Resolve the conflict markers, then save.`,
    );
  }

  /** Handles a newly created .task.md file — never auto-pushes (see CodeLens provider). */
  private async handleNewFile(_uri: vscodeType.Uri): Promise<void> {
    // New file events are intentionally ignored for push.
    // Files pulled from remote are suppressed during write.
    // User-created files require explicit publish via CodeLens or command.
  }

  private onFileChanged(uri: vscodeType.Uri): void {
    void this.handleChangedFile(uri.fsPath);
  }

  private async handleChangedFile(filePath: string): Promise<void> {
    if (await this.shouldIgnoreFileEvent(filePath)) {
      return;
    }

    // readOnly targets never push local changes
    if (this.target.readOnly) {
      return;
    }

    // Only auto-push files that are already published (have a remote ID).
    // Unpublished files require explicit action via the CodeLens or command.
    try {
      const { frontmatter } = await readIssueFile(filePath);
      const stateEntry = this.stateManager.getEntry(filePath);
      if (this.plugin.getRemoteId(frontmatter, stateEntry) === undefined) {
        return;
      }
    } catch {
      return;
    }

    // Only schedule a debounced push in "afterDelay" mode
    if (this.config.autoPush === "afterDelay") {
      this.debouncedPush(filePath);
    }
  }

  private async shouldIgnoreFileEvent(filePath: string): Promise<boolean> {
    if (this.isSuppressed(filePath)) {
      return true;
    }

    const lastExtensionWriteMtimeMs = this.extensionWriteMtimeMs.get(filePath);
    if (lastExtensionWriteMtimeMs === undefined) {
      return false;
    }

    try {
      const stat = await fs.promises.stat(filePath);
      if (isExtensionWriteEvent(stat.mtimeMs, lastExtensionWriteMtimeMs)) {
        return true;
      }
    } catch {
      this.extensionWriteMtimeMs.delete(filePath);
      return true;
    }

    this.extensionWriteMtimeMs.delete(filePath);
    return false;
  }

  /** Records the mtime after an extension-authored write. */
  private async markExtensionWrite(filePath: string): Promise<void> {
    try {
      const stat = await fs.promises.stat(filePath);
      this.extensionWriteMtimeMs.set(filePath, stat.mtimeMs);
    } catch {
      // Ignore if file cannot be stat'ed
    }
  }

  /** Writes a pulled item's data while suppressing watcher events. */
  private async writePullItemSuppressed(
    filePath: string,
    item: PullItem,
  ): Promise<void> {
    const frontmatter: IssueFrontmatter = {
      [this.plugin.id]: item.frontmatter,
    };
    await this.writeFileSuppressed(
      filePath,
      frontmatter,
      item.body,
      item.remoteInfo,
      item.remoteKey,
    );
  }

  /** Writes a file while suppressing watcher events and updating sync state. */
  private async writeFileSuppressed(
    filePath: string, //
    frontmatter: IssueFrontmatter,
    body: string,
    remoteInfo: RemoteIssueInfo,
    remoteKey: string,
  ): Promise<void> {
    this.suppress(filePath, 1);
    try {
      // If readOnly, temporarily restore write permission before writing
      if (this.target.readOnly) {
        await makeFileWritable(filePath);
      }
      await writeIssueFile(filePath, frontmatter, body);
      await this.markExtensionWrite(filePath);
      await this.stateManager.setSyncedAt(
        filePath,
        remoteInfo,
        this.plugin.id,
        remoteKey,
      );
      // Enforce read-only permission after writing
      if (this.target.readOnly) {
        await makeFileReadOnly(filePath);
      }
    } finally {
      this.suppress(filePath, -1);
    }
  }

  /**
   * Propagates content from a sibling copy (same remote issue in another target).
   * Writes the file while suppressing watcher events and updating sync state.
   */
  async propagateFromSibling(
    filePath: string, //
    frontmatter: IssueFrontmatter,
    body: string,
    remoteInfo: RemoteIssueInfo,
    remoteKey: string,
  ): Promise<void> {
    await this.writeFileSuppressed(
      filePath, //
      frontmatter,
      body,
      remoteInfo,
      remoteKey,
    );
  }

  /**
   * Propagates raw content from a local sibling edit.
   * Writes the file while suppressing watcher events and updating local_written_at
   * but does NOT change sync timestamps (no remote info available).
   */
  async propagateLocalEdit(
    filePath: string, //
    content: string,
  ): Promise<void> {
    this.suppress(filePath, 1);
    try {
      if (this.target.readOnly) {
        await makeFileWritable(filePath);
      }
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, content, "utf8");
      await this.markExtensionWrite(filePath);
      await this.stateManager.setLocalWrittenAt(filePath);
      if (this.target.readOnly) {
        await makeFileReadOnly(filePath);
      }
    } finally {
      this.suppress(filePath, -1);
    }
  }

  /** Deletes a file while suppressing watcher events and removes its state entry. */
  private async unlinkSuppressed(filePath: string): Promise<void> {
    this.suppress(filePath, 1);
    try {
      if (this.target.readOnly) {
        await makeFileWritable(filePath);
      }
      await fs.promises.unlink(filePath);
      await this.stateManager.deleteEntry(filePath);
    } catch {
      /* ignore if already gone */
    } finally {
      this.suppress(filePath, -1);
    }
  }
}

/** Returns true if cloud version is newer than local synced_at. */
export function isConflict(
  cloudUpdatedAt: string,
  syncedAt: string | undefined,
): boolean {
  if (!syncedAt) {
    return false;
  }
  return new Date(cloudUpdatedAt) > new Date(syncedAt);
}

/**
 * Returns true when a file event still points at the same mtime as an
 * extension-authored write (allowing small filesystem timestamp jitter).
 */
export function isExtensionWriteEvent(
  eventMtimeMs: number,
  lastExtensionWriteMtimeMs: number,
): boolean {
  const MTIME_JITTER_MS = 1;
  return eventMtimeMs <= lastExtensionWriteMtimeMs + MTIME_JITTER_MS;
}
