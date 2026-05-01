import * as path from 'path';
import type * as vscodeType from 'vscode';
import type { SyncStateManager } from './syncStateManager';

// Lazy vscode import so unit tests can run without a VS Code instance
function vscode(): typeof vscodeType {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('vscode');
}

interface ManagedTarget {
  filesDir: string;
  pluginId: string;
  displayName: string;
  stateManager: SyncStateManager;
}

/**
 * Provides CodeLens actions on task files.
 * - Unpublished files: shows "▶ Publish to <service>" button.
 * - Published files: shows "owner/repo#42 → Open in Browser" button.
 */
export class PublishCodeLensProvider implements vscodeType.CodeLensProvider {
  private _emitter: vscodeType.EventEmitter<void> | undefined;
  private targets: ManagedTarget[] = [];

  readonly onDidChangeCodeLenses: vscodeType.Event<void> = (listener, thisArgs, disposables) => {
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
      (t) => filePath === t.filesDir || filePath.startsWith(t.filesDir + path.sep),
    );
    if (!matchingTarget) {
      return [];
    }
    if (!filePath.endsWith('.md')) {
      return [];
    }

    // Check sync state to determine if file is published
    const stateEntry = matchingTarget.stateManager.getEntry(filePath);
    const pluginRef = stateEntry?.plugins?.[matchingTarget.pluginId];

    if (pluginRef?.key) {
      // Published — show remote reference CodeLens
      return [this.createRemoteRefCodeLens(document, pluginRef.key, matchingTarget.pluginId, matchingTarget.stateManager)];
    }

    // Unpublished — show publish button at line 0
    return [this.createPublishCodeLens(document, 0, matchingTarget.displayName)];
  }

  private createRemoteRefCodeLens(
    document: vscodeType.TextDocument, //
    remoteKey: string,
    pluginId: string,
    stateManager: SyncStateManager,
  ): vscodeType.CodeLens {
    const vs = vscode();
    const range = new vs.Range(0, 0, 0, 0);

    // Parse remoteKey "owner/repo/42" → "owner/repo#42"
    const parts = remoteKey.split('/');
    let label: string;
    if (parts.length >= 3) {
      const number = parts[parts.length - 1];
      const repo = parts.slice(0, -1).join('/');
      label = `${repo}#${number}`;
    } else {
      label = remoteKey;
    }

    // Get html_url from plugin data in state
    const pluginData = stateManager.getPluginData(document.uri.fsPath, pluginId);
    const htmlUrl = pluginData?.html_url as string | undefined;

    const url = htmlUrl
      ?? (parts.length >= 3
        ? `https://github.com/${parts.slice(0, -1).join('/')}/issues/${parts[parts.length - 1]}`
        : undefined);

    return new vs.CodeLens(range, {
      title: `🔗 ${label}`,
      command: url ? 'vscode.open' : '',
      arguments: url ? [vs.Uri.parse(url)] : [],
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
      command: 'issuesAsCode.publishFile',
      arguments: [document.uri],
    });
  }
}
