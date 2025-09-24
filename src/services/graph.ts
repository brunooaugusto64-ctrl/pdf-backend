// src/services/graph.ts
// Adapter que reexporta as funções com os nomes esperados pelo excel.ts

export type InboxItem = { id: string; name: string; webUrl?: string }

export {
  ensurePaperMindFolders,
  listInboxFirstPdf,
  downloadFileBuffer,
  moveFileToProcessed,
  moveFileToErrors,
} from "./msGraph"
