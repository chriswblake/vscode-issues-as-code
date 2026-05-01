import type { IssueFrontmatter } from '../fileManager';
import type { SyncStateManager, SyncStateEntry, RemoteIssueInfo } from '../syncStateManager';

// ---------------------------------------------------------------------------
// Plugin result types
// ---------------------------------------------------------------------------

/** Represents one remote item fetched during a pull operation. */
export interface PullItem {
  /** Unique remote identifier (e.g. "owner/repo/42" for gh-issues). */
  remoteKey: string;
  /** Data used to render the file name from the naming template. */
  namingTokens: Record<string, string | number>;
  /** Frontmatter section owned by this plugin (merged into the file's frontmatter). */
  frontmatter: Record<string, unknown>;
  /** File body content (only primary plugins provide this). */
  body: string;
  /** Remote revision info for conflict detection. */
  remoteInfo: RemoteIssueInfo;
}

/** Result of a push operation. */
export interface PushResult {
  /** Updated remote info after the push. */
  remoteInfo: RemoteIssueInfo;
  /** The unique remote key for this item (e.g. "owner/repo/42"). */
  remoteKey: string;
  /** Updated frontmatter section for this plugin (editable fields only). */
  frontmatter: Record<string, unknown>;
  /** Updated naming tokens (e.g. if title changed on create). */
  namingTokens: Record<string, string | number>;
  /** Updated body (e.g. after server-side normalization). */
  body: string;
}

// ---------------------------------------------------------------------------
// Plugin context (provided by the sync manager to each plugin call)
// ---------------------------------------------------------------------------

export interface PluginContext {
  /** The workspace folder path. */
  workspaceFolderPath: string;
  /** Access to the sync state for this workspace. */
  stateManager: SyncStateManager;
}

// ---------------------------------------------------------------------------
// Primary Sync Plugin — owns file body, title, creation, and naming
// ---------------------------------------------------------------------------

/**
 * A primary sync plugin provides the source of truth for task file content.
 * Each sync target has exactly one primary plugin (e.g. gh-issues).
 * The primary plugin owns: body content, naming tokens, and create/update.
 */
export interface PrimarySyncPlugin {
  /** Plugin identifier matching the config key (e.g. 'gh-issues'). */
  readonly id: string;

  /** Human-readable display name (e.g. 'GitHub Issues'). */
  readonly displayName: string;

  /**
   * Discovers and fetches remote items matching the target's plugin config.
   * Returns one PullItem per remote task/issue.
   */
  pull(pluginConfig: Record<string, unknown>, context: PluginContext): Promise<PullItem[]>;

  /**
   * Pushes a local file's content to the remote service.
   * For existing items, remoteKey identifies the remote resource.
   * For new items, remoteKey is undefined.
   */
  push(
    frontmatter: IssueFrontmatter, //
    body: string,
    pluginConfig: Record<string, unknown>,
    context: PluginContext,
    remoteKey?: string,
  ): Promise<PushResult>;

  /**
   * Renders a filename from the naming template and remote data tokens.
   * Handles slug generation and character sanitization.
   */
  buildFileName(namingTokens: Record<string, string | number>, template: string): string;

  /**
   * Returns the plugin-specific numeric/string ID, indicating the file is published.
   * Checks the state entry first (preferred), falls back to frontmatter for legacy files.
   */
  getRemoteId(frontmatter: IssueFrontmatter, stateEntry?: SyncStateEntry): number | string | undefined;

  /**
   * Returns the unique remote key for a file (e.g. "owner/repo/42").
   * Checks the state entry first, falls back to frontmatter + config.
   */
  getRemoteKey(frontmatter: IssueFrontmatter, pluginConfig: Record<string, unknown>, stateEntry?: SyncStateEntry): string | undefined;

  /**
   * Finds an existing local file matching a remote item by name/frontmatter heuristic.
   * Called as a fallback when the sync state doesn't track the file yet.
   * Returns the full file path or null.
   */
  findExistingFile(
    filesDir: string, //
    remoteKey: string,
    naming: string,
  ): Promise<string | null>;

  /**
   * Infers a title for a new file that has no explicit title in frontmatter.
   * Used when creating a new remote item from a local file.
   */
  inferTitle(filePath: string, frontmatter: IssueFrontmatter, body: string): string;
}

// ---------------------------------------------------------------------------
// Metadata Plugin — enriches frontmatter without owning body/naming
// ---------------------------------------------------------------------------

/**
 * A metadata plugin enriches files with additional data from an external service
 * (e.g. GitHub Projects fields). It does not own the file body or naming.
 */
export interface MetadataPlugin {
  /** Plugin identifier matching the config key (e.g. 'gh-projects'). */
  readonly id: string;

  /**
   * Fetches metadata for an item identified by the primary plugin's remote info.
   * Returns the frontmatter section to merge under this plugin's namespace.
   */
  enrich(
    primaryFrontmatter: Record<string, unknown>, //
    pluginConfig: Record<string, unknown>,
    context: PluginContext,
    remoteInfo?: RemoteIssueInfo,
  ): Promise<Record<string, unknown> | null>;
}

// ---------------------------------------------------------------------------
// Plugin registry
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plugin Bootstrap — generic interface for plugin initialization
// ---------------------------------------------------------------------------

/**
 * Each plugin package exports a bootstrap that handles initialization,
 * command registration, and default target generation.
 */
export interface PluginBootstrap {
  /** Plugin identifier (must match PrimarySyncPlugin.id). */
  readonly pluginId: string;

  /**
   * Initialize the plugin (e.g. authenticate) and register it in the registry.
   * Returns true if the plugin was successfully initialized.
   */
  initialize(): Promise<boolean>;

  /**
   * Register plugin-specific VS Code commands.
   * Called once during activation.
   */
  registerCommands(
    context: { subscriptions: { dispose(): void }[] },
    reinitialize: () => Promise<void>,
  ): void;

  /**
   * Attempt to detect default sync targets for a workspace folder.
   * Returns null if this plugin cannot provide defaults for the folder.
   */
  detectDefaults(workspaceFolder: { uri: { fsPath: string } }): Promise<import('../configManager').SyncTarget[] | null>;
}

// ---------------------------------------------------------------------------
// Plugin Registry — lookup plugins by ID for multi-plugin scenarios
// ---------------------------------------------------------------------------

const primaryPlugins = new Map<string, PrimarySyncPlugin>();
const metadataPlugins = new Map<string, MetadataPlugin>();

export function registerPrimaryPlugin(plugin: PrimarySyncPlugin): void {
  primaryPlugins.set(plugin.id, plugin);
}

export function registerMetadataPlugin(plugin: MetadataPlugin): void {
  metadataPlugins.set(plugin.id, plugin);
}

export function getPrimaryPlugin(id: string): PrimarySyncPlugin | undefined {
  return primaryPlugins.get(id);
}

export function getMetadataPlugin(id: string): MetadataPlugin | undefined {
  return metadataPlugins.get(id);
}

/** Returns all registered primary plugin IDs. */
export function getPrimaryPluginIds(): string[] {
  return [...primaryPlugins.keys()];
}

/** Returns all registered metadata plugin IDs. */
export function getMetadataPluginIds(): string[] {
  return [...metadataPlugins.keys()];
}
