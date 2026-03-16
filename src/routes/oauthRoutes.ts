import { Router, Request, Response } from "express";

const router = Router();

function param(req: Request, key: string): string {
  const raw = Array.isArray(req.query[key]) ? req.query[key][0] : req.query[key];
  return String(raw ?? "").trim();
}

router.get("/start", (req: Request, res: Response): void => {
  const service = param(req, "service").toLowerCase();
  if (service !== "github") {
    res.status(400).json({ error: "Unsupported OAuth service. Use service=github" });
    return;
  }
  const redirectTo = param(req, "redirectTo");
  const target = new URL("/api/auth/github/start", `${req.protocol}://${req.get("host")}`);
  if (redirectTo) target.searchParams.set("redirectTo", redirectTo);
  res.redirect(target.toString());
});

router.get("/callback", (req: Request, res: Response): void => {
  const service = param(req, "service").toLowerCase();
  if (service !== "github") {
    res.status(400).json({ error: "Unsupported OAuth service. Use service=github" });
    return;
  }

  const code = param(req, "code");
  const state = param(req, "state");
  const target = new URL("/api/auth/github/callback", `${req.protocol}://${req.get("host")}`);
  if (code) target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  res.redirect(target.toString());
});

export default router;
