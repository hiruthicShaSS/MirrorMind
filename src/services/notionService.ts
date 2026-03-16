import { Client } from "@notionhq/client";

const notion = process.env.NOTION_API_KEY ? new Client({ auth: process.env.NOTION_API_KEY }) : null;

/** Notion rich_text text.content must be ≤ 2000 chars. Return array of rich_text items. */
const NOTION_TEXT_MAX = 2000;
function toRichText(content: string): { type: "text"; text: { content: string } }[] {
  if (content.length <= NOTION_TEXT_MAX) {
    return [{ type: "text", text: { content } }];
  }
  const out: { type: "text"; text: { content: string } }[] = [];
  for (let i = 0; i < content.length; i += NOTION_TEXT_MAX) {
    out.push({ type: "text", text: { content: content.slice(i, i + NOTION_TEXT_MAX) } });
  }
  return out;
}

export interface SyncSessionData {
  title?: string;
  ideaDetails?: string;
  agentReply?: string;
  ideaConversation?: { role: "user" | "assistant"; content: string }[];
  conceptMap?: Record<string, string[]>;
  feasibilitySignal?: number | null;
  tags?: { name: string }[];
  pocTitle?: string;
  pocSummary?: string;
  futureChanges?: string[];
  referenceLinks?: string[];
  githubPrUrl?: string;
}

function toMermaidConceptMap(conceptMap: Record<string, string[]>): string {
  const entries = Object.entries(conceptMap).filter(([k]) => String(k).trim().length > 0);
  if (entries.length === 0) return "graph TD\n  A[No concepts extracted]";

  const lines: string[] = ["graph TD"];
  const conceptIds = new Map<string, string>();
  const termIds = new Map<string, string>();
  let conceptCounter = 1;
  let termCounter = 1;

  const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  for (const [conceptRaw, termsRaw] of entries) {
    const concept = conceptRaw.trim();
    const conceptId = `C${conceptCounter++}`;
    conceptIds.set(concept, conceptId);
    lines.push(`  ${conceptId}["${esc(concept)}"]`);

    for (const t of Array.isArray(termsRaw) ? termsRaw : []) {
      const term = String(t).trim();
      if (!term) continue;
      const termKey = term.toLowerCase();
      let termId = termIds.get(termKey);
      if (!termId) {
        termId = `T${termCounter++}`;
        termIds.set(termKey, termId);
        lines.push(`  ${termId}["${esc(term)}"]`);
      }
      lines.push(`  ${conceptId} --> ${termId}`);
    }
  }

  return lines.join("\n");
}

export async function syncSessionToNotion(sessionData: SyncSessionData): Promise<{ id: string } | null> {
  if (!notion || !process.env.NOTION_DATABASE_ID) {
    console.warn("Notion not configured. Skipping sync.");
    return null;
  }

  const title = sessionData.title ?? `Mirror Mind - ${new Date().toISOString().slice(0, 10)}`;
  const ideaDetails = (sessionData.ideaDetails ?? "").trim();
  const agentReply = (sessionData.agentReply ?? "").trim();
  const ideaConversation = (sessionData.ideaConversation ?? []).filter((m) => (m.content ?? "").trim().length > 0);
  const conceptMap = sessionData.conceptMap ?? {};
  const feasibilitySignal = sessionData.feasibilitySignal;
  const tags = sessionData.tags ?? [];
  const pocTitle = (sessionData.pocTitle ?? "").trim();
  const pocSummary = (sessionData.pocSummary ?? "").trim();
  const futureChanges = (sessionData.futureChanges ?? []).map((item) => String(item).trim()).filter(Boolean);
  const referenceLinks = (sessionData.referenceLinks ?? []).map((item) => String(item).trim()).filter(Boolean);
  const githubPrUrl = (sessionData.githubPrUrl ?? "").trim();

  const feasibilityPercent =
    typeof feasibilitySignal === "number" ? Math.round(feasibilitySignal * 100) : null;

  const children: Record<string, unknown>[] = [];

  if (ideaDetails) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ text: { content: "1) Idea details" } }] },
    });
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: toRichText(ideaDetails) },
    });
  }

  if (ideaConversation.length > 0) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ text: { content: "2) Idea conversation" } }] },
    });
    for (const msg of ideaConversation) {
      const speaker = msg.role === "user" ? "You" : "Mirror Mind";
      children.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: [{ text: { content: speaker } }] },
      });
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: toRichText(msg.content.trim()) },
      });
    }
  }

  if (agentReply) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ text: { content: "3) Agent response (latest)" } }] },
    });
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: toRichText(agentReply) },
    });
  }

  children.push({
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ text: { content: "4) Concept map" } }] },
  });
  if (Object.keys(conceptMap).length > 0) {
    for (const [concept, terms] of Object.entries(conceptMap)) {
      const line = Array.isArray(terms) && terms.length > 0 ? `${concept}: ${terms.join(", ")}` : concept;
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: toRichText(line) },
      });
    }
    const conceptMapJson = JSON.stringify(conceptMap, null, 2);
    children.push({
      object: "block",
      type: "code",
      code: { language: "json", rich_text: toRichText(conceptMapJson) },
    });

    children.push({
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: [{ text: { content: "Mermaid diagram code" } }] },
    });
    const mermaid = toMermaidConceptMap(conceptMap);
    children.push({
      object: "block",
      type: "code",
      code: { language: "plain text", rich_text: toRichText(mermaid) },
    });
  } else {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: "No concepts extracted yet." } }] },
    });
  }

  children.push({
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ text: { content: "5) Feasibility" } }] },
  });
  children.push({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          text: {
            content:
              feasibilityPercent != null ? `Score: ${feasibilityPercent}%` : "Not assessed yet.",
          },
        },
      ],
    },
  });

  if (pocTitle || pocSummary || githubPrUrl || futureChanges.length || referenceLinks.length) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ text: { content: "6) POC delivery" } }] },
    });

    if (pocTitle) {
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: toRichText(`POC title: ${pocTitle}`) },
      });
    }

    if (pocSummary) {
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: toRichText(`POC summary: ${pocSummary}`) },
      });
    }

    if (githubPrUrl) {
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: toRichText(`GitHub PR: ${githubPrUrl}`) },
      });
    }

    if (futureChanges.length) {
      children.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: [{ text: { content: "Future changes required" } }] },
      });
      for (const item of futureChanges) {
        children.push({
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: toRichText(item) },
        });
      }
    }

    if (referenceLinks.length) {
      children.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: [{ text: { content: "Reference apps" } }] },
      });
      for (const link of referenceLinks) {
        children.push({
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: toRichText(link) },
        });
      }
    }
  }

  const titlePropName = process.env.NOTION_TITLE_PROPERTY ?? "Name";
  const properties: Record<string, unknown> = {
    [titlePropName]: { title: [{ text: { content: title.slice(0, 2000) } }] },
  };
  const tagsPropName = process.env.NOTION_TAGS_PROPERTY;
  if (tagsPropName && tags.length > 0) {
    properties[tagsPropName] = { multi_select: tags };
  }

  const response = await notion.pages.create({
    parent: { database_id: process.env.NOTION_DATABASE_ID },
    properties,
    children,
  } as Parameters<Client["pages"]["create"]>[0]);

  console.log("Synced to Notion:", response.id);
  return { id: response.id };
}
