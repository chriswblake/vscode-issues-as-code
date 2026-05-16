import * as fs from "fs";

// ---------------------------------------------------------------------------
// File permission helpers (cross-platform read-only enforcement)
// ---------------------------------------------------------------------------

/**
 * Makes a file read-only on disk to discourage accidental edits.
 * Uses mode 0o444 (read for owner/group/others, no write).
 */
export async function makeFileReadOnly(filePath: string): Promise<void> {
  try {
    await fs.promises.chmod(filePath, 0o444);
  } catch {
    /* ignore — file may not exist or platform may not support */
  }
}

/**
 * Restores write permission on a file so the extension can overwrite it.
 * Uses mode 0o644 (owner read/write, group/others read).
 */
export async function makeFileWritable(filePath: string): Promise<void> {
  try {
    await fs.promises.chmod(filePath, 0o644);
  } catch {
    /* ignore — file may not exist */
  }
}
