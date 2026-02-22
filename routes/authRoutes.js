const express = require("express");
const { initFirebase } = require("../services/firebaseService");
const {
  verifyGoogleCredential,
  getOrCreateUser,
  createSessionToken,
} = require("../services/authService");
const verifyAuth = require("../middleware/authMiddleware");

const router = express.Router();

function setSessionCookie(res, sessionToken) {
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

router.post("/login", async (req, res) => {
  try {
    const { credential, idToken } = req.body;
    const token = credential || idToken;

    if (!token) {
      return res.status(400).json({ error: "credential (ID token) required" });
    }

    const db = await initFirebase();
    const userInfo = await verifyGoogleCredential(token);
    const user = await getOrCreateUser(userInfo, db);

    const sessionToken = createSessionToken(user.id);
    setSessionCookie(res, sessionToken);

    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(401).json({ error: "Login failed", message: error.message });
  }
});

router.get("/me", verifyAuth, async (req, res) => {
  try {
    const db = await initFirebase();
    const userId = req.userId;
    let user = null;
    const byId = await db.collection("users").doc(userId).get();
    if (byId.exists) {
      user = byId.data();
    }
    if (!user) {
      const snapshot = await db.collection("users").where("id", "==", userId).limit(1).get();
      if (!snapshot.empty) user = snapshot.docs[0].data();
    }
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("__Secure-auth-session", { path: "/" });
  res.clearCookie("auth-session", { path: "/" });
  res.json({ success: true });
});

module.exports = router;
