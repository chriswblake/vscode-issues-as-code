import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import {
  SyncStateManager,
  type RemoteIssueInfo,
} from "../src/syncStateManager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-state-test-"));
  return path.join(dir, "sync-state.yml");
}

function makeRemoteInfo(
  overrides: Partial<RemoteIssueInfo> = {},
): RemoteIssueInfo {
  return {
    number: 1,
    state: "open",
    updated_at: "2024-01-15T10:00:00Z",
    closed_at: null,
    html_url: "https://github.com/owner/repo/issues/1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Section 1: load – fresh and missing file
// ---------------------------------------------------------------------------

suite("syncStateManager – load", () => {
  test("starts empty when no file exists", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);

    // Act
    await manager.load();

    // Assert
    assert.strictEqual(manager.getSyncedAt("/issues/1-test.md"), undefined);
  });

  test("loads previously saved state from disk", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/1-test.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(
      manager2.getSyncedAt("/issues/1-test.md"),
      "2024-01-15T10:00:00Z",
    );
  });

  test("resets to empty when file contains invalid YAML", async () => {
    // Arrange
    const statePath = makeTempPath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{ bad yaml: [", "utf8");
    const manager = new SyncStateManager(statePath);

    // Act
    await manager.load();

    // Assert
    assert.strictEqual(manager.getSyncedAt("/issues/1-test.md"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Section 2: getSyncedAt / setSyncedAt
// ---------------------------------------------------------------------------

suite("syncStateManager – getSyncedAt / setSyncedAt", () => {
  test("returns undefined for a file path that has never been written", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    const result = manager.getSyncedAt("/issues/open/99-never.md");

    // Assert
    assert.strictEqual(result, undefined);
  });

  test("returns synced_at after writing an entry", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt(
      "/issues/open/1-a.md",
      makeRemoteInfo({ updated_at: "2024-03-01T00:00:00Z" }),
      "gh-issues",
      "owner/repo/1",
    );

    // Assert
    assert.strictEqual(
      manager.getSyncedAt("/issues/open/1-a.md"),
      "2024-03-01T00:00:00Z",
    );
  });

  test("two files under different locations are stored independently", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt(
      "/issues/open/1-a.md",
      makeRemoteInfo({ updated_at: "2024-01-01T00:00:00Z" }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/closed/1-a.md",
      makeRemoteInfo({ updated_at: "2024-02-01T00:00:00Z" }),
      "gh-issues",
      "owner/repo/1",
    );

    // Assert
    assert.strictEqual(
      manager.getSyncedAt("/issues/open/1-a.md"),
      "2024-01-01T00:00:00Z",
    );
    assert.strictEqual(
      manager.getSyncedAt("/issues/closed/1-a.md"),
      "2024-02-01T00:00:00Z",
    );
  });

  test("persists entries across a load cycle", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/5-one.md",
      makeRemoteInfo({ number: 5 }),
      "gh-issues",
      "owner/repo/5",
    );
    await manager.setSyncedAt(
      "/issues/closed/7-two.md",
      makeRemoteInfo({ number: 7 }),
      "gh-issues",
      "owner/repo/7",
    );

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(
      manager2.getSyncedAt("/issues/open/5-one.md"),
      "2024-01-15T10:00:00Z",
    );
    assert.strictEqual(
      manager2.getSyncedAt("/issues/closed/7-two.md"),
      "2024-01-15T10:00:00Z",
    );
  });

  test("overwriting an entry updates synced_at", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/1-a.md",
      makeRemoteInfo({ updated_at: "2024-01-01T00:00:00Z" }),
      "gh-issues",
      "owner/repo/1",
    );

    // Act
    await manager.setSyncedAt(
      "/issues/1-a.md",
      makeRemoteInfo({ updated_at: "2024-06-01T00:00:00Z" }),
      "gh-issues",
      "owner/repo/1",
    );

    // Assert
    assert.strictEqual(
      manager.getSyncedAt("/issues/1-a.md"),
      "2024-06-01T00:00:00Z",
    );
  });
});

// ---------------------------------------------------------------------------
// Section 3: YAML file structure
// ---------------------------------------------------------------------------

suite("syncStateManager – YAML file structure", () => {
  test("written file is valid YAML", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt(
      "/issues/1-test.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );

    // Assert
    const raw = fs.readFileSync(statePath, "utf8");
    assert.doesNotThrow(() => yaml.load(raw));
  });

  test('written file has a top-level "files" key', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt(
      "/issues/1-test.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );

    // Assert
    const parsed = yaml.load(fs.readFileSync(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.ok(typeof parsed["files"] === "object" && parsed["files"] !== null);
    assert.ok(
      !("version" in parsed),
      '"version" key must not appear in new format',
    );
    assert.ok(
      !("targets" in parsed),
      '"targets" key must not appear in new format',
    );
  });

  test('written file has a top-level "pluginData.gh-issues" key with the issue record', async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    const remote = makeRemoteInfo({
      number: 42,
      html_url: "https://github.com/owner/repo/issues/42",
    });

    // Act
    await manager.setSyncedAt(
      "/issues/42-fix.md",
      remote,
      "gh-issues",
      "owner/repo/42",
    );

    // Assert
    const parsed = yaml.load(fs.readFileSync(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    const pluginData = parsed["pluginData"] as Record<string, unknown>;
    assert.ok(
      typeof pluginData === "object" && pluginData !== null,
      "pluginData section should exist",
    );
    const ghIssues = pluginData["gh-issues"] as Record<string, unknown>;
    assert.ok(
      typeof ghIssues === "object" && ghIssues !== null,
      "gh-issues section should exist",
    );
    const record = ghIssues["owner/repo/42"] as Record<string, unknown>;
    assert.ok(record, "issue record keyed by owner/repo/number should exist");
    assert.strictEqual(record["number"], 42);
  });

  test("files section links back to gh-issues key and stores synced_at", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    const remote = makeRemoteInfo({
      number: 7,
      updated_at: "2025-11-30T12:00:00Z",
      html_url: "https://github.com/owner/repo/issues/7",
    });

    // Act
    await manager.setSyncedAt(
      "/issues/7-test.md",
      remote,
      "gh-issues",
      "owner/repo/7",
    );

    // Assert
    const parsed = yaml.load(fs.readFileSync(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    const files = parsed["files"] as Record<string, unknown>;
    const fileEntry = files["/issues/7-test.md"] as Record<string, unknown>;
    const plugins = fileEntry["plugins"] as Record<string, unknown>;
    const ghRef = plugins["gh-issues"] as Record<string, unknown>;
    assert.strictEqual(ghRef["key"], "owner/repo/7");
    assert.strictEqual(ghRef["synced_at"], "2025-11-30T12:00:00Z");
  });

  test("persists gh-issues record details (state, closed_at, html_url)", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    const remote = makeRemoteInfo({
      number: 42,
      state: "closed",
      updated_at: "2024-03-10T08:30:00Z",
      closed_at: "2024-03-10T08:00:00Z",
      html_url: "https://github.com/owner/repo/issues/42",
    });

    // Act
    await manager.setSyncedAt(
      "/issues/42-fix.md",
      remote,
      "gh-issues",
      "owner/repo/42",
    );

    // Assert
    const parsed = yaml.load(fs.readFileSync(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    const pluginData = parsed["pluginData"] as Record<string, unknown>;
    const ghIssues = pluginData["gh-issues"] as Record<
      string,
      Record<string, unknown>
    >;
    const record = ghIssues["owner/repo/42"];
    assert.strictEqual(record["state"], "closed");
    assert.strictEqual(record["updated_at"], "2024-03-10T08:30:00Z");
    assert.strictEqual(record["closed_at"], "2024-03-10T08:00:00Z");
    assert.strictEqual(
      record["html_url"],
      "https://github.com/owner/repo/issues/42",
    );
  });

  test("creates parent directories for the state file if they do not exist", async () => {
    // Arrange
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sync-state-mkdir-"));
    const statePath = path.join(base, "deeply", "nested", "sync-state.yml");
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    await manager.setSyncedAt(
      "/issues/1-test.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );

    // Assert
    assert.ok(fs.existsSync(statePath));
  });
});

// ---------------------------------------------------------------------------
// Section 4: deleteEntry
// ---------------------------------------------------------------------------

suite("syncStateManager – deleteEntry", () => {
  test("removes the entry for the given file path", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/1-a.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );

    // Act
    await manager.deleteEntry("/issues/1-a.md");

    // Assert
    assert.strictEqual(manager.getSyncedAt("/issues/1-a.md"), undefined);
  });

  test("persists the deletion to disk", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/1-a.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.deleteEntry("/issues/1-a.md");

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(manager2.getSyncedAt("/issues/1-a.md"), undefined);
  });

  test("does not affect other entries", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/1-a.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/2-b.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    // Act
    await manager.deleteEntry("/issues/1-a.md");

    // Assert
    assert.strictEqual(
      manager.getSyncedAt("/issues/2-b.md"),
      "2024-01-15T10:00:00Z",
    );
  });

  test("is a no-op for a file path that does not exist", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/1-a.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );

    // Act – should not throw
    await manager.deleteEntry("/issues/never-existed.md");

    // Assert – existing entry unaffected
    assert.strictEqual(
      manager.getSyncedAt("/issues/1-a.md"),
      "2024-01-15T10:00:00Z",
    );
  });
});

// ---------------------------------------------------------------------------
// Section 5: getFilesUnderLocation
// ---------------------------------------------------------------------------

suite("syncStateManager – getFilesUnderLocation", () => {
  test("returns an empty map for a location with no entries", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    const entries = manager.getFilesUnderLocation("/issues/open");

    // Assert
    assert.strictEqual(entries.size, 0);
  });

  test("returns all entries whose path is under the given location", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/open/2-b.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    // Act
    const entries = manager.getFilesUnderLocation("/issues/open");

    // Assert
    assert.strictEqual(entries.size, 2);
    assert.ok(entries.has("/issues/open/1-a.md"));
    assert.ok(entries.has("/issues/open/2-b.md"));
  });

  test("does not return entries from a sibling location", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/closed/2-b.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    // Act
    const entries = manager.getFilesUnderLocation("/issues/open");

    // Assert
    assert.strictEqual(entries.size, 1);
    assert.ok(entries.has("/issues/open/1-a.md"));
    assert.ok(!entries.has("/issues/closed/2-b.md"));
  });

  test("does not match a location that is only a string prefix of the directory name", async () => {
    // Arrange – '/issues/open2/...' should NOT match getFilesUnderLocation('/issues/open')
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open2/1-a.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );

    // Act
    const entries = manager.getFilesUnderLocation("/issues/open");

    // Assert
    assert.strictEqual(entries.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Section 6: removeFilesUnderLocation
// ---------------------------------------------------------------------------

suite("syncStateManager – removeFilesUnderLocation", () => {
  test("removes all entries under the given location", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/open/2-b.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    // Act
    await manager.removeFilesUnderLocation("/issues/open");

    // Assert
    assert.strictEqual(manager.getSyncedAt("/issues/open/1-a.md"), undefined);
    assert.strictEqual(manager.getSyncedAt("/issues/open/2-b.md"), undefined);
    assert.strictEqual(manager.getFilesUnderLocation("/issues/open").size, 0);
  });

  test("persists removal to disk", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.removeFilesUnderLocation("/issues/open");

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(manager2.getSyncedAt("/issues/open/1-a.md"), undefined);
  });

  test("does not affect entries under other locations", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/closed/2-b.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    // Act
    await manager.removeFilesUnderLocation("/issues/open");

    // Assert
    assert.strictEqual(
      manager.getSyncedAt("/issues/closed/2-b.md"),
      "2024-01-15T10:00:00Z",
    );
  });

  test("is a no-op for a location that has no entries", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );

    // Act – should not throw
    await manager.removeFilesUnderLocation("/issues/never-existed");

    // Assert – existing data unaffected
    assert.strictEqual(
      manager.getSyncedAt("/issues/open/1-a.md"),
      "2024-01-15T10:00:00Z",
    );
  });
});

