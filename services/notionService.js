const { Client } = require("@notionhq/client");

const notion = process.env.NOTION_API_KEY ? new Client({ auth: process.env.NOTION_API_KEY }) : null;

/**
 * Sync a Mirror Mind session to Notion: ideas (conversation), concept map, and feasibility.
 * Creates a new page in the configured Notion database.
 *
 * @param {Object} sessionData
 * @param {string} sessionData.title - Page title
 * @param {Record<string, string[]>} sessionData.conceptMap - Concept → related terms
 * @param {number|null} sessionData.feasibilitySignal - 0-1 score
 * @param {Array<{role: string, content: string}>} sessionData.messages - Conversation (ideas)
 * @param {Array<{name: string}>} [sessionData.tags] - Optional tags for multi_select
 */
async function syncSessionToNotion(sessionData) {
  if (!notion || !process.env.NOTION_DATABASE_ID) {
    console.warn("Notion not configured (NOTION_API_KEY or NOTION_DATABASE_ID missing). Skipping sync.");
    return null;
  }

  const title = sessionData.title || `Mirror Mind - ${new Date().toISOString().slice(0, 10)}`;
  const conceptMap = sessionData.conceptMap || {};
  const feasibilitySignal = sessionData.feasibilitySignal;
  const messages = sessionData.messages || [];
  const tags = sessionData.tags || [];

  const feasibilityPercent =
    typeof feasibilitySignal === "number"
      ? Math.round(feasibilitySignal * 100)
      : null;

  const children = [];

  // Section: Conversation / Ideas
  if (messages.length > 0) {
    children.push(
      { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "💬 Ideas & conversation" } }] } }
    );
    for (const msg of messages) {
      const who = msg.role === "user" ? "You" : "Mirror Mind";
      const content = (msg.content || "").slice(0, 2000);
      if (!content) continue;
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: `${who}: ${content}` } }],
        },
      });
    }
  }

  // Section: Concept map
  children.push(
    { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "🗺️ Concept map" } }] } }
  );
  if (Object.keys(conceptMap).length > 0) {
    for (const [concept, terms] of Object.entries(conceptMap)) {
      const line = Array.isArray(terms) && terms.length > 0
        ? `${concept}: ${terms.join(", ")}`
        : concept;
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: line } }] },
      });
    }
    children.push({
      object: "block",
      type: "code",
      code: {
        language: "json",
        rich_text: [{ text: { content: JSON.stringify(conceptMap, null, 2) } }],
      },
    });
  } else {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: "No concepts extracted yet." } }] },
    });
  }

  // Section: Feasibility
  children.push(
    { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "✅ Feasibility" } }] } }
  );
  children.push({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          text: {
            content:
              feasibilityPercent != null
                ? `Score: ${feasibilityPercent}%`
                : "Not assessed yet.",
          },
        },
      ],
    },
  });

  const titlePropName = process.env.NOTION_TITLE_PROPERTY || "Name";
  const properties = {
    [titlePropName]: {
      title: [{ text: { content: title.slice(0, 2000) } }],
    },
  };

  const tagsPropName = process.env.NOTION_TAGS_PROPERTY;
  if (tagsPropName && tags.length > 0) {
    properties[tagsPropName] = { multi_select: tags };
  }

  const response = await notion.pages.create({
    parent: { database_id: process.env.NOTION_DATABASE_ID },
    properties,
    children,
  });

  console.log("Synced to Notion:", response.id);
  return response;
}

module.exports = {
  syncSessionToNotion,
};
