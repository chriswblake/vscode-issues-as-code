import type * as vscodeType from 'vscode';
import { type RateLimitInfo, type RateLimitBucket, formatResetTime } from './rateLimitMonitor';

// Lazy vscode import so unit tests can run without a VS Code instance
function vscode(): typeof vscodeType {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('vscode');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncTargetSummary {
  name: string;
  trackedIssueCount: number;
  lastFetchTime: Date | null;
  nextFetchTime: Date | null;
}

export interface SyncSummary {
  targets: SyncTargetSummary[];
  rateLimits: Map<RateLimitBucket, RateLimitInfo>;
  isPaused: boolean;
  pauseReason: string | null;
}

// ---------------------------------------------------------------------------
// StatusBarManager
// ---------------------------------------------------------------------------

/**
 * Manages the status bar icon and its interactions.
 * Shows a checklist icon in the status bar with a rich tooltip on hover.
 *
 * This is a pure display class — it renders data pushed to it via update().
 */
export class StatusBarManager {
  private statusBarItem: vscodeType.StatusBarItem | undefined;
  private lastSummary: SyncSummary | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Create the status bar item and wire up the click command. */
  createStatusBar(
    context: vscodeType.ExtensionContext, //
    commandId: string,
  ): void {
    const vs = vscode();
    this.statusBarItem = vs.window.createStatusBarItem(vs.StatusBarAlignment.Right, 50);
    this.statusBarItem.command = commandId;
    this.statusBarItem.text = '$(checklist)';
    this.statusBarItem.tooltip = 'Issues as Code — no sync data yet';
    this.statusBarItem.show();
    context.subscriptions.push(this.statusBarItem);
  }

  /** Push a new sync summary snapshot. Refreshes icon + tooltip. */
  update(summary: SyncSummary): void {
    this.lastSummary = summary;
    this.refreshStatusBar();
  }

  /** Show or hide the status bar icon based on config. */
  setVisible(visible: boolean): void {
    if (this.statusBarItem) {
      if (visible) {
        this.statusBarItem.show();
      } else {
        this.statusBarItem.hide();
      }
    }
  }

  /**
   * Refreshes the tooltip panel content.
   * Called when the user clicks the status bar icon.
   * The panel appears as a floating tooltip next to the status bar on hover.
   */
  showPanel(): void {
    this.refreshStatusBar();
  }

  /** Clean up the status bar item. */
  dispose(): void {
    this.statusBarItem?.dispose();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private refreshStatusBar(): void {
    if (!this.statusBarItem) {
      return;
    }

    const vs = vscode();
    const summary = this.lastSummary;

    if (summary?.isPaused) {
      this.statusBarItem.text = '$(warning)';
      this.statusBarItem.tooltip = this.buildRichTooltip(summary);
      this.statusBarItem.backgroundColor = new vs.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    this.statusBarItem.text = '$(checklist)';
    this.statusBarItem.backgroundColor = undefined;

    if (summary) {
      this.statusBarItem.tooltip = this.buildRichTooltip(summary);
    }
  }

  private buildRichTooltip(summary: SyncSummary): vscodeType.MarkdownString {
    const vs = vscode();
    const md = new vs.MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = true;

    // Title
    md.appendMarkdown('**Issues as Code**\n\n---\n\n');

    // Sync targets — compact table-like layout
    if (summary.targets.length === 0) {
      md.appendMarkdown('*No sync targets configured.*\n\n');
    } else {
      for (const target of summary.targets) {
        const lastFetchStr = target.lastFetchTime ? formatTimestamp(target.lastFetchTime) : 'never';
        const nextFetchStr = target.nextFetchTime ? formatResetTime(target.nextFetchTime) : '—';

        // Each target is one dense line: icon name · count · timing
        md.appendMarkdown(`$(folder) **${target.name}** — ${target.trackedIssueCount} issues · fetched ${lastFetchStr} · next ${nextFetchStr}\n\n`);
      }
    }

    // API quota — single compact line per bucket
    if (summary.rateLimits.size > 0) {
      md.appendMarkdown('---\n\n');
      for (const [bucket, info] of summary.rateLimits) {
        const remainPct = info.limit > 0 ? (((info.limit - info.used) / info.limit) * 100).toFixed(0) : '—';
        const resetDate = new Date(info.resetEpoch * 1000);
        const resetStr = formatResetTime(resetDate);
        const label = bucket === 'core' ? 'REST API' : 'Search API';

        md.appendMarkdown(`${label}: **${remainPct}%** remaining · resets ${resetStr}\n\n`);
      }
    }

    // Pause warning
    if (summary.isPaused) {
      md.appendMarkdown('---\n\n');
      md.appendMarkdown(`$(warning) **Syncing paused** — ${summary.pauseReason}\n`);
    }

    return md;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Formats a timestamp as a human-readable relative or absolute string. */
export function formatTimestamp(date: Date): string {
  const diffMs = Date.now() - date.getTime();

  if (diffMs < 0) {
    return 'just now';
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return 'just now';
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return date.toLocaleDateString();
}
