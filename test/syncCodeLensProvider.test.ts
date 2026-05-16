import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  findFrontmatterSectionLine,
  formatRelativeTime,
} from "../src/syncCodeLensProvider";
import { isLocalFileModified as isFileModified } from "../src/fileModification";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDocument(text: string): { getText(): string; lineCount: number } {
  const lines = text.split(/\r?\n/);
  return {
    getText: () => text,
    lineCount: lines.length,
  };
}

// ---------------------------------------------------------------------------
// Section 1: findFrontmatterSectionLine
// ---------------------------------------------------------------------------

suite("syncCodeLensProvider – findFrontmatterSectionLine", () => {
  test("findFrontmatterSectionLine: returns line number of named section in frontmatter", () => {
    // Arrange
    const text = "---\ngh-issues:\n  title: Hello\n---\n\nBody text\n";
    const doc = makeDocument(text);

    // Act
    const line = findFrontmatterSectionLine(doc as any, "gh-issues");

    // Assert
    assert.strictEqual(line, 1, "gh-issues: is on line 1 (0-indexed)");
  });

  test("findFrontmatterSectionLine: returns 0 when section not found", () => {
    // Arrange
    const text = "---\ngh-issues:\n  title: Hello\n---\n\nBody text\n";
    const doc = makeDocument(text);

    // Act
    const line = findFrontmatterSectionLine(doc as any, "tick-tick");

    // Assert
    assert.strictEqual(line, 0, "missing section falls back to line 0");
  });

  test("findFrontmatterSectionLine: returns 0 when no frontmatter", () => {
    // Arrange
    const text = "No frontmatter here\n\nJust body text\n";
    const doc = makeDocument(text);

    // Act
    const line = findFrontmatterSectionLine(doc as any, "gh-issues");

    // Assert
    assert.strictEqual(line, 0);
  });

  test("findFrontmatterSectionLine: finds section that is not the first key", () => {
    // Arrange
    const text =
      "---\nsome-other:\n  value: x\ngh-issues:\n  title: Hello\n---\n";
    const doc = makeDocument(text);

    // Act
    const line = findFrontmatterSectionLine(doc as any, "gh-issues");

    // Assert
    assert.strictEqual(line, 3, "gh-issues: is on line 3 (0-indexed)");
  });
});

// ---------------------------------------------------------------------------
// Section 2: isFileModified
// ---------------------------------------------------------------------------

suite("syncCodeLensProvider – isFileModified", () => {
  function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "codelens-test-"));
  }

  test("isFileModified: returns false when stateEntry is undefined", () => {
    // Arrange
    const dir = makeTempDir();
    const filePath = path.join(dir, "issue.task.md");
    fs.writeFileSync(filePath, "# Hello\n", "utf8");

    // Act
    const result = isFileModified(filePath, undefined);

    // Assert
    assert.strictEqual(result, false);
    fs.rmSync(dir, { recursive: true });
  });

  test("isFileModified: returns false when file mtime is older than local_written_at", () => {
    // Arrange
    const dir = makeTempDir();
    const filePath = path.join(dir, "issue.task.md");
    fs.writeFileSync(filePath, "# Hello\n", "utf8");
    // Set local_written_at to future (file appears old)
    const future = new Date(Date.now() + 60_000).toISOString();
    const stateEntry = { local_written_at: future };

    // Act
    const result = isFileModified(filePath, stateEntry);

    // Assert
    assert.strictEqual(
      result,
      false,
      "file is not modified when written_at is in the future",
    );
    fs.rmSync(dir, { recursive: true });
  });

  test("isFileModified: returns true when file mtime is newer than local_written_at", () => {
    // Arrange
    const dir = makeTempDir();
    const filePath = path.join(dir, "issue.task.md");
    // Set local_written_at to a time well in the past
    const past = new Date(Date.now() - 10_000).toISOString();
    fs.writeFileSync(filePath, "# Hello\n", "utf8");
    const stateEntry = { local_written_at: past };

    // Act
    const result = isFileModified(filePath, stateEntry);

    // Assert
    assert.strictEqual(
      result,
      true,
      "file is modified when mtime is newer than written_at",
    );
    fs.rmSync(dir, { recursive: true });
  });

  test("isFileModified: returns false when file does not exist", () => {
    // Arrange
    const filePath = "/nonexistent/path/issue.task.md";
    const stateEntry = {
      local_written_at: new Date(Date.now() - 5000).toISOString(),
    };

    // Act
    const result = isFileModified(filePath, stateEntry);

    // Assert
    assert.strictEqual(
      result,
      false,
      "missing file is not considered modified",
    );
  });
});

// ---------------------------------------------------------------------------
// Section 3: formatRelativeTime
// ---------------------------------------------------------------------------

suite("syncCodeLensProvider – formatRelativeTime", () => {
  test("formatRelativeTime: returns 'just now' for very recent timestamps", () => {
    // Arrange
    const date = new Date(Date.now() - 10_000);

    // Act
    const result = formatRelativeTime(date);

    // Assert
    assert.strictEqual(result, "just now");
  });

  test("formatRelativeTime: returns minutes ago for timestamps within the hour", () => {
    // Arrange
    const date = new Date(Date.now() - 5 * 60 * 1000);

    // Act
    const result = formatRelativeTime(date);

    // Assert
    assert.strictEqual(result, "5 minutes ago");
  });

  test("formatRelativeTime: returns hours ago for timestamps within a day", () => {
    // Arrange
    const date = new Date(Date.now() - 3 * 60 * 60 * 1000);

    // Act
    const result = formatRelativeTime(date);

    // Assert
    assert.strictEqual(result, "3 hours ago");
  });

  test("formatRelativeTime: returns days ago for older timestamps", () => {
    // Arrange
    const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    // Act
    const result = formatRelativeTime(date);

    // Assert
    assert.strictEqual(result, "2 days ago");
  });

  test("formatRelativeTime: returns 'just now' for future timestamps", () => {
    // Arrange
    const date = new Date(Date.now() + 60_000);

    // Act
    const result = formatRelativeTime(date);

    // Assert
    assert.strictEqual(result, "just now");
  });
});
