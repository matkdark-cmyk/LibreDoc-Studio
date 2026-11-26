import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { buildAcroFormPdf } from '../../shared/acroFormBuilder';
import type { DocumentField, PrintRenderedPage } from '../../shared/types';

export interface PageRangeParseResult {
  valid: boolean;
  pages: number[];
  error?: string;
}

/**
 * Parses a human-friendly page range string such as "1-3, 5, 7-9" into a sorted,
 * deduplicated list of 1-based page numbers bounded by [1, totalPages].
 */
export function parsePageRange(input: string, totalPages: number): PageRangeParseResult {
  const safeTotal = Math.max(1, Math.floor(totalPages));
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      valid: false,
      pages: [],
      error: `Ingresa al menos una página o rango (ej. 1-${Math.min(3, safeTotal)}).`,
    };
  }

  const pageSet = new Set<number>();
  const parts = trimmed.split(',');

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;

    if (part.includes('-')) {
      const bounds = part.split('-').map((s) => s.trim());
      if (bounds.length !== 2 || !/^\d+$/.test(bounds[0]) || !/^\d+$/.test(bounds[1])) {
        return {
          valid: false,
          pages: [],
          error: `Rango inválido "${part}". Usa el formato 1-3, 5.`,
        };
      }
      const start = Number.parseInt(bounds[0], 10);
      const end = Number.parseInt(bounds[1], 10);
      if (start < 1 || end < 1 || start > safeTotal || end > safeTotal || start > end) {
        return {
          valid: false,
          pages: [],
          error: `El rango "${part}" está fuera de las páginas disponibles (1 a ${safeTotal}).`,
        };
      }
      for (let p = start; p <= end; p++) {
        pageSet.add(p);
      }
    } else {
      if (!/^\d+$/.test(part)) {
        return {
          valid: false,
          pages: [],
          error: `Número de página inválido "${part}".`,
        };
      }
      const num = Number.parseInt(part, 10);
      if (num < 1 || num > safeTotal) {
        return {
          valid: false,
          pages: [],
          error: `La página ${num} está fuera de rango (1 a ${safeTotal}).`,
        };
      }
      pageSet.add(num);
    }
  }

  const sorted = Array.from(pageSet).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      valid: false,
      pages: [],
      error: 'No se seleccionó ninguna página válida.',
    };
  }

  return { valid: true, pages: sorted };
}

export interface RenderPdfForPrintInput {
  pdfBytes: Uint8Array;
  fields?: DocumentField[];
  pageNumbers: number[];
  onProgress?: (renderedCount: number, totalCount: number) => void;
}

/**
 * Produces high-resolution print-ready page images from a PDF.
 * When edited AcroForm fields are provided, bakes all text values, checkmarks,
 * and masked dashes into the PDF via buildAcroFormPdf before rasterizing at crisp print DPI.
 */
export async function renderPdfPagesForPrint(
  input: RenderPdfForPrintInput,
): Promise<PrintRenderedPage[]> {
  const { pdfBytes, fields, pageNumbers, onProgress } = input;

  let sourceBytes = new Uint8Array(pdfBytes);
  if (fields && fields.length > 0) {
    const built = await buildAcroFormPdf({
      originalPdfBytes: sourceBytes,
      fields,
    });
    sourceBytes = new Uint8Array(built.pdfBytes);
  }

  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }

  const loadingTask = pdfjs.getDocument({
    data: sourceBytes,
    useSystemFonts: true,
    verbosity: 0,
  });

  try {
    const pdfDoc = await loadingTask.promise;
    const totalDocPages = Math.max(1, pdfDoc.numPages);
    const validPages = pageNumbers.filter((p) => p >= 1 && p <= totalDocPages);
    const targetPages =
      validPages.length > 0
        ? validPages
        : Array.from({ length: totalDocPages }, (_, idx) => idx + 1);

    const results: PrintRenderedPage[] = [];
    const printScale = 2.75; // ~198 DPI crisp print output while staying fast over IPC

    for (let i = 0; i < targetPages.length; i++) {
      const pageNum = targetPages[i];
      const page = await pdfDoc.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: printScale });

      const canvas = window.document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        throw new Error('No se pudo inicializar el lienzo 2D para preparar la impresión.');
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        intent: 'print',
        annotationMode: 1, // AnnotationMode.ENABLE -> renders /AP text & vector checkmarks cleanly
      }).promise;

      const dataUrl = canvas.toDataURL('image/jpeg', 0.96);
      canvas.width = 0;
      canvas.height = 0;

      results.push({
        pageNumber: pageNum,
        dataUrl,
        widthPt: baseViewport.width,
        heightPt: baseViewport.height,
      });

      onProgress?.(i + 1, targetPages.length);
    }

    return results;
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Converts an uploaded image file (PNG/JPG) into a single PrintRenderedPage.
 */
export async function renderImageBytesForPrint(
  bytes: Uint8Array,
  fileType: string,
): Promise<PrintRenderedPage[]> {
  const mime = fileType.toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('No se pudo leer la imagen para impresión.'));
    reader.readAsDataURL(blob);
  });

  return [
    {
      pageNumber: 1,
      dataUrl,
      widthPt: 612,
      heightPt: 792,
    },
  ];
}
