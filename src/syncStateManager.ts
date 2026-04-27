import * as fs from 'fs';
import * as path from 'path';

/** Persists the last-synced GitHub updated_at timestamp per issue number. */
export class SyncStateManager {
  private state: Record<string, string> = {};

  constructor(private readonly statePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.statePath, 'utf8');
      this.state = JSON.parse(raw) as Record<string, string>;
    } catch {
      this.state = {};
    }
  }

  getSyncedAt(issueNumber: number): string | undefined {
    return this.state[String(issueNumber)];
  }

  async setSyncedAt(issueNumber: number, updatedAt: string): Promise<void> {
    this.state[String(issueNumber)] = updatedAt;
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
