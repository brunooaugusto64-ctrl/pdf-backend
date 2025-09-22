// src/types.ts
export type AnalysisData = {
  titulo?: string;
  autores?: string[] | string;
  palavras_chave?: string[] | string;
  resumo?: string;
  conclusao?: string;
  doi?: string;
  pdf_link?: string;
  link_final?: string; // preferir este
};

export type AnalyzeResponse = {
  filename: string;
  size: number;
  data: AnalysisData;
};
