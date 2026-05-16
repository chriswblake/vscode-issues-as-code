# How to Develop

Developer guide for the **Issues as Code** VS Code extension.

## 1. Prerequisites

- **Node.js LTS** (v20 or later) — [nodejs.org](https://nodejs.org)
- **VS Code** 1.85 or later — [code.visualstudio.com](https://code.visualstudio.com)
- **Git** — [git-scm.com](https://git-scm.com)

> **Tip:** You can skip the local prerequisites entirely by using a Codespace — see [GitHub Codespaces](#github-codespaces) below.

## 2. Setup

```bash
git clone https://github.com/<your-org>/vscode-issues-as-code.git
cd vscode-issues-as-code
npm install
npm run compile
```

## GitHub Codespaces

The repository includes a devcontainer configuration so you can start developing immediately in a browser or via VS Code without installing anything locally.

1. Click **Code → Codespaces → Create codespace on `main`** (or your branch) on the GitHub repository page.
2. Wait for the container to build and the `postCreate` script to finish (`npm install` + `npm run compile` run automatically).
3. The codespace opens with TypeScript support, ESLint, and Prettier already installed.

Once the codespace is ready:

- Press **F5** to launch an **Extension Development Host** window and test the extension interactively.
- Run `npm run watch` in the terminal to rebuild automatically as you edit source files.
- Run `npm run test:unit` to execute the unit test suite.

## 3. Run & Debug

1. Open the repository folder in VS Code.
2. Press **F5** — VS Code launches a new **Extension Development Host** window with the extension loaded.
3. Open a workspace that has a GitHub remote to exercise the sync logic.
4. Use the **Run Extension** launch configuration (`.vscode/launch.json`) for interactive debugging, or **Extension Tests** to run the integration test suite inside the Extension Host.

To rebuild automatically while editing:

```bash
npm run watch
```

## 3b. Test With a Dummy Repository (for example: <username>/vscode-issues-as-code-testing)

When you press F5, VS Code opens an isolated Extension Development Host window. That window often does not inherit your normal git credential flow, so cloning from inside that window may fail.

Use this workflow instead:

1. Create a throwaway GitHub repository such as `<username>/vscode-issues-as-code-testing`.
2. Add a few test issues in GitHub (open and closed) so sync behavior is visible.
3. Clone the dummy repository in your normal terminal or normal VS Code window (not inside Extension Development Host):

   ```bash
   git clone https://github.com/<username>/vscode-issues-as-code-testing.git
   ```

4. In your main extension project window (`vscode-issues-as-code`), press F5 to launch Extension Development Host.
5. In Extension Development Host, open the already-cloned `vscode-issues-as-code-testing` folder with File -> Open Folder.
6. In Extension Development Host, sign in to GitHub if prompted (Accounts menu in the lower-left is a quick check).
7. Configure sync targets for the opened testing workspace:
   - Run the command palette action: Issues as Code: Add Open Issues Default Config, or
   - Manually set `issuesAsCode.syncTargets` in workspace settings.
8. Confirm files appear under `.issues/open` in the testing folder.

If cloning fails in Extension Development Host, that is expected for some setups. Pre-cloning outside the host window is the recommended test path.

### Troubleshooting the dummy-repo workflow

- If repo detection fails, verify the opened folder is a git repository and has an `origin` remote pointing to GitHub.
- If auth fails, sign out/in of GitHub in Extension Development Host and rerun the command.
- If nothing syncs, verify `issuesAsCode.syncTargets` is set for that workspace folder and run Issues as Code: Pull Now (config changes are applied automatically).
- If files still do not appear, check the extension host logs (Output panel) for `[issuesAsCode]` errors.

## 4. Project Structure

| Path                             | Purpose                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `src/extension.ts`               | Entry point — `activate` / `deactivate`                 |
| `src/configManager.ts`           | Configuration helpers, repo detection                   |
| `src/fileManager.ts`             | Read / write / serialize `.task.md` issue files         |
| `src/syncManager.ts`             | Orchestration — watcher, debounce, pull timer, conflict |
| `src/syncStateManager.ts`        | Tracks sync state (remote revisions, local writes)      |
| `src/pluginTypes.ts`             | Plugin interfaces and contracts (core-facing)           |
| `src/pluginRegistry.ts`          | Plugin registry — lookup plugins by ID                  |
| `src/rateLimitMonitor.ts`        | Generic API rate limit tracking and pause logic         |
| `src/statusBarManager.ts`        | Status bar UI (icon, tooltip, panel)                    |
| `src/issueDecorationProvider.ts` | Explorer file decorations (sync state badges)           |
| `src/publishCodeLensProvider.ts` | CodeLens actions (Publish, Sync Now, Pull Changes)      |
| `src/plugins/loader.ts`          | Plugin discovery and initialization                     |
| `src/plugins/gh-issues/`         | GitHub Issues plugin (primary sync plugin)              |
| `src/plugins/gh-projects/`       | GitHub Projects plugin (metadata enrichment)            |
| `src/plugins/ticktick/`          | TickTick plugin (placeholder — not yet implemented)     |
| `test/`                          | Mocha unit and integration tests                        |
| `docs/`                          | Developer documentation                                 |
| `.vscode/`                       | Launch and task configurations                          |

### Plugin Architecture

Each plugin lives in its own subfolder under `src/plugins/`. A plugin folder contains:

- `index.ts` — barrel export (including the bootstrap)
- `*Plugin.ts` — implements `PrimarySyncPlugin` or `MetadataPlugin`
- `*Bootstrap.ts` — implements `PluginBootstrap` (init, commands, providers)
- Supporting files (API clients, providers, etc.)

The core program (`src/*.ts`) never imports plugin implementation files directly.
It interacts with plugins only through:

1. `src/pluginTypes.ts` — defines the interfaces plugins must implement
2. `src/pluginRegistry.ts` — runtime lookup of registered plugins
3. `src/plugins/loader.ts` — discovers and initializes all plugins

To add a new plugin:

1. Create a folder under `src/plugins/<plugin-name>/`
2. Implement `PrimarySyncPlugin` (or `MetadataPlugin`) and `PluginBootstrap`
3. Export the bootstrap from the folder's `index.ts`
4. Add one import + array entry in `src/plugins/loader.ts`

## 5. Common Extension Tasks

### Add or change a configuration option

1. Add the property to the `contributes.configuration.properties` object in `package.json`. Set `"scope": "resource"`.
2. Update the `IssueConfig` interface and `getConfig()` function in `src/configManager.ts`.
3. Update the README configuration table.

### Add a command

1. Add the command to `contributes.commands` in `package.json`.
2. Register the command in `src/extension.ts` with `vscode.commands.registerCommand`.
3. Push the disposable onto `context.subscriptions`.

### Use the GitHub API

`GitHubClient` (in `src/plugins/gh-issues/githubClient.ts`) wraps `@octokit/rest`. To call a new REST endpoint:

```typescript
const { data } = await this.octokit.rest.issues.listComments({
  owner: this.owner,
  repo: this.repo,
  issue_number: number,
});
```

For GraphQL (e.g. GitHub Projects v2):

```typescript
const result = await this.octokit.graphql<MyResponseType>(query, variables);
```

## 6. Package & Publish

### Package

Install `vsce` if you haven't already:

```bash
npm install -g @vscode/vsce
```

Build the `.vsix` package:

```bash
vsce package
```

### Publish

1. Create a Personal Access Token (PAT) on [Azure DevOps](https://dev.azure.com) with **Marketplace → Manage** scope.
2. Log in:
   ```bash
   vsce login <publisher-name>
   ```
3. Publish:
   ```bash
   vsce publish
   ```

For CI/CD, pass the PAT via environment variable:

```bash
vsce publish --pat $VSCE_PAT
```
