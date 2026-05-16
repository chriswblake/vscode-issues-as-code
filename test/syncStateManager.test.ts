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
    assert.strictEqual(
      manager.getSyncedAt("/issues/1-test.task.md"),
      undefined,
    );
  });

  test("loads previously saved state from disk", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/1-test.task.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(
      manager2.getSyncedAt("/issues/1-test.task.md"),
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
    assert.strictEqual(
      manager.getSyncedAt("/issues/1-test.task.md"),
      undefined,
    );
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
    const result = manager.getSyncedAt("/issues/open/99-never.task.md");

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
      "/issues/open/1-a.task.md",
      makeRemoteInfo({ updated_at: "2024-03-01T00:00:00Z" }),
      "gh-issues",
      "owner/repo/1",
    );

    // Assert
    assert.strictEqual(
      manager.getSyncedAt("/issues/open/1-a.task.md"),
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
      "/issues/open/1-a.task.md",
      makeRemoteInfo({ updated_at: "2024-01-01T00:00:00Z" }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/closed/1-a.task.md",
      makeRemoteInfo({ updated_at: "2024-02-01T00:00:00Z" }),
      "gh-issues",
      "owner/repo/1",
    );

    // Assert
    assert.strictEqual(
      manager.getSyncedAt("/issues/open/1-a.task.md"),
      "2024-01-01T00:00:00Z",
    );
    assert.strictEqual(
      manager.getSyncedAt("/issues/closed/1-a.task.md"),
      "2024-02-01T00:00:00Z",
    );
  });

  test("persists entries across a load cycle", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/5-one.task.md",
      makeRemoteInfo({ number: 5 }),
      "gh-issues",
      "owner/repo/5",
    );
    await manager.setSyncedAt(
      "/issues/closed/7-two.task.md",
      makeRemoteInfo({ number: 7 }),
      "gh-issues",
      "owner/repo/7",
    );

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(
      manager2.getSyncedAt("/issues/open/5-one.task.md"),
      "2024-01-15T10:00:00Z",
    );
    assert.strictEqual(
      manager2.getSyncedAt("/issues/closed/7-two.task.md"),
      "2024-01-15T10:00:00Z",
    );
  });

  test("overwriting an entry updates synced_at", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/1-a.task.md",
      makeRemoteInfo({ updated_at: "2024-01-01T00:00:00Z" }),
      "gh-issues",
      "owner/repo/1",
    );

    // Act
    await manager.setSyncedAt(
      "/issues/1-a.task.md",
      makeRemoteInfo({ updated_at: "2024-06-01T00:00:00Z" }),
      "gh-issues",
      "owner/repo/1",
    );

    // Assert
    assert.strictEqual(
      manager.getSyncedAt("/issues/1-a.task.md"),
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
      "/issues/1-test.task.md",
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
      "/issues/1-test.task.md",
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
      "/issues/42-fix.task.md",
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
      "/issues/7-test.task.md",
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
    const fileEntry = files["/issues/7-test.task.md"] as Record<
      string,
      unknown
    >;
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
      "/issues/42-fix.task.md",
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
      "/issues/1-test.task.md",
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
      "/issues/1-a.task.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );

    // Act
    await manager.deleteEntry("/issues/1-a.task.md");

    // Assert
    assert.strictEqual(manager.getSyncedAt("/issues/1-a.task.md"), undefined);
  });

  test("persists the deletion to disk", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/1-a.task.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.deleteEntry("/issues/1-a.task.md");

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(manager2.getSyncedAt("/issues/1-a.task.md"), undefined);
  });

  test("does not affect other entries", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/1-a.task.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/2-b.task.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    // Act
    await manager.deleteEntry("/issues/1-a.task.md");

    // Assert
    assert.strictEqual(
      manager.getSyncedAt("/issues/2-b.task.md"),
      "2024-01-15T10:00:00Z",
    );
  });

  test("is a no-op for a file path that does not exist", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/1-a.task.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );

    // Act – should not throw
    await manager.deleteEntry("/issues/never-existed.task.md");

    // Assert – existing entry unaffected
    assert.strictEqual(
      manager.getSyncedAt("/issues/1-a.task.md"),
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
      "/issues/open/1-a.task.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/open/2-b.task.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    // Act
    const entries = manager.getFilesUnderLocation("/issues/open");

    // Assert
    assert.strictEqual(entries.size, 2);
    assert.ok(entries.has("/issues/open/1-a.task.md"));
    assert.ok(entries.has("/issues/open/2-b.task.md"));
  });

  test("does not return entries from a sibling location", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.task.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/closed/2-b.task.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    // Act
    const entries = manager.getFilesUnderLocation("/issues/open");

    // Assert
    assert.strictEqual(entries.size, 1);
    assert.ok(entries.has("/issues/open/1-a.task.md"));
    assert.ok(!entries.has("/issues/closed/2-b.task.md"));
  });

  test("does not match a location that is only a string prefix of the directory name", async () => {
    // Arrange – '/issues/open2/...' should NOT match getFilesUnderLocation('/issues/open')
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open2/1-a.task.md",
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
      "/issues/open/1-a.task.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/open/2-b.task.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    // Act
    await manager.removeFilesUnderLocation("/issues/open");

    // Assert
    assert.strictEqual(
      manager.getSyncedAt("/issues/open/1-a.task.md"),
      undefined,
    );
    assert.strictEqual(
      manager.getSyncedAt("/issues/open/2-b.task.md"),
      undefined,
    );
    assert.strictEqual(manager.getFilesUnderLocation("/issues/open").size, 0);
  });

  test("persists removal to disk", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.task.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.removeFilesUnderLocation("/issues/open");

    const manager2 = new SyncStateManager(statePath);

    // Act
    await manager2.load();

    // Assert
    assert.strictEqual(
      manager2.getSyncedAt("/issues/open/1-a.task.md"),
      undefined,
    );
  });

  test("does not affect entries under other locations", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.task.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/closed/2-b.task.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    // Act
    await manager.removeFilesUnderLocation("/issues/open");

    // Assert
    assert.strictEqual(
      manager.getSyncedAt("/issues/closed/2-b.task.md"),
      "2024-01-15T10:00:00Z",
    );
  });

  test("is a no-op for a location that has no entries", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.task.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );

    // Act – should not throw
    await manager.removeFilesUnderLocation("/issues/never-existed");

    // Assert – existing data unaffected
    assert.strictEqual(
      manager.getSyncedAt("/issues/open/1-a.task.md"),
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
      "/issues/open/1-a.task.md",
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/closed/2-b.task.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    // Act
    const paths = manager.getKnownFilePaths();

    // Assert
    assert.strictEqual(paths.length, 2);
    assert.ok(paths.includes("/issues/open/1-a.task.md"));
    assert.ok(paths.includes("/issues/closed/2-b.task.md"));
  });

  test("does not include deleted entries", async () => {
    // Arrange
    const statePath = makeTempPath();
    const manager = new SyncStateManager(statePath);
    await manager.load();
    await manager.setSyncedAt(
      "/issues/open/1-a.task.md",
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );
    await manager.setSyncedAt(
      "/issues/closed/2-b.task.md",
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );
    await manager.deleteEntry("/issues/closed/2-b.task.md");

    // Act
    const paths = manager.getKnownFilePaths();

    // Assert
    assert.deepStrictEqual([...paths], ["/issues/open/1-a.task.md"]);
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
          "/issues/1.task.md",
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
          "/issues/1.task.md",
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
              files["/issues/1.task.md"],
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

// ---------------------------------------------------------------------------
// Section: updatePluginDataOnly
// ---------------------------------------------------------------------------

suite("syncStateManager – updatePluginDataOnly", () => {
  test("updatePluginDataOnly: updates pluginData without changing synced_at", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();
    const filePath = "/issues/1.task.md";
    const remote1 = makeRemoteInfo({ updated_at: "2024-01-15T10:00:00Z" });
    await mgr.setSyncedAt(filePath, remote1, "gh-issues", "owner/repo/1");

    // Act
    const remote2 = makeRemoteInfo({ updated_at: "2024-01-16T12:00:00Z" });
    await mgr.updatePluginDataOnly(
      filePath,
      remote2,
      "gh-issues",
      "owner/repo/1",
    );

    // Assert
    const entry = mgr.getEntry(filePath);
    assert.strictEqual(
      entry?.plugins?.["gh-issues"]?.synced_at,
      "2024-01-15T10:00:00Z",
      "synced_at should not change",
    );
    const pluginData = mgr.getPluginData(filePath, "gh-issues");
    assert.strictEqual(
      pluginData?.updated_at,
      "2024-01-16T12:00:00Z",
      "pluginData.updated_at should reflect the newer remote state",
    );
  });

  test("updatePluginDataOnly: stores last_modified_by when provided", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();
    const filePath = "/issues/2.task.md";
    const remote1 = makeRemoteInfo();
    await mgr.setSyncedAt(filePath, remote1, "gh-issues", "owner/repo/2");

    // Act
    const remote2 = makeRemoteInfo({
      updated_at: "2024-01-20T09:00:00Z",
      last_modified_by: "user123",
    });
    await mgr.updatePluginDataOnly(
      filePath,
      remote2,
      "gh-issues",
      "owner/repo/2",
    );

    // Assert
    const pluginData = mgr.getPluginData(filePath, "gh-issues");
    assert.strictEqual(pluginData?.last_modified_by, "user123");
  });
});

