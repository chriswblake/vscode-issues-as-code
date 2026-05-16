import * as path from "path";
import type * as vscodeType from "vscode";
import type { SyncTarget, RepoInfo } from "../../configManager";
import { GhIssuesPlugin } from "./ghIssuesPlugin";
import { GitHubClient } from "./githubClient";
import { FrontmatterCompletionProvider } from "./frontmatterCompletionProvider";
import { registerPrimaryPlugin } from "../../pluginRegistry";
import type {
  PrimarySyncPlugin,
  PluginBootstrap,
  IncludedSyncTargetConfig,
  PluginProviderContext,
} from "../../pluginTypes";

// Lazy vscode import so unit tests can run without a VS Code instance
function vscode(): typeof vscodeType {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("vscode");
}

// ---------------------------------------------------------------------------
// Default targets
// ---------------------------------------------------------------------------

/**
 * Builds a single open-issues sync target config with relative paths (for persisting to settings).
 */
export function openIssuesTarget(owner: string, repo: string): SyncTarget {
  const repository = `${owner}/${repo}`;
  return {
    filesDir: ".issues/open",
    naming: "{gh-issues.number}-{gh-issues.title}",
    "gh-issues": {
      filters: { repository, state: "open" },
    },
  };
}

/**
 * Builds default sync targets for a detected GitHub repo.
 * Open issues + issues closed in the last 10 days.
 */
