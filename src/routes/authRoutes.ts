import { Router, Request, Response } from "express";
import { initFirebase } from "../services/firebaseService";
import {
  verifyGoogleCredential,
  getOrCreateUser,
  createSessionToken,
} from "../services/authService";
import { verifyAuth } from "../middleware/authMiddleware";

const router = Router();

function setSessionCookie(res: Response, sessionToken: string): void {
  const isSecure = process.env.NODE_ENV === "production";
  res.cookie("__Secure-auth-session", sessionToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
  if (!isSecure) {
    res.cookie("auth-session", sessionToken, {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
    });
  }
}

router.post("/login", async (req: Request, res: Response): Promise<void> => {
  try {
    const { credential, idToken } = req.body as { credential?: string; idToken?: string };
    const token = credential ?? idToken;
    if (!token) {
      res.status(400).json({ error: "credential (ID token) required" });
      return;
    }
    const db = await initFirebase();
    const userInfo = await verifyGoogleCredential(token);
    const user = await getOrCreateUser(userInfo, db as unknown as Parameters<typeof getOrCreateUser>[1]);
    const sessionToken = createSessionToken(user.id);
    setSessionCookie(res, sessionToken);
    res.json({ id: user.id, email: user.email, name: user.name, picture: user.picture });
  } catch (error) {
    console.error("Login error:", error);
    res.status(401).json({
      error: "Login failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get("/me", verifyAuth, async (req: Request & { userId?: string }, res: Response): Promise<void> => {
  try {
    const db = await initFirebase();
    const userId = req.userId!;
    const userRef = db.collection("users").doc(userId);
    const byId = await userRef.get();
    const user = byId.exists ? (byId.data() as { id: string; email: string; name: string; picture: string | null }) : null;
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ id: user.id, email: user.email, name: user.name, picture: user.picture });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

router.post("/logout", (_req: Request, res: Response): void => {
  res.clearCookie("__Secure-auth-session", { path: "/" });
  res.clearCookie("auth-session", { path: "/" });
  res.json({ success: true });
});

export default router;
