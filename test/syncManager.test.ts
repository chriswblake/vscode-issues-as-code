import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isConflict,
  isExtensionWriteEvent,
  classifyDiff,
  generateConflictContent,
  hasConflictMarkers,
  reconcileTargetChanges,
  removeEmptyParentDirs,
} from "../src/syncManager";
import { GhIssuesPlugin } from "../src/plugins/gh-issues/ghIssuesPlugin";
import {
  SyncStateManager,
  type RemoteIssueInfo,
} from "../src/syncStateManager";

// ---------------------------------------------------------------------------
// Section 1: Debounce timer behavior
// ---------------------------------------------------------------------------
suite("syncManager – debounce timer behavior", () => {
  /**
   * Create a minimal SyncManager-like object that exposes the debounce
   * logic without requiring VS Code APIs.
   */
  function makeDebouncer(delayMs: number, onFire: (path: string) => void) {
    const timers = new Map<string, NodeJS.Timeout>();

    return {
      debouncedPush(filePath: string) {
        const existing = timers.get(filePath);
        if (existing) {
          clearTimeout(existing);
        }
        const timer = setTimeout(() => {
          timers.delete(filePath);
          onFire(filePath);
        }, delayMs);
        timers.set(filePath, timer);
      },
      dispose() {
        for (const t of timers.values()) {
          clearTimeout(t);
        }
        timers.clear();
      },
    };
  }

  test("multiple rapid saves result in a single push", (done) => {
    const calls: string[] = [];
    const debouncer = makeDebouncer(50, (p) => calls.push(p));

    debouncer.debouncedPush("/issues/1.task.md");
    debouncer.debouncedPush("/issues/1.task.md");
    debouncer.debouncedPush("/issues/1.task.md");

    // After delay fires, should have been called exactly once
    setTimeout(() => {
      debouncer.dispose();
      try {
        assert.strictEqual(calls.length, 1, "expected exactly 1 push");
        assert.strictEqual(calls[0], "/issues/1.task.md");
        done();
      } catch (e) {
        done(e);
      }
    }, 150);
  });

  test("separate files get independent debounce timers", (done) => {
    const calls: string[] = [];
    const debouncer = makeDebouncer(50, (p) => calls.push(p));

    debouncer.debouncedPush("/issues/1.task.md");
    debouncer.debouncedPush("/issues/2.task.md");

    setTimeout(() => {
      debouncer.dispose();
      try {
        assert.strictEqual(calls.length, 2);
        assert.ok(calls.includes("/issues/1.task.md"));
        assert.ok(calls.includes("/issues/2.task.md"));
        done();
      } catch (e) {
        done(e);
      }
    }, 150);
  });

  test("push does not fire if timer is cleared before delay", (done) => {
    const calls: string[] = [];
    const debouncer = makeDebouncer(100, (p) => calls.push(p));

    debouncer.debouncedPush("/issues/1.task.md");
    // Dispose immediately before the timer fires
    debouncer.dispose();

    setTimeout(() => {
      try {
        assert.strictEqual(calls.length, 0, "expected no push after dispose");
        done();
      } catch (e) {
        done(e);
      }
    }, 200);
  });
});

// ---------------------------------------------------------------------------
// Section 2: Conflict detection – isConflict()
// ---------------------------------------------------------------------------
suite("syncManager – conflict detection", () => {
  test("returns true when cloud is newer than local sync state", () => {
    assert.strictEqual(
      isConflict("2026-04-22T12:00:00Z", "2026-04-22T10:00:00Z"), //
      true,
    );
  });

  test("returns false when cloud and local have the same timestamp", () => {
    assert.strictEqual(
      isConflict("2026-04-22T10:00:00Z", "2026-04-22T10:00:00Z"), //
      false,
    );
  });

  test("returns false when local is newer than cloud", () => {
    assert.strictEqual(
      isConflict("2026-04-22T08:00:00Z", "2026-04-22T10:00:00Z"), //
      false,
    );
  });

  test("returns false when local sync state is undefined (never synced)", () => {
    assert.strictEqual(
      isConflict("2026-04-22T12:00:00Z", undefined), //
      false,
    );
  });

  test("handles ISO 8601 strings with milliseconds", () => {
    assert.strictEqual(
      isConflict("2026-04-22T10:00:00.500Z", "2026-04-22T10:00:00.000Z"),
      true,
    );
  });
});

