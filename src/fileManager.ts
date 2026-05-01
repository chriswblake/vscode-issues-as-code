import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';

/**
 * Generic frontmatter type — each key is a plugin namespace (e.g. 'gh-issues')
 * and the value is whatever that plugin stores.
 */
export interface IssueFrontmatter {
  [pluginId: string]: unknown;
}

/** Reads and parses a Markdown issue file into frontmatter + body. */
export async function readIssueFile(filePath: string): Promise<{ frontmatter: IssueFrontmatter; body: string }> {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  const { data, content } = matter(raw);

  // Pass through all frontmatter sections as-is — plugins own their namespaces
  const frontmatter: IssueFrontmatter = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) {
      frontmatter[key] = value;
    }
  }

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
