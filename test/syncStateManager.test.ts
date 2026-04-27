import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SyncStateManager, type RemoteIssueInfo } from '../src/syncStateManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-test-'));
  return path.join(dir, 'sync-state.json');
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

// ---------------------------------------------------------------------------
// Section 1: load – fresh and missing file
// ---------------------------------------------------------------------------

suite('syncStateManager – load', () => {
  test('starts with empty targets when no file exists', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);

    // Act
    await manager.load();

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues', 1), undefined);
  });

  test('loads previously saved state from disk', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues', 1, '/issues/1-test.md', makeRemoteInfo());

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(manager2.getSyncedAt('/issues', 1), '2024-01-15T10:00:00Z');
  });

  test('resets to empty targets when file contains legacy flat format (no version)', async () => {
    // Arrange
    const statePath = makeTempPath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ '1': '2024-01-01T00:00:00Z' }), 'utf8');
    const manager = new SyncStateManager(statePath);

    // Act
    await manager.load();

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues', 1), undefined);
  });

  test('resets to empty targets when file contains invalid JSON', async () => {
    // Arrange
    const statePath = makeTempPath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, 'not-json', 'utf8');
    const manager = new SyncStateManager(statePath);

    // Act
    await manager.load();

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues', 1), undefined);
  });
});

// ---------------------------------------------------------------------------
// Section 2: multiple sync targets
// ---------------------------------------------------------------------------

suite('syncStateManager – multiple sync targets', () => {
  test('stores entries independently per target key', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt('/issues/open', 1, '/issues/open/1-alpha.md', makeRemoteInfo({ updated_at: '2024-01-01T00:00:00Z' }));
    await manager.setSyncedAt('/issues/closed', 1, '/issues/closed/1-alpha.md', makeRemoteInfo({ updated_at: '2024-02-01T00:00:00Z' }));

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues/open', 1), '2024-01-01T00:00:00Z');
    assert.strictEqual(manager.getSyncedAt('/issues/closed', 1), '2024-02-01T00:00:00Z');
  });

  test('returns undefined for an issue number not in a given target', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/open', 1, '/issues/open/1-test.md', makeRemoteInfo());

    // Act
    const result = manager.getSyncedAt('/issues/closed', 1);

    // Assert
    assert.strictEqual(result, undefined);
  });

  test('returns undefined for a target key that has never been written', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    const result = manager.getSyncedAt('/never/written', 99);

    // Assert
    assert.strictEqual(result, undefined);
  });

  test('persists multiple targets to disk', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/open', 5, '/issues/open/5-one.md', makeRemoteInfo({ number: 5 }));
    await manager.setSyncedAt('/issues/closed', 7, '/issues/closed/7-two.md', makeRemoteInfo({ number: 7 }));

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(manager2.getSyncedAt('/issues/open', 5), '2024-01-15T10:00:00Z');
    assert.strictEqual(manager2.getSyncedAt('/issues/closed', 7), '2024-01-15T10:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// Section 3: remote read-only details
// ---------------------------------------------------------------------------

suite('syncStateManager – remote read-only details', () => {
  test('persists all RemoteIssueInfo fields to disk', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    const remote = makeRemoteInfo({
      number: 42,
      state: 'closed',
      updated_at: '2024-03-10T08:30:00Z',
      closed_at: '2024-03-10T08:00:00Z',
      html_url: 'https://github.com/owner/repo/issues/42',
    });

    // Act
    await manager.setSyncedAt('/issues', 42, '/issues/42-fix.md', remote);

    // Assert – reload and verify
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const entry = raw.targets['/issues']['42'];
    assert.strictEqual(entry.remote.number, 42);
    assert.strictEqual(entry.remote.state, 'closed');
    assert.strictEqual(entry.remote.updated_at, '2024-03-10T08:30:00Z');
    assert.strictEqual(entry.remote.closed_at, '2024-03-10T08:00:00Z');
    assert.strictEqual(entry.remote.html_url, 'https://github.com/owner/repo/issues/42');
  });

  test('stores null closed_at for open issues', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    const remote = makeRemoteInfo({ state: 'open', closed_at: null });

    // Act
    await manager.setSyncedAt('/issues', 1, '/issues/1-open.md', remote);

    // Assert
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(raw.targets['/issues']['1'].remote.closed_at, null);
  });
});

// ---------------------------------------------------------------------------
// Section 4: file_path – local issue file path
// ---------------------------------------------------------------------------

