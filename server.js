const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
require("dotenv").config();

const { initFirebase } = require("./services/firebaseService");
const authRoutes = require("./routes/authRoutes");
const agentRoutes = require("./routes/agentRoutes");
const verifyAuth = require("./middleware/authMiddleware");

const app = express();

// CORS: specific origin(s) only (required when credentials: true — browser rejects * with credentials)
const envOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const devOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175",
  "http://127.0.0.1:3000",
];
const frontendOrigins =
  process.env.NODE_ENV === "production"
    ? envOrigins.length ? envOrigins : ["http://localhost:5173"]
    : [...new Set([...envOrigins, ...devOrigins])];

const corsOptions = {
  origin: (origin, cb) => {
    if (origin && frontendOrigins.includes(origin)) return cb(null, origin);
    if (!origin) return cb(null, frontendOrigins[0]);
    cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200,
  preflightContinue: false,
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

// Auth Routes (public)
app.use("/api/auth", authRoutes);

// Protected Routes (require authentication)
app.use("/api/agent", verifyAuth, agentRoutes);

// Health check (public)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Mirror Mind Backend Running 🚀" });
});

// Start server
const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    // Initialize Firebase Firestore connection
    await initFirebase();
    console.log("✓ Firebase initialized");

    app.listen(PORT, () => {
      console.log(`✓ Server running on http://localhost:${PORT}`);
      console.log(`✓ Public endpoints:`);
      console.log(`   - GET /api/health`);
      console.log(`   - POST /api/auth/login (Google Sign-In)`);
      console.log(`   - POST /api/auth/logout`);
      console.log(`   - GET /api/auth/me`);
      console.log(`✓ Protected endpoints (require auth):`);
      console.log(`   - POST /api/agent/sessions`);
      console.log(`   - GET /api/agent/sessions`);
      console.log(`   - GET /api/agent/sessions/:sessionId`);
      console.log(`   - GET /api/agent/concept-maps`);
      console.log(`   - PUT /api/agent/sessions/:sessionId/concept-map`);
      console.log(`   - POST /api/agent/sessions/:sessionId/think`);
      console.log(`   - POST /api/agent/sessions/:sessionId/sync-notion`);
      console.log(`   - POST /api/agent/sessions/:sessionId/close`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
