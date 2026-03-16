import { getUserProfile, updateUserProfile, type StoredGithubConnection } from "./firebaseService";

export interface GitHubRepoSummary {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  url: string;
}

interface GitHubViewer {
  login: string;
  name?: string | null;
  avatar_url?: string | null;
}

interface GitHubRepoApiRecord {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch?: string;
  owner?: { login?: string };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function persistGitHubConnection(
  userId: string,
  payload: {
    accessToken: string;
    scopes?: string[];
    login?: string | null;
    name?: string | null;
    avatarUrl?: string | null;
  }
): Promise<StoredGithubConnection> {
  const now = new Date().toISOString();
  const existing = await getUserProfile(userId);
  if (!existing) throw new Error("User not found");

  const github: StoredGithubConnection = {
    connected: true,
    accessToken: payload.accessToken,
    login: payload.login ?? existing.github?.login ?? null,
    name: payload.name ?? existing.github?.name ?? null,
    avatarUrl: payload.avatarUrl ?? existing.github?.avatarUrl ?? null,
    scopes: payload.scopes ?? existing.github?.scopes ?? [],
    defaultOwner: existing.github?.defaultOwner ?? payload.login ?? null,
    defaultRepo: existing.github?.defaultRepo ?? null,
    connectedAt: existing.github?.connectedAt ?? now,
    updatedAt: now,
  };

  await updateUserProfile(userId, { github });
  return github;
}

export async function getGitHubConnection(userId: string): Promise<StoredGithubConnection | null> {
  const user = await getUserProfile(userId);
  const github = user?.github ?? null;
  if (!github?.connected || !github.accessToken) return null;
  return github;
}

export async function setGitHubDefaultRepo(
  userId: string,
  owner: string,
  repo: string
): Promise<StoredGithubConnection> {
  const existing = await getGitHubConnection(userId);
  if (!existing) throw new Error("GitHub not connected");
  const github: StoredGithubConnection = {
    ...existing,
    defaultOwner: owner,
    defaultRepo: repo,
    updatedAt: new Date().toISOString(),
  };
  await updateUserProfile(userId, { github });
  return github;
}

export async function fetchGitHubViewer(token: string): Promise<GitHubViewer> {
  const response = await fetch("https://api.github.com/user", {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub viewer: ${response.status}`);
  }
  return (await response.json()) as GitHubViewer;
}

export async function listGitHubRepos(token: string): Promise<GitHubRepoSummary[]> {
  const response = await fetch("https://api.github.com/user/repos?sort=updated&per_page=100", {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub repos: ${response.status}`);
  }
  const repos = (await response.json()) as GitHubRepoApiRecord[];
  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: String(repo.owner?.login ?? "").trim(),
    private: repo.private,
    defaultBranch: String(repo.default_branch ?? "main").trim() || "main",
    url: repo.html_url,
  }));
}

export async function getGitHubStatus(userId: string): Promise<{
  connected: boolean;
  login: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  scopes: string[];
  defaultOwner: string | null;
  defaultRepo: string | null;
}> {
  const github = await getGitHubConnection(userId);
  if (!github) {
    return {
      connected: false,
      login: null,
      name: null,
      avatarUrl: null,
      scopes: [],
      defaultOwner: null,
      defaultRepo: null,
    };
  }

  return {
    connected: true,
    login: github.login,
    name: github.name ?? null,
    avatarUrl: github.avatarUrl ?? null,
    scopes: github.scopes ?? [],
    defaultOwner: github.defaultOwner ?? null,
    defaultRepo: github.defaultRepo ?? null,
  };
}
