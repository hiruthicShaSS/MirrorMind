import { Router, Request, Response } from "express";
import { initFirebase } from "../services/firebaseService";
import {
  verifyGoogleCredential,
  getOrCreateUser,
  createSessionToken,
  encodeUserId,
  verifySessionToken,
} from "../services/authService";
import { verifyAuth } from "../middleware/authMiddleware";
import crypto from "crypto";
import { persistGitHubConnection, fetchGitHubViewer } from "../services/githubAccountService";

const router = Router();

const githubOauthStateStore = new Map<
  string,
  { createdAt: number; redirectTo: string; userId: string | null }
>();

function cleanupGithubOauthStates(maxAgeMs = 10 * 60 * 1000): void {
  const now = Date.now();
  for (const [state, rec] of githubOauthStateStore.entries()) {
    if (now - rec.createdAt > maxAgeMs) {
      githubOauthStateStore.delete(state);
    }
  }
}

function getGithubCallbackUrl(req: Request): string {
  const envCallback = getEnvByNodeEnv("GITHUB_OAUTH_CALLBACK_URL");
  if (envCallback) return envCallback;
  const protocol = req.protocol;
  const host = req.get("host");
  return `${protocol}://${host}/api/oauth/callback?service=github`;
}

function getFrontendGithubCallbackUrl(): string {
  const frontendDefault = (process.env.FRONTEND_URL ?? "http://localhost:5173").split(",")[0]?.trim() || "http://localhost:5173";
  return `${frontendDefault.replace(/\/+$/, "")}/auth/github/callback`;
}

function getGithubScopes(): string {
  const raw = (process.env.GITHUB_OAUTH_SCOPES ?? "repo read:user user:email").trim();
  return raw || "repo read:user user:email";
}

function getEnvByNodeEnv(baseKey: string): string {
  const isProd = process.env.NODE_ENV === "production";
  const exact = (process.env[baseKey] ?? "").trim();
  const envSpecific = (process.env[`${baseKey}_${isProd ? "PROD" : "DEV"}`] ?? "").trim();
  return envSpecific || exact;
}

function getGithubOAuthClientConfig(): { clientId: string; clientSecret: string } {
  const clientId = getEnvByNodeEnv("GITHUB_CLIENT_ID");
  const clientSecret = getEnvByNodeEnv("GITHUB_CLIENT_SECRET");
  return { clientId, clientSecret };
}

function safeRedirectToUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return getFrontendGithubCallbackUrl();
    return parsed.toString();
  } catch {
    return getFrontendGithubCallbackUrl();
  }
}

function setSessionCookie(res: Response, sessionToken: string): void {
  const crossSiteCookies = process.env.CROSS_SITE_COOKIES === "1";
  const isSecure = process.env.NODE_ENV === "production";
  const sameSite: "lax" | "strict" | "none" = crossSiteCookies ? "none" : "lax";
  res.cookie("__Secure-auth-session", sessionToken, {
    httpOnly: true,
    secure: isSecure || crossSiteCookies,
    sameSite,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
  if (!isSecure && !crossSiteCookies) {
    res.cookie("auth-session", sessionToken, {
      httpOnly: true,
      secure: false,
      sameSite,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
    });
  }
}

function getUserIdFromSessionCookie(req: Request): string | null {
  const sessionToken =
    (req.cookies as { ["__Secure-auth-session"]?: string })["__Secure-auth-session"] ??
    (req.cookies as { ["auth-session"]?: string })["auth-session"];
  if (!sessionToken) return null;
  try {
    return verifySessionToken(sessionToken).userId;
  } catch {
    return null;
  }
}

async function handleGoogleLogin(req: Request, res: Response): Promise<void> {
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
    res.json({
      id: user.id,
      encodedUserId: encodeUserId(user.id),
      email: user.email,
      name: user.name,
      picture: user.picture,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(401).json({
      error: "Login failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

router.post("/login", handleGoogleLogin);
router.post("/google", handleGoogleLogin);

router.get("/github/start", async (req: Request, res: Response): Promise<void> => {
  try {
    const { clientId } = getGithubOAuthClientConfig();
    if (!clientId) {
      res.status(500).json({ error: "GITHUB_CLIENT_ID is not configured" });
      return;
    }

    cleanupGithubOauthStates();
    const state = crypto.randomBytes(24).toString("hex");
    const redirectToRaw = Array.isArray(req.query.redirectTo) ? req.query.redirectTo[0] : req.query.redirectTo;
    const redirectTo = safeRedirectToUrl(String(redirectToRaw ?? getFrontendGithubCallbackUrl()).trim());
    const userId = getUserIdFromSessionCookie(req);
    githubOauthStateStore.set(state, { createdAt: Date.now(), redirectTo, userId });

    const callbackUrl = getGithubCallbackUrl(req);
    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizeUrl.searchParams.set("scope", getGithubScopes());
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("allow_signup", "true");

    res.redirect(authorizeUrl.toString());
  } catch (error) {
    console.error("GitHub OAuth start error:", error);
    res.status(500).json({ error: "Failed to start GitHub OAuth" });
  }
});

router.get("/github/callback", async (req: Request, res: Response): Promise<void> => {
  try {
    const code = String(Array.isArray(req.query.code) ? req.query.code[0] : req.query.code ?? "").trim();
    const state = String(Array.isArray(req.query.state) ? req.query.state[0] : req.query.state ?? "").trim();
    const { clientId, clientSecret } = getGithubOAuthClientConfig();
    const callbackUrl = getGithubCallbackUrl(req);

    if (!clientId || !clientSecret) {
      res.status(500).json({ error: "GitHub OAuth is not configured (missing client ID/secret)" });
      return;
    }
    if (!code || !state) {
      res.status(400).json({ error: "Missing OAuth code/state" });
      return;
    }

    cleanupGithubOauthStates();
    const storedState = githubOauthStateStore.get(state);
    githubOauthStateStore.delete(state);
    if (!storedState) {
      res.status(400).json({ error: "Invalid or expired OAuth state" });
      return;
    }

    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
        state,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      res.status(502).json({ error: "GitHub token exchange failed", details: body.slice(0, 300) });
      return;
    }

    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenJson.access_token) {
      res.status(400).json({
        error: tokenJson.error || "GitHub did not return access token",
        details: tokenJson.error_description || "OAuth callback failed",
      });
      return;
    }

    const viewer = await fetchGitHubViewer(tokenJson.access_token);
    const githubLogin = String(viewer.login ?? "").trim();

    if (storedState.userId) {
      await persistGitHubConnection(storedState.userId, {
        accessToken: tokenJson.access_token,
        scopes: String(tokenJson.scope ?? "")
          .split(/[,\s]+/)
          .map((part) => part.trim())
          .filter(Boolean),
        login: githubLogin || null,
        name: viewer.name ?? null,
        avatarUrl: viewer.avatar_url ?? null,
      });
    }

    const redirect = new URL(storedState.redirectTo);
    redirect.searchParams.set("provider", "github");
    redirect.searchParams.set("status", "success");
    redirect.searchParams.set("scope", String(tokenJson.scope ?? ""));
    if (githubLogin) redirect.searchParams.set("githubLogin", githubLogin);
    if (storedState.userId) redirect.searchParams.set("connected", "1");

    res.redirect(redirect.toString());
  } catch (error) {
    console.error("GitHub OAuth callback error:", error);
    res.status(500).json({
      error: "GitHub OAuth callback failed",
      message: error instanceof Error ? error.message : String(error),
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
    res.json({
      id: user.id,
      encodedUserId: encodeUserId(user.id),
      email: user.email,
      name: user.name,
      picture: user.picture,
    });
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
