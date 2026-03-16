import { GoogleGenerativeAI } from "@google/generative-ai";
import type { SessionContextMessage } from "../types";

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.warn("GOOGLE_API_KEY not set");
}

const client = apiKey ? new GoogleGenerativeAI(apiKey) : null;

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro-latest",
  "gemini-pro",
];

const SYSTEM_PROMPT = `You are Mirror Mind—an intelligent companion that accelerates ideas to products. Talk like a friend, not a bot.

Your job:
- Listen to half-formed thoughts and mirror them back so the user feels understood
- Ask 1–2 short Socratic questions before jumping to structure (EXCEPTION below for POC intent)
- Turn the user's idea into a concept map: 2–5 main concepts, each with 2–4 related terms
- Give a feasibility score 0–1 and optionally rough weeks to build an MVP
- If the user says "pivot to X" or "no, actually...", drop old context and reframe instantly

EXCEPTION — when the user intent is “build a POC” (phrases like “build/create/generate a POC”):
- Do NOT ask any other clarifying questions.
- If tech stack is missing, ask only: “What tech stack should I use? (e.g., Next.js + Supabase). Once you share it, I'll start building and then ask about target audience, UI style, and product type.”
- After the stack is known, proceed to build and then ask, in order: target audience, UI style preference, product type (web/mobile/desktop/CLI). No extra questions beyond these.

Autonomous builder overlay (keep replies concise, architect-style, not chatty):
- Track project context continuously: idea, tech_stack, target_users, core_features, repository_name.
- When intent like “build the poc/create the project/start coding/make the prototype” is expressed and you have a tech stack, treat that as a build trigger: restate a one-line plan (idea + stack + target + product type if known) and proceed (the backend handles execution).
- If critical fields are missing, ask only short questions to fill them: “What tech stack should we use?”, “Who are the target users?”, “What core features should the MVP include?”.
- When all required fields are known, DO NOT say you are already building. Instead, summarize the plan in one line and end with the exact question: “Shall I generate the POC now?” — nothing implying work has started.
- Always end build-trigger replies with that standard conclusion line the backend expects.

Tone: Warm, direct, like a sharp co-founder. Ask don't lecture.

CRITICAL: You MUST end your reply with a single line of valid JSON (no markdown, no code fence, no extra text after it). Example:
{"conceptMap": {"Core Idea": ["sub idea 1", "sub idea 2"], "Tech": ["stack", "APIs"]}, "feasibilitySignal": 0.7}
Rules for the JSON:
- conceptMap: object with string keys (concept names) and array values (related terms). Always include at least 2 concepts.
- Every concept must include at least 2 related terms; do not return an empty conceptMap.
- feasibilitySignal: number between 0 and 1.
- Optional: "roughWeeks": number for MVP estimate.
Output the JSON on its own line at the very end.`;

function buildContents(sessionContext: SessionContextMessage[], userInput: string): { role: string; parts: { text: string }[] }[] {
  const parts: { role: string; parts: { text: string }[] }[] = [];
  for (const m of sessionContext || []) {
    const role = m.role === "user" ? "user" : "model";
    const text = typeof m.content === "string" ? m.content : String(m.content ?? "");
    parts.push({ role, parts: [{ text }] });
  }
  parts.push({ role: "user", parts: [{ text: userInput }] });
  return parts;
}

