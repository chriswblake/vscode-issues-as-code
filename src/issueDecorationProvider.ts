import * as fs from "fs";
import * as path from "path";
import type * as vscodeType from "vscode";
import type { ShowSyncIconsConfig } from "./configManager";
import type { SyncStateManager } from "./syncStateManager";

// Lazy vscode import so unit tests can run without a VS Code instance
function vscode(): typeof vscodeType {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("vscode");
}

export type SyncStatus = "new" | "modified" | "synchronized" | "readOnly";

// Decoration definitions per status
const DECORATIONS: Record<
  SyncStatus,
  { badge: string; tooltip: string; colorId?: string }
> = {
  new: {
    badge: "A",
    tooltip: "New Issue: Not pushed to remote yet",
    colorId: "gitDecoration.addedResourceForeground",
  },
  modified: {
    badge: "M",
    tooltip: "Modified: Locally modified but not pushed to remote yet",
    colorId: "gitDecoration.modifiedResourceForeground",
  },
  synchronized: {
    badge: "✓",
    tooltip: "Synchronized: Local issue matches remote issue",
  },
  readOnly: {
    badge: "🔏",
    tooltip: "Read-Only: Managed by remote; local changes are not pushed",
  },
};

interface ManagedLocation {
  location: string;
  stateManager: SyncStateManager;
  readOnly?: boolean;
}

/**
 * Provides file decorations (badge + tooltip) for issue files in the Explorer,
 * reflecting their sync status relative to GitHub.
 */
export class IssueDecorationProvider
  implements vscodeType.FileDecorationProvider
{
  private _emitter:
    | vscodeType.EventEmitter<vscodeType.Uri | vscodeType.Uri[] | undefined>
    | undefined;

  private getEmitter():
    | vscodeType.EventEmitter<vscodeType.Uri | vscodeType.Uri[] | undefined>
    | undefined {
    if (!this._emitter) {
      try {
        this._emitter = new (vscode().EventEmitter)();
      } catch {
        // vscode not available (unit test context)
        return undefined;
      }
    }
    return this._emitter;
  }

  readonly onDidChangeFileDecorations: vscodeType.Event<
    vscodeType.Uri | vscodeType.Uri[] | undefined
  > = (listener, thisArgs, disposables) => {
    const emitter = this.getEmitter();
    if (emitter) {
      return emitter.event(listener, thisArgs, disposables);
    }
    return { dispose: () => {} };
  };

  private managedLocations: ManagedLocation[] = [];
  private showSyncIcons: ShowSyncIconsConfig = {
    newIssue: true,
    modified: true,
    synchronized: true,
  };
  private dirtyFiles = new Set<string>();

  /** Replace all managed locations and config; refresh all decorations. */
  update(
    locations: ManagedLocation[],
    showSyncIcons: ShowSyncIconsConfig,
  ): void {
    this.managedLocations = locations;
    this.showSyncIcons = showSyncIcons;
    this.getEmitter()?.fire(undefined);
  }

  /** Mark a file as having unsaved editor changes; shows M badge immediately. */
  markDirty(filePath: string): void {
    if (!this.isManaged(filePath)) {
      return;
    }
    if (this.dirtyFiles.has(filePath)) {
      return; // Already marked — no need to re-fire
    }
    this.dirtyFiles.add(filePath);
    this.refresh(filePath);
  }

  /** Clear dirty state for a file (called after confirmed sync or on revert). */
  clearDirty(filePath: string): void {
    if (!this.dirtyFiles.has(filePath)) {
      return;
    }
    this.dirtyFiles.delete(filePath);
    this.refresh(filePath);
  }

  private isManaged(filePath: string): boolean {
    if (!filePath.endsWith(".md")) {
      return false;
    }
    return this.managedLocations.some(({ location }) =>
      filePath.startsWith(location + path.sep),
    );
  }

  /** Trigger a decoration refresh for a single file. */
  refresh(filePath: string): void {
    try {
      this.getEmitter()?.fire(vscode().Uri.file(filePath));
    } catch {
      // vscode not available (unit test context)
    }
  }

  provideFileDecoration(
    uri: vscodeType.Uri,
  ): vscodeType.FileDecoration | undefined {
    if (!uri.fsPath.endsWith(".md")) {
      return undefined;
    }

    // Only decorate files under a managed location
    const managed = this.managedLocations.find(({ location }) =>
      uri.fsPath.startsWith(location + path.sep),
    );
    if (!managed) {
      return undefined;
    }

    const status = this.resolveStatus(
      uri.fsPath,
      managed.stateManager,
      managed.readOnly,
    );

    // Check if the icon for this status is enabled
    if (status === "new" && !this.showSyncIcons.newIssue) {
      return undefined;
    }
    if (status === "modified" && !this.showSyncIcons.modified) {
      return undefined;
    }
    if (status === "synchronized" && !this.showSyncIcons.synchronized) {
      return undefined;
    }

    const def = DECORATIONS[status];
    let color: vscodeType.ThemeColor | undefined;
    if (def.colorId) {
      try {
        color = new (vscode().ThemeColor)(def.colorId);
      } catch {
        // vscode not available (unit test context)
      }
    }
    return {
      badge: def.badge,
      tooltip: def.tooltip,
      color,
    };
  }

  private resolveStatus(
    filePath: string,
    stateManager: SyncStateManager,
    readOnly?: boolean,
  ): SyncStatus {
    // readOnly files always show the lock icon
    if (readOnly) {
      return "readOnly";
    }

    // Unsaved editor changes — show modified immediately, before any disk write
    if (this.dirtyFiles.has(filePath)) {
      return "modified";
    }

    const entry = stateManager.getEntry(filePath);

    if (!entry) {
      // No sync state — file not yet pushed to remote
      return "new";
    }

    const localWrittenAt = new Date(entry.local_written_at).getTime();

    let fileMtime = 0;
    try {
      fileMtime = fs.statSync(filePath).mtimeMs;
    } catch {
      // File may not exist yet; treat as new
      return "new";
    }

    // Allow 1 second tolerance to account for filesystem resolution differences
    if (fileMtime > localWrittenAt + 1000) {
      return "modified";
    }

    return "synchronized";
  }
}