suite('syncStateManager – file_path for local issue file', () => {
  test('persists the file path to disk', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt('/issues', 10, '/workspace/.issues/10-my-issue.md', makeRemoteInfo({ number: 10 }));

    // Assert
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(raw.targets['/issues']['10'].file_path, '/workspace/.issues/10-my-issue.md');
  });

  test('file_path is preserved across a load cycle', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues', 3, '/workspace/.issues/3-open.md', makeRemoteInfo({ number: 3 }));

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert – file_path is not directly exposed via getSyncedAt, so check raw JSON
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(raw.targets['/issues']['3'].file_path, '/workspace/.issues/3-open.md');
  });

  test('updating an issue entry replaces the old file_path', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues', 5, '/issues/5-old-title.md', makeRemoteInfo({ number: 5 }));

    // Act
    await manager.setSyncedAt('/issues', 5, '/issues/5-new-title.md', makeRemoteInfo({ number: 5, updated_at: '2024-06-01T00:00:00Z' }));

    // Assert
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(raw.targets['/issues']['5'].file_path, '/issues/5-new-title.md');
  });
});

// ---------------------------------------------------------------------------
// Section 5: JSON file structure
// ---------------------------------------------------------------------------

suite('syncStateManager – JSON file structure', () => {
  test('written file includes version field set to 1', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt('/issues', 1, '/issues/1-test.md', makeRemoteInfo());

    // Assert
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(raw.version, 1);
  });

  test('written file has a top-level "targets" object', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt('/issues', 1, '/issues/1-test.md', makeRemoteInfo());

    // Assert
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(typeof raw.targets === 'object' && raw.targets !== null);
  });

  test('synced_at equals the remote updated_at timestamp', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    const remote = makeRemoteInfo({ updated_at: '2025-11-30T12:00:00Z' });

    // Act
    await manager.setSyncedAt('/issues', 1, '/issues/1-test.md', remote);

    // Assert
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(raw.targets['/issues']['1'].synced_at, '2025-11-30T12:00:00Z');
  });

  test('creates parent directories for the state file if they do not exist', async () => {
    // Arrange
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-mkdir-'));
    const statePath = path.join(base, 'deeply', 'nested', 'sync-state.json');
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt('/issues', 1, '/issues/1-test.md', makeRemoteInfo());

    // Assert
    assert.ok(fs.existsSync(statePath));
  });
});

// ---------------------------------------------------------------------------
// Section 6: watchForDeletion – recreate file when deleted
// ---------------------------------------------------------------------------

suite('syncStateManager – watchForDeletion', () => {
  test('recreates the file when it is deleted', (done) => {
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);

    // Arrange
    manager
      .load()
      .then(() => {
        return manager.setSyncedAt('/issues', 1, '/issues/1.md', makeRemoteInfo());
      })
      .then(() => {
        manager.watchForDeletion(50);
        fs.unlinkSync(statePath);

        // Assert – watcher should recreate the file within the poll interval
        setTimeout(() => {
          manager.dispose();
          try {
            assert.ok(fs.existsSync(statePath), 'file should be recreated after deletion');
            done();
          } catch (e) {
            done(e);
          }
        }, 300);
      })
      .catch(done);
  });

  test('recreated file preserves in-memory state', (done) => {
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);

    // Arrange
    manager
      .load()
      .then(() => {
        return manager.setSyncedAt('/issues', 7, '/issues/7-preserved.md', makeRemoteInfo({ number: 7, updated_at: '2024-05-01T00:00:00Z' }));
      })
      .then(() => {
        manager.watchForDeletion(50);
        fs.unlinkSync(statePath);

        // Assert – recreated file should contain the in-memory state
        setTimeout(() => {
          manager.dispose();
          try {
            const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            assert.strictEqual(raw.targets['/issues']['7'].synced_at, '2024-05-01T00:00:00Z');
            done();
          } catch (e) {
            done(e);
          }
        }, 300);
      })
      .catch(done);
  });

  test('dispose stops the watcher', (done) => {
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);

    // Arrange
    manager
      .load()
      .then(() => {
        return manager.setSyncedAt('/issues', 1, '/issues/1.md', makeRemoteInfo());
      })
      .then(() => {
        manager.watchForDeletion(50);
        manager.dispose();
        fs.unlinkSync(statePath);

        // Assert – file should NOT be recreated because watcher was disposed
        setTimeout(() => {
          try {
            assert.ok(!fs.existsSync(statePath), 'file should not be recreated after dispose');
            done();
          } catch (e) {
            done(e);
          }
        }, 300);
      })
      .catch(done);
  });
});
