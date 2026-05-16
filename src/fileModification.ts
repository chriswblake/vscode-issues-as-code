import * as fs from "fs";

// ---------------------------------------------------------------------------
// Local file modification detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the saved file has been modified since the extension last wrote it.
 * Provides a 1 second tolerance for filesystem timestamp differences.
 */
export function isLocalFileModified(
  filePath: string, //
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
