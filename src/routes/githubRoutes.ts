import { Router, Request, Response } from "express";
import {
  getGitHubConnection,
  getGitHubStatus,
  listGitHubRepos,
  setGitHubDefaultRepo,
} from "../services/githubAccountService";

const router = Router();

router.get("/status", async (req: Request & { userId?: string }, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const status = await getGitHubStatus(userId);
    res.json(status);
  } catch (error) {
    console.error("GitHub status error:", error);
    res.status(500).json({ error: "Failed to fetch GitHub status" });
  }
});

router.get("/repos", async (req: Request & { userId?: string }, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const github = await getGitHubConnection(userId);
    if (!github) {
      res.status(404).json({ error: "GitHub not connected" });
      return;
    }

    const repos = await listGitHubRepos(github.accessToken);
    res.json({
      repos,
      defaultOwner: github.defaultOwner ?? null,
      defaultRepo: github.defaultRepo ?? null,
    });
  } catch (error) {
    console.error("GitHub repos error:", error);
    res.status(500).json({
      error: "Failed to fetch GitHub repositories",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.put("/default-repo", async (req: Request & { userId?: string }, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const { owner, repo } = req.body as { owner?: string; repo?: string };
    const normalizedOwner = String(owner ?? "").trim();
    const normalizedRepo = String(repo ?? "").trim();

    if (!normalizedOwner || !normalizedRepo) {
      res.status(400).json({ error: "owner and repo are required" });
      return;
    }

    const github = await setGitHubDefaultRepo(userId, normalizedOwner, normalizedRepo);
    res.json({
      success: true,
      defaultOwner: github.defaultOwner ?? null,
      defaultRepo: github.defaultRepo ?? null,
    });
  } catch (error) {
    console.error("GitHub default repo error:", error);
    res.status(500).json({
      error: "Failed to update default repo",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