// ---------------------------------------------------------------------------
// Section: hasPendingRemoteChanges
// ---------------------------------------------------------------------------

suite("syncStateManager – hasPendingRemoteChanges", () => {
  test("hasPendingRemoteChanges: returns false when synced_at equals pluginData.updated_at", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();
    const filePath = "/issues/1.task.md";
    const remote = makeRemoteInfo({ updated_at: "2024-01-15T10:00:00Z" });
    await mgr.setSyncedAt(filePath, remote, "gh-issues", "owner/repo/1");

    // Act
    const result = mgr.hasPendingRemoteChanges(filePath, "gh-issues");

    // Assert
    assert.strictEqual(result, false);
  });

  test("hasPendingRemoteChanges: returns true when pluginData.updated_at is newer than synced_at", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();
    const filePath = "/issues/1.task.md";
    const remote1 = makeRemoteInfo({ updated_at: "2024-01-15T10:00:00Z" });
    await mgr.setSyncedAt(filePath, remote1, "gh-issues", "owner/repo/1");

    const remote2 = makeRemoteInfo({ updated_at: "2024-01-16T12:00:00Z" });
    await mgr.updatePluginDataOnly(
      filePath,
      remote2,
      "gh-issues",
      "owner/repo/1",
    );

    // Act
    const result = mgr.hasPendingRemoteChanges(filePath, "gh-issues");

    // Assert
    assert.strictEqual(result, true);
  });

  test("hasPendingRemoteChanges: returns false for unknown file", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();

    // Act
    const result = mgr.hasPendingRemoteChanges(
      "/nonexistent.task.md",
      "gh-issues",
    );

    // Assert
    assert.strictEqual(result, false);
  });
});

