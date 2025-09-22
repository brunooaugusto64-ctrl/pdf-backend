// src/services/openai.ts
import OpenAI from 'openai'

let _client: OpenAI | null = null
function getClient() {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY ausente no .env')
  if (!_client) _client = new OpenAI({ apiKey: key })
  return _client
}

export type AnalysisResult = {
  titulo?: string
  autores?: string[]
  palavras_chave?: string[]
  resumo?: string
  conclusao?: string
  doi?: string
  pdf_link?: string
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

function tryParseJsonLoose(s: string): any {
  try { return JSON.parse(s) } catch {}
  const m = s.match(/\{[\s\S]*\}$/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return {}
}

export async function analyzeTextToJSON(
  text: string,
  filename: string,
  pdfLink?: string
): Promise<AnalysisResult> {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  const snippet = cleaned.slice(0, 6000)

  const schemaHint = `
Devolva APENAS um JSON válido e nada mais, com o seguinte formato:
{
  "titulo": string,
  "autores": string[],
  "palavras_chave": string[],
  "resumo": string,
  "conclusao": string,
  "doi": string,
  "pdf_link": string
}
- "resumo": até 150 palavras.
- Preencha "pdf_link" com o valor fornecido no contexto; se não houver, devolva "".
`.trim()

  const user = `
Arquivo: ${filename}
Link (se houver): ${pdfLink || ''}
Texto (parcial):
${snippet}
`.trim()

  const client = getClient()
  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Você é um extrator que retorna somente JSON válido.' },
      { role: 'user', content: schemaHint },
      { role: 'user', content: user },
    ],
  })

  const raw = (resp.choices?.[0]?.message?.content || '').trim()
  console.log('[openai] resposta (200 chars):', raw.slice(0, 200))

  const parsed = tryParseJsonLoose(raw) as AnalysisResult
  // garantia extra: se a IA não preencher, nós garantimos o campo
  if (pdfLink && !parsed.pdf_link) parsed.pdf_link = pdfLink
  return parsed
}