suite("syncManager – extension write event fence", () => {
  test("returns true for identical mtime", () => {
    assert.strictEqual(isExtensionWriteEvent(1000, 1000), true);
  });

  test("returns true for tiny timestamp jitter", () => {
    assert.strictEqual(isExtensionWriteEvent(1001, 1000), true);
  });

  test("returns false when file is newer than extension write", () => {
    assert.strictEqual(isExtensionWriteEvent(1002, 1000), false);
  });
});

// ---------------------------------------------------------------------------
// Section 2b: New issue title inference
// ---------------------------------------------------------------------------
suite("syncManager – new issue title inference", () => {
  // Uses the GhIssuesPlugin.inferTitle method (previously inferNewIssueTitle)
  const plugin = new GhIssuesPlugin(null as any);

  test("prefers explicit frontmatter title when present", () => {
    const result = plugin.inferTitle(
      "/issues/new.task.md",
      {
        "gh-issues": {
          title: "My explicit title",
          state: "open",
          labels: [],
          assignees: [],
        },
      },
      "Body line",
    );
    assert.strictEqual(result, "My explicit title");
  });

  test("uses first non-empty body line when frontmatter title is blank", () => {
    const result = plugin.inferTitle(
      "/issues/new.task.md",
      {
        "gh-issues": { title: "   ", state: "open", labels: [], assignees: [] },
      },
      "\n\nThis is body title\nMore details",
    );
    assert.strictEqual(result, "This is body title");
  });

  test("strips markdown heading markers from body-derived title", () => {
    const result = plugin.inferTitle(
      "/issues/new.task.md",
      { "gh-issues": { title: "", state: "open", labels: [], assignees: [] } },
      "# Heading Title\nBody",
    );
    assert.strictEqual(result, "Heading Title");
  });

  test("falls back to filename when title and body are empty", () => {
    const result = plugin.inferTitle(
      "/issues/bug in step 3.task.md",
      { "gh-issues": { title: "", state: "open", labels: [], assignees: [] } },
      "   \n  ",
    );
    assert.strictEqual(result, "bug in step 3");
  });
});

// ---------------------------------------------------------------------------
// Section 3: suppressedUris ref-counting
// ---------------------------------------------------------------------------
suite("syncManager – suppressedUris ref-counting", () => {
  /** Minimal stub of the suppress/isSuppressed logic from SyncManager. */
  function makeSuppressionTracker() {
    const map = new Map<string, number>();

    return {
      suppress(filePath: string, delta: number) {
        const current = map.get(filePath) ?? 0;
        const next = current + delta;
        if (next <= 0) {
          map.delete(filePath);
        } else {
          map.set(filePath, next);
        }
      },
      isSuppressed(filePath: string): boolean {
        return (map.get(filePath) ?? 0) > 0;
      },
    };
  }

  test("file is suppressed after increment", () => {
    const tracker = makeSuppressionTracker();
    tracker.suppress("/issues/1.task.md", 1);
    assert.strictEqual(tracker.isSuppressed("/issues/1.task.md"), true);
  });

  test("file is unsuppressed after balanced increment/decrement", () => {
    const tracker = makeSuppressionTracker();
    tracker.suppress("/issues/1.task.md", 1);
    tracker.suppress("/issues/1.task.md", -1);
    assert.strictEqual(tracker.isSuppressed("/issues/1.task.md"), false);
  });

  test("nested increments require matching decrements", () => {
    const tracker = makeSuppressionTracker();
    tracker.suppress("/issues/1.task.md", 1);
    tracker.suppress("/issues/1.task.md", 1);
    tracker.suppress("/issues/1.task.md", -1);
    assert.strictEqual(
      tracker.isSuppressed("/issues/1.task.md"),
      true,
      "still suppressed",
    );
    tracker.suppress("/issues/1.task.md", -1);
    assert.strictEqual(
      tracker.isSuppressed("/issues/1.task.md"),
      false,
      "now unsuppressed",
    );
  });

  test("unsuppressed file is not in the map", () => {
    const tracker = makeSuppressionTracker();
    assert.strictEqual(
      tracker.isSuppressed("/issues/never-touched.task.md"),
      false,
    );
  });

  test("different files have independent suppression", () => {
    const tracker = makeSuppressionTracker();
    tracker.suppress("/issues/1.task.md", 1);
    assert.strictEqual(tracker.isSuppressed("/issues/1.task.md"), true);
    assert.strictEqual(tracker.isSuppressed("/issues/2.task.md"), false);
  });
});

