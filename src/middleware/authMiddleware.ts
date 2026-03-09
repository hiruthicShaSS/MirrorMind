import { Request, Response, NextFunction } from "express";
import { verifySessionToken } from "../services/authService";

const allowAnonymous =
  process.env.ALLOW_ANONYMOUS_AGENT === "1" || process.env.NODE_ENV === "development";

export async function verifyAuth(
  req: Request & { userId?: string },
  res: Response,
  next: NextFunction
): Promise<void> {
  // Keep knowledge graph available even when no auth session is active.
  if (req.path.startsWith("/knowledge-graph")) {
    const sessionToken =
      (req.cookies as { ["__Secure-auth-session"]?: string })["__Secure-auth-session"] ??
      (req.cookies as { ["auth-session"]?: string })["auth-session"];
    if (!sessionToken) {
      req.userId = "anonymous";
      return next();
    }
    try {
      req.userId = verifySessionToken(sessionToken).userId;
      return next();
    } catch {
      req.userId = "anonymous";
      return next();
    }
  }

  const sessionToken =
    (req.cookies as { ["__Secure-auth-session"]?: string })["__Secure-auth-session"] ??
    (req.cookies as { ["auth-session"]?: string })["auth-session"];

  if (!sessionToken) {
    if (allowAnonymous) {
      req.userId = "anonymous";
      return next();
    }
    res.status(401).json({ error: "Unauthorized: No valid session" });
    return;
  }

  try {
    const decoded = verifySessionToken(sessionToken);
    req.userId = decoded.userId;
    next();
  } catch {
    if (allowAnonymous) {
      req.userId = "anonymous";
      return next();
    }
    res.status(401).json({ error: "Unauthorized: Invalid session" });
  }
}
