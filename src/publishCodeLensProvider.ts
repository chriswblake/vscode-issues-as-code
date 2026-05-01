import * as fs from "fs";
import * as path from "path";
import type * as vscodeType from "vscode";
import type { SyncStateManager } from "./syncStateManager";

// Lazy vscode import so unit tests can run without a VS Code instance
function vscode(): typeof vscodeType {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("vscode");
}

interface ManagedTarget {
  filesDir: string;
  pluginId: string;
  displayName: string;
  stateManager: SyncStateManager;
  readOnly?: boolean;
}

/**
 * Provides CodeLens actions on task files.
 * - Unpublished files: shows "▶ Publish to <service>" button.
 * - Published files: shows "owner/repo#42 → Open in Browser" button, with an optional "⟳ Sync Now" button when modified.
 * - Read-only files: shows only the remote reference link (no publish or sync buttons).
 */
export class PublishCodeLensProvider implements vscodeType.CodeLensProvider {
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

  provideCodeLenses(
    document: vscodeType.TextDocument,
    _token: vscodeType.CancellationToken,
  ): vscodeType.CodeLens[] {
    const filePath = document.uri.fsPath;

    // Only provide CodeLens for .md files inside managed target directories
    const matchingTarget = this.targets.find(
      (t) =>
        filePath === t.filesDir || filePath.startsWith(t.filesDir + path.sep),
    );
    if (!matchingTarget) {
      return [];
    }
    if (!filePath.endsWith(".md")) {
      return [];
    }

    // Check sync state to determine if file is published
    const stateEntry = matchingTarget.stateManager.getEntry(filePath);
    const pluginRef = stateEntry?.plugins?.[matchingTarget.pluginId];

    if (pluginRef?.key) {
      // Published — show remote reference CodeLens above the plugin's frontmatter section
      const sectionLine = findFrontmatterSectionLine(
        document,
        matchingTarget.pluginId,
      );
      const lenses = [
        this.createRemoteRefCodeLens(
          document, //
          pluginRef.key,
          matchingTarget.pluginId,
          matchingTarget.stateManager,
          sectionLine,
        ),
      ];

      // Show a "Sync Now" button when the file has unsaved or unsynced changes, unless read-only
      if (!matchingTarget.readOnly && isFileModified(filePath, stateEntry)) {
        lenses.push(this.createSyncNowCodeLens(document, sectionLine));
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

  private createRemoteRefCodeLens(
    document: vscodeType.TextDocument, //
    remoteKey: string,
    pluginId: string,
    stateManager: SyncStateManager,
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

    const url =
      htmlUrl ??
      (parts.length >= 3
        ? `https://github.com/${parts.slice(0, -1).join("/")}/issues/${parts[parts.length - 1]}`
        : undefined);

    return new vs.CodeLens(range, {
      title: `🔗 ${label}`,
      command: url ? "vscode.open" : "",
      arguments: url ? [vs.Uri.parse(url)] : [],
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
 * Returns true if the saved file has been modified since the extension last wrote it.
 * Provides a 1 second tolerance for filesystem timestamp differences.
 */
export function isFileModified(
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
