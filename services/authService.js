const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

function createSessionToken(userId) {
  const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || "dev-secret";
  return jwt.sign({ userId }, secret, { expiresIn: "7d" });
}

function verifySessionToken(token) {
  try {
    const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || "dev-secret";
    const decoded = jwt.verify(token, secret);
    return decoded;
  } catch (error) {
    throw new Error("Invalid session");
  }
}

async function verifyGoogleCredential(credential) {
  try {
    if (!admin.apps.length) {
      throw new Error("Firebase Admin not initialized.");
    }
    const decodedToken = await admin.auth().verifyIdToken(credential);
    return {
      uid: decodedToken.uid,
      email: normalizeEmail(decodedToken.email || ""),
      name: decodedToken.name || decodedToken.email || "User",
      picture: decodedToken.picture || null,
    };
  } catch (error) {
    console.error("Firebase ID token verification failed:", error.message);
    throw new Error(`Invalid credential: ${error.message}`);
  }
}

async function getOrCreateUser(userInfo, db) {
  const normalized = normalizeEmail(userInfo.email);
  const userRef = db.collection("users").doc(normalized);
  const userDoc = await userRef.get();
  
  if (userDoc.exists) {
    const d = userDoc.data();
    await userRef.update({ lastLogin: new Date().toISOString() });
    return { id: d.id, email: d.email, name: d.name, picture: d.picture };
  }
  
  const userId = uuidv4();
  const userData = {
    id: userId,
    email: normalized,
    name: userInfo.name || normalized.split("@")[0],
    picture: userInfo.picture || null,
    createdAt: new Date().toISOString(),
    lastLogin: new Date().toISOString(),
  };
  
  await userRef.set(userData);
  await db.collection("users").doc(userId).set(userData);
  return userData;
}

module.exports = {
  createSessionToken,
  verifySessionToken,
  verifyGoogleCredential,
  getOrCreateUser,
};
