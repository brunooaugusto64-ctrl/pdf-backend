// src/services/pdf.ts

/**
 * Extração de texto de PDF usando pdf-parse.
 * Exporta ambos os nomes para compatibilidade:
 *  - extractTextFromPDF
 *  - extractTextFromBuffer (alias)
 */

type PdfParse = (
  data: Buffer | Uint8Array,
  options?: any
) => Promise<{ text: string }>;

/* eslint-disable @typescript-eslint/no-var-requires */
// pdf-parse é CommonJS; usar require evita problemas com ts-node/ESM.
const pdfParse: PdfParse = require("pdf-parse");
/* eslint-enable @typescript-eslint/no-var-requires */

/** Normaliza espaços e quebras de linha. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Checagem simples do header para evitar parse em não-PDFs. */
function looksLikePDF(buf: Buffer | Uint8Array): boolean {
  // PDFs começam com "%PDF-"
  return (
    buf.length >= 5 &&
    String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4]) === "%PDF-"
  );
}

export async function extractTextFromPDF(
  buf: Buffer | Uint8Array
): Promise<string> {
  try {
    if (!looksLikePDF(buf)) {
      throw new Error("Arquivo não parece ser um PDF válido (header ausente).");
    }
    const { text } = await pdfParse(buf);
    return normalizeWhitespace(text ?? "");
  } catch (e: any) {
    const msg =
      e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
    throw new Error(`Falha ao extrair texto do PDF: ${msg}`);
  }
}

/** Alias para compatibilidade com código antigo. */
export async function extractTextFromBuffer(
  buf: Buffer | Uint8Array
): Promise<string> {
  return extractTextFromPDF(buf);
}
