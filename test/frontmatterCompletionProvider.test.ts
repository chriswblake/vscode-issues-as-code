import * as assert from "assert";
import { getFrontmatterContext } from "../src/frontmatterCompletionProvider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDocumentAndPosition(
  text: string,
  line: number,
  character: number = 0,
): {
  document: { getText(): string };
  position: { line: number; character: number };
} {
  return {
    document: { getText: () => text },
    position: { line, character },
  };
}

// ---------------------------------------------------------------------------
// Section 1: getFrontmatterContext – basic detection
// ---------------------------------------------------------------------------

suite("frontmatterCompletionProvider – getFrontmatterContext", () => {
  test("getFrontmatterContext: returns undefined outside front matter", () => {
    // Arrange
    const text = "---\ngh-issues:\n  state: open\n---\n\nBody text here\n";
    const { document, position } = makeDocumentAndPosition(text, 5);

    // Act
    const result = getFrontmatterContext(document as any, position as any);

    // Assert
    assert.strictEqual(
      result,
      undefined,
      "outside front matter should return undefined",
    );
  });

  test("getFrontmatterContext: returns undefined when no front matter", () => {
    // Arrange
    const text = "Just a body with no front matter\n";
    const { document, position } = makeDocumentAndPosition(text, 0);

    // Act
    const result = getFrontmatterContext(document as any, position as any);

    // Assert
    assert.strictEqual(result, undefined);
  });

  test("getFrontmatterContext: detects state field inside gh-issues section", () => {
    // Arrange
    const text = "---\ngh-issues:\n  state: |\n---\n";
    // Cursor on "  state: " line (line 2)
    const { document, position } = makeDocumentAndPosition(text, 2);

    // Act
    const result = getFrontmatterContext(document as any, position as any);

    // Assert
    assert.ok(result, "should detect context");
    assert.strictEqual(result!.section, "gh-issues");
    assert.strictEqual(result!.field, "state");
  });

  test("getFrontmatterContext: detects labels field inside gh-issues section", () => {
    // Arrange
    const text = "---\ngh-issues:\n  labels:\n    - \n---\n";
    // Cursor on the list item line (line 3)
    const { document, position } = makeDocumentAndPosition(text, 3);

    // Act
    const result = getFrontmatterContext(document as any, position as any);

    // Assert
    assert.ok(result, "should detect context for list item");
    assert.strictEqual(result!.section, "gh-issues");
    assert.strictEqual(result!.field, "labels");
  });

  test("getFrontmatterContext: detects assignees field inside gh-issues section", () => {
    // Arrange
    const text = "---\ngh-issues:\n  assignees:\n    - \n---\n";
    // Cursor on the list item line (line 3)
    const { document, position } = makeDocumentAndPosition(text, 3);

    // Act
    const result = getFrontmatterContext(document as any, position as any);

    // Assert
    assert.ok(result, "should detect context");
    assert.strictEqual(result!.section, "gh-issues");
    assert.strictEqual(result!.field, "assignees");
  });

  test("getFrontmatterContext: returns undefined on the closing delimiter line", () => {
    // Arrange
    const text = "---\ngh-issues:\n  state: open\n---\n";
    // Cursor on closing --- (line 3)
    const { document, position } = makeDocumentAndPosition(text, 3);

    // Act
    const result = getFrontmatterContext(document as any, position as any);

    // Assert
    assert.strictEqual(
      result,
      undefined,
      "cursor on closing --- should be undefined",
    );
  });

  test("getFrontmatterContext: returns undefined on the opening delimiter line", () => {
    // Arrange
    const text = "---\ngh-issues:\n  state: open\n---\n";
    // Cursor on opening --- (line 0)
    const { document, position } = makeDocumentAndPosition(text, 0);

    // Act
    const result = getFrontmatterContext(document as any, position as any);

    // Assert
    assert.strictEqual(
      result,
      undefined,
      "cursor on opening --- should be undefined",
    );
  });
});
