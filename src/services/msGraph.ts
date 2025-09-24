/// <reference lib="dom" />
// src/services/msGraph.ts
import express, { Request, Response } from 'express'
import multer from 'multer'
import { Client } from '@microsoft/microsoft-graph-client'
import 'isomorphic-fetch'
import * as XLSX from 'xlsx'

/* ================= helpers: token & client ================= */

function getBearerToken(req: Request): string | null {
  const h = req.headers['authorization'] || ''
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim()

  const q = req.query as any
  if (typeof q.ms_token_dev === 'string') return q.ms_token_dev
  if (typeof q.token === 'string') return q.token

  if (typeof req.headers['x-ms-token'] === 'string') return String(req.headers['x-ms-token'])
  if (typeof (req.body || {}).token === 'string') return String((req.body as any).token)
  return null
}

function graphClientFromReq(req: Request) {
  const token = getBearerToken(req)
  if (!token) throw new Error('Faltou token (Authorization: Bearer ... | ?ms_token_dev=...)')
  return Client.init({ authProvider: (done) => done(null, token) })
}

/** ====== NOVO: client fora do ciclo da request (ex.: pipeline) ====== */
const { MS_GRAPH_TEST_TOKEN = '' } = process.env
function clientFromToken(token?: string) {
  const tk = (token || MS_GRAPH_TEST_TOKEN || '').trim()
  if (!tk) throw new Error('Faltou token do Microsoft Graph (MS_GRAPH_TEST_TOKEN ou parâmetro)')
  return Client.init({ authProvider: (done) => done(null, tk) })
}

/* ================= OneDrive ================= */

async function ensureFolder(client: Client, folderPath: string): Promise<{ id: string }> {
  try {
    const item = await client.api(`/me/drive/root:/${folderPath}`).get()
    return { id: item.id }
  } catch {
    const parts = folderPath.split('/').filter(Boolean)
    let parentId = 'root'
    let currentPath = ''
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      try {
        const item = await client.api(`/me/drive/root:/${currentPath}`).get()
        parentId = item.id
      } catch {
        const created = await client.api(`/me/drive/items/${parentId}/children`).post({
          name: part,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'rename',
        })
        parentId = created.id
      }
    }
    return { id: parentId }
  }
}

async function uploadLargeFile(
  client: Client,
  targetPath: string,
  buffer: Buffer,
  chunkSize = 2 * 1024 * 1024 // 2MB
) {
  const session = await client
    .api(`/me/drive/root:/${encodeURI(targetPath)}:/createUploadSession`)
    .post({
      item: {
        '@microsoft.graph.conflictBehavior': 'replace',
        name: targetPath.split('/').pop(),
      },
    })

  const uploadUrl: string = session.uploadUrl
  let start = 0
  let end = chunkSize - 1
  const total = buffer.length

  while (start < total) {
    if (end >= total) end = total - 1
    const contentLength = end - start + 1
    const chunk = buffer.subarray(start, end + 1)

    // >>> casts p/ calar o TS no Node (Buffer como BodyInit)
    const res = await fetch(uploadUrl as any, {
      method: 'PUT',
      headers: {
        'Content-Length': String(contentLength),
        'Content-Range': `bytes ${start}-${end}/${total}`,
      } as Record<string, string>,
      body: chunk as unknown as BodyInit,
    } as RequestInit)

    if (res.status === 201 || res.status === 200) return await res.json()
    if (res.status !== 202) throw new Error(`Falha no upload (${res.status}): ${await res.text()}`)
    start = end + 1
    end = start + chunkSize - 1
  }
}

/** Baixa um arquivo do OneDrive como Buffer (null se 404) */
async function downloadAsBuffer(client: Client, path: string): Promise<Buffer | null> {
  try {
    const stream: any = await client.api(`/me/drive/root:/${encodeURI(path)}:/content`).getStream()
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => resolve())
      stream.on('error', reject)
    })
    return Buffer.concat(chunks)
  } catch (e: any) {
    if (e?.statusCode === 404) return null
    throw e
  }
}

/** ====== NOVO: baixar por ID (para o pipeline) ====== */
async function downloadById(client: Client, fileId: string): Promise<Buffer> {
  const stream: any = await client.api(`/me/drive/items/${encodeURIComponent(fileId)}/content`).getStream()
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return Buffer.concat(chunks)
}

/* ================= Excel (XLSX em memória) ================= */

function createInitialWorkbookBuffer() {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([
    ['Title', 'Authors', 'Keywords', 'Summary', 'Conclusion', 'PdfUrl', 'CreatedAt'],
  ])
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer
}

function appendRowToWorkbookBuffer(existing: Buffer, row: any[]) {
  const wb = XLSX.read(existing, { type: 'buffer' })
  const sheetName = wb.SheetNames[0] || 'Sheet1'
  const ws = wb.Sheets[sheetName] || XLSX.utils.aoa_to_sheet([])
  XLSX.utils.sheet_add_aoa(ws, [row], { origin: -1 })
  wb.Sheets[sheetName] = ws
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer
}

