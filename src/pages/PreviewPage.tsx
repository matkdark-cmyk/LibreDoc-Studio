import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import JSZip from 'jszip';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Columns2,
  FileEdit,
  FileText,
  Loader2,
  Maximize2,
  PanelLeft,
  Printer,
  RotateCw,
  ScrollText,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  DocumentRecord,
  PlainTextContentResult,
  PrintDocumentOptions,
  PrintRenderedPage,
  PrintResult,
  SessionState,
  SessionStatePatch,
  SystemPrinterInfo,
} from '../../shared/types';
import { SaveOrPrintModal } from '../components/SaveOrPrintModal';

interface PreviewPageProps {
  document: DocumentRecord | null;
  recentDocuments: DocumentRecord[];
  session: SessionState;
  isElectron: boolean;
  ingesting: boolean;
  onSelectDocumentForPreview: (documentId: string) => void;
  onPickFileForPreview: () => Promise<void>;
  onIngestFilesForPreview: (files: FileList) => Promise<void>;
  onOpenInEditor: (documentId: string) => void;
  onGoToWorkspace: () => void;
  onPatchSession: (patch: SessionStatePatch) => void;
  onListPrinters: () => Promise<SystemPrinterInfo[]>;
  onPrintRenderedDocument: (
    pages: PrintRenderedPage[],
    options: PrintDocumentOptions,
    documentTitle: string,
  ) => Promise<PrintResult>;
  onReadPlainText: (documentId: string) => Promise<PlainTextContentResult | null>;
  onReadWorkingFileBytes: (documentId: string) => Promise<Uint8Array | null>;
}

type ViewLayoutMode = 'continuous' | 'single';

interface PageSizePt {
  widthPt: number;
  heightPt: number;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const PDF_CSS_SCALE = 96 / 72;
const MAX_CANVAS_PIXELS = 16_000_000;

function computeCrispOutputScale(cssWidth: number, cssHeight: number): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const target = Math.min(3.5, Math.max(2, dpr * 2));
  const area = Math.max(1, cssWidth * cssHeight);
  const maxSafe = Math.sqrt(MAX_CANVAS_PIXELS / area);
  return Math.max(1, Math.min(target, maxSafe));
}

function extractParagraphsFromDocxXml(xml: string): string[] {
  const paragraphs: string[] = [];
  const pMatches = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];

  for (const pXml of pMatches) {
    const textMatches = pXml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g) ?? [];
    if (textMatches.length === 0) continue;
    const combined = textMatches
      .map((node) =>
        node
          .replace(/<w:t\b[^>]*>/, '')
          .replace(/<\/w:t>$/, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'"),
      )
      .join('')
      .trim();

    if (combined) {
      paragraphs.push(combined);
    }
  }

  return paragraphs;
}

interface PdfCanvasPageProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  rotation: number;
  baseSize: PageSizePt;
  scrollRoot: HTMLDivElement | null;
  eager?: boolean;
  onRegisterNode?: (pageNumber: number, node: HTMLDivElement | null) => void;
}

