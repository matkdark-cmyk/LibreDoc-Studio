import type { RenderedPagePayload } from '../../shared/types';

function applyGrayscaleAndContrast(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  // Gentle contrast enhancement around midpoint 128 in grayscale to sharpen phone photos & scans
  const contrastFactor = 1.28;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const adjusted = Math.max(0, Math.min(255, (lum - 128) * contrastFactor + 128));
    data[i] = adjusted;
    data[i + 1] = adjusted;
    data[i + 2] = adjusted;
  }

  ctx.putImageData(imageData, 0, 0);
}

async function canvasToPngUint8Array(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    throw new Error('No se pudo exportar la página renderizada a PNG.');
  }
  const arrayBuf = await blob.arrayBuffer();
  return new Uint8Array(arrayBuf);
}

export async function renderPdfPagesForOcr(params: {
  pdfBytes: Uint8Array;
  enhanceContrast?: boolean;
  onPageProgress?: (currentPage: number, totalPages: number) => void;
}): Promise<RenderedPagePayload[]> {
  const { pdfBytes, enhanceContrast = true, onPageProgress } = params;
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
  }

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true,
    verbosity: 0,
  });

  const pdfDoc = await loadingTask.promise;
  const rendered: RenderedPagePayload[] = [];

  try {
    const totalPages = pdfDoc.numPages;

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      onPageProgress?.(pageNumber, totalPages);
      const page = await pdfDoc.getPage(pageNumber);

      const baseViewport = page.getViewport({ scale: 1 });
      // Target ~300 DPI (300 / 72 = 4.16) capped safely at max 2400px longest side for fast local OCR
      const maxEdge = Math.max(baseViewport.width, baseViewport.height);
      const targetScale = Math.min(3.5, Math.max(2.0, 2400 / Math.max(1, maxEdge)));
      const viewport = page.getViewport({ scale: targetScale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        throw new Error('No se pudo inicializar el contexto Canvas 2D para OCR.');
      }

      // Solid white background before rendering PDF page
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({
        canvas,
        canvasContext: ctx,
        viewport,
      }).promise;

      if (enhanceContrast) {
        applyGrayscaleAndContrast(ctx, canvas.width, canvas.height);
      }

      const pngBytes = await canvasToPngUint8Array(canvas);

      rendered.push({
        pageNumber,
        pngBytes,
        pdfWidthPt: baseViewport.width,
        pdfHeightPt: baseViewport.height,
        imageWidthPx: canvas.width,
        imageHeightPx: canvas.height,
      });

      // Release canvas memory promptly
      canvas.width = 0;
      canvas.height = 0;
    }

    return rendered;
  } finally {
    await loadingTask.destroy();
  }
}
