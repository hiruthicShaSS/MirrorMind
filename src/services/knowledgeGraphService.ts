import { initFirebase } from "./firebaseService";

export interface KnowledgeNode {
  id: string;
  label: string;
  type: "concept" | "term";
  weight: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sessionIds: string[];
}

export interface KnowledgeEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  weight: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sessionIds: string[];
}

interface KnowledgeGraphDoc {
  userId: string;
  nodes: Record<string, KnowledgeNode>;
  edges: Record<string, KnowledgeEdge>;
  updatedAt: string;
  version: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}

const GRAPH_LABEL_MAX = 64;
const BLOCKED_LABEL_RE = /\b(thoughts?|analysis|reasoning|conversation|response|assistant|user|mirror\s*mind)\b/i;

function isValidGraphLabel(labelRaw: string, kind: "concept" | "term"): boolean {
  const label = normalizeLabel(labelRaw);
  if (!label) return false;
  if (label.length > GRAPH_LABEL_MAX) return false;
  if (BLOCKED_LABEL_RE.test(label)) return false;
  // Drop sentence-like content; graph labels should be short noun phrases.
  if (/[.!?]/.test(label)) return false;
  if (kind === "concept" && label.split(" ").length > 6) return false;
  if (kind === "term" && label.split(" ").length > 5) return false;
  return true;
}

function sanitizeConceptMapForGraph(conceptMap: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [conceptRaw, termsRaw] of Object.entries(conceptMap ?? {})) {
    const concept = normalizeLabel(String(conceptRaw || ""));
    if (!isValidGraphLabel(concept, "concept")) continue;
    const terms = (Array.isArray(termsRaw) ? termsRaw : [])
      .map((t) => normalizeLabel(String(t || "")))
      .filter((t) => isValidGraphLabel(t, "term"));
    const deduped = [...new Set(terms)];
    if (deduped.length === 0) continue;
    out[concept] = deduped.slice(0, 12);
  }
  return out;
}

function toNodeId(label: string): string {
  const normalized = normalizeLabel(label).toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (slug) return `n_${slug}`;
  const fallback = Buffer.from(normalized || "node").toString("base64url").slice(0, 16);
  return `n_${fallback}`;
}

function ensureSession(sessionIds: string[], sessionId: string): string[] {
  if (!sessionId) return sessionIds;
  if (sessionIds.includes(sessionId)) return sessionIds;
  const out = [...sessionIds, sessionId];
  return out.slice(-20);
}

function edgeId(source: string, target: string, label: string): string {
  return `e_${source}|${label.toLowerCase()}|${target}`;
}

async function getGraphDoc(userId: string): Promise<KnowledgeGraphDoc> {
  const database = await initFirebase();
  const doc = await database.collection("knowledge_graphs").doc(userId).get();
  const data = doc.exists ? (doc.data() as Partial<KnowledgeGraphDoc>) : null;
  return {
    userId,
    nodes: data?.nodes ?? {},
    edges: data?.edges ?? {},
    updatedAt: data?.updatedAt ?? nowIso(),
    version: 1,
  };
}

async function saveGraphDoc(graph: KnowledgeGraphDoc): Promise<void> {
  const database = await initFirebase();
  await database.collection("knowledge_graphs").doc(graph.userId).set(
    {
      ...graph,
      updatedAt: nowIso(),
      version: 1,
    } as unknown as Record<string, unknown>
  );
}

function upsertNode(
  graph: KnowledgeGraphDoc,
  labelRaw: string,
  type: "concept" | "term",
  sessionId: string,
  at: string
): KnowledgeNode {
  const label = normalizeLabel(labelRaw);
  const id = toNodeId(label);
  const existing = graph.nodes[id];
  const next: KnowledgeNode = existing
    ? {
        ...existing,
        label,
        type: existing.type === "concept" || type === "concept" ? "concept" : "term",
        weight: existing.weight + 1,
        lastSeenAt: at,
        sessionIds: ensureSession(existing.sessionIds ?? [], sessionId),
      }
    : {
        id,
        label,
        type,
        weight: 1,
        firstSeenAt: at,
        lastSeenAt: at,
        sessionIds: sessionId ? [sessionId] : [],
      };
  graph.nodes[id] = next;
  return next;
}

function upsertEdge(
  graph: KnowledgeGraphDoc,
  source: string,
  target: string,
  label: string,
  sessionId: string,
  at: string
): void {
  const id = edgeId(source, target, label);
  const existing = graph.edges[id];
  graph.edges[id] = existing
    ? {
        ...existing,
        weight: existing.weight + 1,
        lastSeenAt: at,
        sessionIds: ensureSession(existing.sessionIds ?? [], sessionId),
      }
    : {
        id,
        source,
        target,
        label,
        weight: 1,
        firstSeenAt: at,
        lastSeenAt: at,
        sessionIds: sessionId ? [sessionId] : [],
      };
}

function toResponse(graph: KnowledgeGraphDoc, limitNodes = 300, limitEdges = 600): {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  updatedAt: string;
} {
  const nodes = Object.values(graph.nodes)
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
    .slice(0, Math.max(1, limitNodes));
  const nodeSet = new Set(nodes.map((n) => n.id));
  const edges = Object.values(graph.edges)
    .filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target))
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
    .slice(0, Math.max(1, limitEdges));
  return { nodes, edges, updatedAt: graph.updatedAt };
}

