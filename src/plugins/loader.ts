/**
 * Plugin loader — dynamically discovers and initializes all available plugins.
 * Extension.ts calls these generic functions without knowing which plugins exist.
 */
import type { SyncTarget } from "../configManager";
import type {
  PluginBootstrap,
  IncludedSyncTargetConfig,
  PluginProviderContext,
} from "../pluginTypes";

// Import all available plugin bootstraps here.
// Adding a new plugin = adding one import + one array entry.
import { bootstrap as ghIssuesBootstrap } from "./gh-issues";

const allBootstraps: PluginBootstrap[] = [ghIssuesBootstrap];

// ---------------------------------------------------------------------------
// Included config item with plugin metadata for QuickPick display
// ---------------------------------------------------------------------------

export interface IncludedConfigItem {
  /** Plugin display name (e.g. "GitHub Issues"). */
  pluginDisplayName: string;
  /** The included config from the plugin. */
  config: IncludedSyncTargetConfig;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize all plugins (authenticate, register in the registry).
 * Returns the list of plugin IDs that were successfully initialized.
 */
export async function initializePlugins(): Promise<string[]> {
  const initialized: string[] = [];
  for (const b of allBootstraps) {
    const ok = await b.initialize();
    if (ok) {
      initialized.push(b.pluginId);
    }
  }
  return initialized;
}

/**
 * Register all plugin-specific VS Code commands.
 */
export function registerPluginCommands(
  context: { subscriptions: { dispose(): void }[] },
  reinitialize: () => Promise<void>,
): void {
  for (const b of allBootstraps) {
    b.registerCommands(context, reinitialize);
  }
}

/**
 * Register all plugin-specific VS Code providers (completions, decorations, etc.).
 */
export function registerPluginProviders(
  providerContext: PluginProviderContext,
): void {
  for (const b of allBootstraps) {
    b.registerProviders(providerContext);
  }
}

/**
 * Collect included sync target configs from all plugins for a workspace folder.
 * Each item includes the plugin display name for QuickPick prefixing.
 */
export async function getAllIncludedConfigs(workspaceFolder: {
  uri: { fsPath: string };
}): Promise<IncludedConfigItem[]> {
  const items: IncludedConfigItem[] = [];
  for (const b of allBootstraps) {
    const configs = await b.getIncludedConfigs(workspaceFolder);
    for (const config of configs) {
      items.push({ pluginDisplayName: b.displayName, config });
    }
  }
  return items;
}

/**
 * Detect default sync targets for a workspace folder.
 * Tries each plugin until one returns defaults.
 */
export async function detectDefaultTargets(workspaceFolder: {
  uri: { fsPath: string };
}): Promise<SyncTarget[] | null> {
  for (const b of allBootstraps) {
    const targets = await b.detectDefaults(workspaceFolder);
    if (targets && targets.length > 0) {
      return targets;
    }
  }
  return null;
}

/**
 * Persist default sync targets to workspace settings if none are configured.
 * Tries each plugin until one persists defaults.
 */
export async function persistDefaultTargets(workspaceFolder: {
  uri: { fsPath: string };
}): Promise<SyncTarget[] | null> {
  for (const b of allBootstraps) {
    const targets = await b.persistDefaults(workspaceFolder);
    if (targets && targets.length > 0) {
      return targets;
    }
  }
  return null;
}
