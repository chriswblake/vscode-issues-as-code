import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { issueToFileName, issueNumberFromFileName, findFileByNumber, issueMatchesFilter, serializeIssueFile, readIssueFile, writeIssueFile, type IssueFrontmatter } from '../src/fileManager';
import type { IssueData } from '../src/githubClient';

// ---------------------------------------------------------------------------
// Section 1: issueToFileName
// ---------------------------------------------------------------------------
suite('fileManager – issueToFileName', () => {
  function makeIssue(number: number, title: string): IssueData {
    return {
      number,
      title,
      state: 'open',
      body: null,
      labels: [],
      assignees: [],
      updated_at: new Date().toISOString(),
      closed_at: null,
      node_id: 'node1',
    };
  }

  test('produces expected filename from default template', () => {
    const issue = makeIssue(42, 'Fix the bug');
    const result = issueToFileName(issue, '{issue-num}-{issue-title}');
    assert.strictEqual(result, '42-fix-the-bug');
  });

  test('strips characters invalid in filenames', () => {
    const issue = makeIssue(1, 'Hello: world / test');
    const result = issueToFileName(issue, '{issue-num}-{issue-title}');
    assert.ok(!result.includes('/'), 'should not contain /');
    assert.ok(!result.includes(':'), 'should not contain :');
  });

  test('collapses consecutive dashes', () => {
    const issue = makeIssue(3, 'A   B   C');
    const result = issueToFileName(issue, '{issue-num}-{issue-title}');
    assert.ok(!result.includes('--'), 'should not have consecutive dashes');
  });

  test('lowercases title slug', () => {
    const issue = makeIssue(7, 'UPPER CASE TITLE');
    const result = issueToFileName(issue, '{issue-num}-{issue-title}');
    assert.strictEqual(result, '7-upper-case-title');
  });

  test('handles custom template', () => {
    const issue = makeIssue(99, 'my task');
    const result = issueToFileName(issue, 'issue-{issue-num}');
    assert.strictEqual(result, 'issue-99');
  });
});

// ---------------------------------------------------------------------------
// Section 2: issueMatchesFilter
// ---------------------------------------------------------------------------
suite('fileManager – issueMatchesFilter', () => {
  function makeFrontmatter(overrides: Partial<IssueFrontmatter> = {}): IssueFrontmatter {
    return {
      number: 1,
      title: 'Test',
      state: 'open',
      labels: [],
      assignees: [],
      closed_at: null,
      ...overrides,
    };
  }

  test('state:open matches open issue', () => {
    const fm = makeFrontmatter({ state: 'open' });
    assert.strictEqual(issueMatchesFilter(fm, 'is:issue state:open'), true);
  });

  test('state:open does not match closed issue', () => {
    const fm = makeFrontmatter({ state: 'closed' });
    assert.strictEqual(issueMatchesFilter(fm, 'state:open'), false);
  });

  test('state:closed matches closed issue', () => {
    const fm = makeFrontmatter({ state: 'closed', closed_at: '2026-04-20T00:00:00Z' });
    assert.strictEqual(issueMatchesFilter(fm, 'state:closed'), true);
  });

  test('label: matches when label present', () => {
    const fm = makeFrontmatter({ labels: ['bug', 'help wanted'] });
    assert.strictEqual(issueMatchesFilter(fm, 'label:bug'), true);
  });

  test('label: does not match when label absent', () => {
    const fm = makeFrontmatter({ labels: ['enhancement'] });
    assert.strictEqual(issueMatchesFilter(fm, 'label:bug'), false);
  });

  test('assignee: matches when assignee present', () => {
    const fm = makeFrontmatter({ assignees: ['octocat'] });
    assert.strictEqual(issueMatchesFilter(fm, 'assignee:octocat'), true);
  });

  test('assignee: does not match when assignee absent', () => {
    const fm = makeFrontmatter({ assignees: [] });
    assert.strictEqual(issueMatchesFilter(fm, 'assignee:octocat'), false);
  });

  test('is:issue always matches', () => {
    const fm = makeFrontmatter();
    assert.strictEqual(issueMatchesFilter(fm, 'is:issue'), true);
  });

  test('updated:> matches when synced_at is after the date', () => {
    const fm = makeFrontmatter();
    assert.strictEqual(issueMatchesFilter(fm, 'updated:>2026-04-01', '2026-04-22T10:00:00Z'), true);
  });

  test('updated:> does not match when synced_at is before the date', () => {
    const fm = makeFrontmatter();
    assert.strictEqual(issueMatchesFilter(fm, 'updated:>2026-04-01', '2026-03-01T10:00:00Z'), false);
  });

  test('updated:> does not match when syncedAt is not provided', () => {
    const fm = makeFrontmatter();
    assert.strictEqual(issueMatchesFilter(fm, 'updated:>2026-04-01'), false);
  });

  test('closed:> matches when closed_at is after the date', () => {
    const fm = makeFrontmatter({ closed_at: '2026-04-20T00:00:00Z' });
    assert.strictEqual(issueMatchesFilter(fm, 'closed:>2026-04-10'), true);
  });

  test('closed:> does not match when closed_at is null', () => {
    const fm = makeFrontmatter({ closed_at: null });
    assert.strictEqual(issueMatchesFilter(fm, 'closed:>2026-04-10'), false);
  });

  test('unknown token is treated as matching', () => {
    const fm = makeFrontmatter({ state: 'open' });
    assert.strictEqual(issueMatchesFilter(fm, 'repo:owner/repo state:open'), true);
  });
});

