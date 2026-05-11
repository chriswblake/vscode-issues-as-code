import * as assert from "assert";
import { formatTimestamp } from "../src/statusBarManager";

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------
suite("statusBarManager – formatTimestamp", () => {
  test("formatTimestamp: returns 'just now' for very recent timestamps", () => {
    // Arrange
    const recent = new Date(Date.now() - 10 * 1000);

    // Act
    const result = formatTimestamp(recent);

    // Assert
    assert.strictEqual(result, "just now");
  });

  test("formatTimestamp: returns 'just now' for future timestamps", () => {
    // Arrange
    const future = new Date(Date.now() + 60000);

    // Act
    const result = formatTimestamp(future);

    // Assert
    assert.strictEqual(result, "just now");
  });

  test("formatTimestamp: returns minutes for recent timestamps", () => {
    // Arrange
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

    // Act
    const result = formatTimestamp(fiveMinAgo);

    // Assert
    assert.strictEqual(result, "5 min ago");
  });

  test("formatTimestamp: returns hours for older timestamps", () => {
    // Arrange
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

    // Act
    const result = formatTimestamp(threeHoursAgo);

    // Assert
    assert.strictEqual(result, "3h ago");
  });

  test("formatTimestamp: returns date string for very old timestamps", () => {
    // Arrange
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    // Act
    const result = formatTimestamp(twoDaysAgo);

    // Assert
    assert.ok(
      result.includes("/") || result.includes("-") || result.includes("."),
      `Expected a date string, got: ${result}`,
    );
  });
});
