import type { IssueFrontmatter } from "../../fileManager";
import type { SyncStateEntry } from "../../syncStateManager";
import type {
  PrimarySyncPlugin,
  PullItem,
  PushResult,
  PluginContext,
} from "../../pluginTypes";

// ---------------------------------------------------------------------------
// TickTick plugin (placeholder)
// ---------------------------------------------------------------------------

/**
 * Placeholder plugin for TickTick task sync.
 * Not yet implemented — serves as a template for future integration.
 */
export class TickTickPlugin implements PrimarySyncPlugin {
  readonly id = "tick-tick";
  readonly displayName = "TickTick";
  readonly defaultFileName = "{tick-tick.title}";

  async pull(
    _pluginConfig: Record<string, unknown>,
    _context: PluginContext,
  ): Promise<PullItem[]> {
    console.warn("[issuesAsCode] TickTick plugin is not yet implemented.");
    return [];
  }

  async push(
    _frontmatter: IssueFrontmatter, //
    _body: string,
    _pluginConfig: Record<string, unknown>,
    _context: PluginContext,
    _remoteKey?: string,
  ): Promise<PushResult> {
    throw new Error("TickTick plugin is not yet implemented.");
  }

  buildFileName(
    _namingTokens: Record<string, string | number>,
    template: string,
  ): string {
    return template.replace(/\{[^}]+\}/g, "untitled");
  }

  getRemoteId(
    _frontmatter: IssueFrontmatter,
    _stateEntry?: SyncStateEntry,
  ): undefined {
    return undefined;
  }

  getRemoteKey(
    _frontmatter: IssueFrontmatter,
    _pluginConfig: Record<string, unknown>,
    _stateEntry?: SyncStateEntry,
  ): undefined {
    return undefined;
  }

  async findExistingFile(
    _filesDir: string,
    _remoteKey: string,
    _naming: string,
  ): Promise<string | null> {
    return null;
  }

  inferTitle(
    filePath: string,
    _frontmatter: IssueFrontmatter,
    _body: string,
  ): string {
    const path = require("path");
    return path.basename(filePath, path.extname(filePath)).trim() || "New task";
  }

  validatePulledItems(
    items: PullItem[],
    _pluginConfig: Record<string, unknown>,
  ): PullItem[] {
    // TickTick plugin has no filter criteria, so all items are valid.
    return items;
  }

  fileMatchesTargetConfig(
    _frontmatter: IssueFrontmatter,
    _pluginConfig: Record<string, unknown>,
    _syncedAt?: string,
  ): boolean {
    // TickTick plugin has no filter criteria, so all files are valid.
    return true;
  }
}
