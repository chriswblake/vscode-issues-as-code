export { bootstrap } from "./ghIssuesBootstrap";
export {
  GhIssuesPlugin,
  buildSearchQuery,
  buildFileName,
  matchesFilter,
  resolveQueryDateTokens,
} from "./ghIssuesPlugin";
export type { GhIssuesFilters, GhIssuesPluginConfig } from "./ghIssuesPlugin";
export { GitHubClient, parseRateLimitHeaders } from "./githubClient";
export {
  detectRepo,
  defaultSyncTargets,
  createGhIssuesPlugin,
  getAuthenticatedUsername,
  getGhIssuesIncludedConfigs,
  hasDuplicateGhIssuesTarget,
  parseGitHubUrl,
} from "./ghIssuesBootstrap";
export { FrontmatterCompletionProvider } from "./frontmatterCompletionProvider";
