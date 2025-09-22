// src/services/msLocal.ts
import express, { Request, Response } from 'express'
import multer from 'multer'
import * as XLSX from 'xlsx'
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_MB = Number(process.env.MAX_PDF_MB || 25)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
})

// Base local: ./storage
const LOCAL_BASE = path.resolve(process.cwd(), 'storage')

async function ensureDir(absPath: string) {
  await fs.mkdir(absPath, { recursive: true })
}

async function listDir(relPath = '') {
  const abs = path.join(LOCAL_BASE, relPath)
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true })
    return entries.map(e => ({
      name: e.name,
      folder: e.isDirectory(),
      file: !e.isDirectory(),
    }))
  } catch {
    return []
  }
}

// ===== XLSX helpers =====
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

// ===== EXPORTA O ROUTER (ESSENCIAL!) =====
export function msLocalRouter() {
  const router = express.Router()

  router.get('/ping', (_req, res) =>
    res.json({ ok: true, route: '/ms/ping', source: 'local' }),
  )

  // GET /ms/drive/list?path=PaperMind
  router.get('/drive/list', async (req: Request, res: Response) => {
    try {
      const rel = String(req.query.path || '')
      await ensureDir(path.join(LOCAL_BASE, rel))
      const value = await listDir(rel)
      return res.json({ ok: true, source: 'local', value })
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'list_failed' })
    }
  })

  // POST /ms/drive/upload?folder=PaperMind  (form-data: file=<arquivo>)
  router.post('/drive/upload', upload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: 'file_missing' })
      const folder = String(req.query.folder || 'PaperMind')
      await ensureDir(path.join(LOCAL_BASE, folder))
      const dest = path.join(LOCAL_BASE, folder, req.file.originalname || 'arquivo.bin')
      await fs.writeFile(dest, req.file.buffer)
      return res.json({ ok: true, source: 'local', path: `${folder}/${req.file.originalname}` })
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'upload_failed' })
    }
  })

  // POST /ms/excel/append  (JSON: {title, authors, keywords, summary, conclusion, pdfUrl})
  router.post('/excel/append', express.json(), async (req: Request, res: Response) => {
    try {
      const { title, authors, keywords, summary, conclusion, pdfUrl } = req.body || {}
      if (!title) return res.status(400).json({ ok: false, error: 'title_missing' })

      const folder = 'PaperMind'
      await ensureDir(path.join(LOCAL_BASE, folder))
      const excelFs = path.join(LOCAL_BASE, folder, 'papermind.xlsx')

      let fileBuf: Buffer
      try { fileBuf = await fs.readFile(excelFs) } catch { fileBuf = createInitialWorkbookBuffer() }

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
      await fs.writeFile(excelFs, updated)
      return res.json({ ok: true, source: 'local', excelPath: 'PaperMind/papermind.xlsx' })
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'excel_append_failed' })
    }
  })

  return router
}