export function defaultSyncTargets(
  owner: string,
  repo: string,
  workspaceFolderPath: string,
): SyncTarget[] {
  const issuesBase = path.join(workspaceFolderPath, ".issues");
  const repository = `${owner}/${repo}`;
  return [
    {
      filesDir: path.join(issuesBase, "open"),
      naming: "{gh-issues.number}-{gh-issues.title}",
      "gh-issues": {
        filters: { repository, state: "open" },
      },
    },
    {
      filesDir: path.join(issuesBase, "closed_10days"),
      naming: "{gh-issues.number}-{gh-issues.title}",
      "gh-issues": {
        filters: { repository, state: "closed", created_at: ">{today-10d}" },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Repo detection
// ---------------------------------------------------------------------------

/**
 * Detects GitHub repo from git remote using vscode.git extension API.
 */
export async function detectRepo(workspaceFolder: {
  uri: { fsPath: string };
}): Promise<RepoInfo | null> {
  try {
    const gitExtension =
      vscode().extensions.getExtension("vscode.git")?.exports;
    if (!gitExtension) {
      return null;
    }

    const api = gitExtension.getAPI(1);
    if (!api) {
      return null;
    }

    const repo = api.repositories.find((r: { rootUri: { fsPath: string } }) =>
      workspaceFolder.uri.fsPath.startsWith(r.rootUri.fsPath),
    );
    if (!repo) {
      return null;
    }

    const remotes: Array<{
      name: string;
      fetchUrl?: string;
      pushUrl?: string;
    }> = repo.state.remotes ?? [];
    if (remotes.length === 0) {
      return null;
    }

    const remote = remotes.find((r) => r.name === "origin") ?? remotes[0];
    const url = remote.fetchUrl ?? remote.pushUrl ?? "";

    return parseGitHubUrl(url);
  } catch {
    return null;
  }
}

/**
 * Parses a GitHub remote URL (HTTPS or SSH) and returns owner/repo.
 */
export function parseGitHubUrl(url: string): RepoInfo | null {
  const httpsMatch = url.match(
    /https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Creates a PrimarySyncPlugin for a target containing a 'gh-issues' config section.
 * Authenticates with GitHub and returns null if auth fails.
 */
export async function createGhIssuesPlugin(): Promise<PrimarySyncPlugin | null> {
  const client = await GitHubClient.authenticate();
  if (!client) {
    return null;
  }
  const plugin = new GhIssuesPlugin(client);
  registerPrimaryPlugin(plugin);
  return plugin;
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

/** Gets the authenticated GitHub username via VS Code's auth provider. */
export async function getAuthenticatedUsername(): Promise<string | null> {
  try {
    const session = await vscode().authentication.getSession(
      "github",
      ["repo"],
      {
        createIfNone: true,
      },
    );
    if (!session) {
      return null;
    }
    return session.account.label;
  } catch {
    return null;
  }
}

/**
 * Checks if a target with matching gh-issues filters already exists in the config.
 */
export function hasDuplicateGhIssuesTarget(
  currentTargets: SyncTarget[],
  predicate: (filters: Record<string, unknown> | undefined) => boolean,
): boolean {
  return currentTargets.some((t) => {
    const ghIssues = t["gh-issues"] as
      | { filters?: Record<string, unknown> }
      | undefined;
    return predicate(ghIssues?.filters);
  });
}

/**
 * Returns preset sync target configs for GitHub Issues.
 * Configs that require a repo or authenticated user are omitted if unavailable.
 */
export async function getGhIssuesIncludedConfigs(workspaceFolder: {
  uri: { fsPath: string };
}): Promise<IncludedSyncTargetConfig[]> {
  const configs: IncludedSyncTargetConfig[] = [];
  const repoInfo = await detectRepo(workspaceFolder);

  // Open issues on this repository (requires repo)
  if (repoInfo) {
    const repository = `${repoInfo.owner}/${repoInfo.repo}`;
    configs.push({
      label: "Open issues on this repository",
      description: repository,
      target: openIssuesTarget(repoInfo.owner, repoInfo.repo),
      isDefault: true,
      isDuplicate: (targets) =>
        hasDuplicateGhIssuesTarget(
          targets,
          (f) =>
            f?.repository === repository && f?.state === "open" && !f?.assignee,
        ),
    });
  }

  // My open issues on this repository (requires repo + auth)
  const username = await getAuthenticatedUsername();
  if (username && repoInfo) {
    const repository = `${repoInfo.owner}/${repoInfo.repo}`;
    configs.push({
      label: "My open issues on this repository",
      description: `${username} on ${repository}`,
      target: {
        filesDir: ".issues/open",
        naming: "{gh-issues.number}-{gh-issues.title}",
        "gh-issues": {
          filters: { repository, assignee: username, state: "open" },
        },
      },
      isDuplicate: (targets) =>
        hasDuplicateGhIssuesTarget(
          targets,
          (f) => f?.repository === repository && f?.assignee === username,
        ),
    });
  }

  // My open issues on GitHub (requires auth, no repo needed)
  if (username) {
    configs.push({
      label: "My open issues on GitHub",
      description: username,
      target: {
        filesDir: ".issues/github/me",
        naming: "{gh-issues.number}-{gh-issues.title}",
        "gh-issues": { filters: { assignee: username, state: "open" } },
      },
      isDuplicate: (targets) =>
        hasDuplicateGhIssuesTarget(
          targets,
          (f) =>
            f?.assignee === username && f?.state === "open" && !f?.repository,
        ),
    });
  }

  return configs;
}

// ---------------------------------------------------------------------------
// Bootstrap export — standard interface for dynamic plugin loading
// ---------------------------------------------------------------------------

export const bootstrap: PluginBootstrap = {
  pluginId: "gh-issues",
  displayName: "GitHub Issues",

  async initialize(): Promise<boolean> {
    const plugin = await createGhIssuesPlugin();
    return plugin !== null;
  },

  registerCommands(
    _context: { subscriptions: { dispose(): void }[] },
    _reinitialize: () => Promise<void>,
  ): void {
    // No plugin-specific commands; presets are handled via getIncludedConfigs.
  },

  registerProviders(providerContext: PluginProviderContext): void {
    // Wire up rate limit monitoring for GitHub API calls
    GitHubClient.setRateLimitMonitor(providerContext.rateLimitMonitor);

    // Register frontmatter completion provider (labels, assignees, state)
    void GitHubClient.authenticate().then((client) => {
      if (!client) {
        return;
      }
      const completionProvider = new FrontmatterCompletionProvider(client);
      const { extensionContext } = providerContext;

      extensionContext.subscriptions.push(
        vscode().languages.registerCompletionItemProvider(
          [
            { scheme: "file", language: "markdown" },
            { scheme: "file", language: "task-md" },
          ],
          completionProvider,
          ":",
          " ",
          "-",
          "\n",
        ),
      );

      // Update targets now and whenever they change
      const updateTargets = () => {
        const targets = providerContext.getTargets();
        const completionTargets = targets
          .filter((t) => t.pluginId === "gh-issues")
          .map((t) => {
            const filters = t.pluginConfig?.["filters"] as
              | Record<string, unknown>
              | undefined;
            const repository =
              typeof filters?.["repository"] === "string"
                ? filters["repository"]
                : undefined;
            return {
              filesDir: t.filesDir,
              pluginId: t.pluginId,
              repository,
              stateManager: t.stateManager,
            };
          });
        completionProvider.update(completionTargets);
      };

      updateTargets();
      providerContext.onDidChangeTargets(updateTargets);
    });
  },

  async getIncludedConfigs(workspaceFolder: {
    uri: { fsPath: string };
  }): Promise<IncludedSyncTargetConfig[]> {
    return getGhIssuesIncludedConfigs(workspaceFolder);
  },

  async detectDefaults(workspaceFolder: {
    uri: { fsPath: string };
  }): Promise<SyncTarget[] | null> {
    const repoInfo = await detectRepo(workspaceFolder);
    if (!repoInfo) {
      return null;
    }
    return defaultSyncTargets(
      repoInfo.owner,
      repoInfo.repo,
      workspaceFolder.uri.fsPath,
    );
  },

  async persistDefaults(workspaceFolder: {
    uri: { fsPath: string };
  }): Promise<SyncTarget[] | null> {
    try {
      const folder = vscode().workspace.workspaceFolders?.find(
        (f: vscodeType.WorkspaceFolder) =>
          f.uri.fsPath === workspaceFolder.uri.fsPath,
      );
      if (!folder) {
        return null;
      }

      const cfg = vscode().workspace.getConfiguration(
        "issuesAsCode",
        folder.uri,
      );
      const currentTargets = cfg.get<SyncTarget[]>("syncTargets") ?? [];
      if (currentTargets.length > 0) {
        return null;
      }

      const repoInfo = await detectRepo(workspaceFolder);
      if (!repoInfo) {
        return null;
      }

      const target = openIssuesTarget(repoInfo.owner, repoInfo.repo);
      await cfg.update(
        "syncTargets",
        [target],
        vscode().ConfigurationTarget.WorkspaceFolder,
      );

      return [target];
    } catch {
      return null;
    }
  },
};
