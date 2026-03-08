import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

type FirestoreLike = admin.firestore.Firestore | InMemoryDb;
type TimestampLike = admin.firestore.Timestamp | string;

let db: FirestoreLike | null = null;
let initialized = false;
let usingFallback = false;

const memoryStore = new Map<string, Record<string, unknown>>();

interface InMemoryDocRef {
  set(data: Record<string, unknown>): Promise<void>;
  get(): Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  update(data: Record<string, unknown>): Promise<void>;
}

interface InMemoryQuerySnapshot {
  get(): Promise<{ docs: { data: () => Record<string, unknown> }[] }>;
}
interface InMemoryCollectionRef {
  doc(docId: string): InMemoryDocRef;
  where(_field: string): { orderBy(_field: string): { limit(n: number): InMemoryQuerySnapshot } };
}

interface InMemoryDb {
  collection(name: string): InMemoryCollectionRef;
}

function createInMemoryDb(): InMemoryDb {
  return {
    collection(collectionName: string) {
      return {
        doc(docId: string): InMemoryDocRef {
          const key = `${collectionName}/${docId}`;
          return {
            set: async (data) => {
              memoryStore.set(key, data as Record<string, unknown>);
            },
            get: async () => ({
              exists: memoryStore.has(key),
              data: () => memoryStore.get(key),
            }),
            update: async (data) => {
              const existing = memoryStore.get(key) || {};
              memoryStore.set(key, { ...existing, ...data });
            },
          };
        },
        where() {
          return {
            orderBy() {
              return {
                limit() {
                  return {
                    get: async () => ({ docs: [] }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function nowStamp(): TimestampLike {
  return usingFallback ? new Date().toISOString() : (admin.firestore.Timestamp.now() as TimestampLike);
}

function normalizeMessage(
  m: { id?: string; role?: string; content?: string; createdAt?: string; timestamp?: { toDate?: () => Date } },
  i: number
): { id: string; role: string; content: string; createdAt: string } {
  return {
    id: m.id ?? `msg-${i}`,
    role: m.role ?? "user",
    content: m.content ?? "",
    createdAt:
      m.createdAt ??
      (m.timestamp && typeof m.timestamp.toDate === "function" ? m.timestamp.toDate().toISOString() : new Date().toISOString()),
  };
}

export interface SessionData {
  id: string;
  userId?: string | null;
  createdAt: TimestampLike;
  updatedAt?: TimestampLike;
  closedAt?: TimestampLike;
  messages: { id?: string; role?: string; content?: string; createdAt?: string; timestamp?: { toDate?: () => Date } }[];
  conceptMap: Record<string, string[]> | { nodes?: unknown[]; edges?: unknown[] };
  feasibilitySignal: number | null;
  isActive: boolean;
}

export interface FormattedSession {
  id: string;
  userId?: string;
  createdAt: string;
  updatedAt?: string;
  closedAt?: string;
  messages: { id: string; role: string; content: string; createdAt: string }[];
  conceptMap: Record<string, string[]>;
  feasibilitySignal: number | null;
  isActive: boolean;
}

export async function initFirebase(): Promise<FirestoreLike> {
  if (initialized && db) return db;

  const keyPath = path.join(process.cwd(), "firebase-key.json");
  const keyFileExists = fs.existsSync(keyPath);

  if (!keyFileExists && process.env.NODE_ENV === "development") {
    console.warn("\n⚠️  firebase-key.json not found!");
    console.warn("✓ Running in DEVELOPMENT MODE with in-memory storage\n");
    usingFallback = true;
    initialized = true;
    db = createInMemoryDb();
    return db;
  }

  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS && keyFileExists) {
      admin.initializeApp();
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKey: (process.env.FIREBASE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          authUri: "https://accounts.google.com/o/oauth2/auth",
          tokenUri: "https://oauth2.googleapis.com/token",
          authProviderX509CertUrl: "https://www.googleapis.com/oauth2/v1/certs",
        } as admin.ServiceAccount),
      });
    } else {
      throw new Error("No valid Firebase credentials provided");
    }
    db = admin.firestore();
    initialized = true;
    console.log("✓ Firebase Firestore initialized (production)");
    return db;
  } catch (error) {
    console.error("Firebase initialization failed:", (error as Error).message);
    throw error;
  }
}

function formatSessionResponse(data: SessionData): FormattedSession {
  const out = { ...data } as FormattedSession;
  const toStr = (v: TimestampLike): string =>
    typeof v === "string" ? v : typeof (v as { toDate?: () => Date }).toDate === "function" ? (v as { toDate: () => Date }).toDate().toISOString() : String(v);
  if (out.createdAt) out.createdAt = toStr(out.createdAt as TimestampLike);
  if (out.closedAt) out.closedAt = toStr(out.closedAt as TimestampLike);
  if (out.updatedAt) out.updatedAt = toStr(out.updatedAt as TimestampLike);
  out.messages = (out.messages || []).map(normalizeMessage);
  const rawConceptMap = out.conceptMap as { nodes?: { label?: string; id?: string }[]; edges?: { from?: string; label?: string; to?: string }[] };
  if (rawConceptMap?.nodes) {
    const flat: Record<string, string[]> = {};
    (rawConceptMap.nodes || []).forEach((n) => {
      flat[n.label ?? n.id ?? ""] =
        rawConceptMap.edges?.filter((e) => e.from === n.id).map((e) => e.label ?? e.to ?? "") ?? [];
    });
    out.conceptMap = flat;
  }
  if (typeof out.conceptMap !== "object" || out.conceptMap === null) {
    out.conceptMap = {};
  }
  return out;
}

export async function createSession(userId: string | null = null): Promise<FormattedSession> {
  const database = await initFirebase();
  const sessionId = uuidv4();
  const session: SessionData = {
    id: sessionId,
    userId: userId ?? null,
    createdAt: nowStamp(),
    messages: [],
    conceptMap: {},
    feasibilitySignal: null,
    isActive: true,
  };
  await (database as InMemoryDb).collection("sessions").doc(sessionId).set(session as unknown as Record<string, unknown>);
  return formatSessionResponse(session);
}

export async function getSession(sessionId: string): Promise<FormattedSession | null> {
  const database = await initFirebase();
  const doc = await (database as InMemoryDb).collection("sessions").doc(sessionId).get();
  if (!doc.exists) return null;
  const data = doc.data() as SessionData | undefined;
  return data ? formatSessionResponse(data) : null;
}

export async function appendMessage(
  sessionId: string,
  role: string,
  content: string
): Promise<FormattedSession> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");
  const newMessage = {
    id: uuidv4(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
  const newMessages = [...(session.messages || []), newMessage];
  await (await initFirebase()).collection("sessions").doc(sessionId).update({
    messages: newMessages,
    updatedAt: nowStamp(),
  } as unknown as Record<string, unknown>);
  return { ...session, messages: newMessages };
}

export async function updateConceptMap(
  sessionId: string,
  conceptMap: Record<string, string[]>
): Promise<FormattedSession> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");
  const normalized =
    typeof conceptMap === "object" && conceptMap !== null && !Array.isArray(conceptMap) ? conceptMap : {};
  await (await initFirebase()).collection("sessions").doc(sessionId).update({
    conceptMap: normalized,
    updatedAt: nowStamp(),
  } as unknown as Record<string, unknown>);
  return { ...session, conceptMap: normalized };
}

export async function updateFeasibilitySignal(
  sessionId: string,
  signal: number
): Promise<FormattedSession> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");
  await (await initFirebase()).collection("sessions").doc(sessionId).update({
    feasibilitySignal: signal,
    updatedAt: nowStamp(),
  } as unknown as Record<string, unknown>);
  return { ...session, feasibilitySignal: signal };
}

export async function closeSession(sessionId: string): Promise<FormattedSession> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");
  await (await initFirebase()).collection("sessions").doc(sessionId).update({
    isActive: false,
    closedAt: nowStamp(),
  } as unknown as Record<string, unknown>);
  return { ...session, isActive: false };
}

export async function getUserSessions(userId: string, limit = 10): Promise<FormattedSession[]> {
  const database = await initFirebase();
  if (usingFallback) {
    const sessions: FormattedSession[] = [];
    for (const [key, data] of memoryStore) {
      if (!key.startsWith("sessions/")) continue;
      const d = data as unknown as SessionData;
      if (d.userId !== userId && (userId !== "anonymous" || d.userId != null)) continue;
      sessions.push(formatSessionResponse(d));
    }
    sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return sessions.slice(0, limit);
  }
  const snapshot = await (database as admin.firestore.Firestore)
    .collection("sessions")
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snapshot.docs.map((doc) => formatSessionResponse(doc.data() as unknown as SessionData));
}

export async function getAllUserSessions(userId: string, batchSize = 200): Promise<FormattedSession[]> {
  const database = await initFirebase();
  if (usingFallback) {
    const sessions: FormattedSession[] = [];
    for (const [key, data] of memoryStore) {
      if (!key.startsWith("sessions/")) continue;
      const d = data as unknown as SessionData;
      if (d.userId !== userId && (userId !== "anonymous" || d.userId != null)) continue;
      sessions.push(formatSessionResponse(d));
    }
    sessions.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return sessions;
  }

  const out: FormattedSession[] = [];
  let cursor: admin.firestore.QueryDocumentSnapshot | null = null;

  while (true) {
    let query = (database as admin.firestore.Firestore)
      .collection("sessions")
      .where("userId", "==", userId)
      .orderBy("createdAt", "asc")
      .limit(batchSize);

    if (cursor) query = query.startAfter(cursor);

    const snapshot = await query.get();
    if (snapshot.empty) break;
    out.push(...snapshot.docs.map((doc) => formatSessionResponse(doc.data() as unknown as SessionData)));
    cursor = snapshot.docs[snapshot.docs.length - 1] ?? null;
    if (snapshot.size < batchSize) break;
  }

  return out;
}
