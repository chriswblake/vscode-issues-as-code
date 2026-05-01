import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SyncStateManager, type RemoteIssueInfo } from '../src/syncStateManager';
import { IssueDecorationProvider, type SyncStatus } from '../src/issueDecorationProvider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deco-test-'));
}

function makeTempStatePath(dir: string): string {
  return path.join(dir, 'sync-state.yml');
}

function makeRemoteInfo(overrides: Partial<RemoteIssueInfo> = {}): RemoteIssueInfo {
  return {
    number: 1,
    state: 'open',
    updated_at: '2024-01-15T10:00:00Z',
    closed_at: null,
    html_url: 'https://github.com/owner/repo/issues/1',
    ...overrides,
  };
}

function makeUri(filePath: string): { fsPath: string } {
  return { fsPath: filePath };
}

// ---------------------------------------------------------------------------
// Section 1: resolveStatus – new issue (no sync state)
// ---------------------------------------------------------------------------

suite('issueDecorationProvider – new issue status', () => {
  test('returns new for a file with no sync state entry', async () => {
    // Arrange
    const dir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();
    const issueFile = path.join(dir, '1-new-issue.md');
    fs.writeFileSync(issueFile, '# New issue\n', 'utf8');

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: true, modified: true, synchronized: true });

    // Act
    const decoration = provider.provideFileDecoration(makeUri(issueFile) as any);

    // Assert
    assert.ok(decoration, 'should return a decoration');
    assert.strictEqual(decoration!.badge, 'A');
  });

  test('returns undefined for new issue when newIssue icon is disabled', async () => {
    // Arrange
    const dir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();
    const issueFile = path.join(dir, '1-new-issue.md');
    fs.writeFileSync(issueFile, '# New issue\n', 'utf8');

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: false, modified: true, synchronized: true });

    // Act
    const decoration = provider.provideFileDecoration(makeUri(issueFile) as any);

    // Assert
    assert.strictEqual(decoration, undefined);
  });
});

// ---------------------------------------------------------------------------
// Section 2: resolveStatus – synchronized (file written by extension, not modified)
// ---------------------------------------------------------------------------

suite('issueDecorationProvider – synchronized status', () => {
  test('returns synchronized for a file written by the extension and not modified since', async () => {
    // Arrange
    const dir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();
    const issueFile = path.join(dir, '1-synced-issue.md');

    // Write and immediately record sync state (local_written_at = now)
    fs.writeFileSync(issueFile, '# Synced issue\n', 'utf8');
    await stateManager.setSyncedAt(issueFile, makeRemoteInfo());

    // Set file mtime to before local_written_at so it looks unmodified
    const past = new Date(Date.now() - 10000);
    fs.utimesSync(issueFile, past, past);

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: true, modified: true, synchronized: true });

    // Act
    const decoration = provider.provideFileDecoration(makeUri(issueFile) as any);

    // Assert
    assert.ok(decoration, 'should return a decoration');
    assert.strictEqual(decoration!.badge, '✓');
  });

  test('returns undefined for synchronized when synchronized icon is disabled', async () => {
    // Arrange
    const dir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();
    const issueFile = path.join(dir, '1-synced-issue.md');

    fs.writeFileSync(issueFile, '# Synced issue\n', 'utf8');
    await stateManager.setSyncedAt(issueFile, makeRemoteInfo());

    const past = new Date(Date.now() - 10000);
    fs.utimesSync(issueFile, past, past);

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: true, modified: true, synchronized: false });

    // Act
    const decoration = provider.provideFileDecoration(makeUri(issueFile) as any);

    // Assert
    assert.strictEqual(decoration, undefined);
  });
});

// ---------------------------------------------------------------------------
// Section 3: resolveStatus – modified (file edited after last sync)
// ---------------------------------------------------------------------------

suite('issueDecorationProvider – modified status', () => {
  test('returns modified for a file whose mtime is newer than local_written_at', async () => {
    // Arrange
    const dir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();
    const issueFile = path.join(dir, '1-modified-issue.md');

    // Set sync state first, then set mtime far in the future to simulate user edit
    fs.writeFileSync(issueFile, '# Issue\n', 'utf8');
    await stateManager.setSyncedAt(issueFile, makeRemoteInfo());

    const future = new Date(Date.now() + 60000);
    fs.utimesSync(issueFile, future, future);

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: true, modified: true, synchronized: true });

    // Act
    const decoration = provider.provideFileDecoration(makeUri(issueFile) as any);

    // Assert
    assert.ok(decoration, 'should return a decoration');
    assert.strictEqual(decoration!.badge, 'M');
  });

  test('returns undefined for modified when modified icon is disabled', async () => {
    // Arrange
    const dir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();
    const issueFile = path.join(dir, '1-modified-issue.md');

    fs.writeFileSync(issueFile, '# Issue\n', 'utf8');
    await stateManager.setSyncedAt(issueFile, makeRemoteInfo());

    const future = new Date(Date.now() + 60000);
    fs.utimesSync(issueFile, future, future);

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: true, modified: false, synchronized: true });

    // Act
    const decoration = provider.provideFileDecoration(makeUri(issueFile) as any);

    // Assert
    assert.strictEqual(decoration, undefined);
  });
});

