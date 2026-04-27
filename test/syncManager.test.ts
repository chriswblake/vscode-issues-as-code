import * as assert from 'assert';
import { isConflict, inferNewIssueTitle } from '../src/syncManager';

// ---------------------------------------------------------------------------
// Section 1: Debounce timer behavior
// ---------------------------------------------------------------------------
suite('syncManager – debounce timer behavior', () => {
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

  test('multiple rapid saves result in a single push', (done) => {
    const calls: string[] = [];
    const debouncer = makeDebouncer(50, (p) => calls.push(p));

    debouncer.debouncedPush('/issues/1.md');
    debouncer.debouncedPush('/issues/1.md');
    debouncer.debouncedPush('/issues/1.md');

    // After delay fires, should have been called exactly once
    setTimeout(() => {
      debouncer.dispose();
      try {
        assert.strictEqual(calls.length, 1, 'expected exactly 1 push');
        assert.strictEqual(calls[0], '/issues/1.md');
        done();
      } catch (e) {
        done(e);
      }
    }, 150);
  });

  test('separate files get independent debounce timers', (done) => {
    const calls: string[] = [];
    const debouncer = makeDebouncer(50, (p) => calls.push(p));

    debouncer.debouncedPush('/issues/1.md');
    debouncer.debouncedPush('/issues/2.md');

    setTimeout(() => {
      debouncer.dispose();
      try {
        assert.strictEqual(calls.length, 2);
        assert.ok(calls.includes('/issues/1.md'));
        assert.ok(calls.includes('/issues/2.md'));
        done();
      } catch (e) {
        done(e);
      }
    }, 150);
  });

  test('push does not fire if timer is cleared before delay', (done) => {
    const calls: string[] = [];
    const debouncer = makeDebouncer(100, (p) => calls.push(p));

    debouncer.debouncedPush('/issues/1.md');
    // Dispose immediately before the timer fires
    debouncer.dispose();

    setTimeout(() => {
      try {
        assert.strictEqual(calls.length, 0, 'expected no push after dispose');
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
suite('syncManager – conflict detection', () => {
  test('returns true when cloud is newer than local synced_at', () => {
    assert.strictEqual(
      isConflict('2026-04-22T12:00:00Z', '2026-04-22T10:00:00Z'), //
      true,
    );
  });

  test('returns false when cloud and local have the same timestamp', () => {
    assert.strictEqual(
      isConflict('2026-04-22T10:00:00Z', '2026-04-22T10:00:00Z'), //
      false
    );
  });

  test('returns false when local is newer than cloud', () => {
    assert.strictEqual(
      isConflict('2026-04-22T08:00:00Z', '2026-04-22T10:00:00Z'), //
      false
    );
  });

  test('handles ISO 8601 strings with milliseconds', () => {
    assert.strictEqual(
      isConflict('2026-04-22T10:00:00.500Z', '2026-04-22T10:00:00.000Z'),
      true
    );
  });
});

// ---------------------------------------------------------------------------
// Section 2b: New issue title inference
// ---------------------------------------------------------------------------
suite('syncManager – new issue title inference', () => {
  test('prefers explicit frontmatter title when present', () => {
    const result = inferNewIssueTitle('/issues/new.md', 'My explicit title', 'Body line');
    assert.strictEqual(result, 'My explicit title');
  });

  test('uses first non-empty body line when frontmatter title is blank', () => {
    const result = inferNewIssueTitle('/issues/new.md', '   ', '\n\nThis is body title\nMore details');
    assert.strictEqual(result, 'This is body title');
  });

  test('strips markdown heading markers from body-derived title', () => {
    const result = inferNewIssueTitle('/issues/new.md', '', '# Heading Title\nBody');
    assert.strictEqual(result, 'Heading Title');
  });

  test('falls back to filename when title and body are empty', () => {
    const result = inferNewIssueTitle('/issues/bug in step 3.md', '', '   \n  ');
    assert.strictEqual(result, 'bug in step 3');
  });
});

// ---------------------------------------------------------------------------
// Section 3: suppressedUris ref-counting
// ---------------------------------------------------------------------------
suite('syncManager – suppressedUris ref-counting', () => {
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

  test('file is suppressed after increment', () => {
    const tracker = makeSuppressionTracker();
    tracker.suppress('/issues/1.md', 1);
    assert.strictEqual(tracker.isSuppressed('/issues/1.md'), true);
  });

  test('file is unsuppressed after balanced increment/decrement', () => {
    const tracker = makeSuppressionTracker();
    tracker.suppress('/issues/1.md', 1);
    tracker.suppress('/issues/1.md', -1);
    assert.strictEqual(tracker.isSuppressed('/issues/1.md'), false);
  });

  test('nested increments require matching decrements', () => {
    const tracker = makeSuppressionTracker();
    tracker.suppress('/issues/1.md', 1);
    tracker.suppress('/issues/1.md', 1);
    tracker.suppress('/issues/1.md', -1);
    assert.strictEqual(tracker.isSuppressed('/issues/1.md'), true, 'still suppressed');
    tracker.suppress('/issues/1.md', -1);
    assert.strictEqual(tracker.isSuppressed('/issues/1.md'), false, 'now unsuppressed');
  });

  test('unsuppressed file is not in the map', () => {
    const tracker = makeSuppressionTracker();
    assert.strictEqual(tracker.isSuppressed('/issues/never-touched.md'), false);
  });

  test('different files have independent suppression', () => {
    const tracker = makeSuppressionTracker();
    tracker.suppress('/issues/1.md', 1);
    assert.strictEqual(tracker.isSuppressed('/issues/1.md'), true);
    assert.strictEqual(tracker.isSuppressed('/issues/2.md'), false);
  });
});
