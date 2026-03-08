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
  conceptMap?: Record<string, string[]>;
  feasibilitySignal?: number | null;
  messages?: { role: string; content?: string }[];
  tags?: { name: string }[];
}

export async function syncSessionToNotion(sessionData: SyncSessionData): Promise<{ id: string } | null> {
  if (!notion || !process.env.NOTION_DATABASE_ID) {
    console.warn("Notion not configured. Skipping sync.");
    return null;
  }

  const title = sessionData.title ?? `Mirror Mind - ${new Date().toISOString().slice(0, 10)}`;
  const conceptMap = sessionData.conceptMap ?? {};
  const feasibilitySignal = sessionData.feasibilitySignal;
  const messages = sessionData.messages ?? [];
  const tags = sessionData.tags ?? [];

  const feasibilityPercent =
    typeof feasibilitySignal === "number" ? Math.round(feasibilitySignal * 100) : null;

  const children: Record<string, unknown>[] = [];

  if (messages.length > 0) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ text: { content: "💬 Ideas & conversation" } }] },
    });
    for (const msg of messages) {
      const who = msg.role === "user" ? "You" : "Mirror Mind";
      const content = msg.content ?? "";
      if (!content) continue;
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: toRichText(`${who}: ${content}`) },
      });
    }
  }

  children.push({
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ text: { content: "🗺️ Concept map" } }] },
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
    heading_2: { rich_text: [{ text: { content: "✅ Feasibility" } }] },
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
