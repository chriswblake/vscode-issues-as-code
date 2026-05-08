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
import { SyncStateManager, type RemoteIssueInfo } from "./syncStateManager";
import { type PrimarySyncPlugin, type PullItem } from "./plugins/syncPlugin";

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

export class SyncManager {
  private suppressedUris = new Map<string, number>();
  private extensionWriteMtimeMs = new Map<string, number>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private pullTimer: NodeJS.Timeout | null = null;
  private watcher: vscodeType.FileSystemWatcher | null = null;
  private isDisposed = false;

  constructor(
    readonly plugin: PrimarySyncPlugin,
    readonly config: IssueConfig,
    readonly target: SyncTarget,
    private workspaceFolder: vscodeType.WorkspaceFolder,
    private context: vscodeType.ExtensionContext,
    readonly stateManager: SyncStateManager,
  ) {}

  get workspaceFolderFsPath(): string {
    return this.workspaceFolder.uri.fsPath;
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
        `${locationRelative}/**/*.md`,
      ),
    );

    this.watcher.onDidChange((uri) => this.onFileChanged(uri));
    this.watcher.onDidCreate((uri) => this.handleNewFile(uri));

    this.context.subscriptions.push(this.watcher);

    // Start periodic pull
    const intervalMs = this.config.autoFetchInterval * 60 * 1000;
    this.pullTimer = setInterval(() => {
      void this.pullAll();
    }, intervalMs);

    // Initial pull on activation
    await this.pullAll();
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
  }

  /** Pull all remote items for this target via the plugin. */
  async pullAll(): Promise<void> {
    try {
      await this.pullTarget();
    } catch (err) {
      console.error(
        `[issuesAsCode] pullTarget "${this.target.filesDir}" failed:`, //
        err,
      );
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

    const pluginConfig = this.target[this.plugin.id] as
      | Record<string, unknown>
      | undefined;
    if (!pluginConfig) {
      return;
    }

    const context = {
      workspaceFolderPath: this.workspaceFolder.uri.fsPath,
      stateManager: this.stateManager,
    };

    let items = await this.plugin.pull(pluginConfig, context);

    // Validate pulled items against target config to filter out non-matching items.
    // This ensures orphaned entries are not created if the plugin returns unexpected results.
    items = this.plugin.validatePulledItems(items, pluginConfig);

    const naming = this.target.naming ?? this.config.fileNaming;
    const pulledRemoteKeys = new Set(items.map((i) => i.remoteKey));

    for (const item of items) {
      if (this.isDisposed) {
        return;
      }

      const expectedFileName =
        this.plugin.buildFileName(item.namingTokens, naming) + ".md";
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
      const pluginConfig = this.target[this.plugin.id] as
        | Record<string, unknown>
        | undefined;
      if (
        pluginConfig &&
        !(await this.entryMatchesTargetConfig(filePath, pluginConfig))
      ) {
        await this.unlinkSuppressed(filePath);
      }
    }
  }

  /** Finds an existing file by its remoteKey in the sync state (unique across repos). */
  private findExistingFileByKey(remoteKey: string): string | null {
    return (
      this.stateManager.findFileByPluginKey(this.plugin.id, remoteKey) ?? null
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
    const pluginConfig = this.target[this.plugin.id] as
      | Record<string, unknown>
      | undefined;
    if (!pluginConfig) {
      return;
    }

    const stateEntry = this.stateManager.getEntry(filePath);
    const pluginRef = stateEntry?.plugins?.[this.plugin.id];
    if (!pluginRef?.key) {
      return;
    }

    const context = {
      workspaceFolderPath: this.workspaceFolder.uri.fsPath,
      stateManager: this.stateManager,
    };

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
    const pluginConfig = this.target[this.plugin.id] as
      | Record<string, unknown>
      | undefined;
    if (!pluginConfig) {
      return;
    }

    const stateEntry = this.stateManager.getEntry(filePath);
    const pluginRef = stateEntry?.plugins?.[this.plugin.id];
    if (!pluginRef?.key) {
      return;
    }

    const context = {
      workspaceFolderPath: this.workspaceFolder.uri.fsPath,
      stateManager: this.stateManager,
    };

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
    const raw = await fs.promises.readFile(filePath, "utf8");
    if (hasConflictMarkers(raw)) {
      return undefined;
    }

    const { frontmatter, body } = await readIssueFile(filePath);
    const pluginConfig = this.target[this.plugin.id] as
      | Record<string, unknown>
      | undefined;
    if (!pluginConfig) {
      return undefined;
    }

    const stateEntry = this.stateManager.getEntry(filePath);
    const remoteId = this.plugin.getRemoteId(frontmatter, stateEntry);
    const context = {
      workspaceFolderPath: this.workspaceFolder.uri.fsPath,
      stateManager: this.stateManager,
    };

    let existingRemoteKey: string | undefined;
    if (remoteId !== undefined) {
      // Existing item — check for conflicts before pushing
      existingRemoteKey = this.plugin.getRemoteKey(
        frontmatter,
        pluginConfig,
        stateEntry,
      );

      // Re-pull to get latest remote state for conflict check
      const items = await this.plugin.pull(pluginConfig, context);
      const cloudItem = existingRemoteKey
        ? items.find((i) => i.remoteKey === existingRemoteKey)
        : undefined;

      if (
        cloudItem &&
        isConflict(
          cloudItem.remoteInfo.updated_at,
          this.stateManager.getSyncedAt(filePath),
        )
      ) {
        // Update plugin data so CodeLens shows "Pull Changes"
        await this.stateManager.updatePluginDataOnly(
          filePath,
          cloudItem.remoteInfo,
          this.plugin.id,
          cloudItem.remoteKey,
        );

        if (options.interactive) {
          void vscode().window.showWarningMessage(
            `Cannot push: the remote has been updated since your last sync. Please pull remote changes first.`,
          );
        }
        return undefined;
      }
    }

    // Infer title for new files
    if (remoteId === undefined) {
      const title = this.plugin.inferTitle(filePath, frontmatter, body);
      if (frontmatter[this.plugin.id]) {
        (frontmatter[this.plugin.id] as Record<string, unknown>).title = title;
      } else {
        (frontmatter as Record<string, unknown>)[this.plugin.id] = { title };
      }
    }

    const result = await this.plugin.push(
      frontmatter,
      body,
      pluginConfig,
      context,
      existingRemoteKey,
    );

    // Write updated file with server-assigned data
    const naming = this.target.naming ?? this.config.fileNaming;
    const expectedFileName =
      this.plugin.buildFileName(result.namingTokens, naming) + ".md";
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

    // Post-push validation: remove the file if it no longer matches the target query
    // (e.g. user closed an issue but the target filters for state: open)
    if (!(await this.entryMatchesTargetConfig(expectedPath, pluginConfig))) {
      await this.closeEditorTab(expectedPath);
      await this.unlinkSuppressed(expectedPath);
      return undefined;
    }

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

  /** Handles a newly created .md file — never auto-pushes (see CodeLens provider). */
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

/** Pure helper: returns true if the file content contains unresolved merge conflict markers. */
export function hasConflictMarkers(content: string): boolean {
  return /^<{7} /m.test(content);
}

/** Pure helper: returns true if cloud version is newer than local synced_at. */
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
 * Returns true if the saved file has been modified since the extension last wrote it.
 * Provides a 1 second tolerance for filesystem timestamp differences.
 */
export function isLocalFileModified(
  filePath: string,
  stateEntry: { local_written_at: string } | undefined,
): boolean {
  if (!stateEntry) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    const localWrittenAt = new Date(stateEntry.local_written_at).getTime();
    return stat.mtimeMs > localWrittenAt + 1000;
  } catch {
    return false;
  }
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

// Diff helpers

type DiffLine = { type: "equal" | "added" | "removed"; line: string };

/** LCS-based line diff. 'added' = in cloud only, 'removed' = in local only. */
export function computeLineDiff(
  localLines: string[],
  cloudLines: string[],
): DiffLine[] {
  const m = localLines.length;
  const n = cloudLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (localLines[i] === cloudLines[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (localLines[i] === cloudLines[j]) {
      result.push({ type: "equal", line: localLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "removed", line: localLines[i] });
      i++;
    } else {
      result.push({ type: "added", line: cloudLines[j] });
      j++;
    }
  }
  while (i < m) {
    result.push({ type: "removed", line: localLines[i++] });
  }
  while (j < n) {
    result.push({ type: "added", line: cloudLines[j++] });
  }

  return result;
}

/** Returns whether a cloud→local change is additions-only, removals-only, mixed, or identical. */
export function classifyDiff(
  localContent: string,
  cloudContent: string,
): "identical" | "additions-only" | "removals-only" | "mixed" {
  const diff = computeLineDiff(
    localContent.split(/\r?\n/), //
    cloudContent.split(/\r?\n/),
  );

  let hasAdditions = false;
  let hasRemovals = false;
  for (const item of diff) {
    if (item.type === "added") hasAdditions = true;
    if (item.type === "removed") hasRemovals = true;
  }

  if (!hasAdditions && !hasRemovals) return "identical";
  if (hasAdditions && !hasRemovals) return "additions-only";
  if (!hasAdditions && hasRemovals) return "removals-only";
  return "mixed";
}

/** Produces file content with standard merge conflict markers for all diff hunks. */
export function generateConflictContent(
  localContent: string,
  cloudContent: string,
): string {
  const diff = computeLineDiff(
    localContent.split(/\r?\n/), //
    cloudContent.split(/\r?\n/),
  );

  const output: string[] = [];
  let i = 0;
  while (i < diff.length) {
    if (diff[i].type === "equal") {
      output.push(diff[i].line);
      i++;
    } else {
      // Collect a contiguous conflict hunk
      const localSection: string[] = [];
      const cloudSection: string[] = [];
      while (i < diff.length && diff[i].type !== "equal") {
        if (diff[i].type === "removed") localSection.push(diff[i].line);
        else cloudSection.push(diff[i].line);
        i++;
      }
      output.push("<<<<<<< Local");
      output.push(...localSection);
      output.push("=======");
      output.push(...cloudSection);
      output.push(">>>>>>> Remote");
    }
  }

  return output.join("\n");
}

// ---------------------------------------------------------------------------
// Target reconciliation (location changes and removals)
// ---------------------------------------------------------------------------

/** Identity key for a sync target: based on plugin configuration so changing filesDir triggers a move. */
function targetIdentity(target: SyncTarget): string {
  // Find plugin config keys (anything that's not a core SyncTarget field)
  const coreFields = new Set(["filesDir", "naming"]);
  for (const key of Object.keys(target)) {
    if (coreFields.has(key)) {
      continue;
    }
    const pluginConfig = target[key];
    if (pluginConfig && typeof pluginConfig === "object") {
      return `${key}||${JSON.stringify(pluginConfig)}`;
    }
  }
  return `filesDir||${target.filesDir}`;
}

/**
 * Reconciles the file system and sync state when sync targets change between config reloads.
 *
 * - Moved targets (same plugin config, different filesDir): issue files are moved to the new
 *   location and the sync state is updated so no re-download is triggered.
 * - Removed targets (not present in new config): issue files are deleted and their state
 *   entries are removed.
 *
 * Safe from mid-process corruption: a crash leaves orphaned files at worst (no data loss).
 */
export async function reconcileTargetChanges(
  oldTargets: SyncTarget[], //
  newTargets: SyncTarget[],
  stateManager: SyncStateManager,
): Promise<void> {
  const oldByIdentity = new Map(oldTargets.map((t) => [targetIdentity(t), t]));
  const newByIdentity = new Map(newTargets.map((t) => [targetIdentity(t), t]));

  // Move files for targets whose filesDir changed
  for (const [id, oldTarget] of oldByIdentity) {
    const newTarget = newByIdentity.get(id);
    if (newTarget && newTarget.filesDir !== oldTarget.filesDir) {
      await moveTargetFiles(oldTarget, newTarget, stateManager);
    }
  }

  // Delete files for targets that were removed entirely
  for (const [id, oldTarget] of oldByIdentity) {
    if (!newByIdentity.has(id)) {
      await deleteTargetFiles(oldTarget, stateManager);
    }
  }
}

/** Moves all tracked issue files from the old target location to the new one, updating state. */
async function moveTargetFiles(
  oldTarget: SyncTarget, //
  newTarget: SyncTarget,
  stateManager: SyncStateManager,
): Promise<void> {
  const entries = stateManager.getFilesUnderLocation(oldTarget.filesDir);
  if (entries.size === 0) {
    return;
  }

  await fs.promises.mkdir(newTarget.filesDir, { recursive: true });

  for (const [oldFilePath, entry] of entries) {
    const newFilePath = path.join(
      newTarget.filesDir,
      path.basename(oldFilePath),
    );

    // Copy to new location; source may already be gone if this is crash recovery
    try {
      await fs.promises.copyFile(oldFilePath, newFilePath);
    } catch {
      /* source already gone — state cleanup still proceeds */
    }

    await stateManager.setSyncedAtEntry(newFilePath, entry);
    await stateManager.deleteEntry(oldFilePath);

    try {
      await fs.promises.unlink(oldFilePath);
    } catch {
      /* already gone */
    }
  }
}

/** Deletes all tracked issue files under the old target location, and removes their state entries. */
async function deleteTargetFiles(
  oldTarget: SyncTarget, //
  stateManager: SyncStateManager,
): Promise<void> {
  const entries = stateManager.getFilesUnderLocation(oldTarget.filesDir);

  for (const [filePath] of entries) {
    try {
      // Make read-only files writable before deletion
      if (oldTarget.readOnly) {
        await makeFileWritable(filePath);
      }
      await fs.promises.unlink(filePath);
    } catch {
      /* already gone */
    }
  }

  await stateManager.removeFilesUnderLocation(oldTarget.filesDir);
}

// ---------------------------------------------------------------------------
// File permission helpers (cross-platform read-only enforcement)
// ---------------------------------------------------------------------------

/**
 * Makes a file read-only on disk to discourage accidental edits.
 * Uses mode 0o444 (read for owner/group/others, no write).
 * Silently ignores errors (e.g. file does not exist yet).
 */
async function makeFileReadOnly(filePath: string): Promise<void> {
  try {
    await fs.promises.chmod(filePath, 0o444);
  } catch {
    /* ignore — file may not exist or platform may not support */
  }
}

/**
 * Restores write permission on a file so the extension can overwrite it.
 * Uses mode 0o644 (owner read/write, group/others read).
 * Silently ignores errors.
 */
async function makeFileWritable(filePath: string): Promise<void> {
  try {
    await fs.promises.chmod(filePath, 0o644);
  } catch {
    /* ignore — file may not exist */
  }
}