// ---------------------------------------------------------------------------
// Section 4: classifyDiff
// ---------------------------------------------------------------------------
suite("syncManager – classifyDiff", () => {
  test("identical content returns identical", () => {
    // Arrange
    const content = "line one\nline two\nline three";

    // Act
    const result = classifyDiff(content, content);

    // Assert
    assert.strictEqual(result, "identical");
  });

  test("cloud adds lines → additions-only", () => {
    // Arrange
    const local = "line one\nline two";
    const cloud = "line one\nline two\nline three";

    // Act
    const result = classifyDiff(local, cloud);

    // Assert
    assert.strictEqual(result, "additions-only");
  });

  test("cloud removes lines → removals-only", () => {
    // Arrange
    const local = "line one\nline two\nline three";
    const cloud = "line one\nline three";

    // Act
    const result = classifyDiff(local, cloud);

    // Assert
    assert.strictEqual(result, "removals-only");
  });

  test("cloud both adds and removes lines → mixed", () => {
    // Arrange
    const local = "line one\nline two\nline three";
    const cloud = "line one\nline TWO\nline three\nline four";

    // Act
    const result = classifyDiff(local, cloud);

    // Assert
    assert.strictEqual(result, "mixed");
  });

  test("cloud replaces all lines → mixed", () => {
    // Arrange
    const local = "old content";
    const cloud = "new content";

    // Act
    const result = classifyDiff(local, cloud);

    // Assert
    assert.strictEqual(result, "mixed");
  });
});

// ---------------------------------------------------------------------------
// Section 5: generateConflictContent
// ---------------------------------------------------------------------------
suite("syncManager – generateConflictContent", () => {
  test("equal lines pass through without markers", () => {
    // Arrange
    const local = "line one\nline two";
    const cloud = "line one\nline two";

    // Act
    const result = generateConflictContent(local, cloud);

    // Assert
    assert.strictEqual(result, "line one\nline two");
  });

  test("replaced line is wrapped in conflict markers", () => {
    // Arrange
    const local = "intro\nold line\noutro";
    const cloud = "intro\nnew line\noutro";

    // Act
    const result = generateConflictContent(local, cloud);

    // Assert
    const expected =
      "intro\n<<<<<<< Local\nold line\n=======\nnew line\n>>>>>>> Remote\noutro";
    assert.strictEqual(result, expected);
  });

  test("added-only hunk has empty local section", () => {
    // Arrange
    const local = "line one\nline two";
    const cloud = "line one\ninserted\nline two";

    // Act
    const result = generateConflictContent(local, cloud);

    // Assert
    assert.ok(
      result.includes("<<<<<<< Local\n=======\ninserted\n>>>>>>> Remote"),
    );
  });

  test("removed-only hunk has empty cloud section", () => {
    // Arrange
    const local = "line one\nremoved\nline two";
    const cloud = "line one\nline two";

    // Act
    const result = generateConflictContent(local, cloud);

    // Assert
    assert.ok(
      result.includes("<<<<<<< Local\nremoved\n=======\n>>>>>>> Remote"),
    );
  });

  test("unchanged context lines appear outside markers", () => {
    // Arrange
    const local = "header\nold body\nfooter";
    const cloud = "header\nnew body\nfooter";

    // Act
    const result = generateConflictContent(local, cloud);
    const lines = result.split("\n");

    // Assert
    assert.strictEqual(lines[0], "header");
    assert.strictEqual(lines[lines.length - 1], "footer");
  });
});