// ---------------------------------------------------------------------------
// Section: findFileByPluginKeyUnderLocation
// ---------------------------------------------------------------------------

suite("syncStateManager – findFileByPluginKeyUnderLocation", () => {
  test("findFileByPluginKeyUnderLocation: returns file under matching location", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();

    const filePath = "/workspace/.issues/target-a/7-fix-bug.task.md";
    const remote = makeRemoteInfo({ number: 7 });
    await mgr.setSyncedAt(filePath, remote, "gh-issues", "owner/repo/7");

    // Act
    const result = mgr.findFileByPluginKeyUnderLocation(
      "gh-issues",
      "owner/repo/7",
      "/workspace/.issues/target-a",
    );

    // Assert
    assert.strictEqual(result, filePath);
  });

  test("findFileByPluginKeyUnderLocation: returns undefined when file is in different location", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();

    const filePath = "/workspace/.issues/target-a/7-fix-bug.task.md";
    const remote = makeRemoteInfo({ number: 7 });
    await mgr.setSyncedAt(filePath, remote, "gh-issues", "owner/repo/7");

    // Act
    const result = mgr.findFileByPluginKeyUnderLocation(
      "gh-issues",
      "owner/repo/7",
      "/workspace/.issues/target-b",
    );

    // Assert
    assert.strictEqual(result, undefined);
  });

  test("findFileByPluginKeyUnderLocation: finds correct file among multiple targets", async () => {
    // Same issue tracked in two different target directories.

    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();

    const fileA = "/workspace/.issues/target-a/7-fix-bug.task.md";
    const fileB = "/workspace/.issues/target-b/7-fix-bug.task.md";
    const remote = makeRemoteInfo({ number: 7 });
    await mgr.setSyncedAt(fileA, remote, "gh-issues", "owner/repo/7");
    await mgr.setSyncedAt(fileB, remote, "gh-issues", "owner/repo/7");

    // Act
    const resultA = mgr.findFileByPluginKeyUnderLocation(
      "gh-issues",
      "owner/repo/7",
      "/workspace/.issues/target-a",
    );
    const resultB = mgr.findFileByPluginKeyUnderLocation(
      "gh-issues",
      "owner/repo/7",
      "/workspace/.issues/target-b",
    );

    // Assert
    assert.strictEqual(resultA, fileA);
    assert.strictEqual(resultB, fileB);
  });
});

