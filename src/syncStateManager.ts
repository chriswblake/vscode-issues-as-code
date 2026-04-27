import * as fs from 'fs';
import * as path from 'path';

/** Read-only snapshot of a GitHub issue at the time it was last synced. */
export interface RemoteIssueInfo {
  number: number;
  state: 'open' | 'closed';
  updated_at: string;
  closed_at: string | null;
  html_url: string;
}

/** State record for a single issue file. */
export interface SyncStateEntry {
  /** Timestamp of the remote copy when it was last pulled. */
  synced_at: string;
  /** Read-only details from the remote at the time of last sync. */
  remote: RemoteIssueInfo;
}

interface SyncStateFile {
  version: number;
  /** Keyed by absolute path of the local issue file. */
  files: Record<string, SyncStateEntry>;
}

// Legacy v1 shape used only during migration.
interface LegacySyncStateFile {
  version: 1;
  targets: Record<string, Record<string, { synced_at: string; file_path: string; remote: RemoteIssueInfo }>>;
}

/**
 * Persists per-issue sync state keyed by the absolute path of each local issue file.
 */
export class SyncStateManager {
  private state: SyncStateFile = { version: 2, files: {} };

  constructor(private readonly statePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as SyncStateFile | LegacySyncStateFile;

      if (!parsed.version) {
        // Legacy flat format (no version field) — discard
        this.state = { version: 2, files: {} };
      } else if (parsed.version === 1) {
        // Migrate v1 (targets keyed by location) → v2 (files keyed by file path)
        const legacy = parsed as LegacySyncStateFile;
        const files: Record<string, SyncStateEntry> = {};
        for (const targetEntries of Object.values(legacy.targets ?? {})) {
          for (const entry of Object.values(targetEntries)) {
            if (entry.file_path) {
              files[entry.file_path] = { synced_at: entry.synced_at, remote: entry.remote };
            }
          }
        }
        this.state = { version: 2, files };
      } else {
        this.state = parsed as SyncStateFile;
      }
    } catch {
      this.state = { version: 2, files: {} };
    }
  }

  getSyncedAt(filePath: string): string | undefined {
    return this.state.files[filePath]?.synced_at;
  }

  async setSyncedAt(filePath: string, remote: RemoteIssueInfo): Promise<void> {
    this.state.files[filePath] = { synced_at: remote.updated_at, remote };
    await this.save();
  }

  /** Removes the state entry for a single file path, then persists. */
  async deleteEntry(filePath: string): Promise<void> {
    delete this.state.files[filePath];
    await this.save();
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

  private async save(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.promises.writeFile(
      this.statePath, //
      JSON.stringify(this.state, null, 2),
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
