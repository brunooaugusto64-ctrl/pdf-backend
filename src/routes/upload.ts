// src/routes/upload.ts
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import { extractTextFromPDF } from "../services/pdf"; // <-- caminho correto

const router = express.Router();

// Limite por .env (fallback 25MB)
const MAX_MB = Number(process.env.MAX_PDF_MB || 25);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ ok: false, error: "Arquivo ausente (campo 'file')." });
    }
    if (req.file.mimetype !== "application/pdf") {
      return res
        .status(400)
        .json({ ok: false, error: "Envie um PDF (content-type application/pdf)." });
    }

    // 1) extrai texto do PDF
    const text = await extractTextFromPDF(req.file.buffer);

    // 2) pede análise para a OpenAI (JSON estruturado)
    const prompt = `
Você recebe o texto (possivelmente parcial) de um artigo científico.
Extraia um JSON com as chaves EXATAS:
"title": string,
"authors": string[],
"keywords": string[],
"abstract": string,
"conclusion": string.
Se faltar info, deixe "" ou [] sem inventar.

Texto:
"""${text.slice(0, 12000)}"""
`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const raw = resp.choices[0]?.message?.content ?? "{}";
    let data: any = {};
    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }

    return res.json({
      ok: true,
      filename: req.file.originalname,
      bytes: req.file.size,
      data: {
        title: String(data.title ?? ""),
        authors: Array.isArray(data.authors) ? data.authors.map(String) : [],
        keywords: Array.isArray(data.keywords) ? data.keywords.map(String) : [],
        abstract: String(data.abstract ?? ""),
        conclusion: String(data.conclusion ?? ""),
      },
    });
  } catch (err: any) {
    console.error("[/upload] error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "Erro interno" });
  }
});

export default router;
