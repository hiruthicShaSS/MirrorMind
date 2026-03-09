import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";

function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

const getSecret = () =>
  process.env.JWT_SECRET ?? process.env.SESSION_SECRET ?? "dev-secret";

export function createSessionToken(userId: string): string {
  return jwt.sign({ userId }, getSecret(), { expiresIn: "7d" });
}

export function verifySessionToken(token: string): { userId: string } {
  try {
    const decoded = jwt.verify(token, getSecret()) as { userId?: string };
    if (!decoded?.userId) throw new Error("Invalid session");
    return { userId: decoded.userId };
  } catch {
    throw new Error("Invalid session");
  }
}

export function encodeUserId(userId: string): string {
  return Buffer.from(userId, "utf8").toString("base64url");
}

export function decodeUserId(encodedUserId: string): string | null {
  try {
    const decoded = Buffer.from(encodedUserId, "base64url").toString("utf8").trim();
    return decoded || null;
  } catch {
    return null;
  }
}

export interface UserInfo {
  uid: string;
  email: string;
  name: string;
  picture: string | null;
}

function sanitizeMissingGoogleCredentialsPath(): void {
  const raw = (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
  if (!raw) return;
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  if (!fs.existsSync(resolved)) {
    console.warn(`GOOGLE_APPLICATION_CREDENTIALS file not found at ${resolved}. Ignoring this env var.`);
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
}

interface ServiceAccountEnvShape {
  project_id?: string;
  private_key?: string;
  client_email?: string;
}

function parseServiceAccountFromEnv(): ServiceAccountEnvShape | null {
  const rawKey = (process.env.FIREBASE_SERVICE_ACCOUNT_KEY ?? "").trim();
  if (rawKey) {
    try {
      if (rawKey.startsWith("{")) {
        return JSON.parse(rawKey) as ServiceAccountEnvShape;
      }
      return JSON.parse(Buffer.from(rawKey, "base64").toString("utf8")) as ServiceAccountEnvShape;
    } catch {
      console.warn("FIREBASE_SERVICE_ACCOUNT_KEY is invalid (expected JSON or base64 JSON). Ignoring.");
    }
  }

  const rawJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "").trim();
  if (rawJson) {
    try {
      return JSON.parse(rawJson) as ServiceAccountEnvShape;
    } catch {
      console.warn("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Ignoring.");
    }
  }

  const rawB64 = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON_B64 ?? "").trim();
  if (rawB64) {
    try {
      return JSON.parse(Buffer.from(rawB64, "base64").toString("utf8")) as ServiceAccountEnvShape;
    } catch {
      console.warn("FIREBASE_SERVICE_ACCOUNT_JSON_B64 is invalid. Ignoring.");
    }
  }
  return null;
}

function ensureFirebaseAdminInitialized(): void {
  if (admin.apps.length) return;

  sanitizeMissingGoogleCredentialsPath();
  const saJson = parseServiceAccountFromEnv();
  const projectId = (saJson?.project_id ?? process.env.FIREBASE_PROJECT_ID ?? "").trim();
  const clientEmail = (saJson?.client_email ?? process.env.FIREBASE_CLIENT_EMAIL ?? "").trim();
  const privateKey = (saJson?.private_key ?? process.env.FIREBASE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim();

  if (projectId && clientEmail && privateKey) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
    return;
  }

  if ((process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim()) {
    admin.initializeApp();
    return;
  }

  if (projectId) {
    admin.initializeApp({ projectId });
    return;
  }

  throw new Error(
    "Firebase Admin not initialized. Set FIREBASE_SERVICE_ACCOUNT_JSON(_B64) or FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY/FIREBASE_PROJECT_ID."
  );
}

export async function verifyGoogleCredential(credential: string): Promise<UserInfo> {
  ensureFirebaseAdminInitialized();
  const decodedToken = await admin.auth().verifyIdToken(credential);
  return {
    uid: decodedToken.uid,
    email: normalizeEmail(decodedToken.email ?? ""),
    name: (decodedToken.name as string) ?? (decodedToken.email as string) ?? "User",
    picture: (decodedToken.picture as string) ?? null,
  };
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  picture: string | null;
}

type FirestoreLike = { collection: (name: string) => { doc: (id: string) => { get: () => Promise<{ exists: boolean; data: () => UserRecord }>; update: (data: unknown) => Promise<void>; set: (data: unknown) => Promise<void> } } };

export async function getOrCreateUser(
  userInfo: UserInfo,
  db: FirestoreLike
): Promise<UserRecord> {
  const normalized = normalizeEmail(userInfo.email);
  const userRef = db.collection("users").doc(normalized);
  const userDoc = await userRef.get();

  if (userDoc.exists) {
    const d = userDoc.data()!;
    await userRef.update({ lastLogin: new Date().toISOString() });
    return { id: d.id, email: d.email, name: d.name, picture: d.picture };
  }

  const userId = uuidv4();
  const userData: UserRecord & { createdAt?: string; lastLogin?: string } = {
    id: userId,
    email: normalized,
    name: userInfo.name ?? normalized.split("@")[0],
    picture: userInfo.picture ?? null,
    createdAt: new Date().toISOString(),
    lastLogin: new Date().toISOString(),
  };
  await userRef.set(userData);
  await db.collection("users").doc(userId).set(userData);
  return userData;
}
