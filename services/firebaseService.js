const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

let db = null;
let initialized = false;
let usingFallback = false;

// In-memory session store for development (fallback when no Firebase key)
const memoryStore = new Map();

// Initialize Firebase Admin (requires service account key)
async function initFirebase() {
  if (initialized) {
    return db;
  }

  // Check if firebase-key.json exists
  const keyPath = path.join(process.cwd(), "firebase-key.json");
  const keyFileExists = fs.existsSync(keyPath);

  if (!keyFileExists && process.env.NODE_ENV === "development") {
    console.warn("\n⚠️  firebase-key.json not found!");
    console.warn("📋 To set up Firebase Firestore:");
    console.warn("   1. Go to: https://console.firebase.google.com/project/mirror-mind-593c0/settings/serviceaccounts/adminsdk");
    console.warn("   2. Click 'Generate New Private Key'");
    console.warn("   3. Save as: firebase-key.json in project root\n");
    console.warn("✓ Running in DEVELOPMENT MODE with in-memory storage");
    console.warn("  (Data will NOT persist across restarts)\n");

    usingFallback = true;
    initialized = true;
    db = createInMemoryDb();
    return db;
  }

  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS && keyFileExists) {
      admin.initializeApp();
    } else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          clientId: process.env.FIREBASE_CLIENT_ID,
          authUri: "https://accounts.google.com/o/oauth2/auth",
          tokenUri: "https://oauth2.googleapis.com/token",
          authProviderX509CertUrl:
            "https://www.googleapis.com/oauth2/v1/certs",
        }),
      });
    } else {
      throw new Error("No valid Firebase credentials provided");
    }

    db = admin.firestore();
    initialized = true;

    console.log("✓ Firebase Firestore initialized (production)");
    return db;
  } catch (error) {
    console.error("Firebase initialization failed:", error.message);
    console.error("\n📚 See FIREBASE_SETUP.md for configuration instructions");
    throw error;
  }
}

// In-memory database for development (no persistence)
function createInMemoryDb() {
  return {
    collection: (collectionName) => ({
      doc: (docId) => ({
        set: async (data) => {
          memoryStore.set(`${collectionName}/${docId}`, data);
        },
        get: async () => ({
          exists: memoryStore.has(`${collectionName}/${docId}`),
          data: () => memoryStore.get(`${collectionName}/${docId}`),
        }),
        update: async (data) => {
          const key = `${collectionName}/${docId}`;
          const existing = memoryStore.get(key) || {};
          memoryStore.set(key, { ...existing, ...data });
        },
      }),
      where: () => ({
        orderBy: () => ({
          limit: () => ({
            get: async () => ({
              docs: [],
            }),
          }),
        }),
      }),
    }),
  };
}

function nowStamp() {
  return usingFallback ? new Date().toISOString() : admin.firestore.Timestamp.now();
}

function normalizeMessage(m, i) {
  return {
    id: m.id || `msg-${i}`,
    role: m.role || "user",
    content: m.content || "",
    createdAt: m.createdAt || (m.timestamp && typeof m.timestamp.toDate === "function" ? m.timestamp.toDate().toISOString() : new Date().toISOString()),
  };
}

// Create a new thinking session
async function createSession(userId = null) {
  const database = await initFirebase();
  const sessionId = uuidv4();

  const session = {
    id: sessionId,
    userId: userId,
    createdAt: nowStamp(),
    messages: [],
    conceptMap: {}, // Record<string, string[]>
    feasibilitySignal: null,
    isActive: true,
  };

  await database.collection("sessions").doc(sessionId).set(session);
  return formatSessionResponse(session);
}

function formatSessionResponse(data) {
  const out = { ...data };
  if (out.createdAt && typeof out.createdAt.toDate === "function") {
    out.createdAt = out.createdAt.toDate().toISOString();
  }
  if (out.closedAt && typeof out.closedAt?.toDate === "function") {
    out.closedAt = out.closedAt.toDate().toISOString();
  }
  if (out.updatedAt && typeof out.updatedAt?.toDate === "function") {
    out.updatedAt = out.updatedAt.toDate().toISOString();
  }
  out.messages = (out.messages || []).map(normalizeMessage);
  if (out.conceptMap && out.conceptMap.nodes) {
    const flat = {};
    (out.conceptMap.nodes || []).forEach((n) => {
      flat[n.label || n.id] = out.conceptMap.edges?.filter((e) => e.from === n.id).map((e) => e.label || e.to) || [];
    });
    out.conceptMap = flat;
  }
  if (typeof out.conceptMap !== "object" || out.conceptMap === null) {
    out.conceptMap = {};
  }
  return out;
}

// Get session
async function getSession(sessionId) {
  const database = await initFirebase();
  const doc = await database.collection("sessions").doc(sessionId).get();

  if (!doc.exists) {
    return null;
  }

  const data = doc.data();
  return formatSessionResponse(data);
}

// Append message to session
async function appendMessage(sessionId, role, content) {
  const database = await initFirebase();
  const session = await getSession(sessionId);

  if (!session) {
    throw new Error("Session not found");
  }

  const newMessage = {
    id: uuidv4(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };

  const newMessages = [...(session.messages || []), newMessage];

  await database.collection("sessions").doc(sessionId).update({
    messages: newMessages,
    updatedAt: nowStamp(),
  });

  return { ...session, messages: newMessages };
}

// Update concept map (conceptMap: Record<string, string[]>)
async function updateConceptMap(sessionId, conceptMap) {
  const database = await initFirebase();
  const session = await getSession(sessionId);

  if (!session) {
    throw new Error("Session not found");
  }

  const normalized = typeof conceptMap === "object" && conceptMap !== null && !Array.isArray(conceptMap)
    ? conceptMap
    : {};

  await database.collection("sessions").doc(sessionId).update({
    conceptMap: normalized,
    updatedAt: nowStamp(),
  });

  return { ...session, conceptMap: normalized };
}

// Update feasibility signal
async function updateFeasibilitySignal(sessionId, signal) {
  const database = await initFirebase();
  const session = await getSession(sessionId);

  if (!session) {
    throw new Error("Session not found");
  }

  await database.collection("sessions").doc(sessionId).update({
    feasibilitySignal: signal,
    updatedAt: nowStamp(),
  });

  return { ...session, feasibilitySignal: signal };
}

// Close session
async function closeSession(sessionId) {
  const database = await initFirebase();
  const session = await getSession(sessionId);

  if (!session) {
    throw new Error("Session not found");
  }

  await database.collection("sessions").doc(sessionId).update({
    isActive: false,
    closedAt: nowStamp(),
  });

  return { ...session, isActive: false };
}

// Get all user sessions
async function getUserSessions(userId, limit = 10) {
  const database = await initFirebase();
  const snapshot = await database
    .collection("sessions")
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => formatSessionResponse(doc.data()));
}

module.exports = {
  initFirebase,
  createSession,
  getSession,
  appendMessage,
  updateConceptMap,
  updateFeasibilitySignal,
  closeSession,
  getUserSessions,
};
