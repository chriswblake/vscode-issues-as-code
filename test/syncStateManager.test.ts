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
  test('starts empty when no file exists', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);

    // Act
    await manager.load();

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues/1-test.md'), undefined);
  });

  test('loads previously saved state from disk', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/1-test.md', makeRemoteInfo());

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(manager2.getSyncedAt('/issues/1-test.md'), '2024-01-15T10:00:00Z');
  });

  test('resets to empty when file contains legacy flat format (no version)', async () => {
    // Arrange
    const statePath = makeTempPath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ '1': '2024-01-01T00:00:00Z' }), 'utf8');
    const manager = new SyncStateManager(statePath);

    // Act
    await manager.load();

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues/1-test.md'), undefined);
  });

  test('resets to empty when file contains invalid JSON', async () => {
    // Arrange
    const statePath = makeTempPath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, 'not-json', 'utf8');
    const manager = new SyncStateManager(statePath);

    // Act
    await manager.load();

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues/1-test.md'), undefined);
  });

  test('migrates v1 format (targets nested by location) to v2 (flat by file path)', async () => {
    // Arrange
    const statePath = makeTempPath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const v1State = {
      version: 1,
      targets: {
        '/issues/open': {
          '5': { synced_at: '2024-06-01T00:00:00Z', file_path: '/issues/open/5-thing.md', remote: makeRemoteInfo({ number: 5, updated_at: '2024-06-01T00:00:00Z' }) },
        },
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(v1State), 'utf8');
    const manager = new SyncStateManager(statePath);

    // Act
    await manager.load();

    // Assert – accessible via new file-path key
    assert.strictEqual(manager.getSyncedAt('/issues/open/5-thing.md'), '2024-06-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// Section 2: getSyncedAt / setSyncedAt
// ---------------------------------------------------------------------------

suite('syncStateManager – getSyncedAt / setSyncedAt', () => {
  test('returns undefined for a file path that has never been written', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    const result = manager.getSyncedAt('/issues/open/99-never.md');

    // Assert
    assert.strictEqual(result, undefined);
  });

  test('returns synced_at after writing an entry', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt('/issues/open/1-a.md', makeRemoteInfo({ updated_at: '2024-03-01T00:00:00Z' }));

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues/open/1-a.md'), '2024-03-01T00:00:00Z');
  });

  test('two files under different locations are stored independently', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt('/issues/open/1-a.md', makeRemoteInfo({ updated_at: '2024-01-01T00:00:00Z' }));
    await manager.setSyncedAt('/issues/closed/1-a.md', makeRemoteInfo({ updated_at: '2024-02-01T00:00:00Z' }));

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues/open/1-a.md'), '2024-01-01T00:00:00Z');
    assert.strictEqual(manager.getSyncedAt('/issues/closed/1-a.md'), '2024-02-01T00:00:00Z');
  });

  test('persists entries across a load cycle', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/open/5-one.md', makeRemoteInfo({ number: 5 }));
    await manager.setSyncedAt('/issues/closed/7-two.md', makeRemoteInfo({ number: 7 }));

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(manager2.getSyncedAt('/issues/open/5-one.md'), '2024-01-15T10:00:00Z');
    assert.strictEqual(manager2.getSyncedAt('/issues/closed/7-two.md'), '2024-01-15T10:00:00Z');
  });

  test('overwriting an entry updates synced_at', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/1-a.md', makeRemoteInfo({ updated_at: '2024-01-01T00:00:00Z' }));

    // Act
    await manager.setSyncedAt('/issues/1-a.md', makeRemoteInfo({ updated_at: '2024-06-01T00:00:00Z' }));

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues/1-a.md'), '2024-06-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// Section 3: remote read-only details
// ---------------------------------------------------------------------------

suite('syncStateManager – remote details', () => {
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
    await manager.setSyncedAt('/issues/42-fix.md', remote);

    // Assert
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const entry = raw.files['/issues/42-fix.md'];
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
    await manager.setSyncedAt('/issues/1-open.md', remote);

    // Assert
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(raw.files['/issues/1-open.md'].remote.closed_at, null);
  });

  test('no file_path field stored inside entry', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt('/issues/1-test.md', makeRemoteInfo());

    // Assert – file_path should NOT appear inside the entry (it is the key)
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(!('file_path' in raw.files['/issues/1-test.md']), 'file_path must not be a field inside the entry');
  });
});

