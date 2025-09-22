// src/services/msauth.ts
import { config } from "dotenv";
config({ override: true });

import express, { Request, Response } from "express";

/**
 * ENVs:
 *  - MS_CLIENT_ID
 *  - MS_CLIENT_SECRET
 *  - MS_TENANT (default: common)
 *  - MS_REDIRECT_URI (ex.: https://SEU_DOMINIO/auth/ms/callback)
 *  - FRONTEND_URL (ex.: https://seu-projeto.framer.app)
 *  - NODE_ENV (production | development)
 *
 * Node 18+ (fetch nativo).
 */

const AUTH_BASE = "https://login.microsoftonline.com";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me";

// Cookies
const CK_STATE = "ms_oauth_state";
const CK_AT = "ms_access_token";
const CK_RT = "ms_refresh_token";
const CK_SCOPE = "ms_scope";

// ---------------- ENV utils ----------------
function getEnv() {
  return {
    MS_CLIENT_ID: process.env.MS_CLIENT_ID ?? "",
    MS_CLIENT_SECRET: process.env.MS_CLIENT_SECRET ?? "",
    MS_TENANT: process.env.MS_TENANT ?? "common",
    MS_REDIRECT_URI: process.env.MS_REDIRECT_URI ?? "",
    FRONTEND_URL: process.env.FRONTEND_URL ?? "http://localhost:3333",
    NODE_ENV: process.env.NODE_ENV ?? "development",
  };
}
function requireEnvOrThrow() {
  const e = getEnv();
  const missing: string[] = [];
  if (!e.MS_CLIENT_ID) missing.push("MS_CLIENT_ID");
  if (!e.MS_CLIENT_SECRET) missing.push("MS_CLIENT_SECRET");
  if (!e.MS_REDIRECT_URI) missing.push("MS_REDIRECT_URI");
  if (missing.length) {
    console.error("[MS Auth] Faltando env:", missing.join(", "));
  }
  return e;
}
function hostsAreDifferent(a?: string, b?: string) {
  try {
    const A = new URL(String(a));
    const B = new URL(String(b));
    return A.hostname !== B.hostname;
  } catch {
    return true; // se não conseguir parsear, trate como cross-site
  }
}

/**
 * Cookies prontos para produção:
 * - Se front e back tiverem hosts diferentes (ex.: Framer ↔ Vercel),
 *   usa SameSite=None + Secure (requisito dos browsers).
 * - Em dev/localhost, mantém Lax.
 */
function cookieFlags(opts?: { httpOnly?: boolean }) {
  const { NODE_ENV, FRONTEND_URL, MS_REDIRECT_URI } = getEnv();
  const prod = NODE_ENV === "production";
  const crossSite = hostsAreDifferent(FRONTEND_URL, MS_REDIRECT_URI);
  const sameSite = prod && crossSite ? ("none" as const) : ("lax" as const);

  // Browsers exigem Secure quando SameSite=None
  const secure = sameSite === "none" ? true : prod;

  return {
    httpOnly: opts?.httpOnly ?? true,
    secure,
    sameSite,
    path: "/",
    // maxAge: 60 * 60 * 24 * 7, // opcional: 7 dias
  } as const;
}

// ---------------- OAuth helpers ----------------
type PromptMode = "select_account" | "login" | "consent";
function resolvePrompt(req: Request): PromptMode {
  const p = String(req.query.prompt ?? "").toLowerCase();
  if (p === "login" || p === "consent" || p === "select_account") return p as PromptMode;
  return "select_account";
}
function newState(): string {
  return "ms_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
function buildAuthUrl(promptMode: PromptMode, state: string) {
  const { MS_CLIENT_ID, MS_TENANT, MS_REDIRECT_URI } = getEnv();
  const SCOPES = [
    "openid",
    "profile",
    "offline_access",
    "User.Read",
    "Files.ReadWrite",
  ].join(" ");

  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: "code",
    response_mode: "query",
    redirect_uri: MS_REDIRECT_URI,
    scope: SCOPES,
    state,
    prompt: promptMode,
  });

  return {
    auth_url: `${AUTH_BASE}/${MS_TENANT}/oauth2/v2.0/authorize?${params}`,
    redirect_uri: MS_REDIRECT_URI,
    scopes: SCOPES,
    tenant: MS_TENANT,
    client_id: MS_CLIENT_ID,
    prompt: promptMode,
    state,
  };
}

// ---------------- Router ----------------
export const msAuthRouter = express.Router();

msAuthRouter.get("/ping", (_req, res) => {
  res.json({ ok: true, scope: "msauth" });
});

/** Inicia OAuth (força seletor por padrão) */
msAuthRouter.get("/login", (req: Request, res: Response) => {
  requireEnvOrThrow();
  const prompt = resolvePrompt(req);
  const state = newState();
  const payload = buildAuthUrl(prompt, state);

  // grava state (httpOnly)
  res.cookie(CK_STATE, state, cookieFlags({ httpOnly: true }));

  if (String(req.query.debug) === "1") {
    return res.json({ ok: true, note: "Abra `auth_url` no navegador.", ...payload });
  }
  return res.redirect(payload.auth_url);
});

