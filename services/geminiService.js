const { GoogleGenerativeAI } = require("@google/generative-ai");

const client = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Use model IDs that exist in Gemini API v1beta (generativelanguage.googleapis.com)
// Order: prefer faster/cheaper first; 429 = quota, 404 = wrong model id
const GEMINI_MODELS = [
 
  "gemini-2.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro-latest",
  "gemini-pro",
];

const SYSTEM_PROMPT = `You are Mirror Mind—an intelligent companion that accelerates ideas to products. Talk like a friend, not a bot.

Your job:
- Listen to half-formed thoughts and mirror them back so the user feels understood
- Ask 1–2 short Socratic questions before jumping to structure
- Turn the user's idea into a concept map: 2–5 main concepts, each with 2–4 related terms
- Give a feasibility score 0–1 and optionally rough weeks to build an MVP
- If the user says "pivot to X" or "no, actually...", drop old context and reframe instantly

Tone: Warm, direct, like a sharp co-founder. Ask don't lecture.

CRITICAL: You MUST end your reply with a single line of valid JSON (no markdown, no code fence, no extra text after it). Example:
{"conceptMap": {"Core Idea": ["sub idea 1", "sub idea 2"], "Tech": ["stack", "APIs"]}, "feasibilitySignal": 0.7}
Rules for the JSON:
- conceptMap: object with string keys (concept names) and array values (related terms). Always include at least 2 concepts.
- feasibilitySignal: number between 0 and 1.
- Optional: "roughWeeks": number for MVP estimate.
Output the JSON on its own line at the very end.`;

function buildContents(sessionContext, userInput) {
  const parts = [];
  (sessionContext || []).forEach((m) => {
    const role = m.role === "user" ? "user" : "model";
    const text = typeof m.content === "string" ? m.content : String(m.content || "");
    parts.push({ role, parts: [{ text }] });
  });
  parts.push({ role: "user", parts: [{ text: userInput }] });
  return parts;
}

function parseStructuredResponse(fullText) {
  let conceptMap = {};
  let feasibilitySignal = null;

  const normalize = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).trim();
      if (!key) continue;
      out[key] = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
    }
    return out;
  };

  // Try: last line that looks like JSON
  const lines = (fullText || "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.conceptMap != null) {
        conceptMap = normalize(parsed.conceptMap);
      }
      if (typeof parsed.feasibilitySignal === "number") {
        feasibilitySignal = Math.max(0, Math.min(1, parsed.feasibilitySignal));
      }
      if (Object.keys(conceptMap).length > 0 || feasibilitySignal != null) {
        return { conceptMap, feasibilitySignal };
      }
    } catch (_) {}
  }

  // Try: single {...} block anywhere (greedy match from last {)
  const lastBrace = fullText.lastIndexOf("{");
  if (lastBrace !== -1) {
    const rest = fullText.slice(lastBrace);
    const end = rest.indexOf("}");
    if (end !== -1) {
      try {
        const parsed = JSON.parse(rest.slice(0, end + 1));
        if (parsed.conceptMap != null) conceptMap = normalize(parsed.conceptMap);
        if (typeof parsed.feasibilitySignal === "number") {
          feasibilitySignal = Math.max(0, Math.min(1, parsed.feasibilitySignal));
        }
      } catch (_) {}
    }
  }

  return { conceptMap, feasibilitySignal };
}

function isQuotaError(err) {
  return err?.message?.includes("429") || err?.message?.includes("quota");
}

async function streamThinkingResponse(userInput, sessionContext = []) {
  const contents = buildContents(sessionContext, userInput);
  let lastError;

  for (const modelId of GEMINI_MODELS) {
    try {
      const model = client.getGenerativeModel({
        model: modelId,
        systemInstruction: SYSTEM_PROMPT,
      });
      const result = await model.generateContentStream({ contents });
      return result;
    } catch (err) {
      lastError = err;
      const msg = err?.message || "";
      console.warn(`Gemini ${modelId} failed:`, msg.slice(0, 120));
      if (isQuotaError(err)) {
        const retrySec = msg.match(/retry in (\d+)/i)?.[1] || "30";
        console.warn(`Quota exceeded for ${modelId}. Retry after ${retrySec}s or try another model.`);
      }
    }
  }

  const hint = isQuotaError(lastError)
    ? " Quota exceeded—wait a minute or check https://ai.google.dev/gemini-api/docs/rate-limits"
    : " Check GOOGLE_API_KEY and model availability at https://ai.google.dev/gemini-api/docs/models";
  throw lastError || new Error("Gemini unavailable." + hint);
}

module.exports = {
  streamThinkingResponse,
  parseStructuredResponse,
};
