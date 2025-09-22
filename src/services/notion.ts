// src/services/notion.ts
import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import fs from "fs";
import express, { Request, Response } from "express";
import { Client } from "@notionhq/client";
import { ensureSid, sessionGet, sessionMerge } from "./session";

// ─────────────────────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────────────────────
const ENV_PATH = resolve(process.cwd(), ".env"); // ajuste para resolve(__dirname, "../../.env") se necessário
loadEnv({ path: ENV_PATH, override: true });

console.log("[NOTION] dotenv path =", ENV_PATH, fs.existsSync(ENV_PATH) ? "OK" : "NOT FOUND");

const {
  NOTION_CLIENT_ID = "",
  NOTION_CLIENT_SECRET = "",
  NOTION_REDIRECT_URI = "",
  FRONTEND_URL = "https://technical-yard-407793.framer.app",
  NOTION_TOKEN = "",
  NOTION_DB_ID = "",
} = process.env;

console.log("[NOTION] NOTION_DB_ID =", NOTION_DB_ID || "(vazio)");

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const qs = (p: Record<string, string>) => new URLSearchParams(p).toString();

let lastNotionAccessToken: string | null = null;
export const getLastNotionToken = () => lastNotionAccessToken;

function getClient(): Client {
  const token = NOTION_TOKEN || lastNotionAccessToken;
  if (!token) {
    throw new Error("Token Notion ausente. Faça login em /notion/auth ou defina NOTION_TOKEN no .env.");
  }
  return new Client({ auth: token });
}

// cache simples do schema do DB para reduzir roundtrips
let _dbCache: any | null = null;
async function getDatabase(client: Client, id: string) {
  if (_dbCache) return _dbCache;
  _dbCache = await client.databases.retrieve({ database_id: id });
  return _dbCache;
}

// ─────────────────────────────────────────────────────────────
// Router (OAuth + Status)
// ─────────────────────────────────────────────────────────────
export const notionRouter = express.Router();

notionRouter.get("/", (_req, res) => res.json({ ok: true, router: "notion" }));

notionRouter.get("/auth", (req: Request, res: Response) => {
  const sid = ensureSid(req, res);
  const state = `notion_${sid}_${Math.random().toString(36).slice(2)}`;
  sessionMerge(sid, { state });

  const url =
    "https://api.notion.com/v1/oauth/authorize?" +
    qs({
      client_id: NOTION_CLIENT_ID,
      response_type: "code",
      owner: "user",
      redirect_uri: NOTION_REDIRECT_URI,
      state,
    });

  console.log("[Notion] redirect ->", url);
  res.redirect(url);
});

