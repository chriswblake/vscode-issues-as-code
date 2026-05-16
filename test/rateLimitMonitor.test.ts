import * as assert from "assert";
import {
  RateLimitMonitor,
  formatResetTime,
  type RateLimitInfo,
} from "../src/rateLimitMonitor";
import { parseRateLimitHeaders } from "../src/plugins/gh-issues/githubClient";

// ---------------------------------------------------------------------------
// parseRateLimitHeaders
// ---------------------------------------------------------------------------
suite("rateLimitMonitor – parseRateLimitHeaders", () => {
  test("parseRateLimitHeaders: extracts core bucket from standard headers", () => {
    // Arrange
    const headers: Record<string, string | undefined> = {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": "1700000000",
      "x-ratelimit-used": "10",
      "x-ratelimit-resource": "core",
    };

    // Act
    const result = parseRateLimitHeaders(headers);

    // Assert
    assert.deepStrictEqual(result, {
      bucket: "gh-issues:core",
      limit: 5000,
      remaining: 4990,
      used: 10,
      resetEpoch: 1700000000,
    });
  });

  test("parseRateLimitHeaders: detects search bucket from resource header", () => {
    // Arrange
    const headers: Record<string, string | undefined> = {
      "x-ratelimit-limit": "30",
      "x-ratelimit-remaining": "25",
      "x-ratelimit-reset": "1700000000",
      "x-ratelimit-used": "5",
      "x-ratelimit-resource": "search",
    };

    // Act
    const result = parseRateLimitHeaders(headers);

    // Assert
    assert.strictEqual(result?.bucket, "gh-issues:search");
  });

  test("parseRateLimitHeaders: detects search bucket from request path", () => {
    // Arrange
    const headers: Record<string, string | undefined> = {
      "x-ratelimit-limit": "30",
      "x-ratelimit-remaining": "25",
      "x-ratelimit-reset": "1700000000",
    };

    // Act
    const result = parseRateLimitHeaders(
      headers,
      "https://api.github.com/search/issues?q=test",
    );

    // Assert
    assert.strictEqual(result?.bucket, "gh-issues:search");
  });

  test("parseRateLimitHeaders: returns null when headers are missing", () => {
    // Arrange
    const headers: Record<string, string | undefined> = {
      "content-type": "application/json",
    };

    // Act
    const result = parseRateLimitHeaders(headers);

    // Assert
    assert.strictEqual(result, null);
  });

  test("parseRateLimitHeaders: defaults used to 0 when header is absent", () => {
    // Arrange
    const headers: Record<string, string | undefined> = {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": "1700000000",
    };

    // Act
    const result = parseRateLimitHeaders(headers);

    // Assert
    assert.strictEqual(result?.used, 0);
  });
});

