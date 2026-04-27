import { Octokit } from '@octokit/rest';

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
    this.octokit = new Octokit({ auth: accessToken });
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
   * Lists issues matching a GitHub search query. Filters out pull requests.
   * Fetches full body for each result (search API truncates body).
   */
  async listIssues(query: string): Promise<IssueData[]> {
    const fullQuery = `${query} repo:${this.owner}/${this.repo}`;
    const searchResults = await this.octokit.paginate(this.octokit.rest.search.issuesAndPullRequests, { q: fullQuery, per_page: 100 }, (response) => {
      const remaining = response.headers['x-ratelimit-remaining'];
      if (remaining !== undefined) {
        console.log(`[issueSync] x-ratelimit-remaining: ${remaining}`);
      }
      return response.data;
    });

    // Filter out pull requests
    const issues = searchResults.filter((item) => !item.pull_request);

    // Fetch full bodies (search API may truncate)
    const BATCH_SIZE = 20;
    const results: IssueData[] = [];

    for (let i = 0; i < issues.length; i += BATCH_SIZE) {
      const batch = issues.slice(i, i + BATCH_SIZE);
      if (i > 0) {
        await delay(250);
      }
      const fetched = await Promise.all(batch.map((item) => this.getIssue(item.number)));
      results.push(...fetched);
    }

    return results;
  }

  /** Gets a single issue by number. */
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
