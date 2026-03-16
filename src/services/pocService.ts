import { GoogleGenerativeAI } from "@google/generative-ai";

export interface PocBuildRequest {
  idea: string;
  techStack: string[];
  productType?: string;
  targetUsers?: string;
}

export interface PocFile {
  path: string;
  content: string;
}

export interface PocBuildResult {
  title: string;
  summary: string;
  backendPlan: string[];
  frontendPlan: string[];
  nextSteps: string[];
  files: PocFile[];
}

const apiKey = process.env.GOOGLE_API_KEY;
const client = apiKey ? new GoogleGenerativeAI(apiKey) : null;

const POC_MODELS = [
  "gemini-2.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro-latest",
];

function normalizeStack(techStack: string[]): string[] {
  return techStack
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function extractJson(raw: string): Record<string, unknown> | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  const direct = safeParseJson<Record<string, unknown>>(text);
  if (direct) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? "";
  const fencedParsed = fenced ? safeParseJson<Record<string, unknown>>(fenced) : null;
  if (fencedParsed) return fencedParsed;

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const slicedParsed = safeParseJson<Record<string, unknown>>(text.slice(first, last + 1));
    if (slicedParsed) return slicedParsed;
  }
  return null;
}

function parseStringList(value: unknown, max = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
}

function parseFiles(value: unknown): PocFile[] {
  if (!Array.isArray(value)) return [];
  const out: PocFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const path = String(rec.path ?? "").trim();
    const content = String(rec.content ?? "").trim();
    if (!path || !content) continue;
    out.push({ path, content });
    if (out.length >= 6) break;
  }
  return out;
}

function fallbackPoc(req: PocBuildRequest): PocBuildResult {
  const stack = normalizeStack(req.techStack);
  const stackLabel = stack.length ? stack.join(", ") : "Node.js, React, Firebase";
  const title = "POC: AI-assisted idea to MVP kickoff";
  const summary = `Build a lightweight workflow where a user finalizes an idea, selects a preferred stack, receives generated starter code, and gets a ready notification.`;

  const backendPlan = [
    "Add API to capture idea details and preferred tech stack.",
    "Generate a starter implementation prompt and scaffold output.",
    "Persist POC artifacts by session and expose fetch endpoint.",
    "Trigger ready notifications through email/webhook adapters.",
  ];

  const frontendPlan = [
    "Add a stack selection step after discussion is complete.",
    "Call POC build endpoint and show generation status.",
    "Render generated files and architecture plan in a review panel.",
    "Show notification status (sent/failed) in the UI timeline.",
  ];

  const nextSteps = [
    "Add one-click create-repo action for generated files.",
    "Allow user edits to stack before re-generating POC.",
    "Add retry for notification providers and delivery logs.",
  ];

  const files: PocFile[] = [
    {
      path: "README_POC.md",
      content: `# ${title}\n\n## Stack\n${stackLabel}\n\n## Idea\n${req.idea}\n\n## Goal\nShip a basic end-to-end flow in 1-2 days.`,
    },
    {
      path: "backend/poc.controller.ts",
      content:
        "export async function buildPoc(req, res) {\n  // validate idea + stack\n  // generate scaffold\n  // send notification\n  res.json({ ok: true });\n}\n",
    },
    {
      path: "frontend/PocBuilder.tsx",
      content:
        "export function PocBuilder() {\n  return (\n    <section>\n      <h2>POC Builder</h2>\n      <p>Select stack and generate starter code.</p>\n    </section>\n  );\n}\n",
    },
  ];

  return { title, summary, backendPlan, frontendPlan, nextSteps, files };
}

function normalizeModelOutput(raw: Record<string, unknown> | null, req: PocBuildRequest): PocBuildResult {
  if (!raw) return fallbackPoc(req);

  const title = String(raw.title ?? "").trim() || "POC Build";
  const summary = String(raw.summary ?? "").trim() || fallbackPoc(req).summary;
  const backendPlan = parseStringList(raw.backendPlan, 8);
  const frontendPlan = parseStringList(raw.frontendPlan, 8);
  const nextSteps = parseStringList(raw.nextSteps, 8);
  const files = parseFiles(raw.files);

  if (!backendPlan.length || !frontendPlan.length || !files.length) {
    const fallback = fallbackPoc(req);
    return {
      title: title || fallback.title,
      summary: summary || fallback.summary,
      backendPlan: backendPlan.length ? backendPlan : fallback.backendPlan,
      frontendPlan: frontendPlan.length ? frontendPlan : fallback.frontendPlan,
      nextSteps: nextSteps.length ? nextSteps : fallback.nextSteps,
      files: files.length ? files : fallback.files,
    };
  }

  return { title, summary, backendPlan, frontendPlan, nextSteps, files };
}

async function generateWithGemini(req: PocBuildRequest): Promise<PocBuildResult | null> {
  return generateWithGeminiUsingClient(req, client);
}

async function generateWithGeminiUsingClient(
  req: PocBuildRequest,
  geminiClient: GoogleGenerativeAI | null
): Promise<PocBuildResult | null> {
  if (!geminiClient) return null;

  const prompt = `You are a senior startup engineer. Create a practical POC output in strict JSON.

User idea:
${req.idea}

Preferred stack:
${normalizeStack(req.techStack).join(", ") || "Not specified"}

Extra context:
- Product type: ${req.productType ?? "Not specified"}
- Target users: ${req.targetUsers ?? "Not specified"}

Return JSON with this exact shape:
{
  "title": "short title",
  "summary": "2-4 sentence summary",
  "backendPlan": ["4-8 concise bullets"],
  "frontendPlan": ["4-8 concise bullets"],
  "nextSteps": ["3-6 concise bullets"],
  "files": [
    { "path": "relative/path.ext", "content": "starter file content" }
  ]
}

Rules:
- Include at least 3 files.
- File contents should be minimal but runnable scaffolds.
- Do not wrap JSON in markdown.`;

  for (const modelId of POC_MODELS) {
    try {
      const model = geminiClient.getGenerativeModel({ model: modelId });
      const result = await model.generateContent(prompt);
      const text = result.response.text() ?? "";
      const parsed = extractJson(text);
      return normalizeModelOutput(parsed, req);
    } catch (error) {
      console.warn(`POC generation failed for ${modelId}:`, error instanceof Error ? error.message : String(error));
    }
  }

  return null;
}

export async function buildPocDraft(
  req: PocBuildRequest,
  options?: { userApiKey?: string }
): Promise<PocBuildResult> {
  const normalizedReq: PocBuildRequest = {
    ...req,
    idea: String(req.idea ?? "").trim(),
    techStack: normalizeStack(req.techStack),
    productType: req.productType?.trim(),
    targetUsers: req.targetUsers?.trim(),
  };

  if (!normalizedReq.idea) {
    throw new Error("idea is required");
  }
  if (!normalizedReq.techStack.length) {
    throw new Error("techStack must include at least one technology");
  }

  const keyFromUser = String(options?.userApiKey ?? "").trim();
  const userClient = keyFromUser ? new GoogleGenerativeAI(keyFromUser) : null;
  const generated = await generateWithGeminiUsingClient(normalizedReq, userClient ?? client);
  return generated ?? fallbackPoc(normalizedReq);
}
