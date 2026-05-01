import { Octokit } from "@octokit/rest";

const GITHUB_API_VERSION = "2022-11-28";

export interface IssueData {
  number: number;
  title: string;
  state: "open" | "closed";
  body: string | null;
  labels: string[];
  assignees: string[];
  updated_at: string;
  closed_at: string | null;
  node_id: string;
  html_url: string;
}

export class GitHubClient {
  public readonly octokit: Octokit;

  constructor(accessToken: string) {
    this.octokit = new Octokit({
      auth: accessToken,
      request: {
        headers: {
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      },
    });
  }

  /**
   * Static factory: authenticates via VS Code's built-in GitHub auth provider.
   */
  static async authenticate(): Promise<GitHubClient | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const vscode = require("vscode");
      let session = await vscode.authentication.getSession("github", ["repo"], {
        createIfNone: false,
      });
      if (!session) {
        session = await vscode.authentication.getSession("github", ["repo"], {
          createIfNone: true,
        });
      }
      if (!session) {
        return null;
      }
      return new GitHubClient(session.accessToken);
    } catch {
      return null;
    }
  }

  /**
   * Discovers issue numbers matching a GitHub search query.
   * The query should already include any repo: qualifiers if scoped to a repository.
   */
  async searchIssueNumbers(query: string): Promise<number[]> {
    const items = await this.searchIssues(query);
    return items.map((item) => item.number);
  }

  /**
   * Searches for issues and returns structured results including repository info.
   * Useful for cross-repo searches where owner/repo isn't known upfront.
   */
  async searchIssues(
    query: string,
  ): Promise<Array<{ number: number; owner: string; repo: string }>> {
    const searchResults = await this.octokit.paginate(
      this.octokit.rest.search.issuesAndPullRequests,
      { q: query, per_page: 100 },
      (response) => {
        const remaining = response.headers["x-ratelimit-remaining"];
        if (remaining !== undefined) {
          console.log(`[issuesAsCode] x-ratelimit-remaining: ${remaining}`);
        }
        return response.data;
      },
    );

    // Filter out pull requests and extract repo info from repository_url
    return searchResults
      .filter((item) => !item.pull_request)
      .map((item) => {
        // repository_url format: "https://api.github.com/repos/owner/repo"
        const repoUrl =
          (item as { repository_url?: string }).repository_url ?? "";
        const parts = repoUrl.split("/");
        const repo = parts[parts.length - 1] ?? "";
        const owner = parts[parts.length - 2] ?? "";
        return { number: item.number, owner, repo };
      });
  }

  /** Gets a single issue by number using the REST API. */
  async getIssue(
    owner: string,
    repo: string,
    number: number,
  ): Promise<IssueData> {
    const { data } = await this.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: number,
    });

    return mapIssue(data);
  }

  /** Creates a new issue. */
  async createIssue(
    owner: string, //
    repo: string,
    params: {
      title: string;
      body?: string;
      labels?: string[];
      assignees?: string[];
    },
  ): Promise<IssueData> {
    const { data } = await this.octokit.rest.issues.create({
      owner,
      repo,
      ...params,
    });
    return mapIssue(data);
  }

  /** Updates an existing issue. */
  async updateIssue(
    owner: string, //
    repo: string,
    number: number,
    params: {
      title?: string;
      body?: string;
      state?: "open" | "closed";
      labels?: string[];
      assignees?: string[];
    },
  ): Promise<IssueData> {
    const { data } = await this.octokit.rest.issues.update({
      owner,
      repo,
      issue_number: number,
      ...params,
    });
    return mapIssue(data);
  }

  /** Lists all label names for a repository. */
  async getLabels(owner: string, repo: string): Promise<string[]> {
    const labels = await this.octokit.paginate(
      this.octokit.rest.issues.listLabelsForRepo,
      {
        owner,
        repo,
        per_page: 100,
      },
    );
    return labels.map((l) => l.name);
  }

  /** Lists contributor logins for a repository. */
  async getContributors(owner: string, repo: string): Promise<string[]> {
    const contributors = await this.octokit.paginate(
      this.octokit.rest.repos.listContributors,
      {
        owner,
        repo,
        per_page: 100,
      },
    );
    return contributors
      .map((c) => (c as { login?: string }).login ?? "")
      .filter((login) => login.length > 0);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapIssue(data: any): IssueData {
  return {
    number: data.number,
    title: data.title,
    state: data.state as "open" | "closed",
    body: data.body ?? null,
    labels: (data.labels ?? []).map((l: { name?: string } | string) =>
      typeof l === "string" ? l : (l.name ?? ""),
    ),
    assignees: (data.assignees ?? []).map((a: { login?: string } | string) =>
      typeof a === "string" ? a : (a.login ?? ""),
    ),
    updated_at: data.updated_at,
    closed_at: data.closed_at ?? null,
    node_id: data.node_id,
    html_url: data.html_url ?? "",
  };
}
