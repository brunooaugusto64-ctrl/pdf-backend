// src/services/excel.ts
/**
 * Watcher stateless (compatível com Vercel Cron e com local dev):
 * - POST /excel/watch/tick  -> processa até BATCH_SIZE PDFs por chamada
 * - GET  /excel/watch/status
 * - POST /excel/watch/start|stop -> no-op em serverless (não quebra chamadas antigas)
 *
 * ENVs:
 *  - ONEDRIVE_ENTRADA_PATH=/Documentos/PaperMind/Entrada
 *  - ONEDRIVE_PROCESSADOS_PATH=/Documentos/PaperMind/Processados
 *  - BATCH_SIZE=2
 *  - OPENAI_API_KEY (opcional; sem ele usa fallback heurístico)
 */

import express, { Request, Response } from "express";

export const msGraphRouter = express.Router();
export const msLocalRouter = express.Router(); // compat

const {
  ONEDRIVE_ENTRADA_PATH = "/Documentos/PaperMind/Entrada",
  ONEDRIVE_PROCESSADOS_PATH = "/Documentos/PaperMind/Processados",
} = process.env;

const BATCH_SIZE = Math.min(Math.max(Number(process.env.BATCH_SIZE || "2"), 1), 5);

// =================== Utils/Graph ===================
function getAccessTokenFromCookies(req: Request): string | null {
  const at =
    (req as any).cookies?.ms_access_token ||
    (req.headers["x-ms-access-token"] as string) ||
    null;
  return at || null;
}

async function graph<T = any>(
  token: string,
  url: string,
  init?: any // evitar tipos DOM em Node
): Promise<{ ok: boolean; status: number; json?: T; text?: string; headers: any }> {
  const r = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  } as any);
  const headers: any = (r as any).headers;
  const ct = r.headers.get?.("content-type") || "";
  if (ct.includes("application/json")) {
    const j = (await r.json()) as T;
    return { ok: (r as any).ok, status: (r as any).status, json: j, headers };
  } else {
    const t = await r.text();
    return { ok: (r as any).ok, status: (r as any).status, text: t, headers };
  }
}

async function graphDownload(
  token: string,
  url: string
): Promise<{ ok: boolean; status: number; buffer?: Buffer; headers: any }> {
  const r: any = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  } as any);
  if (!r.ok) return { ok: false, status: r.status, headers: r.headers };
  const ab = await r.arrayBuffer();
  return { ok: true, status: r.status, buffer: Buffer.from(ab), headers: r.headers };
}

function joinDrivePath(p: string): string {
  return p.startsWith("/") ? p : `/${p}`;
}

function nowIso() {
  return new Date().toISOString();
}

// =================== PDF (backend Node, à prova de pacote) ===================
// Tenta pdfjs-dist (v4 .js, v2/v3 .js, v4 .mjs). Se não existir, usa pdf-parse.
let _pdfEngineLoaded = false;
let _usePdfJs = false;
let _pdfjsLib: any = null;
let _pdfParse: any = null;

async function loadPdfEngine() {
  if (_pdfEngineLoaded) return;
  // 1) pdfjs-dist v4 (legacy .js)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
    _usePdfJs = true;
  } catch {
    // 2) pdfjs-dist v2/v3 (build .js)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _pdfjsLib = require("pdfjs-dist/build/pdf.js");
      _usePdfJs = true;
    } catch {
      // 3) pdfjs-dist v4 ESM (.mjs)
      try {
        _pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
        _usePdfJs = true;
      } catch {
        // 4) Fallback: pdf-parse
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          _pdfParse = require("pdf-parse");
          _usePdfJs = false;
          console.warn("[pdf] usando fallback pdf-parse (instale pdfjs-dist para melhor controle)");
        } catch (e) {
          console.error(
            "[pdf] Nenhuma lib de PDF disponível. Instale uma das opções:\n" +
              "  npm i pdfjs-dist@^4   (recomendado)\n" +
              "  ou npm i pdf-parse    (fallback)"
          );
          throw e;
        }
      }
    }
  }

  if (_usePdfJs && _pdfjsLib) {
    _pdfjsLib.GlobalWorkerOptions = _pdfjsLib.GlobalWorkerOptions || {};
    _pdfjsLib.GlobalWorkerOptions.workerSrc = undefined; // sem worker no backend
  }

  _pdfEngineLoaded = true;
}

async function extractTextFromPdfBuffer(buf: Buffer): Promise<string> {
  await loadPdfEngine();

  if (_usePdfJs && _pdfjsLib) {
    const loadingTask = _pdfjsLib.getDocument({ data: buf });
    const pdf = await loadingTask.promise;
    let fullText = "";
    const maxPages = Math.min(pdf.numPages || 0, 50);
    for (let p = 1; p <= maxPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = (content.items || []) as any[];
      const text = items.map((it) => (it?.str ? String(it.str) : "")).join(" ");
      fullText += (fullText ? "\n" : "") + text;
    }
    await (pdf?.cleanup?.() ?? Promise.resolve());
    return fullText.trim();
  }

  if (_pdfParse) {
    const res = await _pdfParse(buf); // { text, numpages, ... }
    return String(res?.text || "").trim();
  }

  throw new Error("Nenhum motor de PDF disponível.");
}

// =================== GPT (metadados) ===================
type PaperMeta = {
  title: string;
  authors: string[];
  keywords: string[];
  abstract: string;
  conclusion: string;
  fileName: string;
  fileUrl?: string | null;
};

