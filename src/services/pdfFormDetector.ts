import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  classifyPageFormFields,
  extractVectorsWithCtm,
  type PageRasterProvider,
  type PdfJsOpsMap,
  type PdfTextToken,
} from '../../shared/pdfFormClassifier';
import type { UpsertFieldInput } from '../../shared/types';

export interface DetectPdfFieldsOptions {
  documentId: string;
  pdfBytes: Uint8Array;
  onProgress?: (currentPage: number, totalPages: number) => void;
  /**
   * Optional injectable 150 DPI grayscale raster provider (used in headless/Node environments).
   * When omitted in browser/Electron renderer, an offscreen HTML5 <canvas> at 150 DPI is used.
   */
  rasterProviderFactory?: (
    pageNumber: number,
    pageWidthPt: number,
    pageHeightPt: number,
  ) => Promise<PageRasterProvider | null>;
}

export interface DetectPdfFieldsResult {
  fields: UpsertFieldInput[];
  pageCount: number;
}

class CanvasRasterProvider implements PageRasterProvider {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pageWidthPt: number;
  readonly pageHeightPt: number;
  private readonly data: Uint8ClampedArray;

  constructor(
    imageData: ImageData,
    pageWidthPt: number,
    pageHeightPt: number,
  ) {
    this.widthPx = imageData.width;
    this.heightPx = imageData.height;
    this.pageWidthPt = pageWidthPt;
    this.pageHeightPt = pageHeightPt;
    this.data = imageData.data;
  }

  getGrayscale(px: number, py: number): number {
    const cx = Math.max(0, Math.min(this.widthPx - 1, px | 0));
    const cy = Math.max(0, Math.min(this.heightPx - 1, py | 0));
    const idx = (cy * this.widthPx + cx) * 4;
    return Math.round(
      0.299 * this.data[idx] + 0.587 * this.data[idx + 1] + 0.114 * this.data[idx + 2],
    );
  }
}

/**
 * Splits a pdfjs-dist text item into word/symbol tokens with accurate proportional top-down bounds,
 * isolating Unicode checkboxes (`☐`, `□`, `▢`) as well as inline dash (`----`) and underscore (`____`) runs
 * while keeping currency `$` and date masks like `/2026` intact.
 */
function splitTextItemIntoTokens(
  rawStr: string,
  x0: number,
  y0: number,
  totalWidth: number,
  height: number,
  fontSize: number,
  pageWidthPt: number,
  pageHeightPt: number,
): PdfTextToken[] {
  if (!rawStr || rawStr.trim().length === 0) return [];
  const len = rawStr.length;
  if (len === 0 || totalWidth <= 0) return [];

  const tokens: PdfTextToken[] = [];
  const regex = /[☐□▢]|[-–—]{3,}|_{3,}|[^\s☐□▢]+/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(rawStr)) !== null) {
    const piece = match[0];
    const startRatio = match.index / len;
    const endRatio = (match.index + piece.length) / len;
    const rawTx0 = x0 + totalWidth * startRatio;
    const rawTx1 = Math.max(rawTx0 + 2, x0 + totalWidth * endRatio);
    const tx0 = Math.max(0, Math.min(pageWidthPt, rawTx0));
    const tx1 = Math.max(tx0 + 1, Math.min(pageWidthPt, rawTx1));
    const ty0 = Math.max(0, Math.min(pageHeightPt, y0));
    const ty1 = Math.max(ty0 + 4, Math.min(pageHeightPt, y0 + Math.max(6, height)));

    tokens.push({
      text: piece,
      x0: tx0,
      y0: ty0,
      x1: tx1,
      y1: ty1,
      fontSize,
    });
  }

  return tokens;
}

/**
 * Phase 1 & 2 Renderer Pipeline:
 * Executes 3-layer hybrid extraction (Text + CTM Vectors/XObjects + 150 DPI Grayscale Raster)
 * across every page of a static PDF, normalizes all coordinates to top-down `(x0, y0, x1, y1)`
 * respecting real MediaBox/CropBox offsets, and returns classified AcroForm fields.
 */
export async function detectStaticPdfFormFields(
  options: DetectPdfFieldsOptions,
): Promise<DetectPdfFieldsResult> {
  const { documentId, pdfBytes, onProgress, rasterProviderFactory } = options;
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true,
    verbosity: 0,
  });

  const allFields: UpsertFieldInput[] = [];
  const usedFieldNames = new Set<string>();

  try {
    const pdfDoc = await loadingTask.promise;
    const totalPages = Math.max(1, pdfDoc.numPages);
    const rasterScale = 150 / 72; // 150 DPI grayscale layer

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      onProgress?.(pageNumber, totalPages);

      const page = await pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const pageWidthPt = viewport.width;
      const pageHeightPt = viewport.height;

      const viewBox = page.view ?? [0, 0, pageWidthPt, pageHeightPt];
      const cropX = viewBox[0] ?? 0;
      const cropY = viewBox[1] ?? 0;

      // Layer 1: Text tokens with exact top-down bounding boxes via viewport.transform
      const textContent = await page.getTextContent();
      const tokens: PdfTextToken[] = [];

      for (const rawItem of textContent.items) {
        if (!('str' in rawItem) || !rawItem.str || rawItem.str.trim().length === 0) continue;
        const tx = pdfjs.Util.transform(viewport.transform, rawItem.transform);
        const fontHeight = Math.max(6, Math.hypot(tx[2], tx[3]) || Math.abs(rawItem.height) || 10);
        const itemWidth = Math.max(
          4,
          Math.abs(rawItem.width) > 0 ? Math.abs(rawItem.width) : rawItem.str.length * fontHeight * 0.5,
        );
        const x0 = tx[4];
        const baselineY = tx[5];
        const y0 = baselineY - fontHeight * 0.85;

        const split = splitTextItemIntoTokens(
          rawItem.str,
          x0,
          y0,
          itemWidth,
          fontHeight,
          fontHeight,
          pageWidthPt,
          pageHeightPt,
        );
        tokens.push(...split);
      }

      // Layer 2: Vector instructions (paths, rects, Form/Image XObjects) with real 2D affine CTM stack
      const opList = await page.getOperatorList();
      const vectors = extractVectorsWithCtm(
        opList,
        pdfjs.OPS as unknown as PdfJsOpsMap,
        pageWidthPt,
        pageHeightPt,
        cropX,
        cropY,
      );

      // Layer 3: 150 DPI grayscale raster provider (injectable or offscreen HTML5 <canvas>)
      let rasterProvider: PageRasterProvider | null = null;
      if (rasterProviderFactory) {
        rasterProvider = await rasterProviderFactory(pageNumber, pageWidthPt, pageHeightPt);
      } else if (typeof document !== 'undefined') {
        const renderViewport = page.getViewport({ scale: rasterScale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(renderViewport.width));
        canvas.height = Math.max(1, Math.round(renderViewport.height));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({
            canvas,
            canvasContext: ctx,
            viewport: renderViewport,
          }).promise;
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          rasterProvider = new CanvasRasterProvider(imageData, pageWidthPt, pageHeightPt);
        }
        // Release GPU/bitmap backing buffer immediately on multi-page PDFs
        canvas.width = 0;
        canvas.height = 0;
      }

      const pageFields = classifyPageFormFields(
        {
          documentId,
          pageNumber,
          pageWidthPt,
          pageHeightPt,
          tokens,
          vectors,
          raster: rasterProvider,
        },
        usedFieldNames,
      );

      allFields.push(...pageFields);
    }

    return {
      fields: allFields,
      pageCount: totalPages,
    };
  } finally {
    await loadingTask.destroy();
  }
}
