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
  getAllUserSessions,
} from "../services/firebaseService";
import { syncSessionToNotion } from "../services/notionService";
import {
  getKnowledgeGraph,
  getKnowledgeGraphNode,
  rebuildKnowledgeGraphFromSessionMaps,
  searchKnowledgeGraph,
  upsertKnowledgeGraphFromConceptMap,
} from "../services/knowledgeGraphService";
import { decodeUserId } from "../services/authService";

const router = Router();

function sessionIdParam(req: Request): string {
  const p = req.params.sessionId;
  return Array.isArray(p) ? p[0] ?? "" : p ?? "";
}

function extractLatestUserIdea(messages: { role: string; content?: string }[] = []): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    const content = (msg.content ?? "").trim();
    if (content) return content;
  }
  return "";
}

function extractLatestAssistantReply(messages: { role: string; content?: string }[] = []): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const content = (msg.content ?? "").trim();
    if (content) return content;
  }
  return "";
}

function stripTrailingJsonLine(text: string): string {
  const lines = (text || "").split("\n");
  while (lines.length > 0) {
    const last = (lines[lines.length - 1] ?? "").trim();
    if (!last) {
      lines.pop();
      continue;
    }
    if (!last.startsWith("{")) break;
    try {
      JSON.parse(last);
      lines.pop();
      break;
    } catch {
      break;
    }
  }
  return lines.join("\n").trim();
}

function hasConceptMapData(map: Record<string, string[]> | null | undefined): boolean {
  return !!map && typeof map === "object" && Object.keys(map).length > 0;
}

function latestIdeaConversation(messages: { role: string; content?: string }[] = []): { role: "user" | "assistant"; content: string }[] {
  const latestUserIdx = [...messages].map((m) => m.role).lastIndexOf("user");
  if (latestUserIdx < 0) return [];
  const userMsg = (messages[latestUserIdx]?.content ?? "").trim();
  if (!userMsg) return [];

  let assistantMsg = "";
  for (let i = latestUserIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    assistantMsg = stripTrailingJsonLine((m.content ?? "").trim());
    if (assistantMsg) break;
  }

  const out: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: userMsg }];
  if (assistantMsg) out.push({ role: "assistant", content: assistantMsg });
  return out;
}

function sessionConceptMapsForRebuild(
  sessions: { id: string; conceptMap: Record<string, string[]>; messages: { role: string; content?: string }[] }[]
): { sessionId: string; conceptMap: Record<string, string[]> }[] {
  return sessions.map((s) => {
    let conceptMap = s.conceptMap ?? {};
    if (!hasConceptMapData(conceptMap)) {
      const latestAssistantReply = extractLatestAssistantReply(s.messages ?? []);
      if (latestAssistantReply) {
        conceptMap = parseStructuredResponse(latestAssistantReply).conceptMap;
      }
    }
    return { sessionId: s.id, conceptMap };
  });
}

