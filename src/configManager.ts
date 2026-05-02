import * as fs from "fs";
import * as path from "path";

export interface SyncTarget {
  /** Absolute path to the folder where synced files for this target are stored. */
  filesDir: string;
  /** Template for file names. Uses plugin tokens like {pluginId.field}. */
  naming?: string;
  /**
   * When true, files are updated from remote but local changes are never pushed.
   * Local changes are overwritten by the remote on each pull.
   * Files are made read-only on disk to discourage accidental edits.
   */
  readOnly?: boolean;
  /** Plugin configurations keyed by plugin ID. */
  [pluginId: string]: unknown;
}

export interface RepoInfo {
  owner: string;
  repo: string;
}

export interface ShowSyncIconsConfig {
  newIssue: boolean;
  modified: boolean;
  synchronized: boolean;
}

export interface IssueConfig {
  fileNaming: string;
  pushOnSaveDelay: number;
  syncTargets: SyncTarget[];
  autoFetchInterval: number;
  autoPullOnFetch: boolean;
  syncStatePath: string;
  showSyncState: boolean;
  showSyncIcons: ShowSyncIconsConfig;
  enableExperimentalProjects: boolean;
}

const DEFAULT_SYNC_STATE_PATH = ".issues/sync-state.yml";

export function resolveWorkspacePath(
  rawPath: string,
  workspaceFolderPath: string,
): string {
  if (path.isAbsolute(rawPath)) {
    throw new Error(
      "Absolute paths are not allowed in issuesAsCode configuration. Use a path relative to the workspace folder.",
    );
  }

  return path.resolve(workspaceFolderPath, rawPath);
}

function resolveSyncTargets(
  rawTargets: SyncTarget[],
  workspaceFolderPath: string,
): SyncTarget[] {
  return rawTargets.map((t) => ({
    ...t,
    filesDir: resolveWorkspacePath(t.filesDir, workspaceFolderPath),
  }));
}

/**
 * Returns all configuration values for a workspace folder.
 * Accepts explicit values for testability.
 */
export function getConfig(
  workspaceFolderPath: string,
  vscodeWorkspaceFolder?: unknown,
): IssueConfig {
  // When running in VS Code context, read from workspace configuration
  if (vscodeWorkspaceFolder !== undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const vscode = require("vscode") as typeof import("vscode");
      const uri = (vscodeWorkspaceFolder as { uri: import("vscode").Uri }).uri;
      const cfg = vscode.workspace.getConfiguration("issuesAsCode", uri);

      const rawTargets = cfg.get<SyncTarget[]>("syncTargets") ?? [];
      const syncTargets = resolveSyncTargets(rawTargets, workspaceFolderPath);

      const rawSyncStatePath =
        cfg.get<string>("syncStatePath") ?? DEFAULT_SYNC_STATE_PATH;
      const syncStatePath = resolveWorkspacePath(
        rawSyncStatePath,
        workspaceFolderPath,
      );

      const rawShowSyncIcons =
        cfg.get<Partial<ShowSyncIconsConfig>>("showSyncIcons") ?? {};

      return {
        fileNaming:
          cfg.get<string>("fileNaming") ?? "{issue-num}-{issue-title}",
        pushOnSaveDelay: cfg.get<number>("pushOnSaveDelay") ?? 60,
        syncTargets,
        autoFetchInterval:
          cfg.get<number>("autoFetchInterval") ??
          cfg.get<number>("pullInterval") ??
          30,
        autoPullOnFetch: cfg.get<boolean>("autoPullOnFetch") ?? false,
        syncStatePath,
        showSyncState: cfg.get<boolean>("showSyncState") ?? false,
        showSyncIcons: {
          newIssue: rawShowSyncIcons.newIssue ?? true,
          modified: rawShowSyncIcons.modified ?? true,
          synchronized: rawShowSyncIcons.synchronized ?? true,
        },
        enableExperimentalProjects:
          cfg.get<boolean>("enable_experimental_projects") ?? false,
      };
    } catch {
      // Fall through to defaults
    }
  }

  // Default config used in tests or when vscode is unavailable
  return {
    fileNaming: "{issue-num}-{issue-title}",
    pushOnSaveDelay: 60,
    syncTargets: [],
    autoFetchInterval: 30,
    autoPullOnFetch: false,
    syncStatePath: path.join(workspaceFolderPath, ".issues", "sync-state.yml"),
    showSyncState: false,
    showSyncIcons: { newIssue: true, modified: true, synchronized: true },
    enableExperimentalProjects: false,
  };
}

/**
 * Parses an "owner/repo" string into a RepoInfo object.
 * Returns null if the string does not match the expected format.
 */
export function parseOwnerRepo(repository: string): RepoInfo | null {
  const match = repository.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    return null;
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Ensures each issue-location directory (or its closest ancestor inside the
 * workspace) is present in the workspace `.gitignore`.
 */
export async function ensureGitignore(
  workspaceRoot: string,
  locations: string[],
): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");

  const entries = new Set<string>();
  for (const loc of locations) {
    const rel = path.relative(workspaceRoot, loc);
    if (rel.startsWith("..")) {
      continue;
    }
    const topLevel = rel.split(path.sep)[0];
    entries.add(topLevel + "/");
  }

  if (entries.size === 0) {
    return;
  }

  let content = "";
  try {
    content = await fs.promises.readFile(gitignorePath, "utf8");
  } catch {
    // File doesn't exist yet; we'll create it
  }

  const lines = content.split("\n").map((l) => l.trim());
  const toAdd = [...entries].filter((e) => !lines.includes(e));
  if (toAdd.length === 0) {
    return;
  }

  const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
  await fs.promises.writeFile(
    gitignorePath,
    content + suffix + toAdd.join("\n") + "\n",
    "utf8",
  );
}
