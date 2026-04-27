import * as fs from 'fs';
import * as path from 'path';

/** Read-only snapshot of a GitHub issue at the time it was last synced. */
export interface RemoteIssueInfo {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  updated_at: string;
  closed_at: string | null;
  html_url: string;
}

/** State record for a single issue within a sync target. */
export interface SyncStateEntry {
  /** Timestamp of the remote copy when it was last pulled. */
  synced_at: string;
  /** Absolute path to the local issue file. */
  file_path: string;
  /** Read-only details from the remote at the time of last sync. */
  remote: RemoteIssueInfo;
}

interface SyncStateFile {
  version: number;
  /** Keyed by sync target location (absolute path). */
  targets: Record<string, Record<string, SyncStateEntry>>;
}

/**
 * Persists per-issue sync state keyed by sync target location and issue number.
 * The state file is organized to handle multiple sync targets.
 */
export class SyncStateManager {
  private state: SyncStateFile = { version: 1, targets: {} };

  constructor(private readonly statePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as SyncStateFile;
      // Migrate legacy flat format (version absent → Record<string, string>)
      if (!parsed.version) {
        this.state = { version: 1, targets: {} };
      } else {
        this.state = parsed;
      }
    } catch {
      this.state = { version: 1, targets: {} };
    }
  }

  getSyncedAt(targetKey: string, issueNumber: number): string | undefined {
    return this.state.targets[targetKey]?.[String(issueNumber)]?.synced_at;
  }

  async setSyncedAt(
    targetKey: string, //
    issueNumber: number,
    filePath: string,
    remote: RemoteIssueInfo,
  ): Promise<void> {
    if (!this.state.targets[targetKey]) {
      this.state.targets[targetKey] = {};
    }
    this.state.targets[targetKey][String(issueNumber)] = {
      synced_at: remote.updated_at,
      file_path: filePath,
      remote,
    };
    await this.save();
  }

  private async save(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.promises.writeFile(
      this.statePath, //
      JSON.stringify(this.state, null, 2),
      'utf8',
    );
  }
}