// ---------------------------------------------------------------------------
// Section 6: hasConflictMarkers
// ---------------------------------------------------------------------------
suite("syncManager \u2013 hasConflictMarkers", () => {
  test("returns false for clean content", () => {
    // Arrange / Act / Assert
    assert.strictEqual(
      hasConflictMarkers("normal content\nno markers here"),
      false,
    );
  });

  test("returns true when conflict start marker is present", () => {
    // Arrange
    const content =
      "line one\n<<<<<<< Local\nmine\n=======\ntheirs\n>>>>>>> Remote\nline two";

    // Act / Assert
    assert.strictEqual(hasConflictMarkers(content), true);
  });

  test("returns false for less-than characters that are not markers", () => {
    // Arrange
    const content = "value < 7\na <<= b";

    // Act / Assert
    assert.strictEqual(hasConflictMarkers(content), false);
  });

  test("returns true for markers produced by generateConflictContent", () => {
    // Arrange
    const content = generateConflictContent("old\nshared", "new\nshared");

    // Act / Assert
    assert.strictEqual(hasConflictMarkers(content), true);
  });
});

// ---------------------------------------------------------------------------
// Section 7: reconcileTargetChanges – move and delete
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-test-"));
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

suite("syncManager – reconcileTargetChanges (move)", () => {
  test("moves issue files to the new location", async () => {
    // Arrange
    const root = makeTempDir();
    const oldLocation = path.join(root, "old");
    const newLocation = path.join(root, "new");
    fs.mkdirSync(oldLocation, { recursive: true });

    const statePath = path.join(root, "sync-state.yml");
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    const filePath = path.join(oldLocation, "1-issue.task.md");
    fs.writeFileSync(filePath, "content", "utf8");
    await stateManager.setSyncedAt(
      filePath,
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );

    const oldTargets = [
      {
        filesDir: oldLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];
    const newTargets = [
      {
        filesDir: newLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];

    // Act
    await reconcileTargetChanges(oldTargets, newTargets, stateManager);

    // Assert – file exists at new location
    assert.ok(
      fs.existsSync(path.join(newLocation, "1-issue.task.md")),
      "file should be at new location",
    );
  });

  test("removes issue files from the old location after move", async () => {
    // Arrange
    const root = makeTempDir();
    const oldLocation = path.join(root, "old");
    const newLocation = path.join(root, "new");
    fs.mkdirSync(oldLocation, { recursive: true });

    const statePath = path.join(root, "sync-state.yml");
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    const filePath = path.join(oldLocation, "1-issue.task.md");
    fs.writeFileSync(filePath, "content", "utf8");
    await stateManager.setSyncedAt(
      filePath,
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );

    const oldTargets = [
      {
        filesDir: oldLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];
    const newTargets = [
      {
        filesDir: newLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];

    // Act
    await reconcileTargetChanges(oldTargets, newTargets, stateManager);

    // Assert – old file gone
    assert.ok(
      !fs.existsSync(filePath),
      "old file should be removed after move",
    );
  });

  test("state is updated to new location key after move", async () => {
    // Arrange
    const root = makeTempDir();
    const oldLocation = path.join(root, "old");
    const newLocation = path.join(root, "new");
    fs.mkdirSync(oldLocation, { recursive: true });

    const statePath = path.join(root, "sync-state.yml");
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    const filePath = path.join(oldLocation, "1-issue.task.md");
    fs.writeFileSync(filePath, "content", "utf8");
    const remote = makeRemoteInfo({
      number: 1,
      updated_at: "2024-03-01T00:00:00Z",
    });
    await stateManager.setSyncedAt(
      filePath,
      remote,
      "gh-issues",
      "owner/repo/1",
    );

    const oldTargets = [
      {
        filesDir: oldLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];
    const newTargets = [
      {
        filesDir: newLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];

    // Act
    await reconcileTargetChanges(oldTargets, newTargets, stateManager);

    // Assert – state uses new file path and preserves synced_at
    const newFilePath = path.join(newLocation, "1-issue.task.md");
    assert.strictEqual(
      stateManager.getSyncedAt(newFilePath),
      "2024-03-01T00:00:00Z",
    );
    assert.strictEqual(stateManager.getSyncedAt(filePath), undefined);
  });

  test("handles crash recovery: source file already gone before move", async () => {
    // Arrange – simulate a crash where the file was already moved but state was not updated
    const root = makeTempDir();
    const oldLocation = path.join(root, "old");
    const newLocation = path.join(root, "new");
    fs.mkdirSync(oldLocation, { recursive: true });
    fs.mkdirSync(newLocation, { recursive: true });

    const statePath = path.join(root, "sync-state.yml");
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    // State still points to old file path, but file is already at new location
    const oldFilePath = path.join(oldLocation, "1-issue.task.md");
    const newFilePath = path.join(newLocation, "1-issue.task.md");
    fs.writeFileSync(newFilePath, "content", "utf8");
    await stateManager.setSyncedAt(
      oldFilePath,
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );

    const oldTargets = [
      {
        filesDir: oldLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];
    const newTargets = [
      {
        filesDir: newLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];

    // Act – should not throw even though source is missing
    await assert.doesNotReject(
      reconcileTargetChanges(oldTargets, newTargets, stateManager),
    );

    // Assert – old state entry gone
    assert.strictEqual(stateManager.getSyncedAt(oldFilePath), undefined);
  });

  test("no-op when old and new locations are the same", async () => {
    // Arrange
    const root = makeTempDir();
    const location = path.join(root, "issues");
    fs.mkdirSync(location, { recursive: true });

    const statePath = path.join(root, "sync-state.yml");
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    const filePath = path.join(location, "1-issue.task.md");
    fs.writeFileSync(filePath, "content", "utf8");
    await stateManager.setSyncedAt(
      filePath,
      makeRemoteInfo(),
      "gh-issues",
      "owner/repo/1",
    );

    const targets = [
      {
        filesDir: location,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];

    // Act
    await reconcileTargetChanges(targets, targets, stateManager);

    // Assert – file still present at original location, state unchanged
    assert.ok(fs.existsSync(filePath));
    assert.strictEqual(
      stateManager.getSyncedAt(filePath),
      "2024-01-15T10:00:00Z",
    );
  });
});

suite("syncManager – reconcileTargetChanges (delete)", () => {
  test("deletes issue files when target is removed", async () => {
    // Arrange
    const root = makeTempDir();
    const location = path.join(root, "issues");
    fs.mkdirSync(location, { recursive: true });

    const statePath = path.join(root, "sync-state.yml");
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    const filePath = path.join(location, "1-issue.task.md");
    fs.writeFileSync(filePath, "content", "utf8");
    await stateManager.setSyncedAt(
      filePath,
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );

    const oldTargets = [
      {
        filesDir: location,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];
    const newTargets: typeof oldTargets = [];

    // Act
    await reconcileTargetChanges(oldTargets, newTargets, stateManager);

    // Assert – file deleted
    assert.ok(!fs.existsSync(filePath), "issue file should be deleted");
  });

  test("removes target entries from sync state when target is removed", async () => {
    // Arrange
    const root = makeTempDir();
    const location = path.join(root, "issues");
    fs.mkdirSync(location, { recursive: true });

    const statePath = path.join(root, "sync-state.yml");
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    const filePath = path.join(location, "1-issue.task.md");
    fs.writeFileSync(filePath, "content", "utf8");
    await stateManager.setSyncedAt(
      filePath,
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );

    const oldTargets = [
      {
        filesDir: location,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];
    const newTargets: typeof oldTargets = [];

    // Act
    await reconcileTargetChanges(oldTargets, newTargets, stateManager);

    // Assert – state entry removed
    assert.strictEqual(stateManager.getSyncedAt(filePath), undefined);
    assert.strictEqual(stateManager.getFilesUnderLocation(location).size, 0);
  });

  test("handles crash recovery: file already deleted before state cleanup", async () => {
    // Arrange
    const root = makeTempDir();
    const location = path.join(root, "issues");
    fs.mkdirSync(location, { recursive: true });

    const statePath = path.join(root, "sync-state.yml");
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    // State points to a file that no longer exists (already deleted in a prior partial run)
    const filePath = path.join(location, "1-issue.task.md");
    await stateManager.setSyncedAt(
      filePath,
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );

    const oldTargets = [
      {
        filesDir: location,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];
    const newTargets: typeof oldTargets = [];

    // Act – should not throw even though the file is missing
    await assert.doesNotReject(
      reconcileTargetChanges(oldTargets, newTargets, stateManager),
    );

    // Assert – state cleaned up
    assert.strictEqual(stateManager.getSyncedAt(filePath), undefined);
  });

  test("does not affect targets that are still in the new config", async () => {
    // Arrange
    const root = makeTempDir();
    const keptLocation = path.join(root, "kept");
    const removedLocation = path.join(root, "removed");
    fs.mkdirSync(keptLocation, { recursive: true });
    fs.mkdirSync(removedLocation, { recursive: true });

    const statePath = path.join(root, "sync-state.yml");
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    const keptFile = path.join(keptLocation, "1-kept.task.md");
    const removedFile = path.join(removedLocation, "2-removed.task.md");
    fs.writeFileSync(keptFile, "kept", "utf8");
    fs.writeFileSync(removedFile, "removed", "utf8");
    await stateManager.setSyncedAt(
      keptFile,
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );
    await stateManager.setSyncedAt(
      removedFile,
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    const oldTargets = [
      {
        filesDir: keptLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
      {
        filesDir: removedLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "closed" } },
      },
    ];
    const newTargets = [oldTargets[0]];

    // Act
    await reconcileTargetChanges(oldTargets, newTargets, stateManager);

    // Assert – kept target unaffected
    assert.ok(fs.existsSync(keptFile), "kept file should still exist");
    assert.strictEqual(
      stateManager.getSyncedAt(keptFile),
      "2024-01-15T10:00:00Z",
    );

    // Assert – removed target deleted
    assert.ok(!fs.existsSync(removedFile), "removed file should be deleted");
    assert.strictEqual(stateManager.getSyncedAt(removedFile), undefined);
  });
});

// ---------------------------------------------------------------------------
// Section 8: removeEmptyParentDirs
// ---------------------------------------------------------------------------

suite("syncManager – removeEmptyParentDirs", () => {
  test("removeEmptyParentDirs: removes empty directory and its empty parents", async () => {
    // Arrange
    const root = makeTempDir();
    const nested = path.join(root, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    // Act
    await removeEmptyParentDirs(nested);

    // Assert – all empty parents removed
    assert.ok(
      !fs.existsSync(path.join(root, "a", "b", "c")),
      "c should be removed",
    );
    assert.ok(!fs.existsSync(path.join(root, "a", "b")), "b should be removed");
    assert.ok(!fs.existsSync(path.join(root, "a")), "a should be removed");
  });

  test("removeEmptyParentDirs: stops at non-empty parent", async () => {
    // Arrange
    const root = makeTempDir();
    const nested = path.join(root, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, "a", "keep.txt"), "keep", "utf8");

    // Act
    await removeEmptyParentDirs(nested);

    // Assert – only the empty leaf is removed
    assert.ok(!fs.existsSync(nested), "b should be removed");
    assert.ok(
      fs.existsSync(path.join(root, "a")),
      "a should remain (has keep.txt)",
    );
  });

  test("removeEmptyParentDirs: stops at ancestor of an active target", async () => {
    // Arrange
    const root = makeTempDir();
    const oldDir = path.join(root, "issues", "frontend", "old");
    const activeDir = path.join(root, "issues", "backend", "open");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(activeDir, { recursive: true });

    // Act – "issues" is an ancestor of the active target, so stop there
    await removeEmptyParentDirs(oldDir, [activeDir]);

    // Assert
    assert.ok(!fs.existsSync(oldDir), "old should be removed");
    assert.ok(
      !fs.existsSync(path.join(root, "issues", "frontend")),
      "frontend should be removed",
    );
    assert.ok(
      fs.existsSync(path.join(root, "issues")),
      "issues should remain (ancestor of active target)",
    );
  });

  test("removeEmptyParentDirs: no-op when directory does not exist", async () => {
    // Arrange
    const root = makeTempDir();
    const nonExistent = path.join(root, "does", "not", "exist");

    // Act – should not throw
    await assert.doesNotReject(removeEmptyParentDirs(nonExistent));
  });

  test("removeEmptyParentDirs: no-op when directory is non-empty", async () => {
    // Arrange
    const root = makeTempDir();
    const nested = path.join(root, "a");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "file.txt"), "data", "utf8");

    // Act
    await removeEmptyParentDirs(nested);

    // Assert – directory kept because it's not empty
    assert.ok(fs.existsSync(nested), "non-empty directory should remain");
  });

  test("removeEmptyParentDirs: does not remove directory equal to an active target", async () => {
    // Arrange
    const root = makeTempDir();
    const sharedDir = path.join(root, "issues");
    const subDir = path.join(sharedDir, "old");
    fs.mkdirSync(subDir, { recursive: true });

    // Act – sharedDir itself is an active target
    await removeEmptyParentDirs(subDir, [sharedDir]);

    // Assert
    assert.ok(!fs.existsSync(subDir), "old should be removed");
    assert.ok(
      fs.existsSync(sharedDir),
      "issues should remain (is an active target)",
    );
  });
});

suite("syncManager – reconcileTargetChanges removes empty parent dirs", () => {
  test("move: removes empty parent directories after moving files", async () => {
    // Arrange
    const root = makeTempDir();
    const oldLocation = path.join(root, "issues", "deep", "old");
    const newLocation = path.join(root, "new");
    fs.mkdirSync(oldLocation, { recursive: true });

    const statePath = path.join(root, "sync-state.yml");
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    const filePath = path.join(oldLocation, "1-issue.task.md");
    fs.writeFileSync(filePath, "content", "utf8");
    await stateManager.setSyncedAt(
      filePath, //
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );

    const oldTargets = [
      {
        filesDir: oldLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];
    const newTargets = [
      {
        filesDir: newLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];

    // Act
    await reconcileTargetChanges(oldTargets, newTargets, stateManager);

    // Assert – empty parent directories are cleaned up
    assert.ok(
      !fs.existsSync(path.join(root, "issues")),
      "empty parents should be removed",
    );
  });

  test("move: preserves shared parent when another target uses it", async () => {
    // Arrange
    const root = makeTempDir();
    const oldLocation = path.join(root, "issues", "frontend", "old");
    const keptLocation = path.join(root, "issues", "backend", "open");
    const newLocation = path.join(root, "issues", "frontend", "new");
    fs.mkdirSync(oldLocation, { recursive: true });
    fs.mkdirSync(keptLocation, { recursive: true });

    const statePath = path.join(root, "sync-state.yml");
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    const filePath = path.join(oldLocation, "1-issue.task.md");
    fs.writeFileSync(filePath, "content", "utf8");
    await stateManager.setSyncedAt(
      filePath, //
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );

    const keptFile = path.join(keptLocation, "2-issue.task.md");
    fs.writeFileSync(keptFile, "content", "utf8");
    await stateManager.setSyncedAt(
      keptFile, //
      makeRemoteInfo({ number: 2 }),
      "gh-issues",
      "owner/repo/2",
    );

    const oldTargets = [
      {
        filesDir: oldLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
      {
        filesDir: keptLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "closed" } },
      },
    ];
    const newTargets = [
      {
        filesDir: newLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
      {
        filesDir: keptLocation,
        "gh-issues": { filters: { repository: "owner/repo", state: "closed" } },
      },
    ];

    // Act
    await reconcileTargetChanges(oldTargets, newTargets, stateManager);

    // Assert – "old" removed, "frontend" removed (empty), "issues" kept (ancestor of kept target)
    assert.ok(!fs.existsSync(oldLocation), "old location should be removed");
    assert.ok(
      fs.existsSync(path.join(root, "issues")),
      "issues should remain (ancestor of active target)",
    );
    assert.ok(
      fs.existsSync(keptLocation),
      "kept target location should remain",
    );
  });

  test("delete: removes empty parent directories after deleting files", async () => {
    // Arrange
    const root = makeTempDir();
    const location = path.join(root, "issues", "deep", "nested");
    fs.mkdirSync(location, { recursive: true });

    const statePath = path.join(root, "sync-state.yml");
    const stateManager = new SyncStateManager(statePath);
    await stateManager.load();

    const filePath = path.join(location, "1-issue.task.md");
    fs.writeFileSync(filePath, "content", "utf8");
    await stateManager.setSyncedAt(
      filePath, //
      makeRemoteInfo({ number: 1 }),
      "gh-issues",
      "owner/repo/1",
    );

    const oldTargets = [
      {
        filesDir: location,
        "gh-issues": { filters: { repository: "owner/repo", state: "open" } },
      },
    ];
    const newTargets: typeof oldTargets = [];

    // Act
    await reconcileTargetChanges(oldTargets, newTargets, stateManager);

    // Assert – empty parent directories are cleaned up
    assert.ok(
      !fs.existsSync(path.join(root, "issues")),
      "empty parents should be removed",
    );
  });
});