notionRouter.get("/callback", async (req: Request, res: Response) => {
  try {
    const sid = ensureSid(req, res);
    const sess = sessionGet(sid);
    const { code, state, error, error_description } = req.query as any;

    if (error || !code) {
      return res.redirect(
        `${FRONTEND_URL}?notion_ok=0&ms_desc=${encodeURIComponent(String(error_description || error || "login_failed"))}`
      );
    }
    if (!state || state !== sess.state) {
      return res.redirect(`${FRONTEND_URL}?notion_ok=0&ms_desc=${encodeURIComponent("invalid_state")}`);
    }

    const r = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${b64(`${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`)}`,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: NOTION_REDIRECT_URI,
      }),
    });

    const data = (await r.json()) as any;
    if (!r.ok) {
      return res.redirect(
        `${FRONTEND_URL}?notion_ok=0&ms_desc=${encodeURIComponent(JSON.stringify(data).slice(0, 400))}`
      );
    }

    lastNotionAccessToken = String(data.access_token);
    sessionMerge(sid, {
      notion: {
        access_token: lastNotionAccessToken,
        workspace_id: data.workspace_id,
        workspace_name: data.workspace_name,
        bot_id: data.bot_id,
      },
    });

    return res.redirect(`${FRONTEND_URL}?notion_ok=1`);
  } catch (e: any) {
    return res.redirect(`${FRONTEND_URL}?notion_ok=0&ms_desc=${encodeURIComponent(e?.message || "unexpected")}`);
  }
});

notionRouter.get("/status", (req: Request, res: Response) => {
  const sid = ensureSid(req, res);
  const sess = sessionGet(sid);
  res.json({
    ok: true,
    connected: Boolean(sess?.notion?.access_token || NOTION_TOKEN),
    workspace: sess?.notion?.workspace_name || null,
    hasDb: Boolean(NOTION_DB_ID),
    dbId: NOTION_DB_ID,
  });
});

// ─────────────────────────────────────────────────────────────
// Export para o Notion
// ─────────────────────────────────────────────────────────────
export type NotionMeta = {
  title: string;
  authors: string[];
  keywords: string[];
  abstract: string;
  conclusion: string;
  fileName: string;
  fileUrl?: string | null;
  references?: string[];
};

type DbMap = {
  titleProp: string;
  authorsProp: string | null;
  keywordsProp: string | null;
  abstractProp: string | null;
  conclusionProp: string | null;
  fileNameProp: string | null;
  fileUrlProp: string | null;
};

async function resolveDbMapping(client: Client, databaseId: string): Promise<DbMap> {
  const db = await getDatabase(client, databaseId);
  const props = db.properties as Record<string, any>;

  const findByType = (type: string) => Object.entries(props).find(([_, v]) => v?.type === type)?.[0] || null;

  const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const candidates = (want: string[]) => {
    const keys = Object.keys(props);
    const nk = keys.map((k) => [k, normalize(k)] as const);
    for (const w of want) {
      const hit = nk.find(([_, n]) => n === normalize(w));
      if (hit) return hit[0];
    }
    return null;
  };

  const titleProp = findByType("title");
  if (!titleProp) throw new Error("O database do Notion não possui uma propriedade de título (type=title).");

  const pick = (pref: string | null, type: string, orType?: string) => {
    if (pref && props[pref]?.type === type) return pref;
    if (orType && pref && props[pref]?.type === orType) return pref;
    const first = Object.entries(props).find(([_, v]) => v?.type === type)?.[0];
    if (first) return first;
    if (orType) {
      const alt = Object.entries(props).find(([_, v]) => v?.type === orType)?.[0];
      if (alt) return alt;
    }
    return null;
  };

  const authorsPref = candidates(["autores", "authors"]);
  const keywordsPref = candidates(["palavras-chave", "palavras chave", "keywords"]);
  const abstractPref = candidates(["resumo", "abstract"]);
  const conclusionPref = candidates(["conclusao", "conclusão", "conclusion"]);
  const fileNamePref = candidates(["arquivo", "filename", "file name"]);
  const fileUrlPref = candidates(["link", "url", "file url", "pdf"]);

  return {
    titleProp,
    authorsProp: pick(authorsPref, "multi_select", "rich_text"),
    keywordsProp: pick(keywordsPref, "multi_select", "rich_text"),
    abstractProp: pick(abstractPref, "rich_text"),
    conclusionProp: pick(conclusionPref, "rich_text"),
    fileNameProp: pick(fileNamePref, "rich_text"),
    fileUrlProp: pick(fileUrlPref, "url", "rich_text"),
  };
}

export async function exportToNotion(meta: NotionMeta) {
  if (!NOTION_DB_ID) throw new Error("Faltou NOTION_DB_ID no .env (id do database do Notion).");

  const client = getClient();
  const map = await resolveDbMapping(client, NOTION_DB_ID);
  const db = (await getDatabase(client, NOTION_DB_ID)) as any;

  const asTitle = (s: string) => [{ type: "text", text: { content: s || "" } }];
  const asRich = (s: string) => (s ? [{ type: "text", text: { content: s } }] : []);
  const toMulti = (arr: string[]) => (arr || []).slice(0, 50).map((v) => ({ name: v?.slice(0, 90) || "" }));

  const titleValue = meta.title || meta.fileName || "Sem título";

  const properties: Record<string, any> = {
    [map.titleProp]: { title: asTitle(titleValue) },
  };

  // authors
  if (map.authorsProp) {
    if (db.properties[map.authorsProp].type === "multi_select") {
      properties[map.authorsProp] = { multi_select: toMulti(meta.authors || []) };
    } else {
      properties[map.authorsProp] = { rich_text: asRich((meta.authors || []).join(", ")) };
    }
  }

  // keywords
  if (map.keywordsProp) {
    if (db.properties[map.keywordsProp].type === "multi_select") {
      properties[map.keywordsProp] = { multi_select: toMulti(meta.keywords || []) };
    } else {
      properties[map.keywordsProp] = { rich_text: asRich((meta.keywords || []).join(", ")) };
    }
  }

  if (map.abstractProp) properties[map.abstractProp] = { rich_text: asRich(meta.abstract || "") };
  if (map.conclusionProp) properties[map.conclusionProp] = { rich_text: asRich(meta.conclusion || "") };
  if (map.fileNameProp) properties[map.fileNameProp] = { rich_text: asRich(meta.fileName || "") };

  if (map.fileUrlProp) {
    const kind = db.properties[map.fileUrlProp]?.type;
    properties[map.fileUrlProp] = kind === "url" ? { url: meta.fileUrl || "" } : { rich_text: asRich(meta.fileUrl || "") };
  }

  // Fallback: apenas title no DB
  if (Object.keys(properties).length === 1) {
    const anyRich = Object.entries(db.properties).find(([, v]: any) => v?.type === "rich_text")?.[0];
    if (anyRich) {
      const blob = {
        title: meta.title,
        authors: meta.authors,
        keywords: meta.keywords,
        abstract: meta.abstract,
        conclusion: meta.conclusion,
        fileName: meta.fileName,
        fileUrl: meta.fileUrl || "",
        references: meta.references || [],
      };
      properties[anyRich] = { rich_text: asRich(JSON.stringify(blob)) };
    }
  }

  // cria página (propriedades)
  const page = await client.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties,
  });
  const pageId = (page as any).id;

  // garante título + ícone/cover
  await client.pages.update({
    page_id: pageId,
    properties: { [map.titleProp]: { title: asTitle(titleValue) } },
    icon: { type: "emoji", emoji: "📄" },
    cover: { type: "external", external: { url: "https://img.icons8.com/fluency/512/pdf-2.png" } },
  } as any);

  // corpo (layout)
  const children: any[] = [
    { heading_1: { rich_text: [{ type: "text", text: { content: titleValue } }] } },

    { heading_2: { rich_text: [{ type: "text", text: { content: "✍️ Autores" } }] } },
    ...(meta.authors || []).map((a) => ({ bulleted_list_item: { rich_text: [{ type: "text", text: { content: a } }] } })),

    { heading_2: { rich_text: [{ type: "text", text: { content: "🔖 Palavras-chave" } }] } },
    ...(meta.keywords || []).map((k) => ({ bulleted_list_item: { rich_text: [{ type: "text", text: { content: k } }] } })),
  ];

  if (meta.references?.length) {
    children.push({ heading_2: { rich_text: [{ type: "text", text: { content: "📚 Referências" } }] } });
    children.push(
      ...(meta.references || []).map((r) => ({
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: r } }] },
      }))
    );
  }

  children.push(
    { heading_2: { rich_text: [{ type: "text", text: { content: "🧠 Resumo" } }] } },
    { paragraph: { rich_text: [{ type: "text", text: { content: meta.abstract || "—" } }] } },
    { heading_2: { rich_text: [{ type: "text", text: { content: "🔚 Conclusão" } }] } },
    { paragraph: { rich_text: [{ type: "text", text: { content: meta.conclusion || "—" } }] } }
  );

  if (meta.fileUrl) {
    children.push({
      paragraph: {
        rich_text: [
          { type: "text", text: { content: "📎 PDF: " } },
          { type: "text", text: { content: meta.fileUrl, link: { url: meta.fileUrl } } },
        ],
      },
    });
  }

  await client.blocks.children.append({ block_id: pageId, children });

  return { ok: true, pageId, url: (page as any).url || null };
}

export default exportToNotion;