// ---------------------------------------------------------------------------
// Section 7: getKnownFilePaths
// ---------------------------------------------------------------------------

suite("syncStateManager – getKnownFilePaths", () => {
  test("returns empty array when no entries written", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();

    // Act
    const paths = manager.getKnownFilePaths();

    // Assert
    assert.deepStrictEqual([...paths], []);
  });

  test("returns all written file paths", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/closed/2-b.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    // Act
    const paths = manager.getKnownFilePaths();

    // Assert
    assert.strictEqual(paths.length, 2);
    assert.ok(paths.includes("/issues/open/1-a.md"));
    assert.ok(paths.includes("/issues/closed/2-b.md"));
  });

  test("does not include deleted entries", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/closed/2-b.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );
    await manager.deleteEntry("/issues/closed/2-b.md");

    // Act
    const paths = manager.getKnownFilePaths();

    // Assert
    assert.deepStrictEqual([...paths], ["/issues/open/1-a.md"]);
  });
});

// ---------------------------------------------------------------------------
// Section 8: watchForDeletion – recreate file when deleted
// ---------------------------------------------------------------------------

suite("syncStateManager – watchForDeletion", () => {
  test("recreates the file when it is deleted", (done) => {
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);

    // Arrange
    manager
      .load()
      .then(() =>
        manager.setSyncedAt(
          "/issues/1.md",
          makeRemoteInfo(),
          "gh-issues",
          "owner/repo/1",
        ),
      )
      .then(() => {
        manager.watchForDeletion(50);
        fs.unlinkSync(statePath);

        // Assert – watcher should recreate the file within the poll interval
        setTimeout(() => {
          manager.dispose();
          try {
            assert.ok(
              fs.existsSync(statePath),
              "file should be recreated after deletion",
            );
            done();
          } catch (e) {
            done(e);
          }
        }, 300);
      })
      .catch(done);
  });

  test("recreated file preserves in-memory state", (done) => {
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);

    manager
      .load()
      .then(() =>
        manager.setSyncedAt(
          "/issues/1.md",
          makeRemoteInfo({ updated_at: "2025-01-01T00:00:00Z" }),
          "gh-issues",
          "owner/repo/1",
        ),
      )
      .then(() => {
        manager.watchForDeletion(50);
        fs.unlinkSync(statePath);

        setTimeout(() => {
          manager.dispose();
          try {
            assert.ok(fs.existsSync(statePath), "file should be recreated");
            const parsed = yaml.load(
              fs.readFileSync(statePath, "utf8"),
            ) as Record<string, unknown>;
            const files = parsed["files"] as Record<string, unknown>;
            assert.ok(
              files["/issues/1.md"],
              "state should be preserved in recreated file",
            );
            done();
          } catch (e) {
            done(e);
          }
        }, 300);
      })
      .catch(done);
  });
});
