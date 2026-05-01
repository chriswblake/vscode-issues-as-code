import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/** Read-only snapshot of a GitHub issue at the time it was last synced. */
export interface RemoteIssueInfo {
  number: number;
  state: 'open' | 'closed';
  updated_at: string;
  closed_at: string | null;
  html_url: string;
}

/** A reference from a file entry to a plugin record. */
export interface FilePluginRef {
  /** Key into the corresponding plugin section (e.g. "owner/repo/7" for gh-issues). */
  key: string;
  /** ISO timestamp of when the remote record was last synced. */
  synced_at: string;
}

/** State record for a single synced file. */
export interface SyncStateEntry {
  /** ISO timestamp of when the extension last wrote the local file. Used to detect local modifications. */
  local_written_at: string;
  /** Reference to the gh-issues plugin record for this file. */
  'gh-issues'?: FilePluginRef;
  /** Reference to the gh-projects plugin record for this file. */
  'gh-projects'?: FilePluginRef;
  /** Reference to the tick-tick plugin record for this file. */
  'tick-tick'?: FilePluginRef;
}

/** A stored GitHub issue record in the gh-issues plugin section. */
interface GhIssueRecord {
  number: number;
  state: 'open' | 'closed';
  updated_at: string;
  closed_at: string | null;
  html_url: string;
}

interface SyncStateFile {
  'gh-issues'?: Record<string, GhIssueRecord>;
  'gh-projects'?: Record<string, Record<string, unknown>>;
  'tick-tick'?: Record<string, Record<string, unknown>>;
  /** Keyed by absolute path of the local file. */
  files: Record<string, SyncStateEntry>;
}

// Legacy v2 shape used only during migration.
interface LegacyV2SyncStateFile {
  version: 2;
  files: Record<string, { synced_at: string; local_written_at: string; remote: RemoteIssueInfo }>;
}

// Legacy v1 shape used only during migration.
interface LegacyV1SyncStateFile {
  version: 1;
  targets: Record<string, Record<string, { synced_at: string; file_path: string; remote: RemoteIssueInfo }>>;
}

/**
 * Extracts the "owner/repo/number" key for the gh-issues plugin section
 * from a RemoteIssueInfo object using its html_url.
 */
function ghIssuesKeyFromRemoteInfo(remote: RemoteIssueInfo): string {
  const match = remote.html_url.match(/github\.com\/([^/]+\/[^/]+)\/issues\/\d+/);
  return match ? `${match[1]}/${remote.number}` : String(remote.number);
}

/**
 * Persists per-file sync state, structured by plugin (gh-issues, gh-projects, tick-tick)
 * and cross-referenced from the `files` section.
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
      // yaml.load handles both YAML and JSON
      const parsed = yaml.load(raw) as SyncStateFile | LegacyV2SyncStateFile | LegacyV1SyncStateFile | null;

      if (!parsed || typeof parsed !== 'object') {
        this.state = { files: {} };
        return;
      }

      const asAny = parsed as unknown as Record<string, unknown>;

      if ('version' in asAny && asAny['version'] === 1) {
        // Migrate v1 (targets keyed by location) → new format
        const legacy = parsed as LegacyV1SyncStateFile;
        const newState: SyncStateFile = { 'gh-issues': {}, files: {} };
        for (const targetEntries of Object.values(legacy.targets ?? {})) {
          for (const entry of Object.values(targetEntries)) {
            if (entry.file_path && entry.remote) {
              const key = ghIssuesKeyFromRemoteInfo(entry.remote);
              newState['gh-issues']![key] = {
                number: entry.remote.number,
                state: entry.remote.state,
                updated_at: entry.remote.updated_at,
                closed_at: entry.remote.closed_at,
                html_url: entry.remote.html_url,
              };
              newState.files[entry.file_path] = {
                local_written_at: entry.synced_at,
                'gh-issues': { key, synced_at: entry.synced_at },
              };
            }
          }
        }
        this.state = newState;
        return;
      }

      if ('version' in asAny && asAny['version'] === 2) {
        // Migrate v2 (JSON with flat files[path] = {synced_at, local_written_at, remote}) → new format
        const legacy = parsed as LegacyV2SyncStateFile;
        const newState: SyncStateFile = { 'gh-issues': {}, files: {} };
        for (const [filePath, entry] of Object.entries(legacy.files ?? {})) {
          const key = ghIssuesKeyFromRemoteInfo(entry.remote);
          newState['gh-issues']![key] = {
            number: entry.remote.number,
            state: entry.remote.state,
            updated_at: entry.remote.updated_at,
            closed_at: entry.remote.closed_at,
            html_url: entry.remote.html_url,
          };
          newState.files[filePath] = {
            local_written_at: entry.local_written_at,
            'gh-issues': { key, synced_at: entry.synced_at },
          };
        }
        this.state = newState;
        return;
      }

      if (!('version' in asAny) && 'files' in asAny) {
        // Current format
        this.state = parsed as SyncStateFile;
        return;
      }

      // Unknown or legacy flat format (no version, no files key) — discard
      this.state = { files: {} };
    } catch {
      this.state = { files: {} };
    }
  }

  /** Returns the gh-issues synced_at timestamp for the given file path. */
  getSyncedAt(filePath: string): string | undefined {
    return this.state.files[filePath]?.['gh-issues']?.synced_at;
  }

  getLocalWrittenAt(filePath: string): string | undefined {
    return this.state.files[filePath]?.local_written_at;
  }

  getEntry(filePath: string): SyncStateEntry | undefined {
    return this.state.files[filePath];
  }

  async setSyncedAt(filePath: string, remote: RemoteIssueInfo): Promise<void> {
    const key = ghIssuesKeyFromRemoteInfo(remote);

    // Update the gh-issues plugin section
    if (!this.state['gh-issues']) {
      this.state['gh-issues'] = {};
    }
    this.state['gh-issues'][key] = {
      number: remote.number,
      state: remote.state,
      updated_at: remote.updated_at,
      closed_at: remote.closed_at,
      html_url: remote.html_url,
    };

    // Update the files section
    const existing = this.state.files[filePath] ?? {};
    this.state.files[filePath] = {
      ...existing,
      local_written_at: new Date().toISOString(),
      'gh-issues': { key, synced_at: remote.updated_at },
    };

    await this.save();
    this.notifyChange(filePath);
  }

  /** Copies an existing SyncStateEntry to a new file path, then persists. Used when moving files. */
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

  /** Finds the file path for a given plugin key (e.g. "owner/repo/42" for gh-issues). */
  findFileByPluginKey(pluginId: string, key: string): string | undefined {
    for (const [filePath, entry] of Object.entries(this.state.files)) {
      const ref = entry[pluginId as keyof SyncStateEntry] as FilePluginRef | undefined;
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