/** Callback: troca code por tokens e grava cookies */
msAuthRouter.get("/callback", async (req: Request, res: Response) => {
  const { MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT, MS_REDIRECT_URI, FRONTEND_URL } =
    requireEnvOrThrow();
  const TOKEN_URL = `${AUTH_BASE}/${MS_TENANT}/oauth2/v2.0/token`;

  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const stateCookie = String((req as any).cookies?.[CK_STATE] || "");

  if (!code) return res.status(400).send("Missing code");
  if (!state || !stateCookie || state !== stateCookie) {
    res.clearCookie(CK_STATE, cookieFlags({ httpOnly: true }));
    return res.status(400).send("Invalid state");
  }

  try {
    const body = new URLSearchParams({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: MS_REDIRECT_URI,
    });

    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json: any = await r.json();

    if (!r.ok) {
      console.error("[MS Auth] token error:", json);
      return res.status(500).send("Token exchange failed");
    }

    // limpa state
    res.clearCookie(CK_STATE, cookieFlags({ httpOnly: true }));

    // grava tokens
    const base = cookieFlags({ httpOnly: true });
    res.cookie(CK_AT, json.access_token ?? "", base);
    res.cookie(CK_RT, json.refresh_token ?? "", base);
    // scope legível no front
    res.cookie(CK_SCOPE, json.scope ?? "", { ...cookieFlags({ httpOnly: false }) });

    // finaliza
    const html = `<!doctype html>
<html><body>
<h3>Conectado com sucesso ✅</h3>
<script>
  try { window.opener && window.opener.postMessage({ type: "msauth:success" }, "*"); } catch(e) {}
  setTimeout(()=>{ window.close(); }, 500);
  setTimeout(()=>{ window.location.href = ${JSON.stringify(FRONTEND_URL)}; }, 1200);
</script>
</body></html>`;
    return res.status(200).send(html);
  } catch (err: any) {
    console.error("[MS Auth] callback error:", err);
    return res.status(500).send("Callback processing failed");
  }
});

/** Status da sessão */
msAuthRouter.get("/status", (req: Request, res: Response) => {
  const at = (req as any).cookies?.[CK_AT] || "";
  const rt = (req as any).cookies?.[CK_RT] || "";
  const scope = (req as any).cookies?.[CK_SCOPE] || "";
  return res.json({
    ok: true,
    connected: Boolean(at),
    has_refresh: Boolean(rt),
    scope: scope || null,
  });
});

/** Perfil via cookie OU Authorization: Bearer */
msAuthRouter.get("/me", async (req: Request, res: Response) => {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const token = bearer || (req as any).cookies?.[CK_AT] || "";
  if (!token) return res.status(401).json({ ok: false, error: "missing_token" });

  const r = await fetch(GRAPH_ME, { headers: { Authorization: `Bearer ${token}` } });
  const json = await r.json();
  if (!r.ok) return res.status(r.status).json(json);
  return res.json(json);
});

/** Refresh do access_token usando refresh_token do cookie */
msAuthRouter.post("/refresh", async (req: Request, res: Response) => {
  const { MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT, MS_REDIRECT_URI } = requireEnvOrThrow();
  const TOKEN_URL = `${AUTH_BASE}/${MS_TENANT}/oauth2/v2.0/token`;

  const rt = (req as any).cookies?.[CK_RT] || "";
  if (!rt) return res.status(401).json({ ok: false, error: "missing_refresh_token" });

  try {
    const body = new URLSearchParams({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: rt,
      redirect_uri: MS_REDIRECT_URI,
    });

    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json: any = await r.json();

    if (!r.ok) {
      console.error("[MS Auth] refresh error:", json);
      return res.status(500).json({ ok: false, error: "refresh_failed", details: json });
    }

    const base = cookieFlags({ httpOnly: true });
    if (json.access_token) res.cookie(CK_AT, json.access_token, base);
    if (json.refresh_token) res.cookie(CK_RT, json.refresh_token, base);
    if (json.scope) res.cookie(CK_SCOPE, json.scope, { ...cookieFlags({ httpOnly: false }) });

    return res.json({ ok: true, refreshed: true });
  } catch (err: any) {
    console.error("[MS Auth] refresh exception:", err);
    return res.status(500).json({ ok: false, error: "refresh_exception" });
  }
});

/** Logout local (limpa cookies) */
msAuthRouter.post("/logout", (req: Request, res: Response) => {
  const baseHttpOnly = cookieFlags({ httpOnly: true });
  res.clearCookie(CK_STATE, baseHttpOnly);
  res.clearCookie(CK_AT, baseHttpOnly);
  res.clearCookie(CK_RT, baseHttpOnly);
  res.clearCookie(CK_SCOPE, { ...cookieFlags({ httpOnly: false }) });
  return res.json({ ok: true, logged_out: true });
});

export default msAuthRouter;