function resolveGraphUserId(req: Request & { userId?: string }): string {
  const authUserId = (req.userId ?? "").trim();
  if (authUserId && authUserId !== "anonymous") return authUserId;

  const encodedRaw = Array.isArray(req.query.encodedUserId)
    ? req.query.encodedUserId[0]
    : req.query.encodedUserId;
  const encodedUserId = String(encodedRaw ?? "").trim();
  if (encodedUserId) {
    const decoded = decodeUserId(encodedUserId);
    if (decoded) return decoded;
  }

  const userIdRaw = Array.isArray(req.query.userId) ? req.query.userId[0] : req.query.userId;
  const queryUserId = String(userIdRaw ?? "").trim();
  return queryUserId || "anonymous";
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
        if (hasConceptMapData(conceptMap)) {
          await updateConceptMap(sid, conceptMap);
          await upsertKnowledgeGraphFromConceptMap({
            userId,
            sessionId: sid,
            conceptMap,
          });
        }
        if (feasibilitySignal != null) {
          await updateFeasibilitySignal(sid, feasibilitySignal);
        }
        await appendMessage(sid, "assistant", fullResponse);

        if (process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID) {
          await syncSessionToNotion({
            title: `Mirror Mind - ${new Date().toLocaleString()}`,
            ideaDetails: userInput,
            agentReply: stripTrailingJsonLine(fullResponse),
            ideaConversation: [
              { role: "user", content: userInput },
              { role: "assistant", content: stripTrailingJsonLine(fullResponse) },
            ],
            conceptMap,
            feasibilitySignal,
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

router.get("/knowledge-graph", async (req: Request & { userId?: string }, res: Response): Promise<void> => {
  try {
    const userId = resolveGraphUserId(req);
    const limitNodes = parseInt(req.query.limitNodes as string, 10) || 300;
    const limitEdges = parseInt(req.query.limitEdges as string, 10) || 600;
    let graph = await getKnowledgeGraph(userId, limitNodes, limitEdges);

    // If graph store is empty, auto-rebuild from all sessions to avoid blank UI.
    if ((graph.nodes?.length ?? 0) === 0) {
      const sessions = await getAllUserSessions(userId);
      const stats = await rebuildKnowledgeGraphFromSessionMaps({
        userId,
        sessions: sessionConceptMapsForRebuild(sessions),
      });
      graph = await getKnowledgeGraph(userId, limitNodes, limitEdges);
      res.json({
        ...graph,
        resolvedUserId: userId,
        rebuilt: true,
        sessionsTotal: sessions.length,
        sessionsUsed: stats.sessionsProcessed,
      });
      return;
    }

    res.json({ ...graph, resolvedUserId: userId, rebuilt: false });
  } catch (error) {
    console.error("Get knowledge graph error:", error);
    res.status(500).json({ error: "Failed to fetch knowledge graph" });
  }
});

router.get("/knowledge-graph/search", async (req: Request & { userId?: string }, res: Response): Promise<void> => {
  try {
    const userId = resolveGraphUserId(req);
    const q = String(req.query.q ?? "").trim();
    const limit = parseInt(req.query.limit as string, 10) || 20;
    if (!q) {
      res.status(400).json({ error: "q query param required" });
      return;
    }
    const result = await searchKnowledgeGraph(userId, q, limit);
    res.json(result);
  } catch (error) {
    console.error("Search knowledge graph error:", error);
    res.status(500).json({ error: "Failed to search knowledge graph" });
  }
});

router.get("/knowledge-graph/node/:nodeId", async (req: Request & { userId?: string }, res: Response): Promise<void> => {
  try {
    const userId = resolveGraphUserId(req);
    const nodeId = Array.isArray(req.params.nodeId) ? req.params.nodeId[0] : req.params.nodeId;
    if (!nodeId) {
      res.status(400).json({ error: "nodeId required" });
      return;
    }
    const details = await getKnowledgeGraphNode(userId, nodeId);
    if (!details.node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    res.json(details);
  } catch (error) {
    console.error("Get knowledge graph node error:", error);
    res.status(500).json({ error: "Failed to fetch graph node" });
  }
});

router.post("/knowledge-graph/rebuild", async (req: Request & { userId?: string }, res: Response): Promise<void> => {
  try {
    const userId = resolveGraphUserId(req);
    const sessions = await getAllUserSessions(userId);
    const stats = await rebuildKnowledgeGraphFromSessionMaps({
      userId,
      sessions: sessionConceptMapsForRebuild(sessions),
    });
    res.json({
      success: true,
      resolvedUserId: userId,
      sessionsTotal: sessions.length,
      sessionsUsed: stats.sessionsProcessed,
      nodes: stats.nodes,
      edges: stats.edges,
    });
  } catch (error) {
    console.error("Rebuild knowledge graph error:", error);
    res.status(500).json({ error: "Failed to rebuild knowledge graph" });
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
      const latestAssistantReply = extractLatestAssistantReply(session.messages ?? []);
      let conceptMapForSync = session.conceptMap ?? {};
      if (!hasConceptMapData(conceptMapForSync) && latestAssistantReply) {
        conceptMapForSync = parseStructuredResponse(latestAssistantReply).conceptMap;
      }
      const page = await syncSessionToNotion({
        title: `Mirror Mind - ${sessionId.slice(0, 8)} - ${new Date().toLocaleString()}`,
        ideaDetails: extractLatestUserIdea(session.messages ?? []),
        agentReply: stripTrailingJsonLine(latestAssistantReply),
        ideaConversation: latestIdeaConversation(session.messages ?? []),
        conceptMap: conceptMapForSync,
        feasibilitySignal: session.feasibilitySignal,
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
