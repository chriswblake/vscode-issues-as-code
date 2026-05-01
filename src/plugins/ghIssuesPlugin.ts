import * as path from 'path';
import type { IssueFrontmatter } from '../fileManager';
import type { GitHubClient, IssueData } from '../githubClient';
import type { RemoteIssueInfo } from '../syncStateManager';
import type { PrimarySyncPlugin, PullItem, PushResult, PluginContext } from './syncPlugin';

// ---------------------------------------------------------------------------
// GitHub Issues filter types
// ---------------------------------------------------------------------------

export interface GhIssuesFilters {
  repository?: string;
  state?: string;
  assignee?: string;
  author?: string;
  label?: string | string[];
  created_at?: string;
  [key: string]: unknown;
}

export interface GhIssuesPluginConfig {
  filters: GhIssuesFilters;
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

/**
 * Replaces `{today-Nd}` tokens with ISO date strings (YYYY-MM-DD).
 * Example: ">{today-10d}" → ">2026-04-21"
 */
export function resolveQueryDateTokens(query: string): string {
  return query.replace(/\{today-(\d+)d\}/g, (_, n) => {
    const d = new Date();
    d.setDate(d.getDate() - parseInt(n, 10));
    return d.toISOString().slice(0, 10);
  });
}

/**
 * Builds a GitHub Issues search query string from a GhIssuesFilters object.
 * Excludes the `repository` field (handled separately by the search API).
 */
export function buildSearchQuery(filters: GhIssuesFilters): string {
  const parts: string[] = ['is:issue'];

  if (filters.state) {
    parts.push(`state:${filters.state}`);
  }

  if (filters.label) {
    const labels = Array.isArray(filters.label) ? filters.label : [filters.label];
    for (const label of labels) {
      parts.push(`label:${label}`);
    }
  }

  if (filters.assignee) {
    parts.push(`assignee:${filters.assignee}`);
  }

  if (filters.author) {
    parts.push(`author:${filters.author}`);
  }

  if (filters.created_at) {
    parts.push(`created:${resolveQueryDateTokens(String(filters.created_at))}`);
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// File naming
// ---------------------------------------------------------------------------

/**
 * Renders a filename from naming tokens and a template string.
 * Supports tokens: {gh-issues.number}, {gh-issues.title}, {issue-num}, {issue-title}.
 * Strips invalid characters and collapses consecutive dashes.
 */
export function buildFileName(
  namingTokens: Record<string, string | number>, //
  template: string,
): string {
  const slug = String(namingTokens['gh-issues.title'] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  const name = template
    .replace('{gh-issues.number}', String(namingTokens['gh-issues.number'] ?? ''))
    .replace('{gh-issues.title}', slug)
    .replace('{issue-num}', String(namingTokens['gh-issues.number'] ?? ''))
    .replace('{issue-title}', slug);

  return name
    .replace(/[^a-z0-9\-_]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Filter evaluation (client-side)
// ---------------------------------------------------------------------------

/**
 * Evaluates GhIssuesFilters against a file's frontmatter.
 * Used to determine if a file still belongs to a sync target.
 */
export function matchesFilter(
  frontmatter: IssueFrontmatter,
  filters: GhIssuesFilters,
  syncedAt?: string,
  closedAt?: string | null,
): boolean {
  const ghIssues = frontmatter['gh-issues'];
  if (!ghIssues) {
    return false;
  }

  if (filters.state && ghIssues.state !== filters.state) {
    return false;
  }

  if (filters.label) {
    const labels = Array.isArray(filters.label) ? filters.label : [filters.label];
    if (!labels.every((l) => ghIssues.labels.includes(l))) {
      return false;
    }
  }

  if (filters.assignee && !ghIssues.assignees.includes(filters.assignee)) {
    return false;
  }

  if (filters['updated_at']) {
    const dateStr = String(filters['updated_at']).replace(/^>/, '');
    if (!syncedAt || new Date(syncedAt) <= new Date(dateStr)) {
      return false;
    }
  }

  if (filters['closed_at']) {
    const dateStr = String(filters['closed_at']).replace(/^>/, '');
    if (!closedAt || new Date(closedAt) <= new Date(dateStr)) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function issueToRemoteInfo(issue: IssueData): RemoteIssueInfo {
  return {
    number: issue.number,
    state: issue.state,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: issue.html_url,
  };
}

function issueToNamingTokens(issue: IssueData): Record<string, string | number> {
  return {
    'gh-issues.number': issue.number,
    'gh-issues.title': issue.title,
  };
}

function issueToPullItem(issue: IssueData, repository: string): PullItem {
  return {
    remoteKey: `${repository}/${issue.number}`,
    namingTokens: issueToNamingTokens(issue),
    frontmatter: {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: issue.labels,
      assignees: issue.assignees,
      node_id: issue.node_id,
      repository,
    },
    body: issue.body ?? '',
    remoteInfo: issueToRemoteInfo(issue),
  };
}

/**
 * Derives a title for new local issue files when frontmatter title is missing.
 * Priority: explicit title → first non-empty body line → file name.
 */
function inferTitle(filePath: string, frontmatter: IssueFrontmatter, body: string): string {
  const explicit = (frontmatter['gh-issues']?.title ?? '').trim();
  if (explicit) {
    return explicit;
  }

  const bodyLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (bodyLine) {
    const cleaned = bodyLine.replace(/^#+\s*/, '').trim();
    if (cleaned) {
      return cleaned;
    }
  }

  return path.basename(filePath, path.extname(filePath)).trim() || 'New issue';
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

/**
 * Primary sync plugin for GitHub Issues.
 * Owns file body, title, naming, and issue creation/updates.
 */
export class GhIssuesPlugin implements PrimarySyncPlugin {
  readonly id = 'gh-issues';

  constructor(private readonly client: GitHubClient) {}

  async pull(pluginConfig: Record<string, unknown>, _context: PluginContext): Promise<PullItem[]> {
    const config = pluginConfig as unknown as GhIssuesPluginConfig;
    const filters = config.filters;
    const targetRepository = filters.repository ?? '';

    // Build search query; include repo qualifier only when scoped to a specific repo
    const baseQuery = buildSearchQuery(filters);
    const query = targetRepository ? `${baseQuery} repo:${targetRepository}` : baseQuery;

    // Use searchIssues which returns owner/repo per result (supports cross-repo)
    const searchResults = await this.client.searchIssues(query);

    // Fetch full details for each issue using its own owner/repo
    const items: PullItem[] = [];
    for (const result of searchResults) {
      const issue = await this.client.getIssue(result.owner, result.repo, result.number);
      const issueRepo = `${result.owner}/${result.repo}`;
      items.push(issueToPullItem(issue, issueRepo));
    }

    return items;
  }

  async push(
    frontmatter: IssueFrontmatter, //
    body: string,
    pluginConfig: Record<string, unknown>,
    _context: PluginContext,
  ): Promise<PushResult> {
    const config = pluginConfig as unknown as GhIssuesPluginConfig;
    const ghIssues = frontmatter['gh-issues'];
    const issueNumber = ghIssues?.number;

    // Get repository from per-issue frontmatter, fall back to target-level config
    const repository = ghIssues?.repository ?? config.filters.repository ?? '';
    const [owner, repo] = repository.split('/');

    if (issueNumber !== undefined) {
      // Update existing issue
      await this.client.updateIssue(owner, repo, issueNumber, {
        title: ghIssues!.title,
        body,
        state: ghIssues!.state,
        labels: ghIssues!.labels,
        assignees: ghIssues!.assignees,
      });

      // Refresh from server
      const refreshed = await this.client.getIssue(owner, repo, issueNumber);
      return {
        remoteInfo: issueToRemoteInfo(refreshed),
        frontmatter: {
          number: refreshed.number,
          title: refreshed.title,
          state: refreshed.state,
          labels: refreshed.labels,
          assignees: refreshed.assignees,
          node_id: refreshed.node_id,
          repository,
        },
        namingTokens: issueToNamingTokens(refreshed),
        body,
      };
    } else {
      // Create new issue — title inferred by caller via inferTitle
      const title = ghIssues?.title || 'New issue';
      const created = await this.client.createIssue(owner, repo, {
        title,
        body,
        labels: ghIssues?.labels ?? [],
        assignees: ghIssues?.assignees ?? [],
      });

      return {
        remoteInfo: issueToRemoteInfo(created),
        frontmatter: {
          number: created.number,
          title: created.title,
          state: created.state,
          labels: created.labels,
          assignees: created.assignees,
          node_id: created.node_id,
          repository,
        },
        namingTokens: issueToNamingTokens(created),
        body,
      };
    }
  }

  buildFileName(namingTokens: Record<string, string | number>, template: string): string {
    return buildFileName(namingTokens, template);
  }

  getRemoteId(frontmatter: IssueFrontmatter): number | undefined {
    return frontmatter['gh-issues']?.number;
  }

  inferTitle(filePath: string, frontmatter: IssueFrontmatter, body: string): string {
    return inferTitle(filePath, frontmatter, body);
  }
}