// ---------------------------------------------------------------------------
// Section 4: path filtering
// ---------------------------------------------------------------------------

suite('issueDecorationProvider – path filtering', () => {
  test('returns undefined for a non-.md file', async () => {
    // Arrange
    const dir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: true, modified: true, synchronized: true });

    // Act
    const decoration = provider.provideFileDecoration(makeUri(path.join(dir, 'readme.txt')) as any);

    // Assert
    assert.strictEqual(decoration, undefined);
  });

  test('returns undefined for a .md file outside all managed locations', async () => {
    // Arrange
    const dir = makeTempDir();
    const otherDir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: true, modified: true, synchronized: true });

    // Act
    const decoration = provider.provideFileDecoration(makeUri(path.join(otherDir, '1-outside.md')) as any);

    // Assert
    assert.strictEqual(decoration, undefined);
  });

  test('returns undefined when no managed locations are configured', async () => {
    // Arrange
    const dir = makeTempDir();
    const provider = new IssueDecorationProvider();
    provider.update([], { newIssue: true, modified: true, synchronized: true });

    // Act
    const decoration = provider.provideFileDecoration(makeUri(path.join(dir, '1-issue.md')) as any);

    // Assert
    assert.strictEqual(decoration, undefined);
  });
});

// ---------------------------------------------------------------------------
// Section 5: SyncStateManager – local_written_at field
// ---------------------------------------------------------------------------

suite('syncStateManager – local_written_at', () => {
  test('local_written_at is set to a recent ISO timestamp when setSyncedAt is called', async () => {
    // Arrange
    const statePath = path.join(makeTempDir(), 'sync-state.yml');
    const manager = new SyncStateManager(statePath);
    await manager.load();
    const before = Date.now();

    // Act
    await manager.setSyncedAt('/issues/1.md', makeRemoteInfo());

    // Assert
    const after = Date.now();
    const entry = manager.getEntry('/issues/1.md');
    assert.ok(entry, 'entry should exist');
    const writtenAt = new Date(entry!.local_written_at).getTime();
    assert.ok(writtenAt >= before && writtenAt <= after, 'local_written_at should be between before and after');
  });

  test('local_written_at is persisted to disk', async () => {
    // Arrange
    const statePath = path.join(makeTempDir(), 'sync-state.yml');
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt('/issues/1.md', makeRemoteInfo());

    // Assert
    const raw = yaml.safeLoad(fs.readFileSync(statePath, 'utf8')) as { files: Record<string, Record<string, unknown>> };
    assert.ok(typeof raw.files['/issues/1.md']['local_written_at'] === 'string');
  });
});

// ---------------------------------------------------------------------------
// Section 6: SyncStateManager – onDidChange
// ---------------------------------------------------------------------------

suite('syncStateManager – onDidChange', () => {
  test('listener is called with file path when setSyncedAt is called', async () => {
    // Arrange
    const statePath = path.join(makeTempDir(), 'sync-state.yml');
    const manager = new SyncStateManager(statePath);
    await manager.load();
    const changed: string[] = [];
    manager.onDidChange((fp) => changed.push(fp));

    // Act
    await manager.setSyncedAt('/issues/1.md', makeRemoteInfo());

    // Assert
    assert.deepStrictEqual(changed, ['/issues/1.md']);
  });

  test('listener is called with file path when deleteEntry is called', async () => {
    // Arrange
    const statePath = path.join(makeTempDir(), 'sync-state.yml');
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/1.md', makeRemoteInfo());
    const changed: string[] = [];
    manager.onDidChange((fp) => changed.push(fp));

    // Act
    await manager.deleteEntry('/issues/1.md');

    // Assert
    assert.deepStrictEqual(changed, ['/issues/1.md']);
  });

  test('unsubscribed listener is not called after unsubscribe', async () => {
    // Arrange
    const statePath = path.join(makeTempDir(), 'sync-state.yml');
    const manager = new SyncStateManager(statePath);
    await manager.load();
    const changed: string[] = [];
    const unsubscribe = manager.onDidChange((fp) => changed.push(fp));

    // Act
    unsubscribe();
    await manager.setSyncedAt('/issues/1.md', makeRemoteInfo());

    // Assert
    assert.deepStrictEqual(changed, []);
  });
});