async function generateMetadata(text: string, fileName: string): Promise<PaperMeta> {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
  const base: PaperMeta = {
    title: "",
    authors: [],
    keywords: [],
    abstract: "",
    conclusion: "",
    fileName,
    fileUrl: null,
  };

  if (OPENAI_API_KEY) {
    try {
      const sys = `Você é um extrator de metadados acadêmicos. Responda em JSON estrito com as chaves: title, authors[], keywords[], abstract, conclusion.`;
      const user = `Arquivo: ${fileName}\nTexto (truncado):\n${text.slice(0, 8000)}`;

      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: sys },
            { role: "user", content: user },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        }),
      });

      const j: any = await r.json();
      const content = j?.choices?.[0]?.message?.content || "{}";
      const meta = JSON.parse(content);

      return {
        ...base,
        ...meta,
        title: String(meta.title || "").trim(),
        authors: Array.isArray(meta.authors) ? meta.authors : [],
        keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
        abstract: String(meta.abstract || "").trim(),
        conclusion: String(meta.conclusion || "").trim(),
      };
    } catch (e) {
      console.warn("[gpt] falha; usando heurística:", e);
    }
  }

  // fallback heurístico (sem LLM)
  const firstNonEmpty =
    text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)[0] || fileName.replace(/\.pdf$/i, "");

  return {
    ...base,
    title: firstNonEmpty.slice(0, 180),
    abstract: text.slice(0, 1200),
  };
}

// =================== Destinos (stubs com ganchos) ===================
async function saveToNotion(meta: PaperMeta): Promise<{ ok: boolean; id?: string }> {
  console.log("[notion] (stub) salvar:", meta.title);
  return { ok: true, id: "stub-notion-id" };
}

async function saveToExcel(meta: PaperMeta): Promise<{ ok: boolean }> {
  console.log("[excel] (stub) adicionar linha:", meta.title);
  return { ok: true };
}

// =================== Move item no OneDrive ===================
async function moveItemTo(
  token: string,
  itemId: string,
  targetFolderPath: string,
  newName?: string
) {
  const path = joinDrivePath(targetFolderPath);
  const url = `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}`;
  const body = {
    parentReference: { path: `/drive/root:${path}` },
    ...(newName ? { name: newName } : {}),
  };
  return graph(token, url, { method: "PATCH", body: JSON.stringify(body) });
}

// =================== Processar 1 PDF ===================
async function processOnePdfByItem(
  token: string,
  item: any
): Promise<{ ok: boolean; id?: string; title?: string; error?: string }> {
  try {
    const itemId = item.id as string;
    const name = item.name as string;

    const dlUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}/content`;
    const dl = await graphDownload(token, dlUrl);
    if (!dl.ok || !dl.buffer) {
      return { ok: false, error: `download_failed_${dl.status}` };
    }

    const text = await extractTextFromPdfBuffer(dl.buffer);
    const meta = await generateMetadata(text, name);

    await saveToNotion(meta).catch(() => null);
    await saveToExcel(meta).catch(() => null);

    return { ok: true, id: itemId, title: meta.title };
  } catch (e: any) {
    console.error("[processOnePdf] erro:", e?.message || e);
    return { ok: false, error: "exception" };
  }
}

// =================== Tick (batch por chamada) ===================
msGraphRouter.post("/watch/tick", async (req: Request, res: Response) => {
  const token = getAccessTokenFromCookies(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: "missing_ms_access_token_cookie" });
  }
  try {
    const entrada = joinDrivePath(ONEDRIVE_ENTRADA_PATH);
    const listUrl = `https://graph.microsoft.com/v1.0/me/drive/root:${encodeURI(
      entrada
    )}:/children?$top=50`;

    const listing = await graph<any>(token, listUrl, { method: "GET" });
    if (!listing.ok) {
      console.error("[tick] list falhou:", listing.status, listing.json || listing.text);
      return res.status(500).json({ ok: false, error: "list_failed" });
    }

    const files = (listing.json?.value || []).filter(
      (it: any) =>
        it.file && typeof it.name === "string" && it.name.toLowerCase().endsWith(".pdf")
    );

    if (!files.length) {
      return res.json({
        ok: true,
        processed: 0,
        found: 0,
        message: "Nenhum PDF na pasta de Entrada",
        when: nowIso(),
      });
    }

    const batch = files.slice(0, BATCH_SIZE);
    const results: any[] = [];
    for (const item of batch) {
      const move = await moveItemTo(token, item.id, ONEDRIVE_PROCESSADOS_PATH, item.name);
      if (!move.ok) {
        console.warn("[tick] move falhou para", item.name, move.status);
        results.push({ ok: false, file: item.name, step: "move" });
        continue;
      }
      const r = await processOnePdfByItem(token, item);
      results.push({ ...r, file: item.name });
    }

    const okCount = results.filter((r: any) => r.ok).length;
    return res.json({
      ok: true,
      found: files.length,
      processed: results.length,
      success: okCount,
      results,
      when: nowIso(),
    });
  } catch (e: any) {
    console.error("[tick] erro:", e?.message || e);
    return res.status(500).json({ ok: false, error: "tick_exception" });
  }
});

// =================== Rotas compat ===================
msGraphRouter.post("/watch/start", (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    mode: "serverless",
    note: "Use /excel/watch/tick (Cron). start é no-op em serverless.",
  });
});
msGraphRouter.get("/watch/status", (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    running: false,
    mode: "serverless",
    hint: "Configure Cron para POST /excel/watch/tick (*/1 * * * *).",
  });
});
msGraphRouter.post("/watch/stop", (_req: Request, res: Response) => {
  return res.json({ ok: true, stopped: true, mode: "serverless" });
});

// =================== Hook compat ===================
export async function autoStartOnMsConnect(_req: Request) {
  return; // sem loops em serverless
}

export default msGraphRouter;
