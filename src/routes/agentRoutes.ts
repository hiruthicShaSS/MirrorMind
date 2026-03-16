import { Router, Request, Response } from "express";
import { streamThinkingResponse, parseStructuredResponse } from "../services/geminiService";
import {
  createSession,
  getSession,
  appendMessage,
  getUserProfile,
  updateConceptMap,
  updateFeasibilitySignal,
  closeSession,
  getUserSessions,
  getAllUserSessions,
  updateSessionPocDraft,
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
import { buildPocDraft } from "../services/pocService";
import { notifyPocReady } from "../services/notificationService";
import {
  publishPocAsPullRequest,
  publishPocToGitHub,
} from "../services/githubPublishingService";
import {
  getGitHubConnection,
  setGitHubDefaultRepo,
} from "../services/githubAccountService";

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

function parseTechStack(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function parseStringList(value: unknown, limit = 8): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .slice(0, limit);
  }

  const text = String(value ?? "").trim();
  if (!text) return [];
  return text
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function deriveReferenceLinks(seedText: string, explicitLinks: string[]): string[] {
  if (explicitLinks.length > 0) return explicitLinks;

  const text = seedText.toLowerCase();
  const matches: string[] = [];

  const catalog: Array<{ keywords: string[]; links: string[] }> = [
    {
      keywords: ["athlete", "fitness", "training", "workout", "breathing", "health"],
      links: ["https://www.strava.com/", "https://www.whoop.com/", "https://www.headspace.com/"],
    },
    {
      keywords: ["meditation", "mindfulness", "sleep", "wellness"],
      links: ["https://www.calm.com/", "https://www.headspace.com/"],
    },
    {
      keywords: ["task", "project", "productivity", "team", "collaboration"],
      links: ["https://www.notion.so/", "https://trello.com/", "https://asana.com/"],
    },
    {
      keywords: ["chat", "community", "social", "messaging"],
      links: ["https://discord.com/", "https://slack.com/", "https://www.reddit.com/"],
    },
    {
      keywords: ["finance", "budget", "banking", "expense", "invest"],
      links: ["https://www.mint.com/", "https://www.ynab.com/", "https://www.robinhood.com/"],
    },
    {
      keywords: ["education", "learning", "course", "student"],
      links: ["https://www.khanacademy.org/", "https://www.duolingo.com/", "https://www.coursera.org/"],
    },
    {
      keywords: ["ecommerce", "shop", "store", "marketplace"],
      links: ["https://www.shopify.com/", "https://www.etsy.com/", "https://www.amazon.com/"],
    },
    {
      keywords: ["travel", "trip", "hotel", "booking"],
      links: ["https://www.airbnb.com/", "https://www.booking.com/", "https://www.tripadvisor.com/"],
    },
  ];

  for (const group of catalog) {
    if (group.keywords.some((keyword) => text.includes(keyword))) {
      for (const link of group.links) {
        if (!matches.includes(link)) matches.push(link);
      }
    }
    if (matches.length >= 3) break;
  }

  return matches.slice(0, 3);
}

function inferTechStackFromText(text: string, limit = 6): string[] {
  const lowered = text.toLowerCase();
  const triggerSplit = text
    .split(/[,/]| and | with | using /i)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
  const candidates = triggerSplit
    .map((part) => part.replace(/[^a-zA-Z0-9.+#_-]/g, " ").trim())
    .filter(Boolean);
  return candidates.slice(0, limit);
}

function detectProductType(text: string): string | null {
  const lowered = text.toLowerCase();
  const types = ["web", "mobile", "desktop", "cli", "api", "service", "chrome extension", "slack app"];
  for (const t of types) {
    const pattern = new RegExp(`\\b${t.replace(" ", "\\s+")}\\b`, "i");
    if (pattern.test(lowered)) return t;
  }
  return null;
}

function detectTargetAudience(text: string): string | null {
  const match = text.match(/\bfor\s+([A-Za-z0-9 ,.&-]{3,80})/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  const explicit = text.match(/\btarget (audience|users?)[:\s]+([\w ,.&-]{3,80})/i);
  if (explicit && explicit[2]) return explicit[2].trim();
  return null;
}

function detectUiStyle(text: string): string | null {
  const uiMatch = text.match(/\b(ui|design|look|feel|theme|style)\b[:\s-]*([\w ,.&-]{3,80})/i);
  if (uiMatch && uiMatch[2]) return uiMatch[2].trim();
  return null;
}

function formatPocConclusion(opts: {
  idea: string;
  stack: string[];
  target?: string | null;
  productType?: string | null;
}): string {
  const trimmedIdea = opts.idea.length > 120 ? `${opts.idea.slice(0, 117)}...` : opts.idea;
  const stackLabel = opts.stack.length ? opts.stack.join(", ") : "the chosen stack";
  const audience = opts.target?.trim() || "your users";
  const product = opts.productType?.trim() || "product";
  return `Understood! I'll proceed with the POC for ${trimmedIdea || "this idea"}, using ${stackLabel}, tailored for ${audience} as a ${product}.`;
}

const GENERATE_PROMPT = "Shall I generate the POC now?";

function pocEventPayload(
  poc: Record<string, unknown>,
  prUrl: string | null = null
): Record<string, unknown> {
  const files = Array.isArray(poc.files) ? (poc.files as unknown[]) : [];
  const safeFiles = files
    .map((f) => {
      if (!f || typeof f !== "object") return null;
      const rec = f as Record<string, unknown>;
      const path = String(rec.path ?? "").trim();
      const content = String(rec.content ?? "").trim();
      if (!path || !content) return null;
      return { path, content };
    })
    .filter(Boolean);

  return {
    title: String(poc.title ?? "POC Build"),
    summary: String(poc.summary ?? ""),
    techStack: Array.isArray(poc.techStack) ? poc.techStack : [],
    targetUsers: poc.targetUsers ?? null,
    productType: poc.productType ?? null,
    uiStyle: poc.uiStyle ?? null,
    files: safeFiles,
    aiStudioLink: String(poc.aiStudioLink ?? ""),
    referenceLinks: Array.isArray(poc.referenceLinks) ? poc.referenceLinks : [],
    prUrl,
  };
}

function resolveAiStudioLink(value: unknown): string {
  const explicit = String(value ?? "").trim();
  if (explicit) return explicit;
  return String(process.env.AI_STUDIO_DEFAULT_LINK ?? "https://aistudio.google.com/apps").trim();
}

function normalizeRepoTarget(value: unknown): { owner: string; repo: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const owner = String(rec.owner ?? "").trim();
  const repo = String(rec.repo ?? "").trim();
  if (!owner || !repo) return null;
  return { owner, repo };
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

      // Auto-POC intent handling before streaming.
      const wantsPoc = /\b(build|create|generate)\s+(a\s+)?poc\b/i.test(userInput);
      const inferredStack = inferTechStackFromText(userInput);
      const lastAssistantMsg = session.messages?.[session.messages.length - 1];
      const awaitingStack =
        lastAssistantMsg?.role === "assistant" &&
        /which tech stack should i use|what tech stack should i use/i.test(lastAssistantMsg.content ?? "");

      const productTypeFromInput = detectProductType(userInput);
      const targetAudienceFromInput = detectTargetAudience(userInput);
      const uiStyleFromInput = detectUiStyle(userInput);

      const pendingPoc = session.pocDraft && session.pocDraft.generatedBy === "auto-poc-pending"
        ? (session.pocDraft as Record<string, unknown>)
        : null;

      const alreadyPromptedPoc =
        session.pocDraft &&
        session.pocDraft.generatedBy &&
        session.pocDraft.generatedBy !== "auto-poc-pending";

      const pendingStack = Array.isArray(pendingPoc?.techStack) ? (pendingPoc?.techStack as string[]) : [];
      const pendingTarget = typeof pendingPoc?.targetUsers === "string" ? (pendingPoc?.targetUsers as string) : "";
      const pendingProduct = typeof pendingPoc?.productType === "string" ? (pendingPoc?.productType as string) : "";
      const pendingUi = typeof pendingPoc?.uiStyle === "string" ? (pendingPoc?.uiStyle as string) : "";

      // Guided POC intake: ask for missing fields in order, then build and notify.
      if ((wantsPoc || awaitingStack || pendingPoc) && !alreadyPromptedPoc) {
        const ideaMessages = [...(session.messages ?? []), { role: "user", content: userInput }];
        const normalizedIdea = String(extractLatestUserIdea(ideaMessages)).trim();
        const stack = inferredStack.length ? inferredStack : pendingStack;
        const target = targetAudienceFromInput || pendingTarget;
        const productType = productTypeFromInput || pendingProduct;
        const uiStyle = uiStyleFromInput || pendingUi;

        const askStack = stack.length === 0;
        const askTarget = !askStack && !target;
        const askProduct = !askStack && !askTarget && !productType;

        if (askStack) {
          const prompt =
            "I can build the POC. What tech stack should I use? (e.g., Next.js + Supabase). Then I'll ask target audience, UI style, and product type.";
          await appendMessage(sid, "assistant", prompt);
          res.setHeader("Content-Type", "application/x-ndjson");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.write(JSON.stringify({ chunk: prompt }) + "\n");
          res.write(JSON.stringify({ done: true }) + "\n");
          res.end();
          return;
        }

        if (askTarget) {
          await updateSessionPocDraft(
            sid,
            {
              generatedBy: "auto-poc-pending",
              idea: normalizedIdea,
              techStack: stack,
            },
            null
          );
          const prompt = "Great. Who is the target audience for this POC?";
          await appendMessage(sid, "assistant", prompt);
          res.setHeader("Content-Type", "application/x-ndjson");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.write(JSON.stringify({ chunk: prompt }) + "\n");
          res.write(JSON.stringify({ done: true }) + "\n");
          res.end();
          return;
        }

        if (askProduct) {
          await updateSessionPocDraft(
            sid,
            {
              generatedBy: "auto-poc-pending",
              idea: normalizedIdea,
              techStack: stack,
              targetUsers: target,
            },
            null
          );
          const prompt = "What product type should this be (web/mobile/desktop/CLI)?";
          await appendMessage(sid, "assistant", prompt);
          res.setHeader("Content-Type", "application/x-ndjson");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.write(JSON.stringify({ chunk: prompt }) + "\n");
          res.write(JSON.stringify({ done: true }) + "\n");
          res.end();
          return;
        }

        // All required inputs gathered: build POC and notify.
        try {
          const userProfile = await getUserProfile(userId).catch(() => null);
          const loginEmail = String(userProfile?.email ?? "").trim();
          const normalizedAiStudioLink = resolveAiStudioLink(null);

          const pocDraft = await buildPocDraft(
            {
              idea: normalizedIdea,
              techStack: stack,
              productType: productType ?? undefined,
              targetUsers: target ?? undefined,
            },
            { userApiKey: undefined }
          );

          const title = String(pocDraft.title ?? "POC Build").trim() || "POC Build";
          const referenceLinks = Array.isArray(req.body?.referenceLinks) ? parseStringList(req.body.referenceLinks) : [];

          const stored = {
            ...pocDraft,
            title,
            idea: normalizedIdea,
            techStack: stack,
            productType: productType ?? null,
            targetUsers: target ?? null,
            uiStyle: uiStyle ?? null,
            referenceLinks,
            aiStudioLink: normalizedAiStudioLink,
            generatedAt: new Date().toISOString(),
            generatedBy: "auto-poc-ready",
          };

          const summaryLine = formatPocConclusion({
            idea: normalizedIdea,
            stack,
            target,
            productType,
          });

          const reply = [
            summaryLine,
            uiStyle ? `UI style noted: ${uiStyle}.` : "",
            `Title: ${title}`,
            `Summary: ${String(pocDraft.summary ?? "")}`,
            GENERATE_PROMPT,
          ]
            .filter(Boolean)
            .join(" ");

          await appendMessage(sid, "assistant", reply);
          res.setHeader("Content-Type", "application/x-ndjson");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.write(JSON.stringify({ chunk: reply }) + "\n");
          res.write(JSON.stringify({ poc: pocEventPayload(stored, null), prompt: GENERATE_PROMPT }) + "\n");
          res.write(JSON.stringify({ done: true }) + "\n");
          res.end();
          return;
        } catch (autoErr) {
          console.error("Auto POC build failed:", autoErr);
          // fall through to normal streaming on failure
        }
      }

      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // Refinement: if we already have an auto POC and the user provides more details, rebuild and optionally open a PR.
      const hasAutoPoc = session.pocDraft && session.pocDraft.generatedBy === "auto-poc";
      const newStack = inferredStack.length ? inferredStack : null;
      const newProductType = productTypeFromInput;
      const newTargetUsers = targetAudienceFromInput;
      const newUiStyle = uiStyleFromInput;

      if (hasAutoPoc && (newStack || newProductType || newTargetUsers || newUiStyle)) {
        try {
          const existing = session.pocDraft as Record<string, unknown>;
          const idea = String(existing.idea ?? extractLatestUserIdea(session.messages ?? []) ?? "").trim();
          const stack = newStack ?? (Array.isArray(existing.techStack) ? (existing.techStack as string[]) : []);
          if (!stack.length) {
            const prompt =
              "I can rebuild the POC, but I still need the tech stack (e.g., Next.js + Supabase).";
            await appendMessage(sid, "assistant", prompt);
            res.write(JSON.stringify({ chunk: prompt }) + "\n");
            res.write(JSON.stringify({ done: true }) + "\n");
            res.end();
            return;
          }

          const productType = newProductType ?? (existing.productType as string | null) ?? undefined;
          const targetUsers = newTargetUsers ?? (existing.targetUsers as string | null) ?? undefined;
          const uiStyle = newUiStyle ?? (existing.uiStyle as string | null) ?? null;
          const ideaWithUi = uiStyle ? `${idea}\nPreferred UI style: ${uiStyle}` : idea;

          const pocDraft = await buildPocDraft(
            {
              idea: ideaWithUi,
              techStack: stack,
              productType: productType || undefined,
              targetUsers: targetUsers || undefined,
            },
            { userApiKey: undefined }
          );

          const title = String(pocDraft.title ?? "POC Build").trim() || "POC Build";
          const referenceLinks = Array.isArray(req.body?.referenceLinks) ? parseStringList(req.body.referenceLinks) : [];
          const userProfile = await getUserProfile(userId).catch(() => null);
          const normalizedEmail = String(userProfile?.email ?? "").trim();

          const storedPocDraft = {
            ...pocDraft,
            title,
            idea,
            techStack: stack,
            productType: productType ?? null,
            targetUsers: targetUsers ?? null,
            uiStyle,
            referenceLinks,
            aiStudioLink: resolveAiStudioLink(null),
            generatedAt: new Date().toISOString(),
            generatedBy: "auto-poc-refine",
          };

          let prUrl: string | undefined;
          const github = await getGitHubConnection(userId);
          if (github?.accessToken && github.defaultOwner && github.defaultRepo) {
          const pr = await publishPocAsPullRequest({
            token: github.accessToken,
            owner: github.defaultOwner,
            repo: github.defaultRepo,
            prTitle: `POC: ${title}`,
            prBody: [
              String(pocDraft.summary ?? "").trim(),
              "",
              targetUsers ? `Target audience: ${targetUsers}` : "",
              stack.length ? `Tech stack: ${stack.join(", ")}` : "",
              productType ? `Product type: ${productType}` : "",
              uiStyle ? `UI style: ${uiStyle}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            poc: {
              title,
              summary: String(pocDraft.summary ?? ""),
              backendPlan: pocDraft.backendPlan,
              frontendPlan: pocDraft.frontendPlan,
              nextSteps: pocDraft.nextSteps,
              files: pocDraft.files,
              idea,
              techStack: stack,
              aiStudioLink: resolveAiStudioLink(null),
              },
            });
            prUrl = pr.prUrl;
          }

          await updateSessionPocDraft(
            sid,
            {
              ...storedPocDraft,
              github: prUrl
                ? {
                    owner: github!.defaultOwner!,
                    repo: github!.defaultRepo!,
                    baseBranch: "main",
                    branch: "auto-poc",
                    prUrl,
                    prTitle: `POC: ${title}`,
                    pushedAt: new Date().toISOString(),
                  }
                : existing.github ?? null,
            },
            session.pocNotification ?? null
          );

          await notifyPocReady({
            sessionId: sid,
            title,
            aiStudioLink: resolveAiStudioLink(null),
            idea,
            recipientEmail: normalizedEmail || undefined,
            userId,
            techStack: stack,
            futureChanges: [],
            referenceLinks,
            prUrl,
          }).catch((e: Error) => console.warn("Auto POC refine notification skipped:", e.message));

          const reply = [
            formatPocConclusion({
              idea,
              stack,
              target: targetUsers,
              productType,
            }),
            uiStyle ? `UI style noted: ${uiStyle}.` : "",
            prUrl ? `Opened PR: ${prUrl}` : "No PR opened (connect GitHub with a default repo to auto-open).",
          ]
            .filter(Boolean)
            .join(" ");

          await appendMessage(sid, "assistant", reply);
          res.write(JSON.stringify({ chunk: reply }) + "\n");
          res.write(JSON.stringify({ poc: pocEventPayload(storedPocDraft, prUrl ?? null) }) + "\n");
          res.write(JSON.stringify({ done: true }) + "\n");
          res.end();
          return;
        } catch (refineErr) {
          console.error("Auto POC refine failed:", refineErr);
          // continue to normal streaming on failure
        }
      }

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
  "/sessions/:sessionId/poc",
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

      const {
        idea,
        techStack,
        productType,
        targetUsers,
        targetAudience,
        futureChanges,
        referenceLinks,
        notificationEmail,
        aiStudioLink,
        aiStudioApiKey,
        repo,
        owner,
        repoName,
      } = req.body as {
        idea?: string;
        techStack?: unknown;
        productType?: string;
        targetUsers?: string;
        targetAudience?: string;
        futureChanges?: unknown;
        referenceLinks?: unknown;
        notificationEmail?: string;
        aiStudioLink?: string;
        aiStudioApiKey?: string;
        repo?: unknown;
        owner?: string;
        repoName?: string;
      };

      const normalizedIdea = String(idea ?? extractLatestUserIdea(session.messages ?? [])).trim();
      const normalizedTechStack = parseTechStack(techStack);
      const normalizedTargetUsers = String(targetAudience ?? targetUsers ?? "").trim();
      const normalizedFutureChanges = parseStringList(futureChanges);
      const normalizedReferenceLinks = parseStringList(referenceLinks);
      const userProfile = await getUserProfile(userId).catch(() => null);
      const loginEmail = String(userProfile?.email ?? "").trim();
      const extraEmail = String(notificationEmail ?? "").trim();
      const allEmails = [loginEmail, extraEmail].filter(Boolean);
      const normalizedAiStudioLink = resolveAiStudioLink(aiStudioLink);
      const normalizedAiStudioApiKey = String(aiStudioApiKey ?? "").trim();

      if (!normalizedIdea) {
        res.status(400).json({ error: "idea is required (or session must contain user message)" });
        return;
      }
      if (!normalizedTechStack.length) {
        res.status(400).json({ error: "techStack array is required" });
        return;
      }
      if (!normalizedAiStudioApiKey && !String(process.env.GOOGLE_API_KEY ?? "").trim()) {
        res.status(400).json({ error: "aiStudioApiKey is required when server GOOGLE_API_KEY is not configured" });
        return;
      }

      const pocDraft = await buildPocDraft({
        idea: normalizedIdea,
        techStack: normalizedTechStack,
        productType: String(productType ?? "").trim() || undefined,
        targetUsers: normalizedTargetUsers || undefined,
      }, {
        userApiKey: normalizedAiStudioApiKey || undefined,
      });
      const title = String(pocDraft.title ?? "POC Build").trim() || "POC Build";
      const resolvedReferenceLinks = normalizedReferenceLinks.length
        ? normalizedReferenceLinks
        : deriveReferenceLinks(
            `${title}\n${normalizedIdea}\n${String(pocDraft.summary ?? "")}`,
            normalizedReferenceLinks
          );
      const storedPocDraft = {
        ...pocDraft,
        title,
        aiStudioLink: normalizedAiStudioLink,
      };

      let githubResult:
        | {
            owner: string;
            repo: string;
            baseBranch: string;
            branch: string;
            prUrl: string;
            prNumber: number;
            prTitle: string;
            committedFiles: number;
          }
        | null = null;
      let githubWarning: string | null = null;

      const github = await getGitHubConnection(userId);
      const repoOverride =
        normalizeRepoTarget(repo) ??
        (() => {
          const maybeOwner = String(owner ?? "").trim();
          const maybeRepo = String(repoName ?? "").trim();
          return maybeOwner && maybeRepo ? { owner: maybeOwner, repo: maybeRepo } : null;
        })();
      const targetOwner = repoOverride?.owner ?? github?.defaultOwner ?? github?.login ?? "";
      const targetRepo = repoOverride?.repo ?? github?.defaultRepo ?? "";

      if (github?.accessToken && targetOwner && targetRepo) {
        githubResult = await publishPocAsPullRequest({
          token: github.accessToken,
          owner: targetOwner,
          repo: targetRepo,
          prTitle: `POC: ${title}`,
          prBody: [
            String(pocDraft.summary ?? "").trim(),
            "",
            normalizedTargetUsers ? `Target audience: ${normalizedTargetUsers}` : "",
            normalizedTechStack.length ? `Tech stack: ${normalizedTechStack.join(", ")}` : "",
            normalizedFutureChanges.length
              ? `Future changes required:\n- ${normalizedFutureChanges.join("\n- ")}`
              : "",
            resolvedReferenceLinks.length
              ? `Reference apps:\n- ${resolvedReferenceLinks.join("\n- ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
          poc: {
            title,
            summary: String(pocDraft.summary ?? ""),
            backendPlan: Array.isArray(pocDraft.backendPlan) ? pocDraft.backendPlan : [],
            frontendPlan: Array.isArray(pocDraft.frontendPlan) ? pocDraft.frontendPlan : [],
            nextSteps: Array.isArray(pocDraft.nextSteps) ? pocDraft.nextSteps : [],
            files: Array.isArray(pocDraft.files) ? pocDraft.files : [],
            idea: normalizedIdea,
            techStack: normalizedTechStack,
            aiStudioLink: normalizedAiStudioLink,
          },
        });

        if (repoOverride) {
          await setGitHubDefaultRepo(userId, repoOverride.owner, repoOverride.repo);
        }
      } else {
        githubWarning =
          "POC generated, but no GitHub PR was created because no connected GitHub repo target is configured.";
      }

      const conclusion = formatPocConclusion({
        idea: normalizedIdea,
        stack: normalizedTechStack,
        target: normalizedTargetUsers,
        productType: String(productType ?? "").trim() || null,
      });
      const assistantMsg = [
        conclusion,
        `Summary: ${String(pocDraft.summary ?? "")}`,
        `AI Studio: ${normalizedAiStudioLink}`,
      ]
        .filter(Boolean)
        .join("\n");
      await appendMessage(sessionId, "assistant", assistantMsg);

      const notification = await Promise.all(
        (allEmails.length ? allEmails : [undefined]).map((email) =>
          notifyPocReady({
            sessionId,
            title,
            aiStudioLink: normalizedAiStudioLink,
            idea: normalizedIdea,
            recipientEmail: email || undefined,
            userId,
            techStack: normalizedTechStack,
            prUrl: githubResult?.prUrl,
            futureChanges: normalizedFutureChanges,
            referenceLinks: resolvedReferenceLinks,
          })
        )
      ).then((arr) => arr[0]);

      if (process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID) {
        await syncSessionToNotion({
          title: `Mirror Mind POC - ${title}`,
          ideaDetails: normalizedIdea,
          conceptMap: session.conceptMap ?? {},
          feasibilitySignal: session.feasibilitySignal,
          tags: [{ name: "mirror-mind" }, { name: "poc" }],
          pocTitle: title,
          pocSummary: String(pocDraft.summary ?? ""),
          futureChanges: normalizedFutureChanges,
          referenceLinks: resolvedReferenceLinks,
          githubPrUrl: githubResult?.prUrl,
        }).catch((e: Error) => console.warn("Notion POC sync skipped:", e.message));
      }

      await updateSessionPocDraft(
        sessionId,
        {
          ...storedPocDraft,
          github: githubResult
            ? {
                owner: githubResult.owner,
                repo: githubResult.repo,
                baseBranch: githubResult.baseBranch,
                branch: githubResult.branch,
                prUrl: githubResult.prUrl,
                prNumber: githubResult.prNumber,
                prTitle: githubResult.prTitle,
                committedFiles: githubResult.committedFiles,
                pushedAt: new Date().toISOString(),
              }
            : null,
          idea: normalizedIdea,
          techStack: normalizedTechStack,
          productType: String(productType ?? "").trim() || null,
          targetUsers: normalizedTargetUsers || null,
          futureChanges: normalizedFutureChanges,
          referenceLinks: resolvedReferenceLinks,
          generatedAt: new Date().toISOString(),
          generatedBy: "gemini-ai-studio-flow",
          generatedWithUserKey: !!normalizedAiStudioApiKey,
        },
        {
          ...notification,
          email: loginEmail || null,
          notifiedAt: new Date().toISOString(),
        }
      );

      res.json({
        success: true,
        sessionId,
        pocDraft: storedPocDraft,
        github: githubResult,
        githubWarning,
        notification,
      });
    } catch (error) {
      console.error("POC build error:", error);
      res.status(500).json({
        error: "Failed to build POC",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

router.post(
  "/sessions/:sessionId/poc/confirm",
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

      const {
        techStack,
        targetAudience,
        targetUsers,
        productType,
        futureChanges,
        referenceLinks,
        repo,
        owner,
        repoName,
        notificationEmail,
        aiStudioLink,
        aiStudioApiKey,
      } = req.body as {
        techStack?: unknown;
        targetAudience?: string;
        targetUsers?: string;
        productType?: string;
        futureChanges?: unknown;
        referenceLinks?: unknown;
        repo?: unknown;
        owner?: string;
        repoName?: string;
        notificationEmail?: string;
        aiStudioLink?: string;
        aiStudioApiKey?: string;
      };

      const github = await getGitHubConnection(userId);
      if (!github) {
        res.status(400).json({ error: "GitHub is not connected for this account" });
        return;
      }

      const normalizedTechStack = parseTechStack(techStack);
      const normalizedTargetUsers = String(targetAudience ?? targetUsers ?? "").trim();
      const normalizedFutureChanges = parseStringList(futureChanges);
      const normalizedReferenceLinks = parseStringList(referenceLinks);
      const normalizedIdea = String(extractLatestUserIdea(session.messages ?? [])).trim();
      const normalizedAiStudioApiKey = String(aiStudioApiKey ?? "").trim();
      const userProfile = await getUserProfile(userId).catch(() => null);
      const loginEmail = String(userProfile?.email ?? "").trim();
      const extraEmail = String(notificationEmail ?? "").trim();
      const allEmails = [loginEmail, extraEmail].filter(Boolean);
      const normalizedAiStudioLink = resolveAiStudioLink(aiStudioLink);

      if (!normalizedIdea) {
        res.status(400).json({ error: "Session must contain a user idea before confirming POC" });
        return;
      }
      if (!normalizedTechStack.length) {
        res.status(400).json({ error: "techStack array is required" });
        return;
      }

      const repoOverride =
        normalizeRepoTarget(repo) ??
        (() => {
          const maybeOwner = String(owner ?? "").trim();
          const maybeRepo = String(repoName ?? "").trim();
          return maybeOwner && maybeRepo ? { owner: maybeOwner, repo: maybeRepo } : null;
        })();

      const targetOwner = repoOverride?.owner ?? github.defaultOwner ?? github.login ?? "";
      const targetRepo = repoOverride?.repo ?? github.defaultRepo ?? "";
      if (!targetOwner || !targetRepo) {
        res.status(400).json({
          error: "No target repository configured. Connect GitHub and set a default repo or pass owner/repo.",
        });
        return;
      }

      const pocDraft = await buildPocDraft(
        {
          idea: normalizedIdea,
          techStack: normalizedTechStack,
          productType: String(productType ?? "").trim() || undefined,
          targetUsers: normalizedTargetUsers || undefined,
        },
        {
          userApiKey: normalizedAiStudioApiKey || undefined,
        }
      );

      const storedPocDraft = {
        ...pocDraft,
        idea: normalizedIdea,
        techStack: normalizedTechStack,
        productType: String(productType ?? "").trim() || null,
        targetUsers: normalizedTargetUsers || null,
        futureChanges: normalizedFutureChanges,
        referenceLinks: deriveReferenceLinks(
          `${String(pocDraft.title ?? "Mirror Mind POC")}\n${normalizedIdea}\n${String(pocDraft.summary ?? "")}`,
          normalizedReferenceLinks
        ),
        aiStudioLink: normalizedAiStudioLink,
        generatedAt: new Date().toISOString(),
        generatedBy: "session-confirm-flow",
        generatedWithUserKey: !!normalizedAiStudioApiKey,
      };

      const resolvedReferenceLinks = storedPocDraft.referenceLinks;

      const prTitle = `POC: ${String(pocDraft.title ?? "Mirror Mind POC").trim() || "Mirror Mind POC"}`;
      const prBody = [
        String(pocDraft.summary ?? "").trim(),
        "",
        normalizedTargetUsers ? `Target audience: ${normalizedTargetUsers}` : "",
        normalizedTechStack.length ? `Tech stack: ${normalizedTechStack.join(", ")}` : "",
        normalizedFutureChanges.length
          ? `Future changes required:\n- ${normalizedFutureChanges.join("\n- ")}`
          : "",
        resolvedReferenceLinks.length
          ? `Reference apps:\n- ${resolvedReferenceLinks.join("\n- ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      const pr = await publishPocAsPullRequest({
        token: github.accessToken,
        owner: targetOwner,
        repo: targetRepo,
        prTitle,
        prBody,
        poc: {
          title: String(pocDraft.title ?? "Mirror Mind POC").trim() || "Mirror Mind POC",
          summary: String(pocDraft.summary ?? ""),
          backendPlan: pocDraft.backendPlan,
          frontendPlan: pocDraft.frontendPlan,
          nextSteps: pocDraft.nextSteps,
          files: pocDraft.files,
          idea: normalizedIdea,
          techStack: normalizedTechStack,
          aiStudioLink: normalizedAiStudioLink,
        },
      });

      const notification = await Promise.all(
        (allEmails.length ? allEmails : [undefined]).map((email) =>
          notifyPocReady({
            sessionId,
            title: pr.prTitle,
            aiStudioLink: normalizedAiStudioLink,
            idea: normalizedIdea,
            recipientEmail: email || undefined,
            userId,
            techStack: normalizedTechStack,
            prUrl: pr.prUrl,
            futureChanges: normalizedFutureChanges,
            referenceLinks: resolvedReferenceLinks,
          })
        )
      ).then((arr) => arr[0]);

      if (process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID) {
        await syncSessionToNotion({
          title: `Mirror Mind POC - ${pr.prTitle}`,
          ideaDetails: normalizedIdea,
          conceptMap: session.conceptMap ?? {},
          feasibilitySignal: session.feasibilitySignal,
          tags: [{ name: "mirror-mind" }, { name: "poc" }],
          pocTitle: String(pocDraft.title ?? "Mirror Mind POC"),
          pocSummary: String(pocDraft.summary ?? ""),
          futureChanges: normalizedFutureChanges,
          referenceLinks: resolvedReferenceLinks,
          githubPrUrl: pr.prUrl,
        }).catch((e: Error) => console.warn("Notion POC sync skipped:", e.message));
      }

      await updateSessionPocDraft(
        sessionId,
        {
          ...storedPocDraft,
          github: {
            owner: pr.owner,
            repo: pr.repo,
            baseBranch: pr.baseBranch,
            branch: pr.branch,
            prUrl: pr.prUrl,
            prNumber: pr.prNumber,
            prTitle: pr.prTitle,
            committedFiles: pr.committedFiles,
            pushedAt: new Date().toISOString(),
          },
        },
        {
          ...notification,
          email: loginEmail || null,
          notifiedAt: new Date().toISOString(),
        }
      );

      if (repoOverride) {
        await setGitHubDefaultRepo(userId, repoOverride.owner, repoOverride.repo);
      }

      res.json({
        success: true,
        sessionId,
        pocDraft: storedPocDraft,
        github: pr,
        notification,
      });
    } catch (error) {
      console.error("POC confirm error:", error);
      res.status(500).json({
        error: "Failed to confirm POC",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

router.get(
  "/sessions/:sessionId/poc",
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
      res.json({
        sessionId: session.id,
        pocDraft: session.pocDraft ?? null,
        notification: session.pocNotification ?? null,
      });
    } catch (error) {
      console.error("POC fetch error:", error);
      res.status(500).json({ error: "Failed to fetch POC data" });
    }
  }
);

router.post(
  "/sessions/:sessionId/poc/notify",
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

      const { notificationEmail, aiStudioLink, title } = req.body as {
        notificationEmail?: string;
        aiStudioLink?: string;
        title?: string;
      };
      const email = String(notificationEmail ?? "").trim();
      const pocDraft = (session.pocDraft ?? {}) as Record<string, unknown>;
      const idea = String(pocDraft.idea ?? extractLatestUserIdea(session.messages ?? []) ?? "").trim();
      const techStack = parseTechStack(pocDraft.techStack);
      const resolvedTitle = String(title ?? pocDraft.title ?? "POC Build").trim() || "POC Build";
      const resolvedAiStudioLink = resolveAiStudioLink(aiStudioLink ?? pocDraft.aiStudioLink);

      if (!idea || !techStack.length) {
        res.status(400).json({ error: "No generated POC found for this session" });
        return;
      }

      const notification = await notifyPocReady({
        sessionId,
        title: resolvedTitle,
        aiStudioLink: resolvedAiStudioLink,
        userId,
        recipientEmail: email || undefined,
        idea,
        techStack,
      });

      await updateSessionPocDraft(
        sessionId,
        {
          ...pocDraft,
          title: resolvedTitle,
          aiStudioLink: resolvedAiStudioLink,
        },
        {
          ...notification,
          email: email || null,
          notifiedAt: new Date().toISOString(),
        }
      );

      res.json({ success: true, notification });
    } catch (error) {
      console.error("POC notify error:", error);
      res.status(500).json({ error: "Failed to send POC notification" });
    }
  }
);

router.get(
  "/sessions/:sessionId/poc/export",
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

      const pocDraft = (session.pocDraft ?? null) as Record<string, unknown> | null;
      if (!pocDraft) {
        res.status(404).json({ error: "No POC draft available for this session" });
        return;
      }

      const format = String(req.query.format ?? "json").toLowerCase();
      const filenameBase = `poc-${session.id.slice(0, 8)}`;

      if (format === "txt") {
        const lines = [
          `Title: ${String(pocDraft.title ?? "POC Build")}`,
          `AI Studio: ${String(pocDraft.aiStudioLink ?? "https://aistudio.google.com/apps")}`,
          `Generated At: ${String(pocDraft.generatedAt ?? new Date().toISOString())}`,
          "",
          "Summary:",
          String(pocDraft.summary ?? ""),
          "",
          "Files:",
        ];
        const files = Array.isArray(pocDraft.files) ? pocDraft.files : [];
        for (const f of files) {
          if (!f || typeof f !== "object" || Array.isArray(f)) continue;
          const path = String((f as Record<string, unknown>).path ?? "").trim();
          if (path) lines.push(`- ${path}`);
        }
        const payload = lines.join("\n");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename=\"${filenameBase}.txt\"`);
        res.send(payload);
        return;
      }

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=\"${filenameBase}.json\"`);
      res.send(JSON.stringify({
        sessionId: session.id,
        exportedAt: new Date().toISOString(),
        pocDraft,
      }, null, 2));
    } catch (error) {
      console.error("POC export error:", error);
      res.status(500).json({ error: "Failed to export POC data" });
    }
  }
);

router.post(
  "/sessions/:sessionId/poc/github",
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

      const {
        githubToken,
        repoName,
        owner,
        isPrivate,
        description,
      } = req.body as {
        githubToken?: string;
        repoName?: string;
        owner?: string;
        isPrivate?: boolean;
        description?: string;
      };

      const token = String(githubToken ?? "").trim() || String(process.env.GITHUB_TOKEN ?? "").trim();
      const pocDraft = (session.pocDraft ?? null) as Record<string, unknown> | null;
      if (!pocDraft) {
        res.status(400).json({ error: "No generated POC found for this session" });
        return;
      }
      if (!token) {
        res.status(400).json({ error: "githubToken is required" });
        return;
      }

      const title = String(pocDraft.title ?? "Mirror Mind POC").trim() || "Mirror Mind POC";
      const safeRepoName = String(repoName ?? title).trim();

      const files = Array.isArray(pocDraft.files)
        ? pocDraft.files
            .filter((f) => f && typeof f === "object" && !Array.isArray(f))
            .map((f) => {
              const rec = f as Record<string, unknown>;
              return {
                path: String(rec.path ?? "").trim(),
                content: String(rec.content ?? ""),
              };
            })
            .filter((f) => f.path)
        : [];

      const result = await publishPocToGitHub({
        token,
        repoName: safeRepoName,
        owner: String(owner ?? "").trim() || undefined,
        isPrivate: Boolean(isPrivate),
        description: String(description ?? "").trim() || undefined,
        poc: {
          title,
          summary: String(pocDraft.summary ?? ""),
          backendPlan: Array.isArray(pocDraft.backendPlan) ? pocDraft.backendPlan.map((x) => String(x)) : [],
          frontendPlan: Array.isArray(pocDraft.frontendPlan) ? pocDraft.frontendPlan.map((x) => String(x)) : [],
          nextSteps: Array.isArray(pocDraft.nextSteps) ? pocDraft.nextSteps.map((x) => String(x)) : [],
          files,
          idea: String(pocDraft.idea ?? ""),
          techStack: parseTechStack(pocDraft.techStack),
          aiStudioLink: String(pocDraft.aiStudioLink ?? ""),
        },
      });

      await updateSessionPocDraft(
        sessionId,
        {
          ...pocDraft,
          github: {
            ...result,
            pushedAt: new Date().toISOString(),
          },
        },
        session.pocNotification ?? null
      );

      res.json({ success: true, github: result });
    } catch (error) {
      console.error("POC GitHub publish error:", error);
      res.status(500).json({
        error: "Failed to publish POC to GitHub",
        message: error instanceof Error ? error.message : "Unknown error",
      });
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
