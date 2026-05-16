import { Octokit } from "@octokit/rest";
import type { IssueFrontmatter } from "../../fileManager";
import type { RemoteIssueInfo } from "../../syncStateManager";
import type { MetadataPlugin, PluginContext } from "../../pluginTypes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectFieldData {
  projectId: string;
  projectTitle: string;
  itemId: string;
  fieldId: string;
  fieldName: string;
  value: string | null;
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

/**
 * Metadata plugin for GitHub Projects v2.
 * Enriches issue files with project field data (status, iteration, etc.).
 * Does not own file body or naming — only adds to the 'gh-projects' frontmatter section.
 */
export class GhProjectsPlugin implements MetadataPlugin {
  readonly id = "gh-projects";

  constructor(private readonly octokit: Octokit) {}

  async enrich(
    _primaryFrontmatter: Record<string, unknown>, //
    _pluginConfig: Record<string, unknown>,
    _context: PluginContext,
    remoteInfo?: RemoteIssueInfo,
  ): Promise<Record<string, unknown> | null> {
    const nodeId = remoteInfo?.node_id;
    if (!nodeId) {
      return null;
    }

    const fields = await this.getProjectFields(nodeId);
    if (fields.length === 0) {
      return null;
    }

    // Group fields by project title
    const byProject: Record<string, Record<string, string | null>> = {};
    for (const field of fields) {
      if (!byProject[field.projectTitle]) {
        byProject[field.projectTitle] = {};
      }
      byProject[field.projectTitle][field.fieldName] = field.value;
    }

    return byProject;
  }

  /**
   * Fetches project field values for an issue via GraphQL.
   */
  async getProjectFields(issueNodeId: string): Promise<ProjectFieldData[]> {
    const query = `
      query($nodeId: ID!) {
        node(id: $nodeId) {
          ... on Issue {
            projectItems(first: 20) {
              nodes {
                id
                project {
                  id
                  title
                }
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldTextValue {
                      text
                      field { ... on ProjectV2FieldCommon { id name } }
                    }
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2FieldCommon { id name } }
                    }
                    ... on ProjectV2ItemFieldIterationValue {
                      title
                      field { ... on ProjectV2FieldCommon { id name } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await this.octokit.graphql<{
      node: {
        projectItems?: {
          nodes: Array<{
            id: string;
            project: { id: string; title: string };
            fieldValues: {
              nodes: Array<{
                text?: string;
                name?: string;
                title?: string;
                field?: { id: string; name: string };
              }>;
            };
          }>;
        };
      };
    }>(query, { nodeId: issueNodeId });

    const fields: ProjectFieldData[] = [];
    for (const item of response.node.projectItems?.nodes ?? []) {
      for (const fv of item.fieldValues.nodes) {
        if (!fv.field) {
          continue;
        }
        fields.push({
          projectId: item.project.id,
          projectTitle: item.project.title,
          itemId: item.id,
          fieldId: fv.field.id,
          fieldName: fv.field.name,
          value: fv.text ?? fv.name ?? fv.title ?? null,
        });
      }
    }
    return fields;
  }

  /**
   * Updates a single project field value via GraphQL mutation.
   */
  async updateProjectField(
    projectId: string, //
    itemId: string,
    fieldId: string,
    value: string,
  ): Promise<void> {
    const mutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: $value
        }) {
          projectV2Item { id }
        }
      }
    `;
    await this.octokit.graphql(mutation, {
      projectId,
      itemId,
      fieldId,
      value: { text: value },
    });
  }
}
