import admin from "firebase-admin";
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

export interface UserInfo {
  uid: string;
  email: string;
  name: string;
  picture: string | null;
}

export async function verifyGoogleCredential(credential: string): Promise<UserInfo> {
  if (!admin.apps.length) throw new Error("Firebase Admin not initialized.");
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