// ---------------------------------------------------------------------------
// Section 4: JSON file structure
// ---------------------------------------------------------------------------

suite('syncStateManager – JSON file structure', () => {
  test('written file includes version field set to 2', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt('/issues/1-test.md', makeRemoteInfo());

    // Assert
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(raw.version, 2);
  });

  test('written file has a top-level "files" object (not "targets")', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt('/issues/1-test.md', makeRemoteInfo());

    // Assert
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(typeof raw.files === 'object' && raw.files !== null);
    assert.ok(!('targets' in raw), '"targets" key must not appear in v2 file');
  });

  test('synced_at equals the remote updated_at timestamp', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    const remote = makeRemoteInfo({ updated_at: '2025-11-30T12:00:00Z' });

    // Act
    await manager.setSyncedAt('/issues/1-test.md', remote);

    // Assert
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(raw.files['/issues/1-test.md'].synced_at, '2025-11-30T12:00:00Z');
  });

  test('creates parent directories for the state file if they do not exist', async () => {
    // Arrange
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-mkdir-'));
    const statePath = path.join(base, 'deeply', 'nested', 'sync-state.json');
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt('/issues/1-test.md', makeRemoteInfo());

    // Assert
    assert.ok(fs.existsSync(statePath));
  });
});

// ---------------------------------------------------------------------------
// Section 5: deleteEntry
// ---------------------------------------------------------------------------

