import * as path from 'path';
import * as fs from 'fs';
import type * as vscodeType from 'vscode';
import type { GitHubClient, IssueData } from './githubClient';
import {
  readIssueFile, //
  writeIssueFile,
  issueToFileName,
  findFileByNumber,
  serializeIssueFile,
  type IssueFrontmatter,
} from './fileManager';
import {
  type SyncTarget, //
  type IssueConfig,
  resolveQuery,
} from './configManager';
import { SyncStateManager, type RemoteIssueInfo } from './syncStateManager';

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
    private context: vscodeType.ExtensionContext,
    private stateManager: SyncStateManager,
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
      this.workspaceFolder.uri.fsPath, //
      this.target.location,
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
    const intervalMs = this.config.pullInterval * 60 * 1000;
    this.pullTimer = setInterval(() => {
      void this.pullAll();
    }, intervalMs);

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
        `[issueSync] pullTarget "${this.target.repository_url}" failed:`, //
        err,
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
      const existingPath = await findFileByNumber(
        this.target.location, //
        issue.number,
        this.config.fileNaming,
      );

      if (existingPath !== null && existingPath !== expectedPath) {
        // Title changed on GitHub — write to new path and remove the old file
        await this.writeIssueSuppressed(expectedPath, issue);
        await this.unlinkSuppressed(existingPath);
      } else {
        await this.pullIssue(existingPath ?? expectedPath, issue);
      }
    }
  }

  /** Pull a single issue: auto-accept one-directional changes, write conflict markers for mixed. */
  private async pullIssue(localPath: string, issue: IssueData): Promise<void> {
    const localExists = await fs.promises.access(localPath).then(
      () => true,
      () => false,
    );
    if (!localExists) {
      await this.writeIssueSuppressed(localPath, issue);
      return;
    }

    const localContent = await fs.promises.readFile(localPath, 'utf8');

    // Skip if the user is currently resolving a merge conflict
    if (hasConflictMarkers(localContent)) {
      return;
    }

    const cloudFrontmatter: IssueFrontmatter = {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: issue.labels,
      assignees: issue.assignees,
    };
    const cloudContent = serializeIssueFile(cloudFrontmatter, issue.body ?? '');
    const kind = classifyDiff(localContent, cloudContent);

    if (kind === 'identical') {
      // Update state entry so the state file always has a complete record of all tracked issues
      await this.stateManager.setSyncedAt(
        this.target.location, //
        issue.number,
        localPath,
        issueToRemoteInfo(issue),
      );
      return;
    }

    if (!isConflict(issue.updated_at, this.stateManager.getSyncedAt(this.target.location, issue.number))) {
      // Cloud hasn't changed since last sync — local edits are pending push; leave them alone
      return;
    }

    if (kind === 'additions-only' || kind === 'removals-only') {
      await this.writeIssueSuppressed(localPath, issue);
      return;
    }

    // Mixed: write conflict markers so the user can resolve all conflicts in-editor
    await this.writeConflictMarkers(localPath, localContent, cloudContent, issue);
  }

  /** Push a single issue file to GitHub. */
  async pushFile(filePath: string): Promise<void> {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    if (hasConflictMarkers(raw)) {
      return; // Unresolved merge conflict — wait for the user to resolve before pushing
    }

    const { frontmatter, body } = await readIssueFile(filePath);

    if (frontmatter.number !== undefined) {
      // Existing issue — check for conflicts first
      const cloud = await this.client.getIssue(frontmatter.number);

      if (isConflict(cloud.updated_at, this.stateManager.getSyncedAt(this.target.location, frontmatter.number!))) {
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

      // Refresh local file; rename if title changed
      const updated = await this.client.getIssue(frontmatter.number);
      await this.writeAndRename(filePath, updated, body);
    } else {
      // New file — create issue on GitHub, then rename file to match template
      const inferredTitle = inferNewIssueTitle(
        filePath, //
        frontmatter.title,
        body,
      );
      const created = await this.client.createIssue({
        title: inferredTitle,
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
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.pushFile(filePath).catch((err) => {
        console.error(`[issueSync] push failed for "${filePath}":`, err);
        const message = err instanceof Error ? err.message : 'Unknown error';
        void vscode().window.showErrorMessage(`Issue sync push failed for ${path.basename(filePath)}: ${message}`);
      });
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

  /** Handle conflict between local file and cloud version (called from pushFile). */
  private async handleConflict(localPath: string, cloudIssue: IssueData): Promise<void> {
    const cloudFrontmatter: IssueFrontmatter = {
      number: cloudIssue.number,
      title: cloudIssue.title,
      state: cloudIssue.state,
      labels: cloudIssue.labels,
      assignees: cloudIssue.assignees,
    };
    const cloudContent = serializeIssueFile(cloudFrontmatter, cloudIssue.body ?? '');
    const localContent = await fs.promises.readFile(localPath, 'utf8');

    // Auto-accept one-directional changes
    const kind = classifyDiff(localContent, cloudContent);
    if (kind === 'identical' || kind === 'additions-only' || kind === 'removals-only') {
      await this.writeAndRename(localPath, cloudIssue);
      return;
    }

    // Mixed: write conflict markers so the user can resolve all conflicts in-editor
    await this.writeConflictMarkers(localPath, localContent, cloudContent, cloudIssue);
  }

  /** Writes merge conflict markers into localPath and advances the sync timestamp. */
  private async writeConflictMarkers(localPath: string, localContent: string, cloudContent: string, issue: IssueData): Promise<void> {
    const conflictContent = generateConflictContent(localContent, cloudContent);
    this.suppress(localPath, 1);
    try {
      await fs.promises.writeFile(localPath, conflictContent, 'utf8');
      await this.stateManager.setSyncedAt(
        this.target.location, //
        issue.number,
        localPath,
        issueToRemoteInfo(issue),
      );
    } finally {
      this.suppress(localPath, -1);
    }

    void vscode().window.showWarningMessage(`Issue #${issue.number} has conflicting changes. Resolve the conflict markers in ${path.basename(localPath)}, then save.`);
  }

  /** Handles a newly created .md file in the issues directory. */
  private async handleNewFile(uri: vscodeType.Uri): Promise<void> {
    if (this.isSuppressed(uri.fsPath)) {
      return;
    }
    // Debounce to let the user finish writing
    this.debouncedPush(uri.fsPath);
  }

  private onFileChanged(uri: vscodeType.Uri): void {
    if (this.isSuppressed(uri.fsPath)) {
      return;
    }
    this.debouncedPush(uri.fsPath);
  }

  /** Writes an issue file while suppressing watcher events for it. */
  private async writeIssueSuppressed(filePath: string, issue: IssueData, overrideBody?: string): Promise<void> {
    this.suppress(filePath, 1);
    try {
      const frontmatter: IssueFrontmatter = {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels,
        assignees: issue.assignees,
      };
      await writeIssueFile(filePath, frontmatter, overrideBody ?? issue.body ?? '');
      await this.stateManager.setSyncedAt(
        this.target.location, //
        issue.number,
        filePath,
        issueToRemoteInfo(issue),
      );
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
    } catch {
      /* ignore if already gone */
    } finally {
      this.suppress(filePath, -1);
    }
  }
}

/** Maps an IssueData to the RemoteIssueInfo shape stored in the sync state. */
function issueToRemoteInfo(issue: IssueData): RemoteIssueInfo {
  return {
    number: issue.number, //
    state: issue.state,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: issue.html_url,
  };
}

/** Pure helper: returns true if the file content contains unresolved merge conflict markers. */
export function hasConflictMarkers(content: string): boolean {
  return /^<{7} /m.test(content);
}

/** Pure helper: returns true if cloud version is newer than local synced_at. */
export function isConflict(cloudUpdatedAt: string, syncedAt: string | undefined): boolean {
  if (!syncedAt) {
    return false;
  }
  return new Date(cloudUpdatedAt) > new Date(syncedAt);
}

// Diff helpers

type DiffLine = { type: 'equal' | 'added' | 'removed'; line: string };

/** LCS-based line diff. 'added' = in cloud only, 'removed' = in local only. */
export function computeLineDiff(localLines: string[], cloudLines: string[]): DiffLine[] {
  const m = localLines.length;
  const n = cloudLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
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
      result.push({ type: 'equal', line: localLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'removed', line: localLines[i] });
      i++;
    } else {
      result.push({ type: 'added', line: cloudLines[j] });
      j++;
    }
  }
  while (i < m) {
    result.push({ type: 'removed', line: localLines[i++] });
  }
  while (j < n) {
    result.push({ type: 'added', line: cloudLines[j++] });
  }

  return result;
}

/** Returns whether a cloud→local change is additions-only, removals-only, mixed, or identical. */
export function classifyDiff(localContent: string, cloudContent: string): 'identical' | 'additions-only' | 'removals-only' | 'mixed' {
  const diff = computeLineDiff(
    localContent.split(/\r?\n/), //
    cloudContent.split(/\r?\n/),
  );

  let hasAdditions = false;
  let hasRemovals = false;
  for (const item of diff) {
    if (item.type === 'added') hasAdditions = true;
    if (item.type === 'removed') hasRemovals = true;
  }

  if (!hasAdditions && !hasRemovals) return 'identical';
  if (hasAdditions && !hasRemovals) return 'additions-only';
  if (!hasAdditions && hasRemovals) return 'removals-only';
  return 'mixed';
}

/** Produces file content with standard merge conflict markers for all diff hunks. */
export function generateConflictContent(localContent: string, cloudContent: string): string {
  const diff = computeLineDiff(
    localContent.split(/\r?\n/), //
    cloudContent.split(/\r?\n/),
  );

  const output: string[] = [];
  let i = 0;
  while (i < diff.length) {
    if (diff[i].type === 'equal') {
      output.push(diff[i].line);
      i++;
    } else {
      // Collect a contiguous conflict hunk
      const localSection: string[] = [];
      const cloudSection: string[] = [];
      while (i < diff.length && diff[i].type !== 'equal') {
        if (diff[i].type === 'removed') localSection.push(diff[i].line);
        else cloudSection.push(diff[i].line);
        i++;
      }
      output.push('<<<<<<< Local');
      output.push(...localSection);
      output.push('=======');
      output.push(...cloudSection);
      output.push('>>>>>>> GitHub');
    }
  }

  return output.join('\n');
}

/**
 * Derives a title for new local issue files when frontmatter.title is missing.
 * Priority: explicit title -> first non-empty body line (without markdown heading) -> file name.
 */
export function inferNewIssueTitle(filePath: string, frontmatterTitle: string, body: string): string {
  const explicit = frontmatterTitle.trim();
  if (explicit) {
    return explicit;
  }

  const bodyLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (bodyLine) {
    const cleaned = bodyLine.replace(/^#+\s*/, '').trim();
    if (cleaned) {
      return cleaned;
    }
  }

  return path.basename(filePath, path.extname(filePath)).trim() || 'New issue';
}
