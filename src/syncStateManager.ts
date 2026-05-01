import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/** Read-only snapshot of a remote item at the time it was last synced. */
export interface RemoteIssueInfo {
  number: number;
  state: 'open' | 'closed';
  updated_at: string;
  closed_at: string | null;
  html_url: string;
}

/** A reference from a file entry to a plugin record. */
export interface FilePluginRef {
  /** Key into the corresponding plugin section (e.g. "owner/repo/7"). */
  key: string;
  /** ISO timestamp of when the remote record was last synced. */
  synced_at: string;
}

/** State record for a single synced file. */
export interface SyncStateEntry {
  /** ISO timestamp of when the extension last wrote the local file. */
  local_written_at: string;
  /** Plugin references keyed by plugin ID. */
  plugins?: Record<string, FilePluginRef>;
}

interface SyncStateFile {
  /** Plugin data sections keyed by plugin ID, each containing records keyed by remoteKey. */
  pluginData?: Record<string, Record<string, Record<string, unknown>>>;
  /** Keyed by absolute path of the local file. */
  files: Record<string, SyncStateEntry>;
}

/**
 * Persists per-file sync state, structured by plugin and cross-referenced from the `files` section.
 */
export class SyncStateManager {
  private state: SyncStateFile = { files: {} };
  private changeListeners: Array<(filePath: string) => void> = [];

  constructor(private readonly statePath: string) {}

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onDidChange(listener: (filePath: string) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  private notifyChange(filePath: string): void {
    for (const listener of this.changeListeners) {
      listener(filePath);
    }
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.statePath, 'utf8');
      const parsed = yaml.load(raw) as SyncStateFile | null;

      if (parsed && typeof parsed === 'object' && 'files' in parsed) {
        this.state = parsed as SyncStateFile;
      } else {
        this.state = { files: {} };
      }
    } catch {
      this.state = { files: {} };
    }
  }

  /** Returns the synced_at timestamp for the given file path and plugin. */
  getSyncedAt(filePath: string, pluginId?: string): string | undefined {
    const entry = this.state.files[filePath];
    if (!entry) {
      return undefined;
    }
    if (pluginId) {
      return entry.plugins?.[pluginId]?.synced_at;
    }
    // Default: return first plugin's synced_at
    const plugins = entry.plugins;
    if (!plugins) {
      return undefined;
    }
    const first = Object.values(plugins)[0];
    return first?.synced_at;
  }

  getLocalWrittenAt(filePath: string): string | undefined {
    return this.state.files[filePath]?.local_written_at;
  }

  getEntry(filePath: string): SyncStateEntry | undefined {
    return this.state.files[filePath];
  }

  async setSyncedAt(filePath: string, remote: RemoteIssueInfo, pluginId: string, remoteKey: string): Promise<void> {
    // Update the plugin data section
    if (!this.state.pluginData) {
      this.state.pluginData = {};
    }
    if (!this.state.pluginData[pluginId]) {
      this.state.pluginData[pluginId] = {};
    }
    this.state.pluginData[pluginId][remoteKey] = {
      number: remote.number,
      state: remote.state,
      updated_at: remote.updated_at,
      closed_at: remote.closed_at,
      html_url: remote.html_url,
    };

    // Update the files section
    const existing = this.state.files[filePath] ?? { local_written_at: '' };
    const existingPlugins = existing.plugins ?? {};
    this.state.files[filePath] = {
      ...existing,
      local_written_at: new Date().toISOString(),
      plugins: { ...existingPlugins, [pluginId]: { key: remoteKey, synced_at: remote.updated_at } },
    };

    await this.save();
    this.notifyChange(filePath);
  }

  /** Copies an existing SyncStateEntry to a new file path, then persists. */
  async setSyncedAtEntry(filePath: string, entry: SyncStateEntry): Promise<void> {
    this.state.files[filePath] = { ...entry, local_written_at: new Date().toISOString() };
    await this.save();
    this.notifyChange(filePath);
  }

  /** Removes the state entry for a single file path, then persists. */
  async deleteEntry(filePath: string): Promise<void> {
    delete this.state.files[filePath];
    await this.save();
    this.notifyChange(filePath);
  }

  /** Returns all entries whose file path is directly inside the given location directory. */
  getFilesUnderLocation(location: string): ReadonlyMap<string, SyncStateEntry> {
    const prefix = location + path.sep;
    const result = new Map<string, SyncStateEntry>();
    for (const [filePath, entry] of Object.entries(this.state.files)) {
      if (filePath.startsWith(prefix)) {
        result.set(filePath, entry);
      }
    }
    return result;
  }

  /** Removes all state entries whose file path is inside the given location, then persists. */
  async removeFilesUnderLocation(location: string): Promise<void> {
    const prefix = location + path.sep;
    for (const filePath of Object.keys(this.state.files)) {
      if (filePath.startsWith(prefix)) {
        delete this.state.files[filePath];
      }
    }
    await this.save();
  }

  /** Returns all file paths currently stored in the state file. */
  getKnownFilePaths(): ReadonlyArray<string> {
    return Object.keys(this.state.files);
  }

  /** Finds the file path for a given plugin key. */
  findFileByPluginKey(pluginId: string, key: string): string | undefined {
    for (const [filePath, entry] of Object.entries(this.state.files)) {
      const ref = entry.plugins?.[pluginId];
      if (ref?.key === key) {
        return filePath;
      }
    }
    return undefined;
  }

  private async save(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.promises.writeFile(
      this.statePath, //
      yaml.dump(this.state, { lineWidth: -1, noRefs: true }),
      'utf8',
    );
  }

  /** Watches the state file and recreates it if deleted. Call dispose() to stop watching. */
  watchForDeletion(pollInterval = 2000): void {
    fs.watchFile(
      this.statePath, //
      { persistent: false, interval: pollInterval },
      (curr) => {
        if (curr.nlink === 0) {
          void this.save();
        }
      },
    );
  }

  dispose(): void {
    fs.unwatchFile(this.statePath);
  }
}