function PdfCanvasPage({
  pdfDoc,
  pageNumber,
  zoom,
  rotation,
  baseSize,
  scrollRoot,
  eager = false,
  onRegisterNode,
}: PdfCanvasPageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [shouldRender, setShouldRender] = useState(eager);
  const [rendered, setRendered] = useState(false);

  const effectiveScale = zoom * PDF_CSS_SCALE;
  const isSwapped = rotation % 180 !== 0;
  const effectiveW = Math.floor((isSwapped ? baseSize.heightPt : baseSize.widthPt) * effectiveScale);
  const effectiveH = Math.floor((isSwapped ? baseSize.widthPt : baseSize.heightPt) * effectiveScale);

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      onRegisterNode?.(pageNumber, node);
    },
    [onRegisterNode, pageNumber],
  );

  useEffect(() => {
    if (eager) {
      setShouldRender(true);
      return;
    }
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldRender(true);
        }
      },
      {
        root: scrollRoot,
        rootMargin: '450px 0px',
      },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [eager, scrollRoot]);

  useEffect(() => {
    if (!shouldRender) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;

    async function drawPage() {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;

        const cssViewport = page.getViewport({
          scale: effectiveScale,
          rotation: (page.rotate + rotation) % 360,
        });

        const cssWidth = Math.max(1, Math.floor(cssViewport.width));
        const cssHeight = Math.max(1, Math.floor(cssViewport.height));
        const outputScale = computeCrispOutputScale(cssWidth, cssHeight);

        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;

        canvas.width = Math.max(1, Math.floor(cssWidth * outputScale));
        canvas.height = Math.max(1, Math.floor(cssHeight * outputScale));

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const transform =
          outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

        const task = page.render({
          canvas,
          canvasContext: ctx,
          viewport: cssViewport,
          transform,
          intent: 'display',
        });
        renderTask = task;

        await task.promise;
        if (!cancelled) {
          setRendered(true);
        }
      } catch (err) {
        if (!cancelled && (err as { name?: string })?.name !== 'RenderingCancelledException') {
          // Swallow cancellation errors cleanly
        }
      }
    }

    setRendered(false);
    void drawPage();

    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // Ignore cancel race
        }
      }
    };
  }, [pdfDoc, pageNumber, effectiveScale, rotation, shouldRender]);

  return (
    <div
      ref={setRefs}
      data-page-number={pageNumber}
      style={{
        width: `${effectiveW}px`,
        height: `${effectiveH}px`,
      }}
      className="relative bg-white border border-slate-300/90 dark:border-slate-700 rounded-sm shadow-sm overflow-hidden shrink-0"
    >
      <canvas
        ref={canvasRef}
        style={{
          width: `${effectiveW}px`,
          height: `${effectiveH}px`,
        }}
        className="block bg-white"
      />
      {!rendered && (
        <div className="absolute inset-0 bg-white flex flex-col items-center justify-center gap-2 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin text-blue-600" aria-hidden="true" />
          <span className="text-xs font-mono tabular-nums">Página {pageNumber}</span>
        </div>
      )}
    </div>
  );
}

interface PdfThumbnailItemProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  active: boolean;
  rotation: number;
  scrollRoot: HTMLDivElement | null;
  onSelect: (pageNumber: number) => void;
}

function PdfThumbnailItem({
  pdfDoc,
  pageNumber,
  active,
  rotation,
  scrollRoot,
  onSelect,
}: PdfThumbnailItemProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(pageNumber <= 6);

  useEffect(() => {
    if (visible) return;
    const el = buttonRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
        }
      },
      { root: scrollRoot, rootMargin: '200px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, scrollRoot]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;

    async function drawThumb() {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
        const targetWidth = 112;
        const cssScale = targetWidth / Math.max(1, base.width);
        const cssViewport = page.getViewport({
          scale: cssScale,
          rotation: (page.rotate + rotation) % 360,
        });
        const thumbOutputScale = Math.min(3, Math.max(2, (window.devicePixelRatio || 1) * 1.5));

        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = Math.max(1, Math.floor(cssViewport.width * thumbOutputScale));
        canvas.height = Math.max(1, Math.floor(cssViewport.height * thumbOutputScale));

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const task = page.render({
          canvas,
          canvasContext: ctx,
          viewport: cssViewport,
          transform: [thumbOutputScale, 0, 0, thumbOutputScale, 0, 0],
          intent: 'display',
        });
        renderTask = task;
        await task.promise;
      } catch {
        // Ignore thumbnail cancel
      }
    }

    void drawThumb();
    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // Ignore
        }
      }
    };
  }, [pdfDoc, pageNumber, rotation, visible]);

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => onSelect(pageNumber)}
      className={`w-full flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:focus-visible:ring-blue-400 ${
        active
          ? 'bg-blue-50/90 dark:bg-blue-500/15 border-blue-500 dark:border-blue-400'
          : 'bg-transparent border-transparent hover:bg-slate-100 dark:hover:bg-slate-800/70'
      }`}
    >
      <div className="w-28 bg-white rounded-xs border border-slate-200 dark:border-slate-700 overflow-hidden shadow-xs flex items-center justify-center min-h-[130px]">
        <canvas ref={canvasRef} className="w-full h-auto block" />
      </div>
      <span
        className={`text-xs font-mono tabular-nums ${
          active
            ? 'font-semibold text-blue-700 dark:text-blue-300'
            : 'text-slate-600 dark:text-slate-400'
        }`}
      >
        {pageNumber}
      </span>
    </button>
  );
}

