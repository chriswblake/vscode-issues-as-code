import * as path from 'path';
import type * as vscodeType from 'vscode';
import { getPrimaryPlugin } from './plugins/syncPlugin';

// Lazy vscode import so unit tests can run without a VS Code instance
function vscode(): typeof vscodeType {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('vscode');
}

interface ManagedTarget {
  filesDir: string;
  pluginId: string;
  displayName: string;
}

/**
 * Provides CodeLens actions on unpublished task files.
 * When a file has no remote ID in its frontmatter, shows a "Publish to <service>" button
 * above the frontmatter, similar to how test files show "Run" buttons.
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

    // Only provide CodeLens for files inside managed target directories
    const matchingTarget = this.targets.find(
      (t) => filePath === t.filesDir || filePath.startsWith(t.filesDir + path.sep),
    );
    if (!matchingTarget) {
      return [];
    }

    // Only for .md files
    if (!filePath.endsWith('.md')) {
      return [];
    }

    // Check if the file has frontmatter but no remote ID
    const text = document.getText();
    if (!text.startsWith('---')) {
      // No frontmatter — show publish button at line 0
      return [this.createPublishCodeLens(document, 0, matchingTarget.displayName)];
    }

    // Use the registered plugin to check if the file is published
    try {
      const matter = require('gray-matter');
      const { data } = matter(text);
      const plugin = getPrimaryPlugin(matchingTarget.pluginId);
      if (plugin) {
        const remoteId = plugin.getRemoteId(data);
        if (remoteId !== undefined) {
          return [];
        }
      }
    } catch {
      return [];
    }

    // File is unpublished — show CodeLens at the top
    return [this.createPublishCodeLens(document, 0, matchingTarget.displayName)];
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