export function parseStructuredResponse(fullText: string): { conceptMap: Record<string, string[]>; feasibilitySignal: number | null } {
  const parseTerms = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
    if (typeof value === "string") return value.split(",").map((x) => x.trim()).filter(Boolean);
    return [];
  };

  const normalizeConceptMap = (obj: unknown): Record<string, string[]> => {
    if (!obj) return {};

    if (typeof obj === "object" && !Array.isArray(obj)) {
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).trim();
        if (!key) continue;
        out[key] = parseTerms(v);
      }
      if (Object.keys(out).length > 0) return out;
    }

    if (Array.isArray(obj)) {
      const out: Record<string, string[]> = {};
      for (const item of obj) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        const key = String(rec.concept ?? rec.name ?? rec.title ?? "").trim();
        if (!key) continue;
        out[key] = parseTerms(rec.terms ?? rec.related ?? rec.keywords ?? rec.subConcepts);
      }
      if (Object.keys(out).length > 0) return out;
    }

    return {};
  };

  const normalizeFeasibility = (value: unknown): number | null => {
    if (typeof value !== "number" || Number.isNaN(value)) return null;
    const normalized = value > 1 ? value / 100 : value;
    return Math.max(0, Math.min(1, normalized));
  };

  const hydrate = (raw: unknown): { conceptMap: Record<string, string[]>; feasibilitySignal: number | null } => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { conceptMap: {}, feasibilitySignal: null };
    }
    const rec = raw as Record<string, unknown>;
    const conceptMap = normalizeConceptMap(rec.conceptMap ?? rec.concepts ?? rec.mindMap ?? rec.map ?? rec.graph);
    const feasibilitySignal = normalizeFeasibility(rec.feasibilitySignal ?? rec.feasibility ?? rec.score);
    return { conceptMap, feasibilitySignal };
  };

  const tryJson = (text: string): { conceptMap: Record<string, string[]>; feasibilitySignal: number | null } | null => {
    try {
      return hydrate(JSON.parse(text));
    } catch {
      return null;
    }
  };

  const parseConceptMapFromText = (text: string): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    const lines = (text || "").split("\n");
    for (const raw of lines) {
      const line = raw.trim().replace(/^[\-\*\d\.\)\s]+/, "");
      if (!line || !line.includes(":")) continue;
      const idx = line.indexOf(":");
      const key = line.slice(0, idx).trim();
      const rhs = line.slice(idx + 1).trim();
      if (!key || !rhs) continue;
      const terms = rhs
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (terms.length >= 2) out[key] = terms;
    }
    return out;
  };

  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  const fencedBlocks: string[] = [];
  let fenceMatch: RegExpExecArray | null = fencedRegex.exec(fullText || "");
  while (fenceMatch) {
    fencedBlocks.push((fenceMatch[1] ?? "").trim());
    fenceMatch = fencedRegex.exec(fullText || "");
  }
  for (let i = fencedBlocks.length - 1; i >= 0; i--) {
    const parsed = tryJson(fencedBlocks[i]);
    if (parsed && (Object.keys(parsed.conceptMap).length > 0 || parsed.feasibilitySignal != null)) return parsed;
  }

  const lines = (fullText || "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    const parsed = tryJson(line);
    if (parsed && (Object.keys(parsed.conceptMap).length > 0 || parsed.feasibilitySignal != null)) return parsed;
  }

  const candidates: string[] = [];
  for (let i = 0; i < fullText.length; i++) {
    if (fullText[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < fullText.length; j++) {
      const ch = fullText[j];
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(fullText.slice(i, j + 1));
          break;
        }
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = tryJson(candidates[i]);
    if (parsed && (Object.keys(parsed.conceptMap).length > 0 || parsed.feasibilitySignal != null)) return parsed;
  }

  const fallbackConceptMap = parseConceptMapFromText(fullText || "");
  if (Object.keys(fallbackConceptMap).length > 0) {
    return { conceptMap: fallbackConceptMap, feasibilitySignal: null };
  }

  return { conceptMap: {}, feasibilitySignal: null };
}

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.includes("quota");
}

/**
 * Stream thinking response using Gemini (generateContentStream).
 * For real-time voice / interruptible flow, use the Live WebSocket endpoint instead.
 */
export async function streamThinkingResponse(
  userInput: string,
  sessionContext: SessionContextMessage[]
): Promise<AsyncGenerator<{ text: () => string }>> {
  if (!client) throw new Error("GOOGLE_API_KEY not set");

  const contents = buildContents(sessionContext, userInput);
  let lastError: Error | null = null;

  for (const modelId of GEMINI_MODELS) {
    try {
      const model = client.getGenerativeModel({
        model: modelId,
        systemInstruction: SYSTEM_PROMPT,
      });
      const result = await model.generateContentStream({ contents });
      const stream = (result as { stream?: AsyncIterable<{ text: () => string }> }).stream ?? result;

      async function* streamGen(): AsyncGenerator<{ text: () => string }> {
        for await (const chunk of stream as AsyncIterable<{ text?: () => string; candidates?: unknown }>) {
          const text = (chunk as { text?: () => string }).text?.() ?? "";
          if (text) yield { text: () => text };
        }
      }
      return streamGen();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;
      console.warn(`Gemini ${modelId} failed:`, msg.slice(0, 120));
      if (isQuotaError(err)) {
        const retrySec = msg.match(/retry in (\d+)/i)?.[1] ?? "30";
        console.warn(`Quota exceeded for ${modelId}. Retry after ${retrySec}s or try another model.`);
      }
    }
  }

  const hint = lastError && isQuotaError(lastError)
    ? " Quota exceeded—wait a minute or check https://ai.google.dev/gemini-api/docs/rate-limits"
    : " Check GOOGLE_API_KEY and model availability at https://ai.google.dev/gemini-api/docs/models";
  throw lastError ?? new Error("Gemini unavailable." + hint);
}

export const SYSTEM_PROMPT_EXPORT = SYSTEM_PROMPT;