// ---------------------------------------------------------------------------
// Section 7: dirty tracking – markDirty / clearDirty
// ---------------------------------------------------------------------------

suite('issueDecorationProvider – dirty tracking', () => {
  test('markDirty causes M badge before file is saved', async () => {
    // Arrange
    const dir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();
    const issueFile = path.join(dir, '1-issue.md');
    fs.writeFileSync(issueFile, '# Issue\n', 'utf8');
    await stateManager.setSyncedAt(issueFile, makeRemoteInfo());

    // Set mtime to the past so mtime check would say synchronized
    const past = new Date(Date.now() - 10000);
    fs.utimesSync(issueFile, past, past);

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: true, modified: true, synchronized: true });

    // Act — simulate user editing in the editor (file not yet saved)
    provider.markDirty(issueFile);
    const decoration = provider.provideFileDecoration(makeUri(issueFile) as any);

    // Assert
    assert.ok(decoration, 'should return a decoration');
    assert.strictEqual(decoration!.badge, 'M');
  });

  test('markDirty on a synchronized file overrides to M immediately', async () => {
    // Arrange
    const dir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();
    const issueFile = path.join(dir, '1-issue.md');
    fs.writeFileSync(issueFile, '# Issue\n', 'utf8');
    await stateManager.setSyncedAt(issueFile, makeRemoteInfo());

    const past = new Date(Date.now() - 10000);
    fs.utimesSync(issueFile, past, past);

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: true, modified: true, synchronized: true });

    // Confirm starts as synchronized
    const before = provider.provideFileDecoration(makeUri(issueFile) as any);
    assert.strictEqual(before!.badge, '✓');

    // Act
    provider.markDirty(issueFile);
    const after = provider.provideFileDecoration(makeUri(issueFile) as any);

    // Assert
    assert.strictEqual(after!.badge, 'M');
  });

  test('clearDirty reverts to synchronized when mtime check passes', async () => {
    // Arrange
    const dir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();
    const issueFile = path.join(dir, '1-issue.md');
    fs.writeFileSync(issueFile, '# Issue\n', 'utf8');
    await stateManager.setSyncedAt(issueFile, makeRemoteInfo());

    const past = new Date(Date.now() - 10000);
    fs.utimesSync(issueFile, past, past);

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: true, modified: true, synchronized: true });
    provider.markDirty(issueFile);

    // Act — simulate save + confirmed sync (extension writes file back)
    provider.clearDirty(issueFile);
    const decoration = provider.provideFileDecoration(makeUri(issueFile) as any);

    // Assert — mtime is old so falls through to synchronized
    assert.strictEqual(decoration!.badge, '✓');
  });

  test('markDirty is a no-op for files outside managed locations', () => {
    // Arrange
    const dir = makeTempDir();
    const otherDir = makeTempDir();
    const provider = new IssueDecorationProvider();
    provider.update([], { newIssue: true, modified: true, synchronized: true });
    const outsideFile = path.join(otherDir, '1-issue.md');

    // Act — should not throw, and should not affect anything
    provider.markDirty(outsideFile);
    const decoration = provider.provideFileDecoration(makeUri(outsideFile) as any);

    // Assert
    assert.strictEqual(decoration, undefined);
  });

  test('markDirty is idempotent — repeated calls do not change badge', async () => {
    // Arrange
    const dir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();
    const issueFile = path.join(dir, '1-issue.md');
    fs.writeFileSync(issueFile, '# Issue\n', 'utf8');
    await stateManager.setSyncedAt(issueFile, makeRemoteInfo());

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: true, modified: true, synchronized: true });

    // Act
    provider.markDirty(issueFile);
    provider.markDirty(issueFile);
    provider.markDirty(issueFile);
    const decoration = provider.provideFileDecoration(makeUri(issueFile) as any);

    // Assert
    assert.strictEqual(decoration!.badge, 'M');
  });

  test('clearDirty is a no-op when file was not dirty', async () => {
    // Arrange
    const dir = makeTempDir();
    const statePath = makeTempStatePath(dir);
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();
    const issueFile = path.join(dir, '1-issue.md');
    fs.writeFileSync(issueFile, '# Issue\n', 'utf8');
    await stateManager.setSyncedAt(issueFile, makeRemoteInfo());

    const past = new Date(Date.now() - 10000);
    fs.utimesSync(issueFile, past, past);

    const provider = new IssueDecorationProvider();
    provider.update([{ location: dir, stateManager }], { newIssue: true, modified: true, synchronized: true });

    // Act — clear without prior markDirty
    provider.clearDirty(issueFile);
    const decoration = provider.provideFileDecoration(makeUri(issueFile) as any);

    // Assert — still synchronized
    assert.strictEqual(decoration!.badge, '✓');
  });
});
