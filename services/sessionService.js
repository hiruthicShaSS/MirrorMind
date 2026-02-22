const redis = require("redis");
const { v4: uuidv4 } = require("uuid");

let redisClient;

async function initRedis() {
  if (!redisClient) {
    redisClient = redis.createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });

    redisClient.on("error", (err) => console.error("Redis error:", err));

    try {
      await redisClient.connect();
      console.log("Redis connected");
    } catch (e) {
      console.warn("Redis connection failed, running in-memory mode:", e.message);
      // Fallback: use in-memory store
      redisClient = createInMemoryStore();
    }
  }

  return redisClient;
}

// Fallback in-memory session store for development
function createInMemoryStore() {
  const store = new Map();

  return {
    set: async (key, value) => store.set(key, value),
    get: async (key) => store.get(key),
    del: async (key) => store.delete(key),
    connect: async () => {},
    disconnect: async () => {},
  };
}

// Create a new thinking session
async function createSession() {
  const client = await initRedis();
  const sessionId = uuidv4();

  const session = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    messages: [],
    conceptMap: { nodes: [], edges: [] },
    feasibilitySignal: null,
    isActive: true,
  };

  await client.set(`session:${sessionId}`, JSON.stringify(session));
  return session;
}

// Get session
async function getSession(sessionId) {
  const client = await initRedis();
  const data = await client.get(`session:${sessionId}`);
  return data ? JSON.parse(data) : null;
}

// Append message to session
async function appendMessage(sessionId, role, content) {
  const client = await initRedis();
  const session = await getSession(sessionId);

  if (!session) throw new Error("Session not found");

  session.messages.push({
    role,
    content,
    timestamp: new Date().toISOString(),
  });

  await client.set(`session:${sessionId}`, JSON.stringify(session));
  return session;
}

// Update concept map
async function updateConceptMap(sessionId, conceptMap) {
  const client = await initRedis();
  const session = await getSession(sessionId);

  if (!session) throw new Error("Session not found");

  session.conceptMap = conceptMap;
  await client.set(`session:${sessionId}`, JSON.stringify(session));
  return session;
}

// Update feasibility signal
async function updateFeasibilitySignal(sessionId, signal) {
  const client = await initRedis();
  const session = await getSession(sessionId);

  if (!session) throw new Error("Session not found");

  session.feasibilitySignal = signal;
  await client.set(`session:${sessionId}`, JSON.stringify(session));
  return session;
}

// Close session
async function closeSession(sessionId) {
  const client = await initRedis();
  const session = await getSession(sessionId);

  if (!session) throw new Error("Session not found");

  session.isActive = false;
  session.closedAt = new Date().toISOString();

  await client.set(`session:${sessionId}`, JSON.stringify(session));
  return session;
}

module.exports = {
  initRedis,
  createSession,
  getSession,
  appendMessage,
  updateConceptMap,
  updateFeasibilitySignal,
  closeSession,
};
