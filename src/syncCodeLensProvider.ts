import * as path from "path";
import type * as vscodeType from "vscode";
import type { SyncStateStore } from "./syncStateStore";
import { isLocalFileModified } from "./fileModification";

// Lazy vscode import so unit tests can run without a VS Code instance
function vscode(): typeof vscodeType {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("vscode");
}

interface ManagedTarget {
  filesDir: string;
  pluginId: string;
  displayName: string;
  stateManager: SyncStateStore;
  readOnly?: boolean;
}

/**
 * Provides CodeLens actions on task files.
 * - Unpublished files: shows "▶ Publish to <service>" button.
 * - Published files:
 *   - Line 1: "owner/repo#42 → Open in Browser" link.
 *   - Line 2: Sync details — remote status, "Pull Changes" (if pending), "Sync Now" (if modified locally).
 * - Read-only files: shows only the remote reference link (no publish or sync buttons).
 */
export class SyncCodeLensProvider implements vscodeType.CodeLensProvider {
  private _emitter: vscodeType.EventEmitter<void> | undefined;
  private targets: ManagedTarget[] = [];

  readonly onDidChangeCodeLenses: vscodeType.Event<void> = (
    listener,
    thisArgs,
    disposables,
  ) => {
    if (!this._emitter) {
      try {
        this._emitter = new (vscode().EventEmitter)();
      } catch {
        return { dispose: () => {} };
      }
    }
    return this._emitter.event(listener, thisArgs, disposables);
  };

  /** Update the list of managed targets (called when sync managers are initialized). */
  update(targets: ManagedTarget[]): void {
    this.targets = targets;
    this._emitter?.fire();
  }

  /** Signal that CodeLens should be recomputed (e.g. after state changes). */
  refresh(): void {
    this._emitter?.fire();
  }

  provideCodeLenses(
    document: vscodeType.TextDocument,
    _token: vscodeType.CancellationToken,
  ): vscodeType.CodeLens[] {
    const filePath = document.uri.fsPath;

    // Only provide CodeLens for .task.md files inside managed target directories
    const matchingTarget = this.targets.find(
      (t) =>
        filePath === t.filesDir || filePath.startsWith(t.filesDir + path.sep),
    );
    if (!matchingTarget) {
      return [];
    }
    if (!filePath.endsWith(".task.md")) {
      return [];
    }

    // Check sync state to determine if file is published
    const stateEntry = matchingTarget.stateManager.getEntry(filePath);
    const pluginRef = stateEntry?.plugins?.[matchingTarget.pluginId];

    if (pluginRef?.key) {
      // Published — show CodeLens inside the plugin's frontmatter section
      const sectionLine = findFrontmatterSectionLine(
        document,
        matchingTarget.pluginId,
      );

      // Both CodeLens on the first field line so they stack together under "gh-issues:"
      const lensLine = sectionLine + 1;

      // Line 1: Remote reference link
      const lenses = [
        this.createRemoteRefCodeLens(
          document, //
          pluginRef.key,
          matchingTarget.pluginId,
          matchingTarget.stateManager,
          lensLine,
        ),
      ];

      // Line 2: Sync details
      if (!matchingTarget.readOnly) {
        const hasPending = matchingTarget.stateManager.hasPendingRemoteChanges(
          filePath,
          matchingTarget.pluginId,
        );

        // Remote status info
        const statusText = this.buildRemoteStatusText(
          filePath,
          matchingTarget.pluginId,
          matchingTarget.stateManager,
        );
        if (statusText) {
          lenses.push(
            this.createStatusCodeLens(document, lensLine, statusText),
          );
        }

        // "Pull Changes" button when remote has pending changes
        if (hasPending) {
          lenses.push(this.createPullChangesCodeLens(document, lensLine));
        }

        // "Sync Now" button when locally modified and no pending remote changes
        if (!hasPending && isLocalFileModified(filePath, stateEntry)) {
          lenses.push(this.createSyncNowCodeLens(document, lensLine));
        }
      }

      return lenses;
    }

    // Unpublished — show publish button (only for writable targets)
    if (matchingTarget.readOnly) {
      return [];
    }
    const publishLine = findFrontmatterSectionLine(
      document,
      matchingTarget.pluginId,
    );
    return [
      this.createPublishCodeLens(
        document,
        publishLine,
        matchingTarget.displayName,
      ),
    ];
  }

