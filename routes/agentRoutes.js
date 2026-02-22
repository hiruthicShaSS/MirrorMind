const express = require("express");
const {
  streamThinkingResponse,
  parseStructuredResponse,
} = require("../services/geminiService");
const {
  createSession,
  getSession,
  appendMessage,
  updateConceptMap,
  updateFeasibilitySignal,
  closeSession,
  getUserSessions,
} = require("../services/firebaseService");
const { syncSessionToNotion } = require("../services/notionService");

const router = express.Router();

// Create a new thinking session (associated with user)
router.post("/sessions", async (req, res) => {
  try {
    const userId = req.userId; // From auth middleware
    const session = await createSession(userId);
    res.json(session);
  } catch (error) {
    console.error("Session creation error:", error);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// Get session state (verify user owns session)
router.get("/sessions/:sessionId", async (req, res) => {
  try {
    const userId = req.userId;
    const session = await getSession(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Verify user owns this session
    if (session.userId && session.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    res.json(session);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch session" });
  }
});

// Stream thinking response (verify ownership)
router.post("/sessions/:sessionId/think", async (req, res) => {
  const userId = req.userId;
  const { userInput, isInterrupt } = req.body;

  if (!userInput) {
    return res.status(400).json({ error: "userInput required" });
  }

  try {
    const session = await getSession(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Verify user owns this session
    if (session.userId && session.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // If interrupt, clear some context for fast pivot
    let contextMessages = session.messages.slice(-6); // Keep last 6 messages for context
    if (isInterrupt) {
      contextMessages = session.messages.slice(-2); // Minimal context on interrupt
    }

    // Add user input to session
    await appendMessage(req.params.sessionId, "user", userInput);

    // Stream as NDJSON (newline-delimited JSON)
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";

    try {
      const result = await streamThinkingResponse(userInput, contextMessages);
      const stream = result.stream || result;

      for await (const chunk of stream) {
        const text = chunk.text?.() || chunk.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (text) {
          fullResponse += text;
          res.write(JSON.stringify({ chunk: text }) + "\n");
        }
      }

      const { conceptMap, feasibilitySignal } = parseStructuredResponse(fullResponse);

      await updateConceptMap(req.params.sessionId, conceptMap);
      if (feasibilitySignal != null) {
        await updateFeasibilitySignal(req.params.sessionId, feasibilitySignal);
      }

      await appendMessage(req.params.sessionId, "assistant", fullResponse);

      if (process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID) {
        const updatedSession = await getSession(req.params.sessionId);
        await syncSessionToNotion({
          title: `Mirror Mind - ${new Date().toLocaleString()}`,
          conceptMap,
          feasibilitySignal,
          messages: updatedSession?.messages || [],
          tags: [{ name: "mirror-mind" }],
        }).catch((e) => console.warn("Notion sync skipped:", e.message));
      }

      res.write(
        JSON.stringify({
          done: true,
          conceptMap,
          feasibilitySignal,
        }) + "\n"
      );
      res.end();
    } catch (streamError) {
      console.error("Stream error:", streamError);
      res.write(
        JSON.stringify({
          error: "Stream interrupted",
          errorMessage: streamError.message,
        }) + "\n"
      );
      res.end();
    }
  } catch (error) {
    console.error("Think endpoint error:", error);
    res.status(500).json({ error: "Failed to process thinking" });
  }
});

// Get all user sessions (with concept maps)
router.get("/sessions", async (req, res) => {
  try {
    const userId = req.userId;
    const limit = parseInt(req.query.limit) || 50;
    const sessions = await getUserSessions(userId, limit);
    res.json(sessions);
  } catch (error) {
    console.error("Get sessions error:", error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// Get concept map history (summary view)
router.get("/concept-maps", async (req, res) => {
  try {
    const userId = req.userId;
    const limit = parseInt(req.query.limit) || 50;
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
        messageCount: s.messages?.length || 0,
        preview: s.messages?.[0]?.content?.slice(0, 100) || "",
      }))
      .sort((a, b) => {
        const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return bTime - aTime;
      });
    
    res.json(conceptMaps);
  } catch (error) {
    console.error("Get concept maps error:", error);
    res.status(500).json({ error: "Failed to fetch concept maps" });
  }
});

// Save/update concept map for a session
router.put("/sessions/:sessionId/concept-map", async (req, res) => {
  try {
    const userId = req.userId;
    const sessionId = req.params.sessionId;
    const { conceptMap } = req.body;

    if (!conceptMap || typeof conceptMap !== "object" || Array.isArray(conceptMap)) {
      return res.status(400).json({ error: "conceptMap must be an object" });
    }

    const session = await getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (session.userId && session.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    await updateConceptMap(sessionId, conceptMap);
    res.json({ success: true, conceptMap });
  } catch (error) {
    console.error("Update concept map error:", error);
    res.status(500).json({ error: "Failed to update concept map" });
  }
});

// Sync session to Notion (ideas + concept map + feasibility)
router.post("/sessions/:sessionId/sync-notion", async (req, res) => {
  try {
    const userId = req.userId;
    const sessionId = req.params.sessionId;

    const session = await getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (session.userId && session.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const { syncSessionToNotion } = require("../services/notionService");
    const page = await syncSessionToNotion({
      title: `Mirror Mind - ${sessionId.slice(0, 8)} - ${new Date().toLocaleString()}`,
      conceptMap: session.conceptMap || {},
      feasibilitySignal: session.feasibilitySignal,
      messages: session.messages || [],
      tags: [{ name: "mirror-mind" }],
    });

    res.json({ success: true, notionPageId: page?.id });
  } catch (error) {
    console.error("Sync to Notion error:", error);
    res.status(500).json({
      error: "Failed to sync to Notion",
      message: error.message,
    });
  }
});

// Close session and finalize
router.post("/sessions/:sessionId/close", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const userId = req.userId;

    const session = await getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (session.userId && session.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized: You do not own this session" });
    }

    await closeSession(sessionId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to close session" });
  }
});

module.exports = router;