export async function upsertKnowledgeGraphFromConceptMap(input: {
  userId?: string | null;
  sessionId: string;
  conceptMap: Record<string, string[]>;
}): Promise<void> {
  const userId = (input.userId ?? "").trim();
  if (!userId) return;
  const conceptMap = sanitizeConceptMapForGraph(input.conceptMap ?? {});
  if (Object.keys(conceptMap).length === 0) return;

  const at = nowIso();
  const graph = await getGraphDoc(userId);
  const conceptNodeIds: string[] = [];

  for (const [conceptRaw, termsRaw] of Object.entries(conceptMap)) {
    const concept = normalizeLabel(String(conceptRaw || ""));
    if (!concept) continue;
    const c = upsertNode(graph, concept, "concept", input.sessionId, at);
    conceptNodeIds.push(c.id);

    const terms = Array.isArray(termsRaw) ? termsRaw : [];
    for (const tRaw of terms) {
      const term = normalizeLabel(String(tRaw || ""));
      if (!term) continue;
      const t = upsertNode(graph, term, "term", input.sessionId, at);
      upsertEdge(graph, c.id, t.id, "relates_to", input.sessionId, at);
    }
  }

  for (let i = 0; i < conceptNodeIds.length; i++) {
    for (let j = i + 1; j < conceptNodeIds.length; j++) {
      const [a, b] =
        conceptNodeIds[i] < conceptNodeIds[j]
          ? [conceptNodeIds[i], conceptNodeIds[j]]
          : [conceptNodeIds[j], conceptNodeIds[i]];
      upsertEdge(graph, a, b, "co_occurs", input.sessionId, at);
    }
  }

  await saveGraphDoc(graph);
}

export async function getKnowledgeGraph(userId: string, limitNodes = 300, limitEdges = 600): Promise<{
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  updatedAt: string;
}> {
  const graph = await getGraphDoc(userId);
  return toResponse(graph, limitNodes, limitEdges);
}

export async function searchKnowledgeGraph(
  userId: string,
  query: string,
  limit = 20
): Promise<{ nodes: KnowledgeNode[] }> {
  const q = query.trim().toLowerCase();
  if (!q) return { nodes: [] };
  const graph = await getGraphDoc(userId);
  const nodes = Object.values(graph.nodes)
    .filter((n) => n.label.toLowerCase().includes(q))
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
    .slice(0, Math.max(1, limit));
  return { nodes };
}

export async function getKnowledgeGraphNode(
  userId: string,
  nodeId: string
): Promise<{ node: KnowledgeNode | null; neighbors: KnowledgeNode[]; edges: KnowledgeEdge[] }> {
  const graph = await getGraphDoc(userId);
  const node = graph.nodes[nodeId] ?? null;
  if (!node) return { node: null, neighbors: [], edges: [] };

  const edges = Object.values(graph.edges)
    .filter((e) => e.source === nodeId || e.target === nodeId)
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
    .slice(0, 200);
  const neighborIds = new Set<string>();
  for (const e of edges) {
    neighborIds.add(e.source === nodeId ? e.target : e.source);
  }
  const neighbors = [...neighborIds]
    .map((id) => graph.nodes[id])
    .filter(Boolean)
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));

  return { node, neighbors, edges };
}

export async function resetKnowledgeGraph(userId: string): Promise<void> {
  const empty: KnowledgeGraphDoc = {
    userId,
    nodes: {},
    edges: {},
    updatedAt: nowIso(),
    version: 1,
  };
  await saveGraphDoc(empty);
}

export async function rebuildKnowledgeGraphFromSessionMaps(input: {
  userId: string;
  sessions: { sessionId: string; conceptMap: Record<string, string[]> }[];
}): Promise<{ nodes: number; edges: number; sessionsProcessed: number }> {
  const userId = input.userId.trim();
  if (!userId) return { nodes: 0, edges: 0, sessionsProcessed: 0 };

  const graph: KnowledgeGraphDoc = {
    userId,
    nodes: {},
    edges: {},
    updatedAt: nowIso(),
    version: 1,
  };

  let sessionsProcessed = 0;
  for (const s of input.sessions) {
    const conceptMap = sanitizeConceptMapForGraph(s.conceptMap ?? {});
    if (Object.keys(conceptMap).length === 0) continue;
    sessionsProcessed++;
    const at = nowIso();
    const conceptNodeIds: string[] = [];

    for (const [conceptRaw, termsRaw] of Object.entries(conceptMap)) {
      const concept = normalizeLabel(String(conceptRaw || ""));
      if (!concept) continue;
      const c = upsertNode(graph, concept, "concept", s.sessionId, at);
      conceptNodeIds.push(c.id);

      const terms = Array.isArray(termsRaw) ? termsRaw : [];
      for (const tRaw of terms) {
        const term = normalizeLabel(String(tRaw || ""));
        if (!term) continue;
        const t = upsertNode(graph, term, "term", s.sessionId, at);
        upsertEdge(graph, c.id, t.id, "relates_to", s.sessionId, at);
      }
    }

    for (let i = 0; i < conceptNodeIds.length; i++) {
      for (let j = i + 1; j < conceptNodeIds.length; j++) {
        const [a, b] =
          conceptNodeIds[i] < conceptNodeIds[j]
            ? [conceptNodeIds[i], conceptNodeIds[j]]
            : [conceptNodeIds[j], conceptNodeIds[i]];
        upsertEdge(graph, a, b, "co_occurs", s.sessionId, at);
      }
    }
  }

  await saveGraphDoc(graph);
  return {
    nodes: Object.keys(graph.nodes).length,
    edges: Object.keys(graph.edges).length,
    sessionsProcessed,
  };
}
