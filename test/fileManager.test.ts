import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { issueToFileName, issueNumberFromFileName, findFileByNumber, findFileByIssueNumberInFrontmatter, serializeIssueFile, readIssueFile, writeIssueFile, type IssueFrontmatter } from '../src/fileManager';
import { matchesFilter, type GhIssuesFilters } from '../src/plugins/ghIssuesPlugin';
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
      html_url: '',
    };
  }

  test('produces expected filename from new-style token template', () => {
    const issue = makeIssue(42, 'Fix the bug');
    const result = issueToFileName(issue, '{gh-issues.number}-{gh-issues.title}');
    assert.strictEqual(result, '42-fix-the-bug');
  });

  test('produces expected filename from legacy token template', () => {
    const issue = makeIssue(42, 'Fix the bug');
    const result = issueToFileName(issue, '{issue-num}-{issue-title}');
    assert.strictEqual(result, '42-fix-the-bug');
  });

  test('strips characters invalid in filenames', () => {
    const issue = makeIssue(1, 'Hello: world / test');
    const result = issueToFileName(issue, '{gh-issues.number}-{gh-issues.title}');
    assert.ok(!result.includes('/'), 'should not contain /');
    assert.ok(!result.includes(':'), 'should not contain :');
  });

  test('collapses consecutive dashes', () => {
    const issue = makeIssue(3, 'A   B   C');
    const result = issueToFileName(issue, '{gh-issues.number}-{gh-issues.title}');
    assert.ok(!result.includes('--'), 'should not have consecutive dashes');
  });

  test('lowercases title slug', () => {
    const issue = makeIssue(7, 'UPPER CASE TITLE');
    const result = issueToFileName(issue, '{gh-issues.number}-{gh-issues.title}');
    assert.strictEqual(result, '7-upper-case-title');
  });

  test('handles custom template with number only', () => {
    const issue = makeIssue(99, 'my task');
    const result = issueToFileName(issue, 'issue-{gh-issues.number}');
    assert.strictEqual(result, 'issue-99');
  });
});

// ---------------------------------------------------------------------------
// Section 2: matchesFilter
// ---------------------------------------------------------------------------
suite('fileManager – matchesFilter', () => {
  function makeFrontmatter(overrides: Partial<{ state: 'open' | 'closed'; labels: string[]; assignees: string[] }> = {}): IssueFrontmatter {
    return {
      'gh-issues': {
        number: 1,
        title: 'Test',
        state: overrides.state ?? 'open',
        labels: overrides.labels ?? [],
        assignees: overrides.assignees ?? [],
      },
    };
  }

  function makeFilters(overrides: Partial<GhIssuesFilters> = {}): GhIssuesFilters {
    return { repository: 'owner/repo', ...overrides };
  }

  test('state:open matches open issue', () => {
    const fm = makeFrontmatter({ state: 'open' });
    assert.strictEqual(matchesFilter(fm, makeFilters({ state: 'open' })), true);
  });

  test('state:open does not match closed issue', () => {
    const fm = makeFrontmatter({ state: 'closed' });
    assert.strictEqual(matchesFilter(fm, makeFilters({ state: 'open' })), false);
  });

  test('state:closed matches closed issue', () => {
    const fm = makeFrontmatter({ state: 'closed' });
    assert.strictEqual(matchesFilter(fm, makeFilters({ state: 'closed' })), true);
  });

  test('label filter matches when label present', () => {
    const fm = makeFrontmatter({ labels: ['bug', 'help wanted'] });
    assert.strictEqual(matchesFilter(fm, makeFilters({ label: 'bug' })), true);
  });

  test('label filter does not match when label absent', () => {
    const fm = makeFrontmatter({ labels: ['enhancement'] });
    assert.strictEqual(matchesFilter(fm, makeFilters({ label: 'bug' })), false);
  });

  test('label array filter: all labels must be present', () => {
    const fm = makeFrontmatter({ labels: ['bug', 'help wanted'] });
    assert.strictEqual(matchesFilter(fm, makeFilters({ label: ['bug', 'help wanted'] })), true);
    assert.strictEqual(matchesFilter(fm, makeFilters({ label: ['bug', 'missing'] })), false);
  });

  test('assignee filter matches when assignee present', () => {
    const fm = makeFrontmatter({ assignees: ['octocat'] });
    assert.strictEqual(matchesFilter(fm, makeFilters({ assignee: 'octocat' })), true);
  });

  test('assignee filter does not match when assignee absent', () => {
    const fm = makeFrontmatter({ assignees: [] });
    assert.strictEqual(matchesFilter(fm, makeFilters({ assignee: 'octocat' })), false);
  });

  test('filters with only repository field always match', () => {
    const fm = makeFrontmatter();
    assert.strictEqual(matchesFilter(fm, makeFilters()), true);
  });

  test('returns false when gh-issues namespace is missing from frontmatter', () => {
    const fm: IssueFrontmatter = {};
    assert.strictEqual(matchesFilter(fm, makeFilters({ state: 'open' })), false);
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
      'gh-issues': {
        number: 5,
        title: 'My task',
        state: 'open',
        labels: ['bug', 'help wanted'],
        assignees: ['octocat'],
      },
    };
  }

  test('serializeIssueFile produces YAML frontmatter with gh-issues namespace', () => {
    const fm = makeFrontmatter();
    const result = serializeIssueFile(fm, 'Issue body here.');
    assert.ok(result.startsWith('---'), 'should start with ---');
    assert.ok(result.includes('gh-issues:'), 'should include gh-issues namespace');
    assert.ok(result.includes('title: My task'), 'should include title');
    assert.ok(result.includes('Issue body here.'), 'should include body');
  });

  test('readIssueFile round-trips through writeIssueFile', async () => {
    const fm = makeFrontmatter();
    const body = 'Issue body goes here.';
    const filePath = path.join(tmpDir, 'test-issue.md');

    await writeIssueFile(filePath, fm, body);
    const { frontmatter: read, body: readBody } = await readIssueFile(filePath);

    assert.strictEqual(read['gh-issues']?.number, 5);
    assert.strictEqual(read['gh-issues']?.title, 'My task');
    assert.strictEqual(read['gh-issues']?.state, 'open');
    assert.deepStrictEqual(read['gh-issues']?.labels, ['bug', 'help wanted']);
    assert.deepStrictEqual(read['gh-issues']?.assignees, ['octocat']);
    assert.ok(readBody.includes('Issue body goes here.'));
  });

  test('readIssueFile handles missing optional fields gracefully', async () => {
    const filePath = path.join(tmpDir, 'minimal.md');
    const content = '---\ngh-issues:\n  title: Minimal\n  state: open\n---\nBody text.\n';
    await fs.promises.writeFile(filePath, content, 'utf8');

    const { frontmatter, body } = await readIssueFile(filePath);
    assert.strictEqual(frontmatter['gh-issues']?.title, 'Minimal');
    assert.strictEqual(frontmatter['gh-issues']?.state, 'open');
    assert.deepStrictEqual(frontmatter['gh-issues']?.labels, []);
    assert.deepStrictEqual(frontmatter['gh-issues']?.assignees, []);
    assert.ok(body.includes('Body text.'));
  });

  test('readIssueFile parses gh-projects namespace if present', async () => {
    const filePath = path.join(tmpDir, 'with-projects.md');
    const content = '---\ngh-issues:\n  title: T\n  state: open\ngh-projects:\n  title: T\n  field1: val1\n---\nbody\n';
    await fs.promises.writeFile(filePath, content, 'utf8');

    const { frontmatter } = await readIssueFile(filePath);
    assert.ok(frontmatter['gh-projects'], 'gh-projects namespace should be present');
    assert.strictEqual((frontmatter['gh-projects'] as Record<string, unknown>)['field1'], 'val1');
  });
});

