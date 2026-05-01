import type { IssueFrontmatter } from '../fileManager';
import type { PrimarySyncPlugin, PullItem, PushResult, PluginContext } from './syncPlugin';

// ---------------------------------------------------------------------------
// TickTick plugin (placeholder)
// ---------------------------------------------------------------------------

/**
 * Placeholder plugin for TickTick task sync.
 * Not yet implemented — serves as a template for future integration.
 */
export class TickTickPlugin implements PrimarySyncPlugin {
  readonly id = 'tick-tick';

  async pull(_pluginConfig: Record<string, unknown>, _context: PluginContext): Promise<PullItem[]> {
    console.warn('[issuesAsCode] TickTick plugin is not yet implemented.');
    return [];
  }

  async push(
    _frontmatter: IssueFrontmatter, //
    _body: string,
    _pluginConfig: Record<string, unknown>,
    _context: PluginContext,
  ): Promise<PushResult> {
    throw new Error('TickTick plugin is not yet implemented.');
  }

  buildFileName(_namingTokens: Record<string, string | number>, template: string): string {
    return template.replace(/\{[^}]+\}/g, 'untitled');
  }

  getRemoteId(_frontmatter: IssueFrontmatter): undefined {
    return undefined;
  }

  inferTitle(filePath: string, _frontmatter: IssueFrontmatter, _body: string): string {
    const path = require('path');
    return path.basename(filePath, path.extname(filePath)).trim() || 'New task';
  }
}