export function PreviewPage({
  document,
  recentDocuments,
  session,
  isElectron,
  ingesting,
  onSelectDocumentForPreview,
  onPickFileForPreview,
  onIngestFilesForPreview,
  onOpenInEditor,
  onGoToWorkspace,
  onPatchSession,
  onListPrinters,
  onPrintRenderedDocument,
  onReadPlainText,
  onReadWorkingFileBytes,
}: PreviewPageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const viewportScrollRef = useRef<HTMLDivElement | null>(null);
  const thumbScrollRef = useRef<HTMLDivElement | null>(null);
  const pageNodeMapRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const loadingTaskRef = useRef<{ destroy: () => Promise<void> } | null>(null);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PageSizePt[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [currentPage, setCurrentPage] = useState<number>(Math.max(1, session.active_page || 1));
  const [pageInput, setPageInput] = useState<string>(String(Math.max(1, session.active_page || 1)));
  const [layoutMode, setLayoutMode] = useState<ViewLayoutMode>('continuous');
  const [showThumbnails, setShowThumbnails] = useState(true);
  const [rotation, setRotation] = useState(0);
  const [printModalOpen, setPrintModalOpen] = useState(false);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [docxParagraphs, setDocxParagraphs] = useState<string[] | null>(null);
  const [plainTextData, setPlainTextData] = useState<PlainTextContentResult | null>(null);

  const fileType = document?.file_type.toLowerCase() ?? '';
  const isPdf = fileType === 'pdf';
  const isImage = fileType === 'png' || fileType === 'jpg' || fileType === 'jpeg';
  const isDocx = fileType === 'docx';
  const isPlainText = document?.diagnosis_type === 'PLAIN_TEXT';
  const docCacheKey = document
    ? `${document.id}:${document.working_path}:${document.updated_at}`
    : '';

  const sortedDocuments = useMemo(() => {
    const pdfs = recentDocuments.filter((d) => d.file_type.toLowerCase() === 'pdf');
    const others = recentDocuments.filter((d) => d.file_type.toLowerCase() !== 'pdf');
    return [...pdfs, ...others];
  }, [recentDocuments]);

  const zoom = session.zoom_level || 1;

  // Reset per-document viewer state
  useEffect(() => {
    setRotation(0);
    setCurrentPage(1);
    setPageInput('1');
    pageNodeMapRef.current.clear();
  }, [document?.id]);

  // Load PDFDocumentProxy once per document
  useEffect(() => {
    if (!document || !isPdf) {
      if (loadingTaskRef.current) {
        void loadingTaskRef.current.destroy();
        loadingTaskRef.current = null;
      }
      setPdfDoc(null);
      setPageSizes([]);
      return;
    }

    let cancelled = false;
    let currentTask: { destroy: () => Promise<void> } | null = null;

    async function loadPdf() {
      setLoading(true);
      setLoadError(null);
      setPdfDoc(null);
      setPageSizes([]);

      try {
        const bytes = await onReadWorkingFileBytes(document!.id);
        if (cancelled) return;

        if (!bytes || bytes.byteLength === 0) {
          setLoadError(
            'No se encontró el archivo PDF en el almacenamiento local. Vuelve a cargarlo para visualizarlo.',
          );
          setLoading(false);
          return;
        }

        const pdfjs = await import('pdfjs-dist');
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
          pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        }

        const task = pdfjs.getDocument({
          data: new Uint8Array(bytes),
          useSystemFonts: true,
          verbosity: 0,
        });
        currentTask = task;

        const loadedDoc = await task.promise;
        if (cancelled) {
          void task.destroy();
          return;
        }

        const numPages = Math.max(1, loadedDoc.numPages);
        const sizes: PageSizePt[] = [];
        for (let i = 1; i <= numPages; i++) {
          const page = await loadedDoc.getPage(i);
          if (cancelled) {
            void task.destroy();
            return;
          }
          const vp = page.getViewport({ scale: 1 });
          sizes.push({ widthPt: vp.width, heightPt: vp.height });
        }

        if (loadingTaskRef.current && loadingTaskRef.current !== task) {
          void loadingTaskRef.current.destroy();
        }
        loadingTaskRef.current = task;
        setPdfDoc(loadedDoc);
        setPageSizes(sizes);
        setTotalPages(numPages);
        setCurrentPage(1);
        setPageInput('1');
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setLoadError(
            document!.diagnosis_type === 'PDF_ENCRYPTED_OPEN'
              ? 'Este PDF está cifrado con contraseña de apertura. Desbloquéalo primero desde Inicio / Documentos para verlo.'
              : `No se pudo abrir la vista previa del PDF: ${message}`,
          );
          setLoading(false);
        }
      }
    }

    void loadPdf();

    return () => {
      cancelled = true;
      if (currentTask) {
        void currentTask.destroy();
        if (loadingTaskRef.current === currentTask) {
          loadingTaskRef.current = null;
        }
      } else if (loadingTaskRef.current) {
        void loadingTaskRef.current.destroy();
        loadingTaskRef.current = null;
      }
    };
  }, [document?.id, document?.diagnosis_type, docCacheKey, isPdf, onReadWorkingFileBytes]);

  // Load read-only image preview
  useEffect(() => {
    if (!document || !isImage) {
      setImageUrl(null);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;

    async function loadImg() {
      setLoading(true);
      setLoadError(null);
      try {
        const bytes = await onReadWorkingFileBytes(document!.id);
        if (cancelled) return;
        if (!bytes || bytes.byteLength === 0) {
          setLoadError('No se pudo cargar la imagen desde el workspace.');
          setLoading(false);
          return;
        }
        const mime = fileType === 'png' ? 'image/png' : 'image/jpeg';
        createdUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
        setImageUrl(createdUrl);
        setTotalPages(1);
        setCurrentPage(1);
        setPageInput('1');
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Error cargando imagen.');
          setLoading(false);
        }
      }
    }

    void loadImg();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [document?.id, docCacheKey, isImage, fileType, onReadWorkingFileBytes]);

  // Load read-only DOCX paragraphs
  useEffect(() => {
    if (!document || !isDocx) {
      setDocxParagraphs(null);
      return;
    }

    let cancelled = false;
    async function loadDocx() {
      setLoading(true);
      setLoadError(null);
      try {
        const bytes = await onReadWorkingFileBytes(document!.id);
        if (cancelled) return;
        if (!bytes || bytes.byteLength === 0) {
          setDocxParagraphs([]);
          setLoading(false);
          return;
        }
        const zip = await JSZip.loadAsync(bytes);
        const xmlFile = zip.file('word/document.xml');
        const xml = xmlFile ? await xmlFile.async('string') : '';
        if (!cancelled) {
          setDocxParagraphs(xml ? extractParagraphsFromDocxXml(xml) : []);
          setTotalPages(1);
          setCurrentPage(1);
          setPageInput('1');
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Error leyendo archivo Word.');
          setLoading(false);
        }
      }
    }

    void loadDocx();
    return () => {
      cancelled = true;
    };
  }, [document?.id, docCacheKey, isDocx, onReadWorkingFileBytes]);

  // Load read-only plain text
  useEffect(() => {
    if (!document || !isPlainText) {
      setPlainTextData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    onReadPlainText(document.id)
      .then((res) => {
        if (!cancelled) {
          setPlainTextData(res);
          setTotalPages(1);
          setCurrentPage(1);
          setPageInput('1');
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'No se pudo leer el texto.');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [document?.id, isPlainText, onReadPlainText]);

  const registerPageNode = useCallback((pageNum: number, node: HTMLDivElement | null) => {
    if (node) {
      pageNodeMapRef.current.set(pageNum, node);
    } else {
      pageNodeMapRef.current.delete(pageNum);
    }
  }, []);

  const goToPage = useCallback(
    (target: number) => {
      const clamped = Math.max(1, Math.min(totalPages, Math.round(target)));
      setCurrentPage(clamped);
      setPageInput(String(clamped));
      onPatchSession({ active_page: clamped });

      if (layoutMode === 'continuous') {
        const node = pageNodeMapRef.current.get(clamped);
        if (node) {
          node.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } else if (viewportScrollRef.current) {
        viewportScrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
    [layoutMode, onPatchSession, totalPages],
  );

  // Track visible page automatically while scrolling in continuous mode
  useEffect(() => {
    if (!isPdf || layoutMode !== 'continuous' || totalPages <= 1) return;
    const container = viewportScrollRef.current;
    if (!container) return;

    let rafId: number | null = null;
    const onScroll = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const containerRect = container.getBoundingClientRect();
        const midY = containerRect.top + containerRect.height * 0.35;
        let closestPage = 1;
        let closestDist = Number.POSITIVE_INFINITY;

        for (const [pageNum, el] of pageNodeMapRef.current.entries()) {
          const rect = el.getBoundingClientRect();
          const pageMid = rect.top + rect.height / 2;
          const dist = Math.abs(pageMid - midY);
          if (dist < closestDist) {
            closestDist = dist;
            closestPage = pageNum;
          }
        }

        setCurrentPage((prev) => {
          if (prev !== closestPage) {
            setPageInput(String(closestPage));
            return closestPage;
          }
          return prev;
        });
      });
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [isPdf, layoutMode, totalPages]);

  // Keyboard page navigation in single-page mode
  useEffect(() => {
    if (!isPdf || totalPages <= 1) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')
      ) {
        return;
      }
      if (layoutMode === 'single') {
        if (e.key === 'ArrowRight' || e.key === 'PageDown') {
          e.preventDefault();
          goToPage(currentPage + 1);
        } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
          e.preventDefault();
          goToPage(currentPage - 1);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isPdf, layoutMode, currentPage, totalPages, goToPage]);

  const handleStepZoom = (direction: -1 | 1) => {
    const currentIdx = ZOOM_STEPS.findIndex((step) => Math.abs(step - zoom) < 0.05);
    if (currentIdx === -1) {
      const next = Math.max(0.5, Math.min(2, Number((zoom + direction * 0.25).toFixed(2))));
      onPatchSession({ zoom_level: next });
      return;
    }
    const nextIdx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, currentIdx + direction));
    onPatchSession({ zoom_level: ZOOM_STEPS[nextIdx] });
  };

  const handleFitWidth = () => {
    const container = viewportScrollRef.current;
    const pageSize = pageSizes[currentPage - 1] ?? pageSizes[0];
    if (!container || !pageSize) {
      onPatchSession({ zoom_level: 1 });
      return;
    }
    const isSwapped = rotation % 180 !== 0;
    const baseWidth = (isSwapped ? pageSize.heightPt : pageSize.widthPt) * PDF_CSS_SCALE;
    const availableWidth = Math.max(320, container.clientWidth - 64);
    const computed = Math.max(0.5, Math.min(2, Number((availableWidth / baseWidth).toFixed(2))));
    onPatchSession({ zoom_level: computed });
  };

  const handlePageInputSubmit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = Number.parseInt(pageInput, 10);
    if (Number.isFinite(parsed)) {
      goToPage(parsed);
    } else {
      setPageInput(String(currentPage));
    }
  };

  const handlePickClick = async () => {
    if (isElectron) {
      await onPickFileForPreview();
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleBrowserFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    try {
      await onIngestFilesForPreview(files);
    } finally {
      event.target.value = '';
    }
  };

  const hiddenFileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".pdf,.docx,.txt,.rtf,.md,.csv,.json,.png,.jpg,.jpeg"
      onChange={handleBrowserFileSelected}
      className="hidden"
      aria-hidden="true"
    />
  );

  // Empty state when no document is currently selected
  if (!document) {
    return (
      <div className="max-w-3xl mx-auto px-8 py-12 space-y-6">
        {hiddenFileInput}
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-8 text-center">
          <div className="w-11 h-11 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 mx-auto flex items-center justify-center">
            <FileText className="w-5 h-5" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 text-balance">
            Vista previa sin edición
          </h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 max-w-md mx-auto">
            Abre cualquier PDF o documento en modo solo lectura para revisar sus páginas con zoom y
            miniaturas, sin modificar ni detectar campos.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              disabled={ingesting}
              onClick={() => void handlePickClick()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors disabled:opacity-60 whitespace-nowrap"
            >
              {ingesting ? (
                <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
              ) : (
                <Upload className="w-4 h-4 shrink-0" aria-hidden="true" />
              )}
              <span>{ingesting ? 'Cargando...' : 'Cargar PDF para ver'}</span>
            </button>

            <button
              type="button"
              onClick={onGoToWorkspace}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              Ir a Inicio / Documentos
            </button>
          </div>
        </div>

        {sortedDocuments.length > 0 && (
          <section className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Documentos disponibles en tu equipo
              </h2>
              <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {sortedDocuments.length} archivos
              </span>
            </div>
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {sortedDocuments.slice(0, 10).map((doc) => (
                <li key={doc.id}>
                  <button
                    type="button"
                    onClick={() => onSelectDocumentForPreview(doc.id)}
                    className="w-full px-5 py-3 flex items-center justify-between gap-4 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                        {doc.original_name}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                        .{doc.file_type}
                        {doc.analysis?.details.pageCount
                          ? ` · ${doc.analysis.details.pageCount} pág.`
                          : ''}
                      </p>
                    </div>
                    <span className="text-xs font-medium text-blue-700 dark:text-blue-400 whitespace-nowrap shrink-0">
                      Abrir vista previa
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 bg-slate-100/80 dark:bg-slate-950">
      {hiddenFileInput}

      {/* Clean read-only reader toolbar */}
      <div className="px-4 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 shrink-0">
        {/* Left group: Thumbnails toggle + Document switcher + Load PDF */}
        <div className="flex items-center gap-2 min-w-0">
          {isPdf && totalPages > 1 && (
            <button
              type="button"
              onClick={() => setShowThumbnails((prev) => !prev)}
              aria-pressed={showThumbnails}
              title={showThumbnails ? 'Ocultar miniaturas' : 'Mostrar miniaturas'}
              className={`h-8 px-2.5 rounded-lg inline-flex items-center gap-1.5 text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                showThumbnails
                  ? 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100'
                  : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/70'
              }`}
            >
              <PanelLeft className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden xl:inline">Miniaturas</span>
            </button>
          )}

          <select
            aria-label="Cambiar documento en vista previa"
            value={document.id}
            onChange={(e) => onSelectDocumentForPreview(e.target.value)}
            className="h-8 max-w-[230px] px-2.5 rounded-lg text-xs font-medium bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400 truncate"
          >
            {sortedDocuments.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.original_name}
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={ingesting}
            onClick={() => void handlePickClick()}
            title="Cargar otro PDF para vista previa"
            className="h-8 px-2.5 rounded-lg inline-flex items-center gap-1.5 text-xs font-medium border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            {ingesting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
            ) : (
              <Upload className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            )}
            <span>Cargar PDF</span>
          </button>

          <span className="hidden 2xl:inline text-xs text-slate-500 dark:text-slate-400 pl-1 whitespace-nowrap">
            Solo lectura
          </span>
        </div>

        {/* Center group: Page navigation + View layout + Zoom + Rotate */}
        <div className="flex items-center gap-2 flex-wrap">
          {isPdf && (
            <>
              {/* Page navigation */}
              <div className="flex items-center gap-1 border border-slate-200 dark:border-slate-800 rounded-lg p-0.5 bg-slate-50 dark:bg-slate-950">
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => goToPage(currentPage - 1)}
                  aria-label="Página anterior"
                  className="h-7 w-7 rounded-md flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                </button>
                <form onSubmit={handlePageInputSubmit} className="flex items-center gap-1 px-1">
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label="Número de página actual"
                    value={pageInput}
                    onChange={(e) => setPageInput(e.target.value)}
                    onBlur={() => {
                      const parsed = Number.parseInt(pageInput, 10);
                      if (Number.isFinite(parsed) && parsed !== currentPage) {
                        goToPage(parsed);
                      } else {
                        setPageInput(String(currentPage));
                      }
                    }}
                    className="w-9 h-6 text-center text-xs font-mono tabular-nums rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-600"
                  />
                  <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 pr-1">
                    / {totalPages}
                  </span>
                </form>
                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() => goToPage(currentPage + 1)}
                  aria-label="Página siguiente"
                  className="h-7 w-7 rounded-md flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
                >
                  <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>

              {/* Continuous vs Single page toggle */}
              {totalPages > 1 && (
                <div
                  role="group"
                  aria-label="Modo de lectura"
                  className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800"
                >
                  <button
                    type="button"
                    onClick={() => setLayoutMode('continuous')}
                    title="Desplazamiento continuo por todas las páginas"
                    className={`h-7 px-2.5 rounded-md inline-flex items-center gap-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      layoutMode === 'continuous'
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <ScrollText className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>Continuo</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLayoutMode('single')}
                    title="Mostrar una página a la vez"
                    className={`h-7 px-2.5 rounded-md inline-flex items-center gap-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      layoutMode === 'single'
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <Columns2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>Página</span>
                  </button>
                </div>
              )}
            </>
          )}

          {/* Zoom controls */}
          {(isPdf || isImage) && (
            <div className="flex items-center gap-1 border border-slate-200 dark:border-slate-800 rounded-lg p-0.5 bg-slate-50 dark:bg-slate-950">
              <button
                type="button"
                onClick={() => handleStepZoom(-1)}
                disabled={zoom <= 0.5}
                aria-label="Alejar"
                className="h-7 w-7 rounded-md flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
              >
                <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <span className="min-w-[44px] text-center text-xs font-mono tabular-nums text-slate-700 dark:text-slate-200">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => handleStepZoom(1)}
                disabled={zoom >= 2}
                aria-label="Acercar"
                className="h-7 w-7 rounded-md flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
              >
                <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              {isPdf && (
                <>
                  <button
                    type="button"
                    onClick={handleFitWidth}
                    title="Ajustar al ancho"
                    aria-label="Ajustar al ancho"
                    className="h-7 px-2 rounded-md flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 transition-colors"
                  >
                    <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRotation((prev) => (prev + 90) % 360)}
                    title="Rotar 90°"
                    aria-label="Rotar página 90 grados"
                    className="h-7 px-2 rounded-md flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 transition-colors"
                  >
                    <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Right group: Print + Quick transition to Editor */}
        <div className="flex items-center gap-2 shrink-0">
          {(isPdf || isImage) && (
            <button
              type="button"
              disabled={loading || Boolean(loadError)}
              onClick={() => setPrintModalOpen(true)}
              title="Imprimir documento"
              className="h-8 px-3 rounded-lg inline-flex items-center gap-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45 transition-colors whitespace-nowrap shrink-0"
            >
              <Printer className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Imprimir</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onOpenInEditor(document.id)}
            className="h-8 px-3 rounded-lg inline-flex items-center gap-1.5 text-xs font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors whitespace-nowrap shrink-0"
          >
            <FileEdit className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Editar documento</span>
          </button>
        </div>
      </div>

      {/* Body: Optional left thumbnails + Main clean read-only viewport */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {isPdf && pdfDoc && totalPages > 1 && showThumbnails && (
          <aside
            ref={thumbScrollRef}
            aria-label="Miniaturas de páginas"
            className="w-40 shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 overflow-y-auto p-2.5 space-y-2"
          >
            {pageSizes.map((_, idx) => {
              const pageNum = idx + 1;
              return (
                <PdfThumbnailItem
                  key={`${document.id}-thumb-${pageNum}`}
                  pdfDoc={pdfDoc}
                  pageNumber={pageNum}
                  active={currentPage === pageNum}
                  rotation={rotation}
                  scrollRoot={thumbScrollRef.current}
                  onSelect={goToPage}
                />
              );
            })}
          </aside>
        )}

        <div
          ref={viewportScrollRef}
          className="flex-1 min-w-0 overflow-auto px-6 py-7 flex flex-col items-center gap-6"
        >
          {loading && (
            <div className="my-auto flex flex-col items-center gap-3 text-slate-600 dark:text-slate-300">
              <Loader2 className="w-7 h-7 animate-spin text-blue-600" aria-hidden="true" />
              <p className="text-sm font-medium">Cargando vista previa...</p>
            </div>
          )}

          {!loading && loadError && (
            <div className="my-auto max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-7 text-center space-y-3">
              <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 mx-auto flex items-center justify-center">
                <AlertCircle className="w-5 h-5" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{loadError}</p>
              <button
                type="button"
                onClick={onGoToWorkspace}
                className="px-3.5 py-2 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                Volver a Inicio / Documentos
              </button>
            </div>
          )}

          {/* Read-only PDF pages */}
          {!loading && !loadError && isPdf && pdfDoc && pageSizes.length > 0 && (
            <>
              {layoutMode === 'continuous' ? (
                pageSizes.map((size, idx) => {
                  const pageNum = idx + 1;
                  return (
                    <div key={`${document.id}-page-${pageNum}`} className="flex flex-col items-center gap-1.5">
                      <PdfCanvasPage
                        pdfDoc={pdfDoc}
                        pageNumber={pageNum}
                        zoom={zoom}
                        rotation={rotation}
                        baseSize={size}
                        scrollRoot={viewportScrollRef.current}
                        eager={pageNum <= 2}
                        onRegisterNode={registerPageNode}
                      />
                      <span className="text-[11px] font-mono tabular-nums text-slate-400 dark:text-slate-500">
                        Página {pageNum} de {totalPages}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <PdfCanvasPage
                    key={`${document.id}-single-${currentPage}`}
                    pdfDoc={pdfDoc}
                    pageNumber={currentPage}
                    zoom={zoom}
                    rotation={rotation}
                    baseSize={pageSizes[currentPage - 1] ?? pageSizes[0]}
                    scrollRoot={viewportScrollRef.current}
                    eager
                  />
                  <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    Página {currentPage} de {totalPages}
                  </span>
                </div>
              )}
            </>
          )}

          {/* Read-only Image */}
          {!loading && !loadError && isImage && imageUrl && (
            <div className="bg-white border border-slate-300 dark:border-slate-700 rounded-sm shadow-sm p-2">
              <img
                src={imageUrl}
                alt={document.original_name}
                style={{ width: `${Math.round(640 * zoom)}px` }}
                className="max-w-none h-auto block"
                draggable={false}
              />
            </div>
          )}

          {/* Read-only DOCX */}
          {!loading && !loadError && isDocx && (
            <article className="w-full max-w-3xl bg-white text-slate-900 border border-slate-300 dark:border-slate-700 rounded-sm shadow-sm p-10 space-y-4">
              <div className="pb-4 border-b border-slate-200 flex items-center justify-between gap-4">
                <h2 className="text-base font-semibold text-slate-900 truncate">
                  {document.original_name}
                </h2>
                <span className="text-xs font-mono tabular-nums text-slate-500 shrink-0">
                  {docxParagraphs?.length ?? 0} párrafos
                </span>
              </div>
              {docxParagraphs && docxParagraphs.length > 0 ? (
                <div className="space-y-3 text-sm leading-relaxed text-slate-800">
                  {docxParagraphs.map((para, idx) => (
                    <p key={idx}>{para}</p>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  No se detectó texto visible en este documento Word.
                </p>
              )}
            </article>
          )}

          {/* Read-only Plain Text */}
          {!loading && !loadError && isPlainText && (
            <article className="w-full max-w-4xl bg-white text-slate-900 border border-slate-300 dark:border-slate-700 rounded-sm shadow-sm p-8 space-y-3">
              <div className="pb-3 border-b border-slate-200 flex items-center justify-between text-xs font-mono text-slate-500">
                <span className="font-semibold text-slate-800 truncate">
                  {document.original_name}
                </span>
                {plainTextData && (
                  <span className="shrink-0 tabular-nums">
                    {plainTextData.encoding} · {plainTextData.lineCount} líneas
                  </span>
                )}
              </div>
              <pre className="text-xs font-mono leading-relaxed text-slate-800 whitespace-pre-wrap break-words">
                {plainTextData?.content ?? ''}
              </pre>
            </article>
          )}

          {/* Unsupported file type fallback */}
          {!loading && !loadError && !isPdf && !isImage && !isDocx && !isPlainText && (
            <div className="my-auto max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-8 text-center space-y-2.5">
              <FileText className="w-7 h-7 text-slate-400 mx-auto" aria-hidden="true" />
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {document.original_name}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                La vista previa está disponible para archivos PDF, imágenes (PNG/JPG), Word (.docx)
                y texto plano.
              </p>
            </div>
          )}
        </div>
      </div>

      <SaveOrPrintModal
        open={printModalOpen}
        initialTab="print"
        allowSave={false}
        isElectron={isElectron}
        document={document}
        currentPage={currentPage}
        totalPages={totalPages}
        onClose={() => setPrintModalOpen(false)}
        onListPrinters={onListPrinters}
        onReadWorkingFileBytes={onReadWorkingFileBytes}
        onPrintRenderedDocument={onPrintRenderedDocument}
      />
    </div>
  );
}