// ---------------------------------------------------------------------------
// Section 4: issueNumberFromFileName
// ---------------------------------------------------------------------------
suite('fileManager – issueNumberFromFileName', () => {
  test('extracts number from new-style template', () => {
    assert.strictEqual(issueNumberFromFileName('42-fix-the-bug', '{gh-issues.number}-{gh-issues.title}'), 42);
  });

  test('extracts number from legacy template', () => {
    assert.strictEqual(issueNumberFromFileName('42-fix-the-bug', '{issue-num}-{issue-title}'), 42);
  });

  test('extracts number when title contains dashes', () => {
    assert.strictEqual(issueNumberFromFileName('7-some-long-title-here', '{gh-issues.number}-{gh-issues.title}'), 7);
  });

  test('extracts number from number-only template (no title token)', () => {
    assert.strictEqual(issueNumberFromFileName('issue-99', 'issue-{gh-issues.number}'), 99);
  });

  test('extracts number from template with prefix and suffix around num', () => {
    assert.strictEqual(issueNumberFromFileName('GH-123-my-task', 'GH-{gh-issues.number}-{gh-issues.title}'), 123);
  });

  test('returns null when filename does not start with the template prefix', () => {
    assert.strictEqual(issueNumberFromFileName('fix-the-bug', '{gh-issues.number}-{gh-issues.title}'), null);
  });

  test('returns null for an empty string', () => {
    assert.strictEqual(issueNumberFromFileName('', '{gh-issues.number}-{gh-issues.title}'), null);
  });

  test('returns null when template has no number token', () => {
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

    const result = await findFileByNumber(tmpDir, 42, '{gh-issues.number}-{gh-issues.title}');
    assert.strictEqual(result, filePath);
  });

  test('returns null when no file matches the issue number', async () => {
    await fs.promises.writeFile(path.join(tmpDir, '99-other.md'), '# other', 'utf8');

    const result = await findFileByNumber(tmpDir, 42, '{gh-issues.number}-{gh-issues.title}');
    assert.strictEqual(result, null);
  });

  test('returns null when directory does not exist', async () => {
    const result = await findFileByNumber(path.join(tmpDir, 'nonexistent'), 1, '{gh-issues.number}-{gh-issues.title}');
    assert.strictEqual(result, null);
  });

  test('ignores files that are not .md', async () => {
    await fs.promises.writeFile(path.join(tmpDir, '42-fix-the-bug.txt'), 'text', 'utf8');

    const result = await findFileByNumber(tmpDir, 42, '{gh-issues.number}-{gh-issues.title}');
    assert.strictEqual(result, null);
  });

  test('finds file even when another issue has a similar number prefix', async () => {
    await fs.promises.writeFile(path.join(tmpDir, '4-short.md'), '# 4', 'utf8');
    await fs.promises.writeFile(path.join(tmpDir, '42-fix-the-bug.md'), '# 42', 'utf8');

    const result = await findFileByNumber(tmpDir, 42, '{gh-issues.number}-{gh-issues.title}');
    assert.strictEqual(result, path.join(tmpDir, '42-fix-the-bug.md'));
  });
});

