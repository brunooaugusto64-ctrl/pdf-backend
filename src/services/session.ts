// src/services/session.ts
import type { Request, Response } from "express";
import crypto from "crypto";

/** ===== Tipos da sessão ===== */
export interface Sess {
  ms?: {
    access_token?: string;
    exp?: number;
    refresh_token?: string;

    // 👉 adicionados para resolver os erros:
    oauth_state?: string;
    token_type?: string;
    scope?: string;
  };
  notion?: {
    access_token?: string;
    workspace_id?: string;
    workspace_name?: string;
    bot_id?: string;
  };
  // usado no OAuth do Notion (state anti-CSRF)
  state?: string;
}

const STORE = new Map<string, Sess>();
const COOKIE_NAME = "sid";

/** Gera/garante o SID via cookie */
export function ensureSid(req: Request, res: Response): string {
  let sid = String((req.cookies && req.cookies[COOKIE_NAME]) || "");
  if (!sid) {
    sid = crypto.randomBytes(16).toString("hex");
    res.cookie(COOKIE_NAME, sid, {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // true em prod com HTTPS real
      path: "/",
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 dias
    });
  }
  if (!STORE.has(sid)) STORE.set(sid, {});
  return sid;
}

/** Lê a sessão (sempre retorna objeto) */
export function sessionGet(sid: string): Sess {
  return STORE.get(sid) || {};
}

/** Faz merge superficial + merge de objetos ms/notion */
export function sessionMerge(sid: string, patch: Partial<Sess>): Sess {
  const cur = STORE.get(sid) || {};
  const next: Sess = {
    ...cur,
    ...patch,
    ms: { ...(cur.ms || {}), ...(patch.ms || {}) },
    notion: { ...(cur.notion || {}), ...(patch.notion || {}) },
  };
  STORE.set(sid, next);
  return next;
}

/** (opcional) Zera tudo da sessão */
export function sessionClear(sid: string) {
  STORE.set(sid, {});
}
