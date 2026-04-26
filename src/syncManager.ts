import * as path from 'path';
import * as fs from 'fs';
import type * as vscodeType from 'vscode';
import type { GitHubClient, IssueData } from './githubClient';
import {
  readIssueFile,
  writeIssueFile,
  issueToFileName,
  findFileByNumber,
  serializeIssueFile,
  type IssueFrontmatter,
} from './fileManager';
import { type SyncTarget, type IssueConfig, resolveQuery } from './configManager';

// Lazy vscode import so unit tests can stub it out
function vscode(): typeof vscodeType {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('vscode');
}

export class SyncManager {
  private suppressedUris = new Map<string, number>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private pullTimer: NodeJS.Timeout | null = null;
  private watcher: vscodeType.FileSystemWatcher | null = null;

  constructor(
    private client: GitHubClient,
    private config: IssueConfig,
    private target: SyncTarget,
    private workspaceFolder: vscodeType.WorkspaceFolder,
    private context: vscodeType.ExtensionContext
  ) {}

  /** Returns true if the given file path is managed by this sync manager. */
  ownsFile(filePath: string): boolean {
    const base = this.target.location;
    return filePath === base || filePath.startsWith(base + path.sep);
  }

  /** Start the sync manager: setup file watcher and pull timer. */
  async start(): Promise<void> {
    const vs = vscode();
    const locationRelative = path.relative(
      this.workspaceFolder.uri.fsPath,
      this.target.location
    );

    this.watcher = vs.workspace.createFileSystemWatcher(
      new vs.RelativePattern(this.workspaceFolder, `${locationRelative}/**/*.md`)
    );

    this.watcher.onDidChange(uri => this.onFileChanged(uri));
    this.watcher.onDidCreate(uri => this.handleNewFile(uri));

    this.context.subscriptions.push(this.watcher);

    // Start periodic pull
    const intervalMs = this.config.pullInterval * 60 * 1000;
    this.pullTimer = setInterval(() => { void this.pullAll(); }, intervalMs);

    // Initial pull on activation
    await this.pullAll();
  }

  /** Stop: dispose watcher, clear timers. */
  dispose(): void {
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
  }

  /** Pull all issues from GitHub for this target. */
  async pullAll(): Promise<void> {
    try {
      await this.pullTarget();
    } catch (err) {
      console.error(
        `[issueSync] pullTarget "${this.target.repository_url}" failed:`, err
      );
    }
  }

  /** Pull issues for this target. */
  async pullTarget(): Promise<void> {
    const resolved = resolveQuery(this.target.query);
    const issues = await this.client.listIssues(resolved);

    for (const issue of issues) {
      const expectedFileName = issueToFileName(issue, this.config.fileNaming) + '.md';
      const expectedPath = path.join(this.target.location, expectedFileName);

      // Look for any existing file that tracks this issue number
      const existingPath = await findFileByNumber(this.target.location, issue.number, this.config.fileNaming);

      if (existingPath !== null && existingPath !== expectedPath) {
        // Title changed on GitHub — write to new path and remove the old file
        await this.writeIssueSuppressed(expectedPath, issue);
        await this.unlinkSuppressed(existingPath);
      } else {
        await this.writeIssueSuppressed(existingPath ?? expectedPath, issue);
      }
    }
  }

  /** Push a single issue file to GitHub. */
  async pushFile(filePath: string): Promise<void> {
    const { frontmatter, body } = await readIssueFile(filePath);

    if (frontmatter.number !== undefined) {
      // Existing issue — check for conflicts first
      const cloud = await this.client.getIssue(frontmatter.number);

      if (isConflict(cloud.updated_at, frontmatter.synced_at)) {
        await this.handleConflict(filePath, cloud);
        return;
      }

      await this.client.updateIssue(frontmatter.number, {
        title: frontmatter.title,
        body,
        state: frontmatter.state,
        labels: frontmatter.labels,
        assignees: frontmatter.assignees,
      });

      // Refresh local file with updated synced_at; rename if title changed
      const updated = await this.client.getIssue(frontmatter.number);
      await this.writeAndRename(filePath, updated, body);
    } else {
      // New file — create issue on GitHub, then rename file to match template
      const created = await this.client.createIssue({
        title: frontmatter.title,
        body,
        labels: frontmatter.labels,
        assignees: frontmatter.assignees,
      });
      await this.writeAndRename(filePath, created, body);
    }
  }

