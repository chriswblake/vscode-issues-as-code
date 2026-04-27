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

## 4. Project Structure

| Path                   | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `src/extension.ts`     | Entry point — `activate` / `deactivate`                 |
| `src/configManager.ts` | Configuration helpers, repo detection, `resolveQuery`   |
| `src/githubClient.ts`  | Octokit wrapper — REST + GraphQL calls                  |
| `src/fileManager.ts`   | Read / write / serialize `.md` issue files              |
| `src/syncManager.ts`   | Orchestration — watcher, debounce, pull timer, conflict |
| `test/`                | Mocha unit and integration tests                        |
| `docs/`                | Developer documentation                                 |
| `.vscode/`             | Launch and task configurations                          |

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

`GitHubClient` wraps `@octokit/rest`. To call a new REST endpoint:

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