  private buildRemoteStatusText(
    filePath: string,
    pluginId: string,
    stateManager: SyncStateStore,
  ): string | null {
    const pluginData = stateManager.getPluginData(filePath, pluginId);
    if (!pluginData) {
      return null;
    }

    const updatedAt = pluginData.updated_at as string | undefined;
    if (!updatedAt) {
      return null;
    }

    const timeStr = formatRelativeTime(new Date(updatedAt));

    const lastModifiedBy = pluginData.last_modified_by as string | undefined;
    if (lastModifiedBy) {
      return `Remote was last modified ${timeStr} by @${lastModifiedBy}.`;
    }
    return `Remote was last modified ${timeStr}.`;
  }

  private createRemoteRefCodeLens(
    document: vscodeType.TextDocument, //
    remoteKey: string,
    pluginId: string,
    stateManager: SyncStateStore,
    line: number,
  ): vscodeType.CodeLens {
    const vs = vscode();
    const range = new vs.Range(line, 0, line, 0);

    // Parse remoteKey "owner/repo/42" → "owner/repo#42"
    const parts = remoteKey.split("/");
    let label: string;
    if (parts.length >= 3) {
      const number = parts[parts.length - 1];
      const repo = parts.slice(0, -1).join("/");
      label = `${repo}#${number}`;
    } else {
      label = remoteKey;
    }

    // Get html_url from plugin data in state
    const pluginData = stateManager.getPluginData(
      document.uri.fsPath,
      pluginId,
    );
    const htmlUrl = pluginData?.html_url as string | undefined;

    return new vs.CodeLens(range, {
      title: `🔗 ${label}`,
      command: htmlUrl ? "vscode.open" : "",
      arguments: htmlUrl ? [vs.Uri.parse(htmlUrl)] : [],
    });
  }

  private createStatusCodeLens(
    document: vscodeType.TextDocument, //
    line: number,
    statusText: string,
  ): vscodeType.CodeLens {
    const vs = vscode();
    const range = new vs.Range(line, 0, line, 0);

    return new vs.CodeLens(range, {
      title: statusText,
      command: "",
      arguments: [],
    });
  }

  private createPullChangesCodeLens(
    document: vscodeType.TextDocument, //
    line: number,
  ): vscodeType.CodeLens {
    const vs = vscode();
    const range = new vs.Range(line, 0, line, 0);

    return new vs.CodeLens(range, {
      title: "⬇ Pull Changes",
      tooltip: "There are pending changes on the remote.",
      command: "issuesAsCode.pullFile",
      arguments: [document.uri],
    });
  }

  private createSyncNowCodeLens(
    document: vscodeType.TextDocument, //
    line: number,
  ): vscodeType.CodeLens {
    const vs = vscode();
    const range = new vs.Range(line, 0, line, 0);

    return new vs.CodeLens(range, {
      title: "⟳ Sync Now",
      command: "issuesAsCode.publishFile",
      arguments: [document.uri],
    });
  }

  private createPublishCodeLens(
    document: vscodeType.TextDocument, //
    line: number,
    displayName: string,
  ): vscodeType.CodeLens {
    const vs = vscode();
    const range = new vs.Range(line, 0, line, 0);

    return new vs.CodeLens(range, {
      title: `▶ Publish to ${displayName}`,
      command: "issuesAsCode.publishFile",
      arguments: [document.uri],
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Finds the line number of the frontmatter section for the given plugin ID.
 * Returns 0 (start of file) if the section is not found.
 *
 * Frontmatter looks like:
 * ```
 * ---
 * gh-issues:
 *   title: Some issue
 * ---
 * ```
 * The CodeLens is positioned on the `gh-issues:` line so it appears above
 * that section in the editor.
 */
export function findFrontmatterSectionLine(
  document: vscodeType.TextDocument,
  sectionKey: string,
): number {
  const text = document.getText();
  const lines = text.split(/\r?\n/);

  if (!lines[0]?.trim().startsWith("---")) {
    return 0;
  }

  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    if (i === 0 && lines[i].trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter && lines[i].trim() === "---") {
      break;
    }
    if (inFrontmatter && new RegExp(`^${sectionKey}:`).test(lines[i])) {
      return i;
    }
  }

  return 0;
}

/**
 * Formats a date as a relative time string (e.g., "3 minutes ago", "2 hours ago").
 * Timezone-independent since it compares against the current time.
 */
export function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) {
    return "just now";
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }

  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
