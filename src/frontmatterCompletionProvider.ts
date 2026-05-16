import * as path from "path";
import type * as vscodeType from "vscode";
import type { GitHubClient } from "./plugins/githubClient";
import type { SyncStateManager } from "./syncStateManager";
import { parseOwnerRepo } from "./configManager";

// Lazy vscode import so unit tests can run without a VS Code instance
function vscode(): typeof vscodeType {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("vscode");
}

interface ManagedTarget {
  filesDir: string;
  pluginId: string;
  /** Repository in "owner/repo" format, if applicable */
  repository?: string;
  stateManager: SyncStateManager;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const VALID_STATES = ["open", "closed"];

/**
 * Provides completion items inside the frontmatter of task files.
 *
 * Supported fields (within the `gh-issues` section):
 * - `state`: offers "open" / "closed"
 * - `labels`: fetches available labels from the GitHub repository
 * - `assignees`: fetches contributors from the GitHub repository
 */
export class FrontmatterCompletionProvider
  implements vscodeType.CompletionItemProvider
{
  private targets: ManagedTarget[] = [];
  private labelsCache = new Map<string, CacheEntry<string[]>>();
  private assigneesCache = new Map<string, CacheEntry<string[]>>();

  constructor(private readonly client: GitHubClient) {}

  /** Update the list of managed targets (called when sync managers are initialized). */
  update(targets: ManagedTarget[]): void {
    this.targets = targets;
  }

  async provideCompletionItems(
    document: vscodeType.TextDocument,
    position: vscodeType.Position,
  ): Promise<vscodeType.CompletionItem[] | undefined> {
    const filePath = document.uri.fsPath;

    if (!filePath.endsWith(".task.md")) {
      return undefined;
    }

    const matchingTarget = this.targets.find(
      (t) =>
        filePath === t.filesDir || filePath.startsWith(t.filesDir + path.sep),
    );
    if (!matchingTarget) {
      return undefined;
    }

    const context = getFrontmatterContext(document, position);
    if (!context) {
      return undefined;
    }

    const { section, field } = context;

    // Only complete inside the plugin's own section (e.g. gh-issues)
    if (section !== matchingTarget.pluginId) {
      return undefined;
    }

    if (field === "state") {
      return VALID_STATES.map((s) => {
        const item = new (vscode().CompletionItem)(
          s,
          vscode().CompletionItemKind.EnumMember,
        );
        item.detail = `Issue state: ${s}`;
        return item;
      });
    }

    const repository =
      matchingTarget.repository ?? getRepositoryFromFrontmatter(document);
    if (!repository) {
      return undefined;
    }

    const repoInfo = parseOwnerRepo(repository);
    if (!repoInfo) {
      return undefined;
    }

    if (field === "labels") {
      const labels = await this.fetchLabels(repoInfo.owner, repoInfo.repo);
      return labels.map((name) => {
        const item = new (vscode().CompletionItem)(
          name,
          vscode().CompletionItemKind.Value,
        );
        item.detail = "Label";
        return item;
      });
    }

    if (field === "assignees") {
      const assignees = await this.fetchAssignees(
        repoInfo.owner,
        repoInfo.repo,
      );
      return assignees.map((login) => {
        const item = new (vscode().CompletionItem)(
          login,
          vscode().CompletionItemKind.User,
        );
        item.detail = "Assignee";
        return item;
      });
    }

    return undefined;
  }

  private async fetchLabels(owner: string, repo: string): Promise<string[]> {
    const cacheKey = `${owner}/${repo}`;
    const cached = this.labelsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    try {
      const labels = await this.client.getLabels(owner, repo);
      this.labelsCache.set(cacheKey, {
        value: labels,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return labels;
    } catch {
      return [];
    }
  }

  private async fetchAssignees(owner: string, repo: string): Promise<string[]> {
    const cacheKey = `${owner}/${repo}`;
    const cached = this.assigneesCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    try {
      const assignees = await this.client.getContributors(owner, repo);
      this.assigneesCache.set(cacheKey, {
        value: assignees,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return assignees;
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FrontmatterContext {
  /** Parent section key (e.g. "gh-issues") */
  section: string;
  /** The field being completed (e.g. "state", "labels", "assignees") */
  field: string;
}

/**
 * Determines which frontmatter section and field the cursor is in.
 * Returns undefined when the cursor is not inside a frontmatter block
 * or when the context cannot be determined.
 *
 * Example frontmatter structure:
 * ```yaml
 * ---
 * gh-issues:
 *   state: open
 *   labels:
 *     - bug
 *   assignees:
 *     - user1
 * ---
 * ```
 */
export function getFrontmatterContext(
  document: vscodeType.TextDocument,
  position: vscodeType.Position,
): FrontmatterContext | undefined {
  const lines = document.getText().split(/\r?\n/);
  const lineNumber = position.line;

  // Must start with front matter delimiter
  if (!lines[0]?.trim().startsWith("---")) {
    return undefined;
  }

  // Find end of front matter
  let frontmatterEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      frontmatterEnd = i;
      break;
    }
  }

  // Cursor must be inside the front matter block
  if (frontmatterEnd < 0 || lineNumber <= 0 || lineNumber >= frontmatterEnd) {
    return undefined;
  }

  // Find the parent top-level section by scanning upward for a zero-indented key
  let section: string | undefined;
  for (let i = lineNumber; i >= 1; i--) {
    const topLevelMatch = lines[i].match(/^([a-z][a-z0-9-]*):\s*$/);
    if (topLevelMatch) {
      section = topLevelMatch[1];
      break;
    }
    // If we encounter another top-level key (no indent), stop
    const anyTopLevel = lines[i].match(/^[a-z][a-z0-9-]*:/);
    if (anyTopLevel && !/^\s/.test(lines[i])) {
      break;
    }
  }

  if (!section) {
    return undefined;
  }

  // Find the field key on the current line or by scanning upward for a list context
  const currentLine = lines[lineNumber];

  // Direct field value: "  state: |"
  const fieldMatch = currentLine.match(/^\s+([a-z][a-z0-9-]*):\s*/);
  if (fieldMatch) {
    return { section, field: fieldMatch[1] };
  }

  // List item inside a field: "    - |" — scan up to find parent field key
  if (/^\s*-\s*/.test(currentLine)) {
    for (let i = lineNumber - 1; i >= 1; i--) {
      const parentFieldMatch = lines[i].match(/^\s+([a-z][a-z0-9-]*):\s*$/);
      if (parentFieldMatch) {
        return { section, field: parentFieldMatch[1] };
      }
      // Stop if we hit the section header or another non-list line
      if (!lines[i].match(/^\s*(-|$)/)) {
        break;
      }
    }
  }

  return undefined;
}

/**
 * Reads the `repository` field from the current document's frontmatter.
 * Returns undefined if not found or not in "owner/repo" format.
 */
function getRepositoryFromFrontmatter(
  document: vscodeType.TextDocument,
): string | undefined {
  const lines = document.getText().split(/\r?\n/);

  if (!lines[0]?.trim().startsWith("---")) {
    return undefined;
  }

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      break;
    }
    const repoMatch = lines[i].match(/^\s+repository:\s*(.+)\s*$/);
    if (repoMatch) {
      return repoMatch[1].trim();
    }
  }

  return undefined;
}
