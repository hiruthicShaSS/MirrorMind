/**
 * WebSocket handler for Gemini Live agent: /api/agent/live
 * Client sends text or audio; server proxies to Gemini Live and streams back.
 * Auth via session cookie (same as REST). First message must include sessionId.
 */

import { WebSocket } from "ws";
import { IncomingMessage } from "http";
import { verifySessionToken } from "./services/authService";
import { connectLiveSession } from "./services/liveService";
import {
  getSession,
  appendMessage,
  updateConceptMap,
  updateFeasibilitySignal,
} from "./services/firebaseService";

const allowAnonymous =
  process.env.ALLOW_ANONYMOUS_AGENT === "1" || process.env.NODE_ENV === "development";

function getUserIdFromRequest(req: IncomingMessage): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return allowAnonymous ? "anonymous" : null;
  const match = cookieHeader.match(/(?:^|;\s*)(?:__Secure-auth-session|auth-session)=([^;]+)/);
  const token = match?.[1]?.trim();
  if (!token) return allowAnonymous ? "anonymous" : null;
  try {
    return verifySessionToken(token).userId;
  } catch {
    return allowAnonymous ? "anonymous" : null;
  }
}

export type ClientMessage =
  | { type: "init"; sessionId: string }
  | { type: "text"; payload: string }
  | { type: "audio"; payload: string; mimeType?: string };

export type ServerMessage =
  | { type: "ready" }
  | { type: "text"; payload: string }
  | { type: "audio"; payload: string; mimeType?: string }
  | { type: "done"; fullText: string; conceptMap: Record<string, string[]>; feasibilitySignal: number | null }
  | { type: "interrupted" }
  | { type: "error"; message: string };

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function attachLiveWs(ws: WebSocket, req: IncomingMessage): void {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    send(ws, { type: "error", message: "Unauthorized: No valid session" });
    ws.close();
    return;
  }

  let sessionId: string | null = null;
  let liveSession: Awaited<ReturnType<typeof connectLiveSession>> | null = null;

  ws.on("message", async (raw: Buffer | string) => {
    try {
      const data = JSON.parse(raw.toString()) as ClientMessage;
      if (process.env.NODE_ENV !== "production") {
        console.log("[Live WS] Received:", data.type, data.type === "text" ? "(payload length " + (data.payload?.length ?? 0) + ")" : "");
      }

      if (data.type === "init") {
        if (sessionId != null) {
          send(ws, { type: "error", message: "Already initialized" });
          return;
        }
        sessionId = data.sessionId;
        const session = await getSession(sessionId);
        if (!session) {
          send(ws, { type: "error", message: "Session not found" });
          return;
        }
        if (session.userId && session.userId !== userId) {
          send(ws, { type: "error", message: "Unauthorized: session owner mismatch" });
          return;
        }
        liveSession = await connectLiveSession({
          onText: (text) => {
            if (process.env.NODE_ENV !== "production") console.log("[Live WS] Sending text to client, length:", text.length);
            send(ws, { type: "text", payload: text });
          },
          onAudio: (base64, mimeType) => {
            if (process.env.NODE_ENV !== "production") console.log("[Live WS] Sending audio to client, payload length:", base64?.length ?? 0, "mime:", mimeType);
            send(ws, { type: "audio", payload: base64, mimeType });
          },
          onInterrupted: () => send(ws, { type: "interrupted" }),
          onTurnComplete: async (fullText, conceptMap, feasibilitySignal) => {
            send(ws, { type: "done", fullText, conceptMap, feasibilitySignal });
            if (!sessionId) return;
            try {
              await appendMessage(sessionId, "assistant", fullText);
              await updateConceptMap(sessionId, conceptMap);
              if (feasibilitySignal != null) {
                await updateFeasibilitySignal(sessionId, feasibilitySignal);
              }
            } catch (e) {
              console.warn("Live: failed to persist turn:", e);
            }
          },
          onError: (message) => send(ws, { type: "error", message }),
          onClose: (reason) => {
            send(ws, { type: "error", message: reason ? `Live connection closed: ${reason}` : "Live connection closed. Reconnect to try another model." });
          },
        });
        send(ws, { type: "ready" });
        if (process.env.NODE_ENV !== "production") console.log("[Live WS] Init done, sessionId:", sessionId);
        return;
      }

      if (data.type === "text") {
        if (!liveSession) {
          send(ws, { type: "error", message: "Send init with sessionId first" });
          return;
        }
        if (!sessionId) return;
        await appendMessage(sessionId, "user", data.payload);
        if (process.env.NODE_ENV !== "production") console.log("[Live WS] Sending text to Live API:", data.payload.slice(0, 50));
        await liveSession.sendText(data.payload, true);
        return;
      }

      if (data.type === "audio") {
        if (!liveSession) {
          send(ws, { type: "error", message: "Send init with sessionId first" });
          return;
        }
        liveSession.sendAudio(data.payload, data.mimeType);
        return;
      }
    } catch (e) {
      send(ws, { type: "error", message: e instanceof Error ? e.message : "Invalid message" });
    }
  });

  ws.on("close", () => {
    liveSession?.close();
  });
}