// ---------------------------------------------------------------------------
// RateLimitMonitor – pause/resume logic
// ---------------------------------------------------------------------------
suite("rateLimitMonitor – pause/resume logic", () => {
  test("isPaused: false by default with no data", () => {
    // Arrange
    const monitor = new RateLimitMonitor(5);

    // Assert
    assert.strictEqual(monitor.isPaused, false);
    assert.strictEqual(monitor.pauseReason, null);
  });

  test("isPaused: false when quota is above threshold", () => {
    // Arrange
    const monitor = new RateLimitMonitor(5);

    // Act
    monitor.update({
      bucket: "core",
      limit: 5000,
      remaining: 4000,
      used: 1000,
      resetEpoch: Math.floor(Date.now() / 1000) + 3600,
    });

    // Assert
    assert.strictEqual(monitor.isPaused, false);
  });

  test("isPaused: true when quota drops to threshold", () => {
    // Arrange
    const monitor = new RateLimitMonitor(5);

    // Act
    monitor.update({
      bucket: "core",
      limit: 5000,
      remaining: 250, // exactly 5%
      used: 4750,
      resetEpoch: Math.floor(Date.now() / 1000) + 3600,
    });

    // Assert
    assert.strictEqual(monitor.isPaused, true);
    assert.ok(monitor.pauseReason?.includes("core"));
  });

  test("isPaused: true when quota drops below threshold", () => {
    // Arrange
    const monitor = new RateLimitMonitor(10);

    // Act
    monitor.update({
      bucket: "core",
      limit: 5000,
      remaining: 100, // 2%, below 10% threshold
      used: 4900,
      resetEpoch: Math.floor(Date.now() / 1000) + 3600,
    });

    // Assert
    assert.strictEqual(monitor.isPaused, true);
  });

  test("isPaused: triggered by search bucket independently", () => {
    // Arrange
    const monitor = new RateLimitMonitor(10);

    // Act – core is fine, search is low
    monitor.update({
      bucket: "core",
      limit: 5000,
      remaining: 4000,
      used: 1000,
      resetEpoch: Math.floor(Date.now() / 1000) + 3600,
    });
    monitor.update({
      bucket: "search",
      limit: 30,
      remaining: 1, // 3.3%, below 10%
      used: 29,
      resetEpoch: Math.floor(Date.now() / 1000) + 3600,
    });

    // Assert
    assert.strictEqual(monitor.isPaused, true);
    assert.ok(monitor.pauseReason?.includes("search"));
  });

  test("setThreshold: re-evaluates pause state", () => {
    // Arrange
    const monitor = new RateLimitMonitor(5);
    monitor.update({
      bucket: "core",
      limit: 5000,
      remaining: 400, // 8%
      used: 4600,
      resetEpoch: Math.floor(Date.now() / 1000) + 3600,
    });
    assert.strictEqual(monitor.isPaused, false); // 8% > 5%

    // Act – raise threshold to 10%
    monitor.setThreshold(10);

    // Assert – 8% < 10%, now paused
    assert.strictEqual(monitor.isPaused, true);
  });

  test("getBucketInfo: returns all tracked buckets", () => {
    // Arrange
    const monitor = new RateLimitMonitor(5);
    const coreInfo: RateLimitInfo = {
      bucket: "core",
      limit: 5000,
      remaining: 4000,
      used: 1000,
      resetEpoch: 1700000000,
    };
    const searchInfo: RateLimitInfo = {
      bucket: "search",
      limit: 30,
      remaining: 20,
      used: 10,
      resetEpoch: 1700000000,
    };

    // Act
    monitor.update(coreInfo);
    monitor.update(searchInfo);

    // Assert
    const buckets = monitor.getBucketInfo();
    assert.strictEqual(buckets.size, 2);
    assert.deepStrictEqual(buckets.get("core"), coreInfo);
    assert.deepStrictEqual(buckets.get("search"), searchInfo);
  });

  test("dispose: cleans up without errors", () => {
    // Arrange
    const monitor = new RateLimitMonitor(5);
    monitor.update({
      bucket: "core",
      limit: 5000,
      remaining: 100,
      used: 4900,
      resetEpoch: Math.floor(Date.now() / 1000) + 3600,
    });

    // Act & Assert – should not throw
    monitor.dispose();
    assert.strictEqual(monitor.isPaused, true); // state preserved after dispose
  });

  test("onDidChange: listener fires on update", () => {
    // Arrange
    const monitor = new RateLimitMonitor(5);
    let callCount = 0;
    monitor.onDidChange(() => {
      callCount++;
    });

    // Act
    monitor.update({
      bucket: "core",
      limit: 5000,
      remaining: 4000,
      used: 1000,
      resetEpoch: Math.floor(Date.now() / 1000) + 3600,
    });

    // Assert
    assert.strictEqual(callCount, 1);
  });

  test("onDidChange: unsubscribe stops notifications", () => {
    // Arrange
    const monitor = new RateLimitMonitor(5);
    let callCount = 0;
    const unsubscribe = monitor.onDidChange(() => {
      callCount++;
    });

    // Act
    monitor.update({
      bucket: "core",
      limit: 5000,
      remaining: 4000,
      used: 1000,
      resetEpoch: Math.floor(Date.now() / 1000) + 3600,
    });
    unsubscribe();
    monitor.update({
      bucket: "core",
      limit: 5000,
      remaining: 3000,
      used: 2000,
      resetEpoch: Math.floor(Date.now() / 1000) + 3600,
    });

    // Assert
    assert.strictEqual(callCount, 1);
  });
});

// ---------------------------------------------------------------------------
// formatResetTime
// ---------------------------------------------------------------------------
suite("rateLimitMonitor – formatResetTime", () => {
  test("formatResetTime: returns 'now' for past dates", () => {
    // Arrange
    const pastDate = new Date(Date.now() - 60000);

    // Act
    const result = formatResetTime(pastDate);

    // Assert
    assert.strictEqual(result, "now");
  });

  test("formatResetTime: returns minutes for near-future dates", () => {
    // Arrange
    const futureDate = new Date(Date.now() + 15 * 60 * 1000);

    // Act
    const result = formatResetTime(futureDate);

    // Assert
    assert.ok(result.startsWith("in "));
    assert.ok(result.endsWith(" min"));
  });

  test("formatResetTime: returns absolute time for far-future dates", () => {
    // Arrange
    const farFuture = new Date(Date.now() + 2 * 60 * 60 * 1000);

    // Act
    const result = formatResetTime(farFuture);

    // Assert
    assert.ok(result.startsWith("at "));
  });
});