suite('syncStateManager – deleteEntry', () => {
  test('removes the entry for the given file path', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/1-a.md', makeRemoteInfo());

    // Act
    await manager.deleteEntry('/issues/1-a.md');

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues/1-a.md'), undefined);
  });

  test('persists the deletion to disk', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/1-a.md', makeRemoteInfo());
    await manager.deleteEntry('/issues/1-a.md');

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(manager2.getSyncedAt('/issues/1-a.md'), undefined);
  });

  test('does not affect other entries', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/1-a.md', makeRemoteInfo({ number: 1 }));
    await manager.setSyncedAt('/issues/2-b.md', makeRemoteInfo({ number: 2 }));

    // Act
    await manager.deleteEntry('/issues/1-a.md');

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues/2-b.md'), '2024-01-15T10:00:00Z');
  });

  test('is a no-op for a file path that does not exist', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/1-a.md', makeRemoteInfo());

    // Act – should not throw
    await manager.deleteEntry('/issues/never-existed.md');

    // Assert – existing entry unaffected
    assert.strictEqual(manager.getSyncedAt('/issues/1-a.md'), '2024-01-15T10:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// Section 6: getFilesUnderLocation
// ---------------------------------------------------------------------------

suite('syncStateManager – getFilesUnderLocation', () => {
  test('returns an empty map for a location with no entries', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    const entries = manager.getFilesUnderLocation('/issues/open');

    // Assert
    assert.strictEqual(entries.size, 0);
  });

  test('returns all entries whose path is under the given location', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/open/1-a.md', makeRemoteInfo({ number: 1 }));
    await manager.setSyncedAt('/issues/open/2-b.md', makeRemoteInfo({ number: 2 }));

    // Act
    const entries = manager.getFilesUnderLocation('/issues/open');

    // Assert
    assert.strictEqual(entries.size, 2);
    assert.ok(entries.has('/issues/open/1-a.md'));
    assert.ok(entries.has('/issues/open/2-b.md'));
  });

  test('does not return entries from a sibling location', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/open/1-a.md', makeRemoteInfo({ number: 1 }));
    await manager.setSyncedAt('/issues/closed/2-b.md', makeRemoteInfo({ number: 2 }));

    // Act
    const entries = manager.getFilesUnderLocation('/issues/open');

    // Assert
    assert.strictEqual(entries.size, 1);
    assert.ok(entries.has('/issues/open/1-a.md'));
    assert.ok(!entries.has('/issues/closed/2-b.md'));
  });

  test('does not match a location that is only a string prefix of the directory name', async () => {
    // Arrange – '/issues/open2/...' should NOT match getFilesUnderLocation('/issues/open')
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/open2/1-a.md', makeRemoteInfo({ number: 1 }));

    // Act
    const entries = manager.getFilesUnderLocation('/issues/open');

    // Assert
    assert.strictEqual(entries.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Section 7: removeFilesUnderLocation
// ---------------------------------------------------------------------------

suite('syncStateManager – removeFilesUnderLocation', () => {
  test('removes all entries under the given location', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/open/1-a.md', makeRemoteInfo({ number: 1 }));
    await manager.setSyncedAt('/issues/open/2-b.md', makeRemoteInfo({ number: 2 }));

    // Act
    await manager.removeFilesUnderLocation('/issues/open');

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues/open/1-a.md'), undefined);
    assert.strictEqual(manager.getSyncedAt('/issues/open/2-b.md'), undefined);
    assert.strictEqual(manager.getFilesUnderLocation('/issues/open').size, 0);
  });

  test('persists removal to disk', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/open/1-a.md', makeRemoteInfo());
    await manager.removeFilesUnderLocation('/issues/open');

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(manager2.getSyncedAt('/issues/open/1-a.md'), undefined);
  });

  test('does not affect entries under other locations', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/open/1-a.md', makeRemoteInfo({ number: 1 }));
    await manager.setSyncedAt('/issues/closed/2-b.md', makeRemoteInfo({ number: 2 }));

    // Act
    await manager.removeFilesUnderLocation('/issues/open');

    // Assert
    assert.strictEqual(manager.getSyncedAt('/issues/closed/2-b.md'), '2024-01-15T10:00:00Z');
  });

  test('is a no-op for a location that has no entries', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/open/1-a.md', makeRemoteInfo());

    // Act – should not throw
    await manager.removeFilesUnderLocation('/issues/never-existed');

    // Assert – existing data unaffected
    assert.strictEqual(manager.getSyncedAt('/issues/open/1-a.md'), '2024-01-15T10:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// Section 8: getKnownFilePaths
// ---------------------------------------------------------------------------

suite('syncStateManager – getKnownFilePaths', () => {
  test('returns empty array when no entries written', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    const paths = manager.getKnownFilePaths();

    // Assert
    assert.deepStrictEqual([...paths], []);
  });

  test('returns all written file paths', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/open/1-a.md', makeRemoteInfo({ number: 1 }));
    await manager.setSyncedAt('/issues/closed/2-b.md', makeRemoteInfo({ number: 2 }));

    // Act
    const paths = manager.getKnownFilePaths();

    // Assert
    assert.strictEqual(paths.length, 2);
    assert.ok(paths.includes('/issues/open/1-a.md'));
    assert.ok(paths.includes('/issues/closed/2-b.md'));
  });

  test('does not include deleted entries', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt('/issues/open/1-a.md', makeRemoteInfo());
    await manager.setSyncedAt('/issues/closed/2-b.md', makeRemoteInfo({ number: 2 }));
    await manager.deleteEntry('/issues/closed/2-b.md');

    // Act
    const paths = manager.getKnownFilePaths();

    // Assert
    assert.deepStrictEqual([...paths], ['/issues/open/1-a.md']);
  });
});

// ---------------------------------------------------------------------------
// Section 9: watchForDeletion – recreate file when deleted
// ---------------------------------------------------------------------------

suite('syncStateManager – watchForDeletion', () => {
  test('recreates the file when it is deleted', (done) => {
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);

    // Arrange
    manager
      .load()
      .then(() => manager.setSyncedAt('/issues/1.md', makeRemoteInfo()))
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
      .then(() => manager.setSyncedAt('/issues/7-preserved.md', makeRemoteInfo({ number: 7, updated_at: '2024-05-01T00:00:00Z' })))
      .then(() => {
        manager.watchForDeletion(50);
        fs.unlinkSync(statePath);

        // Assert – recreated file should contain the in-memory state
        setTimeout(() => {
          manager.dispose();
          try {
            const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            assert.strictEqual(raw.files['/issues/7-preserved.md'].synced_at, '2024-05-01T00:00:00Z');
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
      .then(() => manager.setSyncedAt('/issues/1.md', makeRemoteInfo()))
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
