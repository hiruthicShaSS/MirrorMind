import { Type } from "@google/genai";
import type { ITaskData } from "../interfaces/ITaskData";
import { Logger } from "../utils/logger";
import {
  BaseIntegrationService,
  SearchResult,
  IntegrationTool,
} from "./baseIntegrationService";

export interface GitHubIssueData extends ITaskData {
  owner: string;
  repo: string;
  milestone?: number;
}

export interface GitHubServiceConfig {
  accessToken: string;
}

export class GitHubService extends BaseIntegrationService<
  GitHubIssueData,
  unknown
> {
  private config: GitHubServiceConfig;

  constructor(config: GitHubServiceConfig) {
    super();
    this.config = config;
  }

  getTools(): IntegrationTool[] {
    return [
      {
        tool: {
          functionDeclarations: [
            {
              name: "github_search_issues",
              description:
                "Search for issues/tasks in a GitHub repository using keywords. Returns a list of matching issues with details.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  keywords: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: "Keywords to search for",
                  },
                  owner: {
                    type: Type.STRING,
                    description: "Repository owner (organization or username)",
                  },
                  repo: {
                    type: Type.STRING,
                    description: "Repository name",
                  },
                },
                required: ["keywords", "owner", "repo"],
              },
            },
          ],
        },
        handler: async (args: Record<string, unknown>) => {
          const { keywords, owner, repo } = args as {
            keywords: string[];
            owner: string;
            repo: string;
          };
          return this.searchSimilarTasks(keywords, { owner, repo });
        },
      },
      {
        tool: {
          functionDeclarations: [
            {
              name: "github_get_issue",
              description:
                "Get details of a specific issue in a GitHub repository by its number.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  issue_number: {
                    type: Type.INTEGER,
                    description: "The issue number",
                  },
                  owner: {
                    type: Type.STRING,
                    description: "Repository owner",
                  },
                  repo: {
                    type: Type.STRING,
                    description: "Repository name",
                  },
                },
                required: ["issue_number", "owner", "repo"],
              },
            },
          ],
        },
        handler: async (args: Record<string, unknown>) => {
          const { issue_number, owner, repo } = args as {
            issue_number: number;
            owner: string;
            repo: string;
          };
          return this.getIssueWithComments(owner, repo, issue_number);
        },
      },
      {
        tool: {
          functionDeclarations: [
            {
              name: "github_list_assigned_issues",
              description:
                "List open issues assigned to a specific user in a repository.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  assignee: {
                    type: Type.STRING,
                    description:
                      "Username of the assignee (e.g. 'me' for authenticated user if applicable, otherwise specific username)",
                  },
                  owner: {
                    type: Type.STRING,
                    description: "Repository owner",
                  },
                  repo: {
                    type: Type.STRING,
                    description: "Repository name",
                  },
                },
                required: ["assignee", "owner", "repo"],
              },
            },
          ],
        },
        handler: async (args: Record<string, unknown>) => {
          const { assignee, owner, repo } = args as {
            assignee: string;
            owner: string;
            repo: string;
          };
          return this.getIssuesAssignedToUser(owner, repo, assignee);
        },
      },
    ];
  }

  async createTask(data: GitHubIssueData): Promise<unknown> {
    const url = `https://api.github.com/repos/${data.owner}/${data.repo}/issues`;
    const body = await this.mapToGitHubPayload(data);

    Logger.debug(`Creating GitHub issue at ${url}`);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        Logger.error(
          `Failed to create GitHub issue: ${response.status} ${response.statusText}`,
          { errorText }
        );
        throw new Error(
          `Failed to create GitHub issue: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const result = (await response.json()) as { number: number; title: string };
      Logger.info(
        `Successfully created GitHub issue #${result.number}: ${result.title}`
      );
      return result;
    } catch (error) {
      Logger.error("Error creating GitHub issue", { error });
      throw error;
    }
  }

  async batchCreateTasks(issues: GitHubIssueData[]): Promise<unknown[]> {
    Logger.info(`Batch creating ${issues.length} GitHub issues in parallel`);
    return Promise.all(issues.map((issue) => this.createTask(issue)));
  }

  private async mapToGitHubPayload(
    data: GitHubIssueData
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      title: data.summary,
      body: data.description || "",
      labels: data.labels || [],
    };

    if (data.assigneeId) {
      const isNumericId = /^\d+$/.test(data.assigneeId);
      let assigneeLogin = data.assigneeId;

      if (isNumericId) {
        try {
          const userResponse = await fetch(
            `https://api.github.com/user/${data.assigneeId}`,
            {
              headers: {
                Authorization: `Bearer ${this.config.accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Bassist-App",
              },
            }
          );
          if (userResponse.ok) {
            const userDetails = (await userResponse.json()) as { login: string };
            assigneeLogin = userDetails.login;
          } else {
            Logger.warn(
              `Failed to convert GitHub user ID to login: ${data.assigneeId}`
            );
            assigneeLogin = data.assigneeId;
          }
        } catch (error) {
          Logger.error("Error converting GitHub user ID to login", { error });
          assigneeLogin = data.assigneeId;
        }
      }

      payload.assignees = [assigneeLogin];
    }

    if (data.milestone) {
      payload.milestone = data.milestone;
    }

    return payload;
  }

  async getRepositoryCollaborators(
    owner: string,
    repo: string
  ): Promise<{ id: number; login: string; name?: string }[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/collaborators`;

    Logger.debug(`Fetching collaborators for ${owner}/${repo}`);

    try {
      const collaborators: { id: number; login: string; name?: string }[] = [];
      let page = 1;
      const perPage = 100;

      while (true) {
        const response = await fetch(
          `${url}?page=${page}&per_page=${perPage}&affiliation=all`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${this.config.accessToken}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "Bassist-App",
            },
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          Logger.warn(
            `Failed to fetch GitHub collaborators: ${response.status}`,
            { errorText, owner, repo }
          );
          break;
        }

        const pageCollaborators = (await response.json()) as Array<{
          id: number;
          login: string;
        }>;
        if (
          !Array.isArray(pageCollaborators) ||
          pageCollaborators.length === 0
        ) {
          break;
        }

        for (const collaborator of pageCollaborators) {
          if (collaborator.login && collaborator.id) {
            collaborators.push({
              id: collaborator.id,
              login: collaborator.login,
            });
          }
        }

        const linkHeader = response.headers.get("link");
        if (!linkHeader || !linkHeader.includes('rel=\"next\"')) {
          break;
        }

        page++;
      }

      Logger.info(
        `Found ${collaborators.length} collaborators for ${owner}/${repo}`
      );
      return collaborators;
    } catch (error) {
      Logger.error("Error fetching GitHub collaborators", {
        error,
        owner,
        repo,
      });
      return [];
    }
  }

  async resolveAssigneeNameToId(
    assigneeNameOrId: string,
    options?: {
      projectKey?: string;
      owner?: string;
      repo?: string;
      projectId?: string | number;
    }
  ): Promise<string> {
    if (!options?.owner || !options?.repo) {
      Logger.warn("GitHub resolveAssigneeNameToId requires owner and repo", {
        options,
      });
      return assigneeNameOrId;
    }

    try {
      const collaborators = await this.getRepositoryCollaborators(
        options.owner,
        options.repo
      );

      if (collaborators.length === 0) {
        Logger.debug("No collaborators found, cannot resolve assignee name", {
          assigneeNameOrId,
        });
        return assigneeNameOrId;
      }

      const normalizedInput = assigneeNameOrId.toLowerCase().trim();

      const exactLoginMatch = collaborators.find(
        (c) =>
          c.login.toLowerCase() === normalizedInput ||
          c.login.toLowerCase().includes(normalizedInput)
      );
      if (exactLoginMatch) {
        Logger.info("Resolved assignee login to GitHub user ID", {
          original: assigneeNameOrId,
          resolved: exactLoginMatch.id.toString(),
        });
        return exactLoginMatch.id.toString();
      }

      for (const collaborator of collaborators) {
        if (collaborator.name) {
          const normalizedName = collaborator.name.toLowerCase().trim();
          if (
            normalizedName === normalizedInput ||
            normalizedName.includes(normalizedInput) ||
            normalizedInput.includes(normalizedName)
          ) {
            Logger.info("Resolved assignee name to GitHub user ID", {
              original: assigneeNameOrId,
              resolved: collaborator.id.toString(),
            });
            return collaborator.id.toString();
          }
        }
      }

      Logger.debug("Could not resolve assignee name to GitHub username", {
        assigneeNameOrId,
        availableCollaborators: collaborators.length,
      });
      return assigneeNameOrId;
    } catch (error) {
      Logger.error("Error resolving assignee name to GitHub username", {
        error,
        assigneeNameOrId,
      });
      return assigneeNameOrId;
    }
  }

  async searchSimilarTasks(
    keywords: string[],
    options?: {
      projectKey?: string;
      owner?: string;
      repo?: string;
      projectId?: string | number;
    }
  ): Promise<SearchResult[]> {
    if (!options?.owner || !options?.repo) {
      Logger.warn("GitHub search requires owner and repo", { options });
      return [];
    }

    const keywordQuery = keywords.join(" ");
    const query = `${keywordQuery} repo:${options.owner}/${options.repo} is:issue assignee:*`;

    Logger.debug("Searching GitHub for similar tasks", { query, keywords });

    try {
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=10&sort=updated&order=desc`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        Logger.warn(`Failed to search GitHub issues: ${response.status}`, {
          errorText,
        });
        return [];
      }

      const result = (await response.json()) as {
        items?: Array<{ id: number; title: string; url: string }>;
      };
      const issues = result.items || [];

      const results: SearchResult[] = [];
      for (const issue of issues.slice(0, 10)) {
        const issueUrl = issue.url;
        const issueResponse = await fetch(issueUrl, {
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Bassist-App",
          },
        });

        if (issueResponse.ok) {
          const fullIssue = (await issueResponse.json()) as {
            assignees?: Array<{ login: string }>;
          };
          if (fullIssue.assignees && fullIssue.assignees.length > 0) {
            const assignee = fullIssue.assignees[0];
            results.push({
              id: issue.id.toString(),
              title: issue.title,
              assigneeId: assignee.login,
              assigneeName: assignee.login,
              summary: issue.title,
            });
          }
        }
      }

      return results;
    } catch (error) {
      Logger.error("Error searching GitHub issues", { error });
      return [];
    }
  }

  async getIssuesAssignedToUser(
    owner: string,
    repo: string,
    assignee: string
  ): Promise<
    {
      id: number;
      number: number;
      title: string;
      body: string;
      state: string;
      assignees: { login: string; id: number }[];
      created_at: string;
      updated_at: string;
    }[]
  > {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues?assignee=${assignee}&state=open&per_page=100`;

    Logger.debug(`Fetching issues assigned to ${assignee} in ${owner}/${repo}`);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        Logger.error(
          `Failed to fetch GitHub issues: ${response.status} ${response.statusText}`,
          { errorText }
        );
        throw new Error(
          `Failed to fetch GitHub issues: ${response.status} ${response.statusText}`
        );
      }

      const issues = (await response.json()) as {
        id: number;
        number: number;
        title: string;
        body: string;
        state: string;
        assignees: { login: string; id: number }[];
        created_at: string;
        updated_at: string;
      }[];
      Logger.info(
        `Found ${issues.length} issues assigned to ${assignee} in ${owner}/${repo}`
      );
      return issues;
    } catch (error) {
      Logger.error("Error fetching GitHub issues", { error });
      throw error;
    }
  }

  async getRepositoryIssues(
    owner: string,
    repo: string,
    options?: {
      state?: "open" | "closed" | "all";
      perPage?: number;
    }
  ): Promise<
    {
      id: number;
      number: number;
      title: string;
      body: string;
      state: string;
      assignees: { login: string; id: number }[];
      labels: { name: string; color: string }[];
      created_at: string;
      updated_at: string;
      closed_at: string | null;
    }[]
  > {
    const state = options?.state || "all";
    const perPage = options?.perPage || 100;
    const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}&sort=updated&direction=desc`;

    Logger.debug(`Fetching all issues from ${owner}/${repo} (state: ${state})`);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        Logger.error(
          `Failed to fetch repository issues: ${response.status} ${response.statusText}`,
          { errorText }
        );
        throw new Error(
          `Failed to fetch repository issues: ${response.status} ${response.statusText}`
        );
      }

      const issues = (await response.json()) as Array<{
        id: number;
        number: number;
        title: string;
        body: string;
        state: string;
        assignees: { login: string; id: number }[];
        labels: { name: string; color: string }[];
        created_at: string;
        updated_at: string;
        closed_at: string | null;
        pull_request?: unknown;
      }>;
      const actualIssues = issues.filter(
        (issue: { pull_request?: unknown }) => !issue.pull_request
      );
      Logger.info(
        `Found ${actualIssues.length} issues in ${owner}/${repo} (filtered from ${issues.length} total items)`
      );
      return actualIssues;
    } catch (error) {
      Logger.error("Error fetching repository issues", { error });
      throw error;
    }
  }

  async getRepositoryContent(
    owner: string,
    repo: string,
    path = ""
  ): Promise<
    | {
        type: "file" | "dir";
        name: string;
        path: string;
        sha: string;
        size?: number;
        content?: string;
        encoding?: string;
        download_url?: string;
      }[]
    | {
        type: "file";
        name: string;
        path: string;
        sha: string;
        size: number;
        content: string;
        encoding: string;
        download_url: string;
      }
  > {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

    Logger.debug(`Fetching repository content from ${owner}/${repo}/${path}`);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        Logger.error(
          `Failed to fetch repository content: ${response.status} ${response.statusText}`,
          { errorText }
        );
        throw new Error(
          `Failed to fetch repository content: ${response.status} ${response.statusText}`
        );
      }

      const content = (await response.json()) as
        | {
            type: "file" | "dir";
            name: string;
            path: string;
            sha: string;
            size?: number;
            content?: string;
            encoding?: string;
            download_url?: string;
          }[]
        | {
            type: "file";
            name: string;
            path: string;
            sha: string;
            size: number;
            content: string;
            encoding: string;
            download_url: string;
          };
      return content;
    } catch (error) {
      Logger.error("Error fetching repository content", { error });
      throw error;
    }
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string
  ): Promise<string | null> {
    try {
      const content = await this.getRepositoryContent(owner, repo, path);

      if (
        !Array.isArray(content) &&
        content.type === "file" &&
        content.content
      ) {
        const decoded = Buffer.from(content.content, "base64").toString(
          "utf-8"
        );
        return decoded;
      }

      return null;
    } catch (error) {
      Logger.warn(`Failed to fetch file content for ${path}`, { error });
      return null;
    }
  }

  async searchUserRepositories(
    query: string,
    username: string
  ): Promise<
    { id: number; name: string; full_name: string; owner: { login: string } }[]
  > {
    const searchQuery = `${query} user:${username} in:name fork:true`;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&sort=updated&per_page=5`;

    Logger.debug(`Searching for user repositories: ${searchQuery}`);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        Logger.warn(`Failed to search user repositories: ${response.status}`, {
          errorText,
        });
        return [];
      }

      const result = (await response.json()) as {
        items?: Array<{
          id: number;
          name: string;
          full_name: string;
          owner: { login: string };
        }>;
      };
      return result.items || [];
    } catch (error) {
      Logger.error("Error searching user repositories", { error });
      return [];
    }
  }

  async getAllAssignedIssues(): Promise<
    {
      id: number;
      number: number;
      title: string;
      body: string;
      state: string;
      assignees: { login: string; id: number }[];
      created_at: string;
      updated_at: string;
    }[]
  > {
    const perPage = 100;
    const maxPages = 5;
    let page = 1;
    let allIssues: {
      id: number;
      number: number;
      title: string;
      body: string;
      state: string;
      assignees: { login: string; id: number }[];
      created_at: string;
      updated_at: string;
    }[] = [];

    Logger.debug(
      `Fetching all issues assigned to user (up to ${maxPages * perPage})`
    );

    try {
      while (page <= maxPages) {
        const url = `https://api.github.com/issues?filter=all&state=open&sort=created&direction=desc&per_page=${perPage}&page=${page}`;

        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Bassist-App",
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          Logger.error(
            `Failed to fetch assigned GitHub issues page ${page}: ${response.status} ${response.statusText}`,
            { errorText }
          );
          if (page === 1) {
            throw new Error(
              `Failed to fetch assigned GitHub issues: ${response.status} ${response.statusText}`
            );
          }
          break;
        }

        const raw = (await response.json()) as Array<{
          id: number;
          number: number;
          title: string;
          body: string;
          state: string;
          assignees: { login: string; id: number }[];
          created_at: string;
          updated_at: string;
          pull_request?: unknown;
        }>;
        if (!raw || raw.length === 0) {
          break;
        }

        const issues = raw.filter(
          (item: { pull_request?: unknown }) => !("pull_request" in item)
        );
        allIssues = allIssues.concat(issues);

        if (issues.length < perPage) {
          break;
        }

        page++;
      }

      Logger.info(`Found total ${allIssues.length} global assigned issues`);
      return allIssues;
    } catch (error) {
      Logger.error("Error fetching all assigned GitHub issues", { error });
      throw error;
    }
  }

  async getIssueWithComments(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<{
    issue: {
      id: number;
      number: number;
      title: string;
      body: string;
      state: string;
      created_at: string;
      updated_at: string;
    };
    comments: {
      id: number;
      body: string;
      user: { login: string };
      created_at: string;
      updated_at: string;
    }[];
    relatedIssues: {
      id: number;
      number: number;
      title: string;
      body: string;
    }[];
  }> {
    try {
      const issueUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
      const issueResponse = await fetch(issueUrl, {
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
        },
      });

      if (!issueResponse.ok) {
        const status = issueResponse.status;
        if (status === 404) {
          throw new Error(
            `GitHub issue #${issueNumber} not found in ${owner}/${repo}. Status: ${status}`
          );
        }
        throw new Error(
          `Failed to fetch GitHub issue #${issueNumber} from ${owner}/${repo}. Status: ${status}`
        );
      }

      const issue = (await issueResponse.json()) as {
        id: number;
        number: number;
        title: string;
        body: string;
        state: string;
        created_at: string;
        updated_at: string;
      };

      const commentsUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
      const commentsResponse = await fetch(commentsUrl, {
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
        },
      });

      const comments = (commentsResponse.ok ? await commentsResponse.json() : []) as Array<{
        id: number;
        body: string;
        user: { login: string };
        created_at: string;
        updated_at: string;
      }>;

      const relatedIssues: {
        id: number;
        number: number;
        title: string;
        body: string;
      }[] = [];

      const issueRefRegex = /#(\d+)/g;
      const allText = `${issue.body} ${comments.map((c: { body: string }) => c.body).join(" ")}`;
      const matches = Array.from(allText.matchAll(issueRefRegex));
      const referencedNumbers = new Set(
        matches.map((m) => parseInt(m[1], 10)).filter((n) => n !== issueNumber)
      );

      for (const num of Array.from(referencedNumbers).slice(0, 5)) {
        try {
          const relatedUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${num}`;
          const relatedResponse = await fetch(relatedUrl, {
            headers: {
              Authorization: `Bearer ${this.config.accessToken}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "Bassist-App",
            },
          });

          if (relatedResponse.ok) {
            const relatedIssue = (await relatedResponse.json()) as {
              id: number;
              number: number;
              title: string;
              body?: string;
            };
            relatedIssues.push({
              id: relatedIssue.id,
              number: relatedIssue.number,
              title: relatedIssue.title,
              body: relatedIssue.body || "",
            });
          }
        } catch {
          // Skip if we can't fetch a related issue
        }
      }

      return { issue, comments, relatedIssues };
    } catch (error) {
      Logger.error("Error fetching issue with comments", { error });
      throw error;
    }
  }

  async createFileAndPR(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    branch: string,
    prTitle: string,
    prBody: string
  ): Promise<{ prUrl: string; prNumber: number }> {
    try {
      const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
      const repoResponse = await fetch(repoUrl, {
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
        },
      });

      if (!repoResponse.ok) {
        throw new Error(`Failed to fetch repo: ${repoResponse.status}`);
      }

      const repoData = (await repoResponse.json()) as { default_branch: string };
      const defaultBranch = repoData.default_branch;

      const refsUrl = `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${defaultBranch}`;
      const refsResponse = await fetch(refsUrl, {
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
        },
      });

      if (!refsResponse.ok) {
        throw new Error(`Failed to fetch ref: ${refsResponse.status}`);
      }

      const refData = (await refsResponse.json()) as { object: { sha: string } };
      const baseSha = refData.object.sha;

      const createBranchUrl = `https://api.github.com/repos/${owner}/${repo}/git/refs`;
      const createBranchResponse = await fetch(createBranchUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        }),
      });

      if (!createBranchResponse.ok) {
        const errorText = await createBranchResponse.text();
        if (createBranchResponse.status === 422) {
          Logger.info(`Branch ${branch} already exists, using it`);
        } else {
          throw new Error(
            `Failed to create branch: ${createBranchResponse.status} - ${errorText}`
          );
        }
      }

      const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
      const fileResponse = await fetch(fileUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          content: Buffer.from(content).toString("base64"),
          branch,
        }),
      });

      if (!fileResponse.ok) {
        const errorText = await fileResponse.text();
        throw new Error(
          `Failed to create file: ${fileResponse.status} - ${errorText}`
        );
      }

      const prUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`;
      const prResponse = await fetch(prUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: prTitle,
          body: prBody,
          head: branch,
          base: defaultBranch,
        }),
      });

      if (!prResponse.ok) {
        const errorText = await prResponse.text();
        throw new Error(
          `Failed to create PR: ${prResponse.status} - ${errorText}`
        );
      }

      const prData = (await prResponse.json()) as {
        number: number;
        html_url: string;
      };
      Logger.info(
        `Successfully created PR #${prData.number}: ${prData.html_url}`
      );

      return {
        prUrl: prData.html_url,
        prNumber: prData.number,
      };
    } catch (error) {
      Logger.error("Error creating file and PR", { error });
      throw error;
    }
  }

  async createPullRequest(
    owner: string,
    repo: string,
    sourceBranch: string,
    targetBranch: string,
    title: string,
    description: string
  ): Promise<{ prUrl: string; prNumber: number }> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls`;

    Logger.info(
      `Creating GitHub PR: ${title} from ${sourceBranch} to ${targetBranch}`
    );

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Bassist-App",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          head: sourceBranch,
          base: targetBranch,
          title,
          body: description,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        Logger.error(`Failed to create GitHub PR: ${response.status}`, {
          errorText,
        });
        throw new Error(
          `Failed to create GitHub PR: ${response.status} - ${errorText}`
        );
      }

      const prData = (await response.json()) as {
        number: number;
        html_url: string;
      };
      Logger.info(`Successfully created GitHub PR #${prData.number}`);

      return {
        prUrl: prData.html_url,
        prNumber: prData.number,
      };
    } catch (error) {
      Logger.error("Error creating GitHub PR", { error });
      throw error;
    }
  }
}
