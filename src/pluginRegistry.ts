import type { PrimarySyncPlugin, MetadataPlugin } from "./pluginTypes";

// ---------------------------------------------------------------------------
// Plugin Registry — lookup plugins by ID
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