  /** Debounced push — called from file watcher. */
  debouncedPush(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) { clearTimeout(existing); }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.pushFile(filePath);
    }, this.config.autosaveDelay * 1000);

    this.debounceTimers.set(filePath, timer);
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

  /** Handle conflict between local file and cloud version. */
  private async handleConflict(localPath: string, cloudIssue: IssueData): Promise<void> {
    const vs = vscode();

    // Build cloud version content
    const cloudFrontmatter: IssueFrontmatter = {
      number: cloudIssue.number,
      title: cloudIssue.title,
      state: cloudIssue.state,
      labels: cloudIssue.labels,
      assignees: cloudIssue.assignees,
      synced_at: cloudIssue.updated_at,
      closed_at: cloudIssue.closed_at,
    };
    const cloudContent = serializeIssueFile(cloudFrontmatter, cloudIssue.body ?? '');

    // Write cloud version to temp file in global storage
    const tempDir = this.context.globalStorageUri.fsPath;
    const tempPath = path.join(tempDir, `temp-issue-${cloudIssue.number}.md`);
    await writeIssueFile(tempPath, cloudFrontmatter, cloudIssue.body ?? '');

    const localUri = vs.Uri.file(localPath);
    const tempUri = vs.Uri.file(tempPath);

    await vs.commands.executeCommand(
      'vscode.diff',
      localUri,
      tempUri,
      `Issue #${cloudIssue.number} — Local vs Cloud`
    );

    const choice = await vs.window.showInformationMessage(
      `Issue #${cloudIssue.number} has been updated on GitHub. Which version do you want to keep?`,
      'Accept Cloud',
      'Keep Local'
    );

    if (choice === 'Accept Cloud') {
      // Write cloud version; rename file if the cloud title differs
      await this.writeAndRename(localPath, cloudIssue);
    } else if (choice === 'Keep Local') {
      // Force-push local version ignoring the conflict, then rename if title changed
      const { frontmatter, body } = await readIssueFile(localPath);
      await this.client.updateIssue(cloudIssue.number, {
        title: frontmatter.title,
        body,
        state: frontmatter.state,
        labels: frontmatter.labels,
        assignees: frontmatter.assignees,
      });
      const updated = await this.client.getIssue(cloudIssue.number);
      await this.writeAndRename(localPath, updated, body);
    }

    // Remove temp file
    try {
      await fs.promises.unlink(tempPath);
    } catch { /* ignore */ }

    void cloudContent; // used above
  }

  /** Handles a newly created .md file in the issues directory. */
  private async handleNewFile(uri: vscodeType.Uri): Promise<void> {
    if (this.isSuppressed(uri.fsPath)) { return; }
    // Debounce to let the user finish writing
    this.debouncedPush(uri.fsPath);
  }

  private onFileChanged(uri: vscodeType.Uri): void {
    if (this.isSuppressed(uri.fsPath)) { return; }
    this.debouncedPush(uri.fsPath);
  }

  /** Writes an issue file while suppressing watcher events for it. */
  private async writeIssueSuppressed(
    filePath: string,
    issue: IssueData,
    overrideBody?: string
  ): Promise<void> {
    this.suppress(filePath, 1);
    try {
      const frontmatter: IssueFrontmatter = {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels,
        assignees: issue.assignees,
        synced_at: issue.updated_at,
        closed_at: issue.closed_at,
      };
      await writeIssueFile(filePath, frontmatter, overrideBody ?? issue.body ?? '');
    } finally {
      this.suppress(filePath, -1);
    }
  }

  /**
   * Writes issue data to the correct template-derived path.
   * If the derived path differs from currentPath (because the title changed),
   * the old file is deleted and the new file is written; otherwise the file
   * is updated in place.
   */
  private async writeAndRename(currentPath: string, issue: IssueData, overrideBody?: string): Promise<void> {
    const expectedFileName = issueToFileName(issue, this.config.fileNaming) + '.md';
    const expectedPath = path.join(this.target.location, expectedFileName);

    await this.writeIssueSuppressed(expectedPath, issue, overrideBody);

    if (expectedPath !== currentPath) {
      await this.unlinkSuppressed(currentPath);
    }
  }

  /** Deletes a file while suppressing watcher events for that path. */
  private async unlinkSuppressed(filePath: string): Promise<void> {
    this.suppress(filePath, 1);
    try {
      await fs.promises.unlink(filePath);
    } catch { /* ignore if already gone */ } finally {
      this.suppress(filePath, -1);
    }
  }
}

/** Pure helper: returns true if cloud version is newer than local synced_at. */
export function isConflict(cloudUpdatedAt: string, syncedAt: string): boolean {
  return new Date(cloudUpdatedAt) > new Date(syncedAt);
}


