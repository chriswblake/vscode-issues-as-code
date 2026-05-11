import type * as vscodeType from "vscode";

// Lazy vscode import so unit tests can run without a VS Code instance
function vscode(): typeof vscodeType {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("vscode");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** GitHub rate limit buckets we track independently. */
export type RateLimitBucket = "core" | "search";

export interface RateLimitInfo {
  bucket: RateLimitBucket;
  limit: number;
  remaining: number;
  used: number;
  /** Unix timestamp (seconds) when the limit resets. */
  resetEpoch: number;
}

/** Callback type for change notifications. */
export type RateLimitChangeListener = () => void;

// ---------------------------------------------------------------------------
// RateLimitMonitor
// ---------------------------------------------------------------------------

/**
 * Tracks GitHub API rate limits per bucket (core, search) and pauses
 * automatic syncing when the remaining quota drops below a threshold.
 *
 * - Updates passively from API response headers (no extra API calls).
 * - Pauses automatic syncs when quota is critically low.
 * - Manual user actions (Sync Now, Publish, Pull Changes) are allowed
 *   with a confirmation prompt.
 * - Notifies listeners on state changes so the UI layer can react.
 */
export class RateLimitMonitor {
  private buckets = new Map<RateLimitBucket, RateLimitInfo>();
  private resumeTimer: NodeJS.Timeout | null = null;
  private _isPaused = false;
  private _pauseReason: string | null = null;
  private changeListeners: RateLimitChangeListener[] = [];

  /** Percentage threshold (0–100). Syncing pauses when remaining% <= this. */
  private threshold: number;

  constructor(threshold: number = 5) {
    this.threshold = threshold;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Whether automatic syncing is paused due to low quota. */
  get isPaused(): boolean {
    return this._isPaused;
  }

  /** Human-readable reason for the current pause, or null. */
  get pauseReason(): string | null {
    return this._pauseReason;
  }

  /** Update the threshold (e.g. when config changes). */
  setThreshold(threshold: number): void {
    this.threshold = threshold;
    this.reevaluatePauseState();
  }

  /** Called after each GitHub API response to update rate limit state. */
  update(info: RateLimitInfo): void {
    this.buckets.set(info.bucket, info);
    this.reevaluatePauseState();
    this.notifyChange();
  }

  /** Returns the current rate limit info for all tracked buckets. */
  getBucketInfo(): Map<RateLimitBucket, RateLimitInfo> {
    return new Map(this.buckets);
  }

  /** Register a listener that fires whenever rate limit state changes. */
  onDidChange(listener: RateLimitChangeListener): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  /** Clean up timers. */
  dispose(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    this.changeListeners = [];
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private reevaluatePauseState(): void {
    const wasPaused = this._isPaused;
    let shouldPause = false;
    let reason: string | null = null;

    for (const [bucket, info] of this.buckets) {
      if (info.limit === 0) {
        continue;
      }
      const pct = (info.remaining / info.limit) * 100;
      if (pct <= this.threshold) {
        shouldPause = true;
        const resetDate = new Date(info.resetEpoch * 1000);
        reason = `${bucket} API quota at ${pct.toFixed(1)}% (${info.remaining}/${info.limit}). Resets ${formatResetTime(resetDate)}.`;
        break;
      }
    }

    this._isPaused = shouldPause;
    this._pauseReason = reason;

    // Transition to paused: show warning and schedule resume
    if (shouldPause && !wasPaused) {
      this.onPaused();
    }
    // Transition to resumed
    if (!shouldPause && wasPaused) {
      this.onResumed();
    }
  }

  private onPaused(): void {
    try {
      void vscode().window.showWarningMessage(
        `Issues as Code: Automatic syncing paused — ${this._pauseReason}`,
      );
    } catch {
      // VS Code unavailable (tests)
    }

    // Schedule auto-resume at the earliest reset time
    this.scheduleResume();
  }

  private onResumed(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  private scheduleResume(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
    }

    // Find the earliest reset across all over-threshold buckets
    let earliestReset = Infinity;
    for (const [, info] of this.buckets) {
      if (info.limit > 0) {
        const pct = (info.remaining / info.limit) * 100;
        if (pct <= this.threshold && info.resetEpoch < earliestReset) {
          earliestReset = info.resetEpoch;
        }
      }
    }

    if (earliestReset === Infinity) {
      return;
    }

    const delayMs = Math.max(0, earliestReset * 1000 - Date.now()) + 5000;
    this.resumeTimer = setTimeout(() => {
      // Reset buckets that have passed their reset time
      for (const [bucket, info] of this.buckets) {
        if (info.resetEpoch * 1000 <= Date.now()) {
          this.buckets.set(bucket, {
            ...info,
            remaining: info.limit,
            used: 0,
          });
        }
      }
      this.reevaluatePauseState();
      this.notifyChange();
    }, delayMs);
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Formats a reset time as relative or absolute depending on distance. */
export function formatResetTime(resetDate: Date): string {
  const diffMs = resetDate.getTime() - Date.now();

  if (diffMs <= 0) {
    return "now";
  }

  const minutes = Math.ceil(diffMs / 60000);
  if (minutes <= 60) {
    return `in ${minutes} min`;
  }

  return `at ${resetDate.toLocaleTimeString()}`;
}

/**
 * Extracts rate limit info from GitHub API response headers.
 * Returns null if headers are missing (e.g. non-GitHub responses).
 */
export function parseRateLimitHeaders(
  headers: Record<string, string | undefined>,
  requestPath?: string,
): RateLimitInfo | null {
  const limit = headers["x-ratelimit-limit"];
  const remaining = headers["x-ratelimit-remaining"];
  const reset = headers["x-ratelimit-reset"];
  const used = headers["x-ratelimit-used"];

  if (limit === undefined || remaining === undefined || reset === undefined) {
    return null;
  }

  // Determine bucket from the x-ratelimit-resource header or request path
  const resource = headers["x-ratelimit-resource"];
  let bucket: RateLimitBucket = "core";
  if (resource === "search" || requestPath?.includes("/search/")) {
    bucket = "search";
  }

  return {
    bucket,
    limit: parseInt(limit, 10),
    remaining: parseInt(remaining, 10),
    used: used !== undefined ? parseInt(used, 10) : 0,
    resetEpoch: parseInt(reset, 10),
  };
}
