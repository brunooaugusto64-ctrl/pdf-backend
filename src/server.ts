// src/server.ts
import { config } from "dotenv";
config({ override: true });

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import msAuthRouter from "./services/msauth";
import { notionRouter } from "./services/notion";
import excelRouter from "./services/excel"; // watcher stateless (serverless)
import uploadRouter from "./routes/upload";

// ===================== ENV & PATCH =====================
const {
  PORT = "3333",
  FRONTEND_URL = "http://localhost:3333", // ajuste em Settings (Vercel) p/ seu Framer/domínio
} = process.env;

// Normaliza APP_BASE_URL sem barra no final
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");

// Monta o redirect da Microsoft baseado no domínio público (Vercel) ou local
if (APP_BASE_URL) {
  process.env.MS_REDIRECT_URI = `${APP_BASE_URL}/auth/ms/callback`;
  console.log("[ENV PATCH] MS_REDIRECT_URI =", process.env.MS_REDIRECT_URI);
  console.log("[ENV] APP_BASE_URL =", APP_BASE_URL);
}

// ===================== APP =====================
const app = express();
app.set("trust proxy", 1); // necessário atrás de proxy (Vercel) para cookies "secure"

app.use(cookieParser());
app.use(express.json({ limit: "25mb" }));

// CORS — permite apenas o FRONTEND_URL e (se quiser) o próprio APP_BASE_URL
const allowedOrigins = [FRONTEND_URL, APP_BASE_URL].filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      // sem origin (ex.: curl/postman/health) -> permite
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      // opcional: log pra depurar CORS
      console.warn("[CORS] Bloqueado origin:", origin);
      return cb(null, false);
    },
    credentials: true,
    optionsSuccessStatus: 204,
  })
);

// Helper de mount com log
function mount(path: string, router: any) {
  app.use(path, router);
  console.log(`[Mount] ${path}`);
}

// Health simples
app.get("/health", (_req, res) =>
  res.json({ ok: true, env: process.env.NODE_ENV || "development" })
);

// Raiz (opcional)
app.get("/", (_req, res) =>
  res.json({ ok: true, name: "PaperMind API", ts: new Date().toISOString() })
);

// ===================== ROTAS =====================
mount("/auth/ms", msAuthRouter);
mount("/notion", notionRouter);
mount("/excel", excelRouter); // POST /excel/watch/tick etc.
mount("/upload", uploadRouter);

// ===================== EXPORT p/ Vercel =====================
export default app;

// ===================== START LOCAL (não roda na Vercel) =====================
if (!process.env.VERCEL) {
  app.listen(Number(PORT), () => {
    console.log(`✅ PaperMind API rodando em http://localhost:${PORT}`);
    console.log(`CORS liberado para: ${FRONTEND_URL}`);
  });
}
