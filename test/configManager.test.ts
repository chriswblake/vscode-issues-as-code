import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { resolveQuery, getConfig, defaultSyncTargets, ensureGitignore } from '../src/configManager';

// ---------------------------------------------------------------------------
// Section 1: resolveQuery – basic {today-Nd} substitution
// ---------------------------------------------------------------------------
suite('configManager – resolveQuery basic substitution', () => {
  test('replaces {today-10d} with a date 10 days ago', () => {
    const result = resolveQuery('closed:>{today-10d}');
    const expected = new Date();
    expected.setDate(expected.getDate() - 10);
    const expectedStr = expected.toISOString().slice(0, 10);
    assert.strictEqual(result, `closed:>${expectedStr}`);
  });

  test('replaces {today-0d} with today\'s date', () => {
    const result = resolveQuery('{today-0d}');
    const today = new Date().toISOString().slice(0, 10);
    assert.strictEqual(result, today);
  });

  test('produces a date in YYYY-MM-DD format', () => {
    const result = resolveQuery('{today-5d}');
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Section 2: resolveQuery – multiple tokens, no tokens, various N values
// ---------------------------------------------------------------------------
suite('configManager – resolveQuery multiple / edge tokens', () => {
  test('replaces multiple {today-Nd} tokens in one string', () => {
    const result = resolveQuery('{today-1d} {today-30d}');
    const d1 = new Date(); d1.setDate(d1.getDate() - 1);
    const d30 = new Date(); d30.setDate(d30.getDate() - 30);
    assert.strictEqual(result, `${d1.toISOString().slice(0, 10)} ${d30.toISOString().slice(0, 10)}`);
  });

  test('leaves string unchanged when no tokens present', () => {
    const input = 'is:issue state:open';
    assert.strictEqual(resolveQuery(input), input);
  });

  test('handles large N values (e.g. {today-365d})', () => {
    const result = resolveQuery('{today-365d}');
    const expected = new Date();
    expected.setDate(expected.getDate() - 365);
    assert.strictEqual(result, expected.toISOString().slice(0, 10));
  });

  test('handles N=1', () => {
    const result = resolveQuery('{today-1d}');
    const expected = new Date();
    expected.setDate(expected.getDate() - 1);
    assert.strictEqual(result, expected.toISOString().slice(0, 10));
  });
});

// ---------------------------------------------------------------------------
// Section 3: resolveQuery – edge cases
// ---------------------------------------------------------------------------
suite('configManager – resolveQuery edge cases', () => {
  test('empty string returns empty string', () => {
    assert.strictEqual(resolveQuery(''), '');
  });

  test('malformed token {today-d} (no number) passes through unchanged', () => {
    const input = '{today-d}';
    assert.strictEqual(resolveQuery(input), input);
  });

  test('partial token {today-10} (no "d") passes through unchanged', () => {
    const input = '{today-10}';
    assert.strictEqual(resolveQuery(input), input);
  });

  test('preserves surrounding text around a token', () => {
    const result = resolveQuery('is:issue closed:>{today-7d} state:closed');
    const expected = new Date();
    expected.setDate(expected.getDate() - 7);
    const dateStr = expected.toISOString().slice(0, 10);
    assert.strictEqual(result, `is:issue closed:>${dateStr} state:closed`);
  });
});

// ---------------------------------------------------------------------------
// Section 4: getConfig – default values (no vscode context)
// ---------------------------------------------------------------------------
suite('configManager – getConfig defaults', () => {
  test('returns empty syncTargets by default', () => {
    const config = getConfig('/workspace');
    assert.deepStrictEqual(config.syncTargets, []);
  });

  test('returns expected default values for other fields', () => {
    const config = getConfig('/workspace');
    assert.strictEqual(config.fileNaming, '{issue-num}-{issue-title}');
    assert.strictEqual(config.autosaveDelay, 60);
    assert.strictEqual(config.pullInterval, 30);
  });
});

// ---------------------------------------------------------------------------
// Section 5: defaultSyncTargets
// ---------------------------------------------------------------------------
suite('configManager – defaultSyncTargets', () => {
  test('returns two targets for the given owner/repo', () => {
    const targets = defaultSyncTargets('myorg', 'myrepo', '/workspace');
    assert.strictEqual(targets.length, 2);
    assert.strictEqual(targets[0].repository_owner, 'myorg');
    assert.strictEqual(targets[0].repository_name, 'myrepo');
    assert.strictEqual(targets[1].repository_owner, 'myorg');
    assert.strictEqual(targets[1].repository_name, 'myrepo');
  });

  test('first target is an open-issues query', () => {
    const targets = defaultSyncTargets('myorg', 'myrepo', '/workspace');
    assert.ok(targets[0].query.includes('state:open'));
  });

  test('second target is a recently-closed query', () => {
    const targets = defaultSyncTargets('myorg', 'myrepo', '/workspace');
    assert.ok(targets[1].query.includes('closed:>'));
  });

  test('locations are under {workspaceDir}/.issues', () => {
    const targets = defaultSyncTargets('myorg', 'myrepo', '/workspace');
    for (const t of targets) {
      assert.ok(t.location.startsWith(path.join('/workspace', '.issues')));
    }
  });

  test('different owners/repos produce different targets', () => {
    const t1 = defaultSyncTargets('org1', 'repo1', '/workspace');
    const t2 = defaultSyncTargets('org2', 'repo2', '/workspace');
    assert.notStrictEqual(t1[0].repository_owner, t2[0].repository_owner);
    assert.notStrictEqual(t1[0].repository_name, t2[0].repository_name);
  });
});

// ---------------------------------------------------------------------------
// Section 6: ensureGitignore
// ---------------------------------------------------------------------------
suite('configManager – ensureGitignore', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates .gitignore with entry when file does not exist', async () => {
    await ensureGitignore(tmpDir, [path.join(tmpDir, '.issues', 'open')]);
    const content = await fs.promises.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.issues/'));
  });

  test('adds entry to existing .gitignore', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.promises.writeFile(gitignorePath, 'node_modules/\n', 'utf8');
    await ensureGitignore(tmpDir, [path.join(tmpDir, '.issues', 'open')]);
    const content = await fs.promises.readFile(gitignorePath, 'utf8');
    assert.ok(content.includes('node_modules/'));
    assert.ok(content.includes('.issues/'));
  });

  test('does not duplicate entry if already present', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.promises.writeFile(gitignorePath, '.issues/\n', 'utf8');
    await ensureGitignore(tmpDir, [path.join(tmpDir, '.issues', 'open')]);
    const content = await fs.promises.readFile(gitignorePath, 'utf8');
    const matches = content.match(/\.issues\//g) ?? [];
    assert.strictEqual(matches.length, 1, 'entry should appear exactly once');
  });

  test('deduplicates multiple locations sharing the same top-level directory', async () => {
    await ensureGitignore(tmpDir, [
      path.join(tmpDir, '.issues', 'open'),
      path.join(tmpDir, '.issues', 'closed'),
    ]);
    const content = await fs.promises.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
    const matches = content.match(/\.issues\//g) ?? [];
    assert.strictEqual(matches.length, 1, '.issues/ should appear exactly once');
  });

  test('adds separate entries for locations under different top-level directories', async () => {
    await ensureGitignore(tmpDir, [
      path.join(tmpDir, '.issues'),
      path.join(tmpDir, '.other-issues'),
    ]);
    const content = await fs.promises.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.issues/'));
    assert.ok(content.includes('.other-issues/'));
  });

  test('skips locations outside the workspace', async () => {
    const outsidePath = path.join(os.tmpdir(), 'outside-workspace');
    await ensureGitignore(tmpDir, [outsidePath]);
    const gitignorePath = path.join(tmpDir, '.gitignore');
    let exists = true;
    try { await fs.promises.access(gitignorePath); } catch { exists = false; }
    // File should not be created (or if it exists, should not have an absolute path entry)
    if (exists) {
      const content = await fs.promises.readFile(gitignorePath, 'utf8');
      assert.strictEqual(content.trim(), '', 'should not write entries for outside paths');
    }
  });
});