/* ================= Router ================= */

export function msGraphRouter() {
  const router = express.Router()
  const maxMb = Number(process.env.MAX_PDF_MB || 25)
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024 },
  })

  router.get('/ping', (_req, res) => res.json({ ok: true, route: '/ms/ping' }))

  // lista raiz ou ?path=PaperMind
  router.get('/drive/list', async (req: Request, res: Response) => {
    try {
      const client = graphClientFromReq(req)
      const path = String(req.query.path || '')
      const api = path ? `/me/drive/root:/${encodeURI(path)}:/children` : `/me/drive/root/children`
      const r = await client.api(api).get()
      return res.json({ ok: true, value: r.value || r })
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'list_failed' })
    }
  })

  // upload multipart (campo "file"), opcional ?folder=PaperMind
  router.post('/drive/upload', upload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: 'file_missing' })

      const filename = req.file.originalname || 'arquivo.pdf'
      const folderName = String(req.query.folder || 'PaperMind')

      const client = graphClientFromReq(req)
      await ensureFolder(client, folderName)

      const targetPath = `${folderName}/${filename}`
      const item = await uploadLargeFile(client, targetPath, req.file.buffer)

      return res.json({ ok: true, path: targetPath, item })
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'upload_failed' })
    }
  })

  // body: { title, authors, keywords, summary, conclusion, pdfUrl }
  router.post('/excel/append', express.json(), async (req: Request, res: Response) => {
    try {
      const { title, authors, keywords, summary, conclusion, pdfUrl } = req.body || {}
      if (!title) return res.status(400).json({ ok: false, error: 'title_missing' })

      const client = graphClientFromReq(req)
      const folder = 'PaperMind'
      await ensureFolder(client, folder)

      const excelPath = `${folder}/papermind.xlsx`
      let fileBuf = await downloadAsBuffer(client, excelPath)
      if (!fileBuf) {
        fileBuf = createInitialWorkbookBuffer()
        await client.api(`/me/drive/root:/${encodeURI(excelPath)}:/content`).put(fileBuf)
      }

      const nowIso = new Date().toISOString()
      const row = [
        String(title || ''),
        Array.isArray(authors) ? authors.join('; ') : String(authors || ''),
        Array.isArray(keywords) ? keywords.join('; ') : String(keywords || ''),
        String(summary || ''),
        String(conclusion || ''),
        String(pdfUrl || ''),
        nowIso,
      ]

      const updated = appendRowToWorkbookBuffer(fileBuf, row)
      const saved = await client.api(`/me/drive/root:/${encodeURI(excelPath)}:/content`).put(updated)

      return res.json({ ok: true, excelPath, saved })
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'excel_append_failed' })
    }
  })

  return router
}

/* ========================================================================
 *                    EXPORTS PARA O PIPELINE (excel.ts)
 *  As funções abaixo são usadas pelo excel.ts e pelo adapter ./graph.ts
 * ===================================================================== */

export type InboxItem = { id: string; name: string; webUrl?: string }

// Garante PaperMind/Inbox, PaperMind/Processed e PaperMind/Erros
export async function ensurePaperMindFolders(token?: string): Promise<void> {
  const client = clientFromToken(token)
  await ensureFolder(client, 'PaperMind')
  await ensureFolder(client, 'PaperMind/Inbox')
  await ensureFolder(client, 'PaperMind/Processed')
  await ensureFolder(client, 'PaperMind/Erros')
}

// Lista o primeiro PDF em PaperMind/Inbox
export async function listInboxFirstPdf(token?: string): Promise<InboxItem | null> {
  const client = clientFromToken(token)
  await ensurePaperMindFolders(token)

  const resp = await client.api(`/me/drive/root:/PaperMind/Inbox:/children`).get()
  const items: any[] = resp?.value || []

  const pdf = items.find(
    (it) =>
      it?.file &&
      (it?.file?.mimeType === 'application/pdf' ||
        String(it?.name || '').toLowerCase().endsWith('.pdf'))
  )

  if (!pdf) return null
  return { id: String(pdf.id), name: String(pdf.name), webUrl: pdf.webUrl }
}

// Baixa pelo ID (Buffer)
export async function downloadFileBuffer(fileId: string, token?: string): Promise<Buffer> {
  const client = clientFromToken(token)
  return await downloadById(client, fileId)
}

// Move para Processed
export async function moveFileToProcessed(fileId: string, token?: string): Promise<void> {
  const client = clientFromToken(token)
  const dest = await client.api(`/me/drive/root:/PaperMind/Processed`).get()
  await client.api(`/me/drive/items/${encodeURIComponent(fileId)}`).patch({
    parentReference: { id: dest.id },
  })
}

// Move para Erros
export async function moveFileToErrors(fileId: string, token?: string): Promise<void> {
  const client = clientFromToken(token)
  const dest = await client.api(`/me/drive/root:/PaperMind/Erros`).get()
  await client.api(`/me/drive/items/${encodeURIComponent(fileId)}`).patch({
    parentReference: { id: dest.id },
  })
}
