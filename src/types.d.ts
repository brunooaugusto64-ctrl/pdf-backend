declare module "pdf-parse" {
  export interface PDFData {
    numpages: number;
    numrender: number;
    info: any;
    metadata?: any;
    version: string;
    text: string;
  }
  const pdf: (data: Buffer | Uint8Array, options?: any) => Promise<PDFData>;
  export default pdf;
}
