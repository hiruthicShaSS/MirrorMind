import http from "http";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { WebSocketServer } from "ws";
import "dotenv/config";

import { initFirebase } from "./services/firebaseService";
import authRoutes from "./routes/authRoutes";
import githubRoutes from "./routes/githubRoutes";
import oauthRoutes from "./routes/oauthRoutes";
import agentRoutes from "./routes/agentRoutes";
import { verifyAuth } from "./middleware/authMiddleware";
import { attachLiveWs } from "./liveWsHandler";

const app = express();

const defaultProdOrigins = [
  "https://mirror-mind.hiruthicsha.com",
  "https://mirrormind-production.up.railway.app",
];

const envOrigins = (process.env.FRONTEND_URL ??
  (process.env.NODE_ENV === "production"
    ? defaultProdOrigins.join(",")
    : "http://localhost:5173"))
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
    ? envOrigins.length
      ? envOrigins
      : ["http://localhost:5173"]
    : [...new Set([...envOrigins, ...devOrigins])];

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    if (origin && frontendOrigins.includes(origin)) return cb(null, origin);
    if (!origin) return cb(null, frontendOrigins[0]);
    cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  optionsSuccessStatus: 200,
  preflightContinue: false,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

app.use("/api/auth", authRoutes);
app.use("/api/oauth", oauthRoutes);
app.use("/api/github", verifyAuth, githubRoutes);
app.use("/api/agent", verifyAuth, agentRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", message: "Mirror Mind Backend Running 🚀" });
});

const PORT = process.env.PORT ?? 5000;

async function startServer(): Promise<void> {
  try {
    await initFirebase();
    console.log("✓ Firebase initialized");

    const server = http.createServer(app);

    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      const path = request.url?.split("?")[0];
      if (path === "/api/agent/live") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          attachLiveWs(ws as import("ws").WebSocket, request);
        });
      } else {
        socket.destroy();
      }
    });

    server.listen(PORT, () => {
      console.log(`✓ Server running on http://localhost:${PORT}`);
      console.log(`✓ Public: GET /api/health, POST /api/auth/login, GET /api/auth/github/start, GET /api/auth/github/callback, GET /api/oauth/start?service=github, GET /api/oauth/callback?service=github, GET /api/auth/me, POST /api/auth/logout`);
      console.log(`✓ Protected: GET /api/github/status, GET /api/github/repos, PUT /api/github/default-repo, POST/GET /api/agent/sessions, GET /api/agent/concept-maps, PUT concept-map, POST think, POST/GET poc, POST poc/confirm, POST poc/notify, GET poc/export, POST poc/github, sync-notion, close`);
      console.log(`✓ Live (WS): ws://localhost:${PORT}/api/agent/live`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