// ---------------------------------------------------------------------------
// Section 6: findFileByIssueNumberInFrontmatter
// ---------------------------------------------------------------------------
suite('fileManager – findFileByIssueNumberInFrontmatter', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontmatter-find-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeFrontmatter(number: number): IssueFrontmatter {
    return { 'gh-issues': { number, title: 'Some Issue', state: 'open', labels: [], assignees: [] } };
  }

  test('finds file whose gh-issues.number matches, regardless of filename', async () => {
    // Arrange
    const filePath = path.join(tmpDir, 'issue-42.md');
    await writeIssueFile(filePath, makeFrontmatter(42), 'body');

    // Act
    const result = await findFileByIssueNumberInFrontmatter(tmpDir, 42);

    // Assert
    assert.strictEqual(result, filePath);
  });

  test('finds file named with old template when current template differs', async () => {
    // Arrange
    const oldPath = path.join(tmpDir, '7-fix-the-bug.md');
    await writeIssueFile(oldPath, makeFrontmatter(7), 'body');

    // Act
    const result = await findFileByIssueNumberInFrontmatter(tmpDir, 7);

    // Assert
    assert.strictEqual(result, oldPath);
  });

  test('returns null when no file has a matching frontmatter number', async () => {
    // Arrange
    await writeIssueFile(path.join(tmpDir, '99-other.md'), makeFrontmatter(99), 'body');

    // Act
    const result = await findFileByIssueNumberInFrontmatter(tmpDir, 42);

    // Assert
    assert.strictEqual(result, null);
  });

  test('returns null when directory does not exist', async () => {
    // Arrange / Act
    const result = await findFileByIssueNumberInFrontmatter(path.join(tmpDir, 'nonexistent'), 1);

    // Assert
    assert.strictEqual(result, null);
  });

  test('skips non-.md files', async () => {
    // Arrange
    await fs.promises.writeFile(path.join(tmpDir, '42.txt'), 'not markdown', 'utf8');

    // Act
    const result = await findFileByIssueNumberInFrontmatter(tmpDir, 42);

    // Assert
    assert.strictEqual(result, null);
  });

  test('skips files with no gh-issues frontmatter', async () => {
    // Arrange
    const content = '---\ntitle: No Number\nstate: open\n---\nbody\n';
    await fs.promises.writeFile(path.join(tmpDir, 'no-number.md'), content, 'utf8');

    // Act
    const result = await findFileByIssueNumberInFrontmatter(tmpDir, 42);

    // Assert
    assert.strictEqual(result, null);
  });

  test('disambiguates same issue number across repos using repository parameter', async () => {
    // Arrange
    const fileA = path.join(tmpDir, '42-from-repo-a.md');
    const fileB = path.join(tmpDir, '42-from-repo-b.md');
    const fmA: IssueFrontmatter = { 'gh-issues': { number: 42, title: 'A', state: 'open', labels: [], assignees: [], repository: 'owner/repo-a' } };
    const fmB: IssueFrontmatter = { 'gh-issues': { number: 42, title: 'B', state: 'open', labels: [], assignees: [], repository: 'owner/repo-b' } };
    await writeIssueFile(fileA, fmA, 'body A');
    await writeIssueFile(fileB, fmB, 'body B');

    // Act
    const resultA = await findFileByIssueNumberInFrontmatter(tmpDir, 42, 'owner/repo-a');
    const resultB = await findFileByIssueNumberInFrontmatter(tmpDir, 42, 'owner/repo-b');

    // Assert
    assert.strictEqual(resultA, fileA);
    assert.strictEqual(resultB, fileB);
  });

  test('returns first match when repository is not specified (backwards compat)', async () => {
    // Arrange
    const file = path.join(tmpDir, '7-issue.md');
    await writeIssueFile(file, makeFrontmatter(7), 'body');

    // Act
    const result = await findFileByIssueNumberInFrontmatter(tmpDir, 7, undefined);

    // Assert
    assert.strictEqual(result, file);
  });
});

