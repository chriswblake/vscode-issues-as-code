import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import type { IssueData } from './githubClient';

export interface IssueFrontmatter {
  number?: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  synced_at: string;
  closed_at: string | null;
  projects?: Record<string, Record<string, string>>;
}

/** Reads and parses a Markdown issue file into frontmatter + body. */
export async function readIssueFile(
  filePath: string
): Promise<{ frontmatter: IssueFrontmatter; body: string }> {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  const { data, content } = matter(raw);

  const frontmatter: IssueFrontmatter = {
    number: typeof data['number'] === 'number' ? data['number'] : undefined,
    title: String(data['title'] ?? ''),
    state: data['state'] === 'closed' ? 'closed' : 'open',
    labels: Array.isArray(data['labels']) ? data['labels'].map(String) : [],
    assignees: Array.isArray(data['assignees']) ? data['assignees'].map(String) : [],
    synced_at: String(data['synced_at'] ?? new Date().toISOString()),
    closed_at: data['closed_at'] != null ? String(data['closed_at']) : null,
    projects: typeof data['projects'] === 'object' && data['projects'] !== null
      ? (data['projects'] as Record<string, Record<string, string>>)
      : undefined,
  };

  return { frontmatter, body: content.trimStart() };
}

/** Writes frontmatter + body to a Markdown file using gray-matter. */
export async function writeIssueFile(
  filePath: string,
  frontmatter: IssueFrontmatter,
  body: string
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const serialized = serializeIssueFile(frontmatter, body);
  await fs.promises.writeFile(filePath, serialized, 'utf8');
}

/** Serializes frontmatter + body to a Markdown string. */
export function serializeIssueFile(frontmatter: IssueFrontmatter, body: string): string {
  return matter.stringify('\n' + body, frontmatter as unknown as Record<string, unknown>);
}

/**
 * Converts an issue to a filename using a template.
 * Strips characters invalid in filenames, collapses consecutive dashes.
 */
export function issueToFileName(issue: IssueData, template: string): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  const name = template
    .replace('{issue-num}', String(issue.number))
    .replace('{issue-title}', slug);

  // Final cleanup: strip any remaining invalid chars, collapse dashes
  return name.replace(/[^a-z0-9\-_]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Evaluates a resolved GitHub search query against an issue's frontmatter.
 * Supported tokens: state:, label:, assignee:, is:issue, updated:>, closed:>
 * Unknown tokens are treated as matching (return true).
 */
export function issueMatchesFilter(frontmatter: IssueFrontmatter, resolvedQuery: string): boolean {
  const tokens = resolvedQuery.trim().split(/\s+/);

  for (const token of tokens) {
    if (token === 'is:issue') {
      // Always true for issue files
      continue;
    }

    if (token.startsWith('state:')) {
      const val = token.slice('state:'.length);
      if (frontmatter.state !== val) { return false; }
      continue;
    }

    if (token.startsWith('label:')) {
      const val = token.slice('label:'.length);
      if (!frontmatter.labels.includes(val)) { return false; }
      continue;
    }

    if (token.startsWith('assignee:')) {
      const val = token.slice('assignee:'.length);
      if (!frontmatter.assignees.includes(val)) { return false; }
      continue;
    }

    if (token.startsWith('updated:>')) {
      const dateStr = token.slice('updated:>'.length);
      if (new Date(frontmatter.synced_at) <= new Date(dateStr)) { return false; }
      continue;
    }

    if (token.startsWith('closed:>')) {
      const dateStr = token.slice('closed:>'.length);
      if (!frontmatter.closed_at || new Date(frontmatter.closed_at) <= new Date(dateStr)) {
        return false;
      }
      continue;
    }

    // Unknown token — treat as matching
  }

  return true;
}