// ---------------------------------------------------------------------------
// Section: findAllFilesByPluginKey
// ---------------------------------------------------------------------------

suite("syncStateManager – findAllFilesByPluginKey", () => {
  test("findAllFilesByPluginKey: returns all files with matching key", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();

    const fileA = "/workspace/.issues/target-a/7-fix-bug.task.md";
    const fileB = "/workspace/.issues/target-b/7-fix-bug.task.md";
    const remote = makeRemoteInfo({ number: 7 });
    await mgr.setSyncedAt(fileA, remote, "gh-issues", "owner/repo/7");
    await mgr.setSyncedAt(fileB, remote, "gh-issues", "owner/repo/7");

    // Act
    const results = mgr.findAllFilesByPluginKey("gh-issues", "owner/repo/7");

    // Assert
    assert.strictEqual(results.length, 2);
    assert.ok(results.includes(fileA));
    assert.ok(results.includes(fileB));
  });

  test("findAllFilesByPluginKey: returns single file when only one matches", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();

    const fileA = "/workspace/.issues/target-a/7-fix-bug.task.md";
    const remote = makeRemoteInfo({ number: 7 });
    await mgr.setSyncedAt(fileA, remote, "gh-issues", "owner/repo/7");

    // Act
    const results = mgr.findAllFilesByPluginKey("gh-issues", "owner/repo/7");

    // Assert
    assert.deepStrictEqual(results, [fileA]);
  });

  test("findAllFilesByPluginKey: returns empty when no files match", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();

    // Act
    const results = mgr.findAllFilesByPluginKey("gh-issues", "owner/repo/999");

    // Assert
    assert.deepStrictEqual(results, []);
  });

  test("findAllFilesByPluginKey: does not return files with different plugin id", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();

    const fileA = "/workspace/.issues/target-a/7-fix-bug.task.md";
    const remote = makeRemoteInfo({ number: 7 });
    await mgr.setSyncedAt(fileA, remote, "gh-issues", "owner/repo/7");

    // Act
    const results = mgr.findAllFilesByPluginKey("gh-projects", "owner/repo/7");

    // Assert
    assert.deepStrictEqual(results, []);
  });
});

// ---------------------------------------------------------------------------
// Section: setLocalWrittenAt
// ---------------------------------------------------------------------------

suite("syncStateManager – setLocalWrittenAt", () => {
  test("setLocalWrittenAt: updates local_written_at without changing synced_at", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();

    const filePath = "/workspace/.issues/target-a/7-fix-bug.task.md";
    const remote = makeRemoteInfo({
      number: 7,
      updated_at: "2024-01-15T10:00:00Z",
    });
    await mgr.setSyncedAt(filePath, remote, "gh-issues", "owner/repo/7");
    const syncedAtBefore = mgr.getSyncedAt(filePath, "gh-issues");

    // Act
    await new Promise((resolve) => setTimeout(resolve, 10));
    await mgr.setLocalWrittenAt(filePath);

    // Assert
    const syncedAtAfter = mgr.getSyncedAt(filePath, "gh-issues");
    assert.strictEqual(syncedAtAfter, syncedAtBefore);

    const localWrittenAt = mgr.getLocalWrittenAt(filePath);
    assert.ok(localWrittenAt);
    assert.ok(new Date(localWrittenAt) > new Date("2024-01-15T10:00:00Z"));
  });

  test("setLocalWrittenAt: no-op for unknown file path", async () => {
    // Arrange
    const statePath = makeTempPath();
    const mgr = new SyncStateManager(statePath);
    await mgr.load();

    // Act & Assert — should not throw
    await mgr.setLocalWrittenAt("/nonexistent.task.md");

    assert.strictEqual(
      mgr.getLocalWrittenAt("/nonexistent.task.md"),
      undefined,
    );
  });
});
