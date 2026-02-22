import { Router, Request, Response } from "express";
import { streamThinkingResponse, parseStructuredResponse } from "../services/geminiService";
import {
  createSession,
  getSession,
  appendMessage,
  updateConceptMap,
  updateFeasibilitySignal,
  closeSession,
  getUserSessions,
} from "../services/firebaseService";
import { syncSessionToNotion } from "../services/notionService";

const router = Router();

function sessionIdParam(req: Request): string {
  const p = req.params.sessionId;
  return Array.isArray(p) ? p[0] ?? "" : p ?? "";
}

router.post("/sessions", async (req: Request & { userId?: string }, res: Response): Promise<void> => {
  try {
    const userId = req.userId ?? null;
    const session = await createSession(userId);
    res.json(session);
  } catch (error) {
    console.error("Session creation error:", error);
    res.status(500).json({ error: "Failed to create session" });
  }
});

router.get(
  "/sessions/:sessionId",
  async (req: Request & { userId?: string }, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const session = await getSession(sessionIdParam(req));
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (session.userId && session.userId !== userId) {
        res.status(403).json({ error: "Unauthorized" });
        return;
      }
      res.json(session);
    } catch {
      res.status(500).json({ error: "Failed to fetch session" });
    }
  }
);

router.post(
  "/sessions/:sessionId/think",
  async (req: Request & { userId?: string }, res: Response): Promise<void> => {
    const userId = req.userId!;
    const { userInput, isInterrupt } = req.body as { userInput?: string; isInterrupt?: boolean };

    if (!userInput) {
      res.status(400).json({ error: "userInput required" });
      return;
    }
    const sid = sessionIdParam(req);
    try {
      const session = await getSession(sid);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (session.userId && session.userId !== userId) {
        res.status(403).json({ error: "Unauthorized" });
        return;
      }

      let contextMessages = session.messages.slice(-6);
      if (isInterrupt) contextMessages = session.messages.slice(-2);

      await appendMessage(sid, "user", userInput);

      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let fullResponse = "";

      try {
        const result = await streamThinkingResponse(userInput, contextMessages);
        const stream = result;

        for await (const chunk of stream) {
          const text = chunk.text?.() ?? "";
          if (text) {
            fullResponse += text;
            res.write(JSON.stringify({ chunk: text }) + "\n");
          }
        }

        const { conceptMap, feasibilitySignal } = parseStructuredResponse(fullResponse);
        await updateConceptMap(sid, conceptMap);
        if (feasibilitySignal != null) {
          await updateFeasibilitySignal(sid, feasibilitySignal);
        }
        await appendMessage(sid, "assistant", fullResponse);

        if (process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID) {
          const updatedSession = await getSession(sid);
          await syncSessionToNotion({
            title: `Mirror Mind - ${new Date().toLocaleString()}`,
            conceptMap,
            feasibilitySignal,
            messages: updatedSession?.messages ?? [],
            tags: [{ name: "mirror-mind" }],
          }).catch((e: Error) => console.warn("Notion sync skipped:", e.message));
        }

        res.write(
          JSON.stringify({ done: true, conceptMap, feasibilitySignal }) + "\n"
        );
        res.end();
      } catch (streamError) {
        console.error("Stream error:", streamError);
        res.write(
          JSON.stringify({
            error: "Stream interrupted",
            errorMessage: streamError instanceof Error ? streamError.message : String(streamError),
          }) + "\n"
        );
        res.end();
      }
    } catch (error) {
      console.error("Think endpoint error:", error);
      res.status(500).json({ error: "Failed to process thinking" });
    }
  }
);

router.get("/sessions", async (req: Request & { userId?: string }, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const sessions = await getUserSessions(userId, limit);
    res.json(sessions);
  } catch (error) {
    console.error("Get sessions error:", error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

router.get("/concept-maps", async (req: Request & { userId?: string }, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const sessions = await getUserSessions(userId, limit);
    const conceptMaps = sessions
      .filter((s) => s.conceptMap && Object.keys(s.conceptMap).length > 0)
      .map((s) => ({
        sessionId: s.id,
        conceptMap: s.conceptMap,
        feasibilitySignal: s.feasibilitySignal,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        isActive: s.isActive,
        messageCount: s.messages?.length ?? 0,
        preview: s.messages?.[0]?.content?.slice(0, 100) ?? "",
      }))
      .sort((a, b) => {
        const aTime = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime();
        const bTime = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime();
        return bTime - aTime;
      });
    res.json(conceptMaps);
  } catch (error) {
    console.error("Get concept maps error:", error);
    res.status(500).json({ error: "Failed to fetch concept maps" });
  }
});

router.put(
  "/sessions/:sessionId/concept-map",
  async (req: Request & { userId?: string }, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const sessionId = sessionIdParam(req);
      const { conceptMap } = req.body as { conceptMap?: unknown };

      if (!conceptMap || typeof conceptMap !== "object" || Array.isArray(conceptMap)) {
        res.status(400).json({ error: "conceptMap must be an object" });
        return;
      }

      const session = await getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (session.userId && session.userId !== userId) {
        res.status(403).json({ error: "Unauthorized" });
        return;
      }
      await updateConceptMap(sessionId, conceptMap as Record<string, string[]>);
      res.json({ success: true, conceptMap });
    } catch (error) {
      console.error("Update concept map error:", error);
      res.status(500).json({ error: "Failed to update concept map" });
    }
  }
);

router.post(
  "/sessions/:sessionId/sync-notion",
  async (req: Request & { userId?: string }, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const sessionId = sessionIdParam(req);
      const session = await getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (session.userId && session.userId !== userId) {
        res.status(403).json({ error: "Unauthorized" });
        return;
      }
      const page = await syncSessionToNotion({
        title: `Mirror Mind - ${sessionId.slice(0, 8)} - ${new Date().toLocaleString()}`,
        conceptMap: session.conceptMap ?? {},
        feasibilitySignal: session.feasibilitySignal,
        messages: session.messages ?? [],
        tags: [{ name: "mirror-mind" }],
      });
      res.json({ success: true, notionPageId: page?.id });
    } catch (error) {
      console.error("Sync to Notion error:", error);
      res.status(500).json({
        error: "Failed to sync to Notion",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

router.post(
  "/sessions/:sessionId/close",
  async (req: Request & { userId?: string }, res: Response): Promise<void> => {
    try {
      const sessionId = sessionIdParam(req);
      const userId = req.userId!;
      const session = await getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (session.userId && session.userId !== userId) {
        res.status(403).json({ error: "Unauthorized: You do not own this session" });
        return;
      }
      await closeSession(sessionId);
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to close session" });
    }
  }
);

export default router;