// ---------------------------------------------------------------------------
// Section 3: serializeIssueFile / readIssueFile round-trip
// ---------------------------------------------------------------------------
suite('fileManager – serialize/read round-trip', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeFrontmatter(): IssueFrontmatter {
    return {
      number: 5,
      title: 'My task',
      state: 'open',
      labels: ['bug', 'help wanted'],
      assignees: ['octocat'],
      closed_at: null,
    };
  }

  test('serializeIssueFile produces YAML frontmatter', () => {
    const fm = makeFrontmatter();
    const result = serializeIssueFile(fm, 'Issue body here.');
    assert.ok(result.startsWith('---'), 'should start with ---');
    assert.ok(result.includes('title: My task'), 'should include title');
    assert.ok(result.includes('Issue body here.'), 'should include body');
  });

  test('readIssueFile round-trips through writeIssueFile', async () => {
    const fm = makeFrontmatter();
    const body = 'Issue body goes here.';
    const filePath = path.join(tmpDir, 'test-issue.md');

    await writeIssueFile(filePath, fm, body);
    const { frontmatter: read, body: readBody } = await readIssueFile(filePath);

    assert.strictEqual(read.number, fm.number);
    assert.strictEqual(read.title, fm.title);
    assert.strictEqual(read.state, fm.state);
    assert.deepStrictEqual(read.labels, fm.labels);
    assert.deepStrictEqual(read.assignees, fm.assignees);
    assert.strictEqual(read.closed_at, fm.closed_at);
    assert.ok(readBody.includes('Issue body goes here.'));
  });

  test('readIssueFile handles missing optional fields gracefully', async () => {
    const filePath = path.join(tmpDir, 'minimal.md');
    const content = '---\ntitle: Minimal\nstate: open\n---\nBody text.\n';
    await fs.promises.writeFile(filePath, content, 'utf8');

    const { frontmatter, body } = await readIssueFile(filePath);
    assert.strictEqual(frontmatter.title, 'Minimal');
    assert.strictEqual(frontmatter.state, 'open');
    assert.deepStrictEqual(frontmatter.labels, []);
    assert.deepStrictEqual(frontmatter.assignees, []);
    assert.strictEqual(frontmatter.closed_at, null);
    assert.ok(body.includes('Body text.'));
  });
});

// ---------------------------------------------------------------------------
// Section 4: issueNumberFromFileName
// ---------------------------------------------------------------------------
suite('fileManager – issueNumberFromFileName', () => {
  test('extracts number from default template', () => {
    assert.strictEqual(issueNumberFromFileName('42-fix-the-bug', '{issue-num}-{issue-title}'), 42);
  });

  test('extracts number when title contains dashes', () => {
    assert.strictEqual(issueNumberFromFileName('7-some-long-title-here', '{issue-num}-{issue-title}'), 7);
  });

  test('extracts number from number-only template (no title token)', () => {
    assert.strictEqual(issueNumberFromFileName('issue-99', 'issue-{issue-num}'), 99);
  });

  test('extracts number from template with prefix and suffix around num', () => {
    assert.strictEqual(issueNumberFromFileName('GH-123-my-task', 'GH-{issue-num}-{issue-title}'), 123);
  });

  test('returns null when filename does not start with the template prefix', () => {
    assert.strictEqual(issueNumberFromFileName('fix-the-bug', '{issue-num}-{issue-title}'), null);
  });

  test('returns null for an empty string', () => {
    assert.strictEqual(issueNumberFromFileName('', '{issue-num}-{issue-title}'), null);
  });

  test('returns null when template has no {issue-num} token', () => {
    assert.strictEqual(issueNumberFromFileName('anything', 'no-placeholder'), null);
  });
});

// ---------------------------------------------------------------------------
// Section 5: findFileByNumber
// ---------------------------------------------------------------------------
suite('fileManager – findFileByNumber', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-issue-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('finds the file matching the issue number', async () => {
    const filePath = path.join(tmpDir, '42-fix-the-bug.md');
    await fs.promises.writeFile(filePath, '# content', 'utf8');

    const result = await findFileByNumber(tmpDir, 42, '{issue-num}-{issue-title}');
    assert.strictEqual(result, filePath);
  });

  test('returns null when no file matches the issue number', async () => {
    await fs.promises.writeFile(path.join(tmpDir, '99-other.md'), '# other', 'utf8');

    const result = await findFileByNumber(tmpDir, 42, '{issue-num}-{issue-title}');
    assert.strictEqual(result, null);
  });

  test('returns null when directory does not exist', async () => {
    const result = await findFileByNumber(path.join(tmpDir, 'nonexistent'), 1, '{issue-num}-{issue-title}');
    assert.strictEqual(result, null);
  });

  test('ignores files that are not .md', async () => {
    await fs.promises.writeFile(path.join(tmpDir, '42-fix-the-bug.txt'), 'text', 'utf8');

    const result = await findFileByNumber(tmpDir, 42, '{issue-num}-{issue-title}');
    assert.strictEqual(result, null);
  });

  test('finds file even when another issue has a similar number prefix', async () => {
    await fs.promises.writeFile(path.join(tmpDir, '4-short.md'), '# 4', 'utf8');
    await fs.promises.writeFile(path.join(tmpDir, '42-fix-the-bug.md'), '# 42', 'utf8');

    const result = await findFileByNumber(tmpDir, 42, '{issue-num}-{issue-title}');
    assert.strictEqual(result, path.join(tmpDir, '42-fix-the-bug.md'));
  });
});
