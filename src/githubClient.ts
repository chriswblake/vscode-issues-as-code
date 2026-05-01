import { Octokit } from '@octokit/rest';

const GITHUB_API_VERSION = '2022-11-28';

export interface IssueData {
  number: number;
  title: string;
  state: 'open' | 'closed';
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

  constructor(
    accessToken: string,
    private readonly owner: string,
    private readonly repo: string,
  ) {
    this.octokit = new Octokit({
      auth: accessToken,
      request: {
        headers: {
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
      },
    });
  }

  /**
   * Static factory: authenticates via VS Code's built-in GitHub auth provider.
   */
  static async authenticate(owner: string, repo: string): Promise<GitHubClient | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const vscode = require('vscode');
      let session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
      if (!session) {
        session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
      }
      if (!session) {
        return null;
      }
      return new GitHubClient(session.accessToken, owner, repo);
    } catch {
      return null;
    }
  }

  /**
   * Discovers issue numbers matching a GitHub search query using the Issues Search API.
   * Does not fetch full issue bodies; use getIssue() for per-issue details.
   */
  async searchIssueNumbers(query: string): Promise<number[]> {
    const fullQuery = `${query} repo:${this.owner}/${this.repo}`;
    const searchResults = await this.octokit.paginate(this.octokit.rest.search.issuesAndPullRequests, { q: fullQuery, per_page: 100 }, (response) => {
      const remaining = response.headers['x-ratelimit-remaining'];
      if (remaining !== undefined) {
        console.log(`[issuesAsCode] x-ratelimit-remaining: ${remaining}`);
      }
      return response.data;
    });

    // Filter out pull requests
    return searchResults.filter((item) => !item.pull_request).map((item) => item.number);
  }

  /** Gets a single issue by number using the REST API. */
  async getIssue(number: number): Promise<IssueData> {
    const { data } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
    });

    return mapIssue(data);
  }

  /** Creates a new issue. */
  async createIssue(params: {
    title: string; //
    body?: string;
    labels?: string[];
    assignees?: string[];
  }): Promise<IssueData> {
    const { data } = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      ...params,
    });
    return mapIssue(data);
  }

  /** Updates an existing issue. */
  async updateIssue(
    number: number,
    params: {
      title?: string;
      body?: string;
      state?: 'open' | 'closed';
      labels?: string[];
      assignees?: string[];
    },
  ): Promise<IssueData> {
    const { data } = await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      ...params,
    });
    return mapIssue(data);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapIssue(data: any): IssueData {
  return {
    number: data.number,
    title: data.title,
    state: data.state as 'open' | 'closed',
    body: data.body ?? null,
    labels: (data.labels ?? []).map((l: { name?: string } | string) => (typeof l === 'string' ? l : (l.name ?? ''))),
    assignees: (data.assignees ?? []).map((a: { login?: string } | string) => (typeof a === 'string' ? a : (a.login ?? ''))),
    updated_at: data.updated_at,
    closed_at: data.closed_at ?? null,
    node_id: data.node_id,
    html_url: data.html_url ?? '',
  };
}
