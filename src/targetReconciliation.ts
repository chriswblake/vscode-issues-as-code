import * as path from "path";
import * as fs from "fs";
import type { SyncTarget } from "./configManager";
import type { SyncStateStore } from "./syncStateStore";
import { makeFileWritable } from "./filePermissions";

// ---------------------------------------------------------------------------
// Target reconciliation (location changes and removals)
// ---------------------------------------------------------------------------

/**
 * Reconciles the file system and sync state when sync targets change between config reloads.
 *
 * - Moved targets (same plugin config, different filesDir): issue files are moved to the new
 *   location and the sync state is updated so no re-download is triggered.
 * - Removed targets (not present in new config): issue files are deleted and their state
 *   entries are removed.
 *
 * Safe from mid-process corruption: a crash leaves orphaned files at worst (no data loss).
 */
export async function reconcileTargetChanges(
  oldTargets: SyncTarget[], //
  newTargets: SyncTarget[],
  stateManager: SyncStateStore,
): Promise<void> {
  const oldByIdentity = new Map(oldTargets.map((t) => [targetIdentity(t), t]));
  const newByIdentity = new Map(newTargets.map((t) => [targetIdentity(t), t]));

  // Collect filesDir paths for targets that remain active after reconciliation
  const activeFilesDirs = newTargets.map((t) => path.resolve(t.filesDir));

  // Move files for targets whose filesDir changed
  for (const [id, oldTarget] of oldByIdentity) {
    const newTarget = newByIdentity.get(id);
    if (newTarget && newTarget.filesDir !== oldTarget.filesDir) {
      await moveTargetFiles(oldTarget, newTarget, stateManager);
      await removeEmptyParentDirs(oldTarget.filesDir, activeFilesDirs);
    }
  }

  // Delete files for targets that were removed entirely
  for (const [id, oldTarget] of oldByIdentity) {
    if (!newByIdentity.has(id)) {
      await deleteTargetFiles(oldTarget, stateManager);
      await removeEmptyParentDirs(oldTarget.filesDir, activeFilesDirs);
    }
  }
}

/**
 * Removes the given directory and any empty parent directories, stopping when a parent
 * is an ancestor of any active sync target path.
 */
export async function removeEmptyParentDirs(
  dirPath: string, //
  activeFilesDirs: string[] = [],
): Promise<void> {
  let current = path.resolve(dirPath);
  const resolvedActive = activeFilesDirs.map((d) => path.resolve(d));

  while (current !== path.dirname(current)) {
    // Stop if this directory is an ancestor of (or equal to) any active target
    if (isAncestorOfAny(current, resolvedActive)) {
      break;
    }

    try {
      await fs.promises.rmdir(current);
    } catch {
      // Directory not empty or already gone — stop climbing
      break;
    }

    current = path.dirname(current);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Identity key for a sync target: based on plugin configuration so changing filesDir triggers a move. */
function targetIdentity(target: SyncTarget): string {
  const coreFields = new Set(["filesDir", "naming"]);
  for (const key of Object.keys(target)) {
    if (coreFields.has(key)) {
      continue;
    }
    const pluginConfig = target[key];
    if (pluginConfig && typeof pluginConfig === "object") {
      return `${key}||${JSON.stringify(pluginConfig)}`;
    }
  }
  return `filesDir||${target.filesDir}`;
}

/** Moves all tracked issue files from the old target location to the new one, updating state. */
async function moveTargetFiles(
  oldTarget: SyncTarget, //
  newTarget: SyncTarget,
  stateManager: SyncStateStore,
): Promise<void> {
  const entries = stateManager.getFilesUnderLocation(oldTarget.filesDir);
  if (entries.size === 0) {
    return;
  }

  await fs.promises.mkdir(newTarget.filesDir, { recursive: true });

  for (const [oldFilePath, entry] of entries) {
    const newFilePath = path.join(
      newTarget.filesDir,
      path.basename(oldFilePath),
    );

    // Copy to new location; source may already be gone if this is crash recovery
    try {
      await fs.promises.copyFile(oldFilePath, newFilePath);
    } catch {
      /* source already gone — state cleanup still proceeds */
    }

    await stateManager.setSyncedAtEntry(newFilePath, entry);
    await stateManager.deleteEntry(oldFilePath);

    try {
      await fs.promises.unlink(oldFilePath);
    } catch {
      /* already gone */
    }
  }
}

/** Deletes all tracked issue files under the old target location, and removes their state entries. */
async function deleteTargetFiles(
  oldTarget: SyncTarget, //
  stateManager: SyncStateStore,
): Promise<void> {
  const entries = stateManager.getFilesUnderLocation(oldTarget.filesDir);

  for (const [filePath] of entries) {
    try {
      if (oldTarget.readOnly) {
        await makeFileWritable(filePath);
      }
      await fs.promises.unlink(filePath);
    } catch {
      /* already gone */
    }
  }

  await stateManager.removeFilesUnderLocation(oldTarget.filesDir);
}

/** Returns true if `dir` is an ancestor of, or equal to, any path in `paths`. */
function isAncestorOfAny(dir: string, paths: string[]): boolean {
  return paths.some((p) => p === dir || p.startsWith(dir + path.sep));
}
