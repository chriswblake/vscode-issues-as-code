import { Octokit } from "@octokit/rest";
import {
  type RateLimitMonitor,
  type RateLimitInfo,
} from "../../rateLimitMonitor";

const GITHUB_API_VERSION = "2022-11-28";

// Module-level monitor shared by all GitHubClient instances
let sharedMonitor: RateLimitMonitor | null = null;

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

    // Hook into every response to extract rate limit headers
    this.octokit.hook.after("request", (response) => {
      if (sharedMonitor && response.headers) {
        const info = parseRateLimitHeaders(
          response.headers as Record<string, string | undefined>,
          response.url,
        );
        if (info) {
          sharedMonitor.update(info);
        }
      }
    });

    // Also capture rate limit headers from error responses (403/429)
    this.octokit.hook.error("request", (error) => {
      if (
        sharedMonitor &&
        error &&
        typeof error === "object" &&
        "response" in error
      ) {
        const resp = (
          error as {
            response?: {
              headers?: Record<string, string | undefined>;
              url?: string;
            };
          }
        ).response;
        if (resp?.headers) {
          const info = parseRateLimitHeaders(resp.headers, resp.url);
          if (info) {
            sharedMonitor.update(info);
          }
        }
      }
      throw error;
    });
  }

  /** Sets the shared rate limit monitor for all GitHubClient instances. */
  static setRateLimitMonitor(monitor: RateLimitMonitor): void {
    sharedMonitor = monitor;
  }

  /** Returns the shared rate limit monitor, if set. */
  static getRateLimitMonitor(): RateLimitMonitor | null {
    return sharedMonitor;
  }

  /**
   * Static factory: authenticates via VS Code's built-in GitHub auth provider.
   */
  static async authenticate(): Promise<GitHubClient | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const vscode = require("vscode");
      const scopes = ["repo", "read:org", "read:project"];
      let session = await vscode.authentication.getSession("github", scopes, {
        createIfNone: false,
      });
      if (!session) {
        session = await vscode.authentication.getSession("github", scopes, {
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
      (response) => response.data,
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

// ---------------------------------------------------------------------------
// GitHub Projects v2 types
// ---------------------------------------------------------------------------

export interface FieldMeta {
  id: string;
  name: string;
  type:
    | "TEXT"
    | "SINGLE_SELECT"
    | "NUMBER"
    | "DATE"
    | "ITERATION"
    | "MILESTONE";
  options?: Record<string, string>; // name → optionId, for SINGLE_SELECT
}

export interface ProjectMeta {
  projectId: string; // GraphQL node ID, e.g. "PVT_kwDOA123"
  title: string;
  url: string; // html_url for the project board
  fields: FieldMeta[];
}

export interface ProjectItemRaw {
  id: string; // PVTI_...
  type: "ISSUE" | "PULL_REQUEST" | "DRAFT_ISSUE";
  fieldValues: Record<string, string | null>; // fieldName → value
  content?: {
    // For ISSUE:
    number?: number;
    title?: string;
    state?: string;
    body?: string | null;
    labels?: string[];
    assignees?: string[];
    repository?: string; // "owner/repo"
    nodeId?: string;
    htmlUrl?: string;
    updatedAt?: string;
    closedAt?: string | null;
    // For DRAFT_ISSUE:
    draftTitle?: string;
    draftBody?: string | null;
  };
}

// ---------------------------------------------------------------------------
// GitHub Projects v2 GraphQL queries
// ---------------------------------------------------------------------------

/** Resolves a project owner/number to metadata including field schema. */
export async function getProjectMetadata(
  octokit: Octokit, //
  owner: string,
  projectNumber: number,
): Promise<ProjectMeta> {
  const projectFragment = `
    fragment ProjectFields on ProjectV2 {
      id
      title
      url
      fields(first: 50) {
        nodes {
          ... on ProjectV2Field {
            id
            name
            dataType
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            dataType
            options { id name }
          }
          ... on ProjectV2IterationField {
            id
            name
            dataType
          }
        }
      }
    }
  `;

  // Try user query first, then org — avoids partial-error issues with combined queries
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let project: any = null;
  let userError: unknown = null;
  let orgError: unknown = null;

  // Attempt as user project
  try {
    const userQuery = `
      ${projectFragment}
      query($owner: String!, $number: Int!) {
        user(login: $owner) {
          projectV2(number: $number) { ...ProjectFields }
        }
      }
    `;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await octokit.graphql(userQuery, {
      owner,
      number: projectNumber,
    });
    project = response?.user?.projectV2 ?? null;
  } catch (err) {
    userError = err;
  }

  // Attempt as organization project
  if (!project) {
    try {
      const orgQuery = `
        ${projectFragment}
        query($owner: String!, $number: Int!) {
          organization(login: $owner) {
            projectV2(number: $number) { ...ProjectFields }
          }
        }
      `;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response: any = await octokit.graphql(orgQuery, {
        owner,
        number: projectNumber,
      });
      project = response?.organization?.projectV2 ?? null;
    } catch (err) {
      orgError = err;
    }
  }

  if (!project) {
    // Include the actual API errors for debugging
    const details: string[] = [];
    if (userError) {
      details.push(
        `User query: ${userError instanceof Error ? userError.message : String(userError)}`,
      );
    }
    if (orgError) {
      details.push(
        `Org query: ${orgError instanceof Error ? orgError.message : String(orgError)}`,
      );
    }
    throw new Error(
      `Project not found: ${owner}/${projectNumber}. Verify the project exists and you have access.${details.length ? "\n" + details.join("\n") : ""}`,
    );
  }

  const fields: FieldMeta[] = (project.fields?.nodes ?? [])
    .filter((f: { id?: string }) => f?.id)
    .map(
      (f: {
        id: string;
        name: string;
        dataType: string;
        options?: Array<{ id: string; name: string }>;
      }) => {
        const meta: FieldMeta = {
          id: f.id,
          name: f.name,
          type: mapFieldType(f.dataType),
        };
        if (f.options) {
          meta.options = {};
          for (const opt of f.options) {
            meta.options[opt.name] = opt.id;
          }
        }
        return meta;
      },
    );

  return {
    projectId: project.id,
    title: project.title,
    url: project.url,
    fields,
  };
}

function mapFieldType(dataType: string): FieldMeta["type"] {
  switch (dataType) {
    case "TEXT":
      return "TEXT";
    case "SINGLE_SELECT":
      return "SINGLE_SELECT";
    case "NUMBER":
      return "NUMBER";
    case "DATE":
      return "DATE";
    case "ITERATION":
      return "ITERATION";
    default:
      return "TEXT";
  }
}

/** Fetches all project items (paginated). Skips PULL_REQUEST items. */
export async function getProjectItems(
  octokit: Octokit, //
  projectId: string,
): Promise<ProjectItemRaw[]> {
  const items: ProjectItemRaw[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query($projectId: ID!, $cursor: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                type
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldTextValue {
                      text
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                    ... on ProjectV2ItemFieldNumberValue {
                      number
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                    ... on ProjectV2ItemFieldDateValue {
                      date
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                    ... on ProjectV2ItemFieldIterationValue {
                      title
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                  }
                }
                content {
                  ... on Issue {
                    number
                    title
                    state
                    body
                    url
                    updatedAt
                    closedAt
                    id
                    labels(first: 50) { nodes { name } }
                    assignees(first: 20) { nodes { login } }
                    repository { nameWithOwner }
                  }
                  ... on DraftIssue {
                    title
                    body
                  }
                }
              }
            }
          }
        }
      }
    `;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await octokit.graphql(query, {
      projectId,
      cursor,
    });

    const itemsPage = response?.node?.items;
    if (!itemsPage) {
      break;
    }

    for (const node of itemsPage.nodes ?? []) {
      const itemType = node.type as "ISSUE" | "PULL_REQUEST" | "DRAFT_ISSUE";

      // Skip pull requests
      if (itemType === "PULL_REQUEST") {
        continue;
      }

      // Parse field values
      const fieldValues: Record<string, string | null> = {};
      for (const fv of node.fieldValues?.nodes ?? []) {
        const fieldName = fv?.field?.name;
        if (!fieldName) {
          continue;
        }
        const value =
          fv.text ??
          fv.name ??
          fv.title ??
          formatNumber(fv.number) ??
          fv.date ??
          null;
        fieldValues[fieldName] = value;
      }

      // Parse content
      const rawContent = node.content;
      let content: ProjectItemRaw["content"] | undefined;

      if (itemType === "ISSUE" && rawContent) {
        content = {
          number: rawContent.number,
          title: rawContent.title,
          state: rawContent.state?.toLowerCase(),
          body: rawContent.body ?? null,
          labels: (rawContent.labels?.nodes ?? []).map(
            (l: { name: string }) => l.name,
          ),
          assignees: (rawContent.assignees?.nodes ?? []).map(
            (a: { login: string }) => a.login,
          ),
          repository: rawContent.repository?.nameWithOwner,
          nodeId: rawContent.id,
          htmlUrl: rawContent.url,
          updatedAt: rawContent.updatedAt,
          closedAt: rawContent.closedAt ?? null,
        };
      } else if (itemType === "DRAFT_ISSUE" && rawContent) {
        content = {
          draftTitle: rawContent.title,
          draftBody: rawContent.body ?? null,
        };
      }

      items.push({
        id: node.id,
        type: itemType,
        fieldValues,
        content,
      });
    }

    hasNextPage = itemsPage.pageInfo?.hasNextPage ?? false;
    cursor = itemsPage.pageInfo?.endCursor ?? null;
  }

  return items;
}

function formatNumber(value: unknown): string | undefined {
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// GitHub Projects v2 mutations
// ---------------------------------------------------------------------------

/** Updates a single-select field on a project item. */
export async function updateSingleSelectField(
  octokit: Octokit, //
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string,
): Promise<void> {
  await octokit.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, optionId },
  );
}

/** Updates a text field on a project item. */
export async function updateTextField(
  octokit: Octokit, //
  projectId: string,
  itemId: string,
  fieldId: string,
  value: string,
): Promise<void> {
  await octokit.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { text: $value }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, value },
  );
}

/** Updates a number field on a project item. */
export async function updateNumberField(
  octokit: Octokit, //
  projectId: string,
  itemId: string,
  fieldId: string,
  value: number,
): Promise<void> {
  await octokit.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { number: $value }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, value },
  );
}

/** Updates a date field on a project item. */
export async function updateDateField(
  octokit: Octokit, //
  projectId: string,
  itemId: string,
  fieldId: string,
  date: string,
): Promise<void> {
  await octokit.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $date: Date!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { date: $date }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, date },
  );
}

/** Clears a field value from a project item. */
export async function clearFieldValue(
  octokit: Octokit, //
  projectId: string,
  itemId: string,
  fieldId: string,
): Promise<void> {
  await octokit.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      clearProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId },
  );
}

// ---------------------------------------------------------------------------
// GitHub Projects v2 draft mutations
// ---------------------------------------------------------------------------

/** Creates a draft item in a project. */
export async function createDraftItem(
  octokit: Octokit, //
  projectId: string,
  title: string,
  body?: string,
): Promise<{ itemId: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: any = await octokit.graphql(
    `mutation($projectId: ID!, $title: String!, $body: String) {
      addProjectV2DraftIssue(input: {
        projectId: $projectId
        title: $title
        body: $body
      }) { projectItem { id } }
    }`,
    { projectId, title, body: body ?? null },
  );
  return { itemId: response.addProjectV2DraftIssue.projectItem.id };
}

/** Updates a draft item's title and/or body. */
export async function updateDraftItem(
  octokit: Octokit, //
  projectId: string,
  itemId: string,
  title?: string,
  body?: string,
): Promise<void> {
  // The updateProjectV2DraftIssue mutation requires the draftIssueId (which is the item's content ID)
  // We use updateProjectV2ItemFieldValue with title value instead, since we have the itemId
  // Actually, we need to use a different approach - update via item
  await octokit.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $title: String, $body: String) {
      updateProjectV2DraftIssue(input: {
        draftIssueId: $itemId
        title: $title
        body: $body
      }) { draftIssue { id } }
    }`,
    { projectId, itemId, title: title ?? null, body: body ?? null },
  );
}

/** Converts a draft project item into a real issue. */
export async function convertDraftToIssue(
  octokit: Octokit, //
  projectId: string,
  itemId: string,
  repositoryId: string,
): Promise<{ issueNumber: number; issueNodeId: string; repository: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: any = await octokit.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $repositoryId: ID!) {
      convertProjectV2DraftIssueItemToIssue(input: {
        projectId: $projectId
        itemId: $itemId
        repositoryId: $repositoryId
      }) {
        item {
          content {
            ... on Issue {
              number
              id
              repository { nameWithOwner }
            }
          }
        }
      }
    }`,
    { projectId, itemId, repositoryId },
  );
  const content = response.convertProjectV2DraftIssueItemToIssue.item.content;
  return {
    issueNumber: content.number,
    issueNodeId: content.id,
    repository: content.repository.nameWithOwner,
  };
}

/** Resolves an owner/repo pair to a GitHub node ID. */
export async function getRepositoryNodeId(
  octokit: Octokit, //
  owner: string,
  repo: string,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: any = await octokit.graphql(
    `query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) { id }
    }`,
    { owner, repo },
  );
  return response.repository.id;
}

// ---------------------------------------------------------------------------
// GitHub rate limit header parsing
// ---------------------------------------------------------------------------

/**
 * Extracts rate limit info from GitHub API response headers.
 * Returns null if headers are missing (e.g. non-GitHub responses).
 * Bucket names are namespaced with "gh-issues:" prefix.
 */
export function parseRateLimitHeaders(
  headers: Record<string, string | undefined>,
  requestPath?: string,
): RateLimitInfo | null {
  const limit = headers["x-ratelimit-limit"];
  const remaining = headers["x-ratelimit-remaining"];
  const reset = headers["x-ratelimit-reset"];
  const used = headers["x-ratelimit-used"];

  if (limit === undefined || remaining === undefined || reset === undefined) {
    return null;
  }

  // Determine bucket from the x-ratelimit-resource header or request path
  const resource = headers["x-ratelimit-resource"];
  let bucket = "gh-issues:core";
  if (resource === "search" || requestPath?.includes("/search/")) {
    bucket = "gh-issues:search";
  }

  return {
    bucket,
    limit: parseInt(limit, 10),
    remaining: parseInt(remaining, 10),
    used: used !== undefined ? parseInt(used, 10) : 0,
    resetEpoch: parseInt(reset, 10),
  };
}
