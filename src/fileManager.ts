import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import type { IssueData } from './githubClient';
import type { GhIssuesFilters } from './configManager';

export interface GhIssuesFrontmatter {
  number?: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
}

export interface IssueFrontmatter {
  'gh-issues'?: GhIssuesFrontmatter;
  'gh-projects'?: Record<string, unknown>;
  'tick-tick'?: Record<string, unknown>;
}

/** Reads and parses a Markdown issue file into frontmatter + body. */
export async function readIssueFile(filePath: string): Promise<{ frontmatter: IssueFrontmatter; body: string }> {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  const { data, content } = matter(raw);

  const rawGhIssues = data['gh-issues'];
  let ghIssues: GhIssuesFrontmatter | undefined;
  if (rawGhIssues && typeof rawGhIssues === 'object') {
    ghIssues = {
      number: typeof rawGhIssues['number'] === 'number' ? rawGhIssues['number'] : undefined,
      title: String(rawGhIssues['title'] ?? ''),
      state: rawGhIssues['state'] === 'closed' ? 'closed' : 'open',
      labels: Array.isArray(rawGhIssues['labels']) ? rawGhIssues['labels'].map(String) : [],
      assignees: Array.isArray(rawGhIssues['assignees']) ? rawGhIssues['assignees'].map(String) : [],
    };
  }

  const rawGhProjects = data['gh-projects'];
  const ghProjects = rawGhProjects && typeof rawGhProjects === 'object' ? (rawGhProjects as Record<string, unknown>) : undefined;

  const rawTickTick = data['tick-tick'];
  const tickTick = rawTickTick && typeof rawTickTick === 'object' ? (rawTickTick as Record<string, unknown>) : undefined;

  const frontmatter: IssueFrontmatter = {};
  if (ghIssues) frontmatter['gh-issues'] = ghIssues;
  if (ghProjects) frontmatter['gh-projects'] = ghProjects;
  if (tickTick) frontmatter['tick-tick'] = tickTick;

  return { frontmatter, body: content.trimStart() };
}

/** Writes frontmatter + body to a Markdown file using gray-matter. */
export async function writeIssueFile(filePath: string, frontmatter: IssueFrontmatter, body: string): Promise<void> {
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
 * Supports {gh-issues.number} and {gh-issues.title} tokens (new style)
 * as well as {issue-num} and {issue-title} tokens (legacy style).
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
    .replace('{gh-issues.number}', String(issue.number))
    .replace('{gh-issues.title}', slug)
    .replace('{issue-num}', String(issue.number))
    .replace('{issue-title}', slug);

  // Final cleanup: strip any remaining invalid chars, collapse dashes
  return name
    .replace(/[^a-z0-9\-_]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Extracts the issue number from a file's base name (without extension) using
 * the configured file naming template.  Returns null if the name does not
 * match the template's numeric placeholder.
 *
 * Supports {gh-issues.number} (new style) and {issue-num} (legacy style) tokens.
 *
 * Example: template='{gh-issues.number}-{gh-issues.title}', baseName='42-fix-the-bug' → 42
 */
export function issueNumberFromFileName(baseName: string, template: string): number | null {
  // Support both new-style {gh-issues.number} and legacy {issue-num}
  const normalizedTemplate = template.replace('{gh-issues.number}', '{issue-num}').replace('{gh-issues.title}', '{issue-title}');

  const parts = normalizedTemplate.split('{issue-num}');
  if (parts.length !== 2) {
    return null;
  }

  // Escape regex special characters in the literal parts of the template
  const escapeLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const before = escapeLiteral(parts[0]);
  // Only the portion between {issue-num} and {issue-title} matters for anchoring
  const afterParts = parts[1].split('{issue-title}');
  const afterNum = escapeLiteral(afterParts[0]);

  const regex = new RegExp(`^${before}(\\d+)${afterNum}`);
  const match = baseName.match(regex);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Scans the given directory for a .md file whose base name encodes the
 * supplied issue number according to the template.  Returns the full path
 * of the first match, or null if no such file exists.
 */
export async function findFileByNumber(location: string, issueNumber: number, template: string): Promise<string | null> {
  let files: string[];
  try {
    files = await fs.promises.readdir(location);
  } catch {
    return null; // directory not yet created
  }

  for (const file of files) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const base = file.slice(0, -3);
    if (issueNumberFromFileName(base, template) === issueNumber) {
      return path.join(location, file);
    }
  }
  return null;
}

/**
 * Fallback scan when the fileNaming template may have changed.
 * Reads the frontmatter of every .md file in the directory and returns the
 * first whose `gh-issues.number` field matches issueNumber.
 */
export async function findFileByIssueNumberInFrontmatter(location: string, issueNumber: number): Promise<string | null> {
  let files: string[];
  try {
    files = await fs.promises.readdir(location);
  } catch {
    return null;
  }

  for (const file of files) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const filePath = path.join(location, file);
    try {
      const { frontmatter } = await readIssueFile(filePath);
      if (frontmatter['gh-issues']?.number === issueNumber) {
        return filePath;
      }
    } catch {
      /* unreadable file — skip */
    }
  }
  return null;
}

/**
 * Evaluates a set of GhIssuesFilters against an issue's frontmatter.
 * Checks: state, label, assignee.
 * Filters that cannot be evaluated client-side (e.g. created_at) are skipped.
 * Unknown keys are treated as matching (return true).
 */
export function issueMatchesFilter(frontmatter: IssueFrontmatter, filters: GhIssuesFilters, syncedAt?: string, closedAt?: string | null): boolean {
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
