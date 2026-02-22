const { verifySessionToken } = require("../services/authService");

const allowAnonymous =
  process.env.ALLOW_ANONYMOUS_AGENT === "1" ||
  process.env.NODE_ENV === "development";

// Middleware to verify session cookie; in dev or with ALLOW_ANONYMOUS_AGENT=1, no session = anonymous
async function verifyAuth(req, res, next) {
  const sessionToken = req.cookies["__Secure-auth-session"] || req.cookies["auth-session"];

  if (!sessionToken) {
    if (allowAnonymous) {
      req.userId = "anonymous";
      return next();
    }
    return res.status(401).json({ error: "Unauthorized: No valid session" });
  }

  try {
    const decoded = verifySessionToken(sessionToken);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    if (allowAnonymous) {
      req.userId = "anonymous";
      return next();
    }
    console.error("Auth middleware error:", error.message);
    return res.status(401).json({ error: "Unauthorized: Invalid session" });
  }
}

module.exports = verifyAuth;
