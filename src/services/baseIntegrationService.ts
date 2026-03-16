import type { ITaskData } from "../interfaces/ITaskData";

export interface SearchResult {
  id: string;
  title: string;
  assigneeId?: string;
  assigneeName?: string;
  summary?: string;
}

export interface IntegrationTool {
  tool: {
    functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: unknown;
    }>;
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export abstract class BaseIntegrationService<TData extends ITaskData, TResult> {
  abstract getTools(): IntegrationTool[];

  abstract createTask(data: TData): Promise<TResult>;

  async batchCreateTasks(items: TData[]): Promise<TResult[]> {
    return Promise.all(items.map((item) => this.createTask(item)));
  }

  async resolveAssigneeNameToId(
    assigneeNameOrId: string,
    _options?: {
      projectKey?: string;
      owner?: string;
      repo?: string;
      projectId?: string | number;
    }
  ): Promise<string> {
    return assigneeNameOrId;
  }
}
