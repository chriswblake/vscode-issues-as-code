/**
 * Plugin loader — dynamically discovers and initializes all available plugins.
 * Extension.ts calls these generic functions without knowing which plugins exist.
 */
import type { SyncTarget } from '../configManager';
import type { PluginBootstrap } from './syncPlugin';

// Import all available plugin bootstraps here.
// Adding a new plugin = adding one import + one array entry.
import { bootstrap as ghIssuesBootstrap } from './ghIssuesBootstrap';

const allBootstraps: PluginBootstrap[] = [
  ghIssuesBootstrap,
];

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
 * Detect default sync targets for a workspace folder.
 * Tries each plugin until one returns defaults.
 */
export async function detectDefaultTargets(
  workspaceFolder: { uri: { fsPath: string } },
): Promise<SyncTarget[] | null> {
  for (const b of allBootstraps) {
    const targets = await b.detectDefaults(workspaceFolder);
    if (targets && targets.length > 0) {
      return targets;
    }
  }
  return null;
}
