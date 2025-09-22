// src/server.ts
import { config } from "dotenv";
config({ override: true });

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import msAuthRouter from "./services/msauth";
import { notionRouter } from "./services/notion";
import excelRouter from "./services/excel";          // default = watcher stateless (serverless)
import uploadRouter from "./routes/upload";

// ===================== ENV & PATCH =====================
const {
  PORT = "3333",
  FRONTEND_URL = "http://localhost:3333", // ajuste na Vercel para seu Framer/domínio
} = process.env;

// Normaliza APP_BASE_URL sem barra no final
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");

// Patch do redirect MS baseado no domínio público (Vercel) ou local
if (APP_BASE_URL) {
  process.env.MS_REDIRECT_URI = `${APP_BASE_URL}/auth/ms/callback`;
  console.log("[ENV PATCH] MS_REDIRECT_URI =", process.env.MS_REDIRECT_URI);
}
if (APP_BASE_URL) {
  console.log("[ENV] APP_BASE_URL =", APP_BASE_URL);
}

// ===================== APP =====================
const app = express();
app.set("trust proxy", 1); // necessário atrás de proxy (Vercel) para cookies "secure"

app.use(cookieParser());
app.use(express.json({ limit: "25mb" }));

// CORS — em prod, deixe sempre o domínio exato do seu front
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
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

// (opcional) raiz
app.get("/", (_req, res) =>
  res.json({ ok: true, name: "PaperMind API", ts: new Date().toISOString() })
);

// ===================== ROTAS =====================
mount("/auth/ms", msAuthRouter);
mount("/notion", notionRouter);
mount("/excel", excelRouter);     // watcher stateless (POST /excel/watch/tick etc.)
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
