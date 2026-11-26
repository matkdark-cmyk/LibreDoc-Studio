import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import JSZip from 'jszip';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { AlertCircle, Check, FileText, Loader2, X } from 'lucide-react';
import type {
  CheckboxStyle,
  DocumentField,
  DocumentRecord,
  FieldType,
  PlainTextContentResult,
} from '../../shared/types';

export type PreviewDrawTool = 'none' | 'text' | 'check' | 'cross';

export interface DrawnFieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
  field_type: FieldType;
  checkbox_style?: CheckboxStyle;
}

interface DocumentLivePreviewProps {
  document: DocumentRecord;
  activePage: number;
  zoomLevel: number;
  fieldsOnPage: DocumentField[];
  draftValues: Record<string, string>;
  activeFieldId: string | null;
  hoveredFieldId: string | null;
  showFieldHighlights: boolean;
  drawTool: PreviewDrawTool;
  plainTextData: PlainTextContentResult | null;
  onReadWorkingFileBytes: (documentId: string) => Promise<Uint8Array | null>;
  onTotalPagesDetected: (totalPages: number) => void;
  onSelectFieldFromPreview: (fieldId: string) => void;
  onHoverField: (fieldId: string | null) => void;
  onMoveOrResizeField: (
    field: DocumentField,
    geometry: { x: number; y: number; width: number; height: number },
  ) => void;
  onCreateDrawnField: (rect: DrawnFieldRect) => void;
  onDeleteField: (fieldId: string) => void;
}

interface PdfPageMetrics {
  widthPt: number;
  heightPt: number;
}

interface DragState {
  mode: 'move' | 'resize';
  field: DocumentField;
  startClientX: number;
  startClientY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
  curX: number;
  curY: number;
  curW: number;
  curH: number;
  moved: boolean;
}

interface DrawDraftRect {
  startX: number;
  startY: number;
  curX: number;
  curY: number;
}

const DEFAULT_PAGE_METRICS: PdfPageMetrics = {
  widthPt: 612,
  heightPt: 792,
};

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

export function DocumentLivePreview({
  document,
  activePage,
  zoomLevel,
  fieldsOnPage,
  draftValues,
  activeFieldId,
  hoveredFieldId,
  showFieldHighlights,
  drawTool,
  plainTextData,
  onReadWorkingFileBytes,
  onTotalPagesDetected,
  onSelectFieldFromPreview,
  onHoverField,
  onMoveOrResizeField,
  onCreateDrawnField,
  onDeleteField,
}: DocumentLivePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageFrameRef = useRef<HTMLDivElement | null>(null);
  const fieldBoxRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageMetrics, setPageMetrics] = useState<PdfPageMetrics>(DEFAULT_PAGE_METRICS);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [docxParagraphs, setDocxParagraphs] = useState<string[] | null>(null);

  const [dragState, setDragState] = useState<DragState | null>(null);
  const [drawDraft, setDrawDraft] = useState<DrawDraftRect | null>(null);

  const dragRef = useRef<DragState | null>(null);
  dragRef.current = dragState;
  const drawRef = useRef<DrawDraftRect | null>(null);
  drawRef.current = drawDraft;

  const fileType = document.file_type.toLowerCase();
  const isPdf = fileType === 'pdf';
  const isImage = fileType === 'png' || fileType === 'jpg' || fileType === 'jpeg';
  const isDocx = fileType === 'docx';
  const isPlainText = document.diagnosis_type === 'PLAIN_TEXT';
  const effectiveScale = zoomLevel * PDF_CSS_SCALE;

  const bytesCacheRef = useRef<{ key: string; bytes: Uint8Array | null }>({
    key: '',
    bytes: null,
  });
  const docCacheKey = `${document.id}:${document.working_path}:${document.updated_at}`;

  // Scroll the highlighted overlay box into view when selected from the left panel
  useEffect(() => {
    if (!activeFieldId || dragRef.current) return;
    const node = fieldBoxRefs.current.get(activeFieldId);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
  }, [activeFieldId, activePage]);

  // Delete selected field with Delete / Supr key (when not typing inside an input/textarea)
  useEffect(() => {
    if (!activeFieldId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      onDeleteField(activeFieldId);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeFieldId, onDeleteField]);

  // Global mouse move/up handlers for drag-to-move, resize, and draw-new-rectangle
  useEffect(() => {
    const handleMouseMove = (e: globalThis.MouseEvent) => {
      const activeDrag = dragRef.current;
      if (activeDrag) {
        const dxPt = (e.clientX - activeDrag.startClientX) / Math.max(0.1, effectiveScale);
        const dyPt = (e.clientY - activeDrag.startClientY) / Math.max(0.1, effectiveScale);
        const moved = activeDrag.moved || Math.abs(dxPt) > 1.5 || Math.abs(dyPt) > 1.5;

        if (activeDrag.mode === 'move') {
          const nextX = Math.max(
            0,
            Math.min(pageMetrics.widthPt - activeDrag.origW, activeDrag.origX + dxPt),
          );
          const nextY = Math.max(
            0,
            Math.min(pageMetrics.heightPt - activeDrag.origH, activeDrag.origY + dyPt),
          );
          setDragState({
            ...activeDrag,
            curX: Number(nextX.toFixed(1)),
            curY: Number(nextY.toFixed(1)),
            moved,
          });
        } else {
          const nextW = Math.max(
            10,
            Math.min(pageMetrics.widthPt - activeDrag.origX, activeDrag.origW + dxPt),
          );
          const nextH = Math.max(
            10,
            Math.min(pageMetrics.heightPt - activeDrag.origY, activeDrag.origH + dyPt),
          );
          setDragState({
            ...activeDrag,
            curW: Number(nextW.toFixed(1)),
            curH: Number(nextH.toFixed(1)),
            moved,
          });
        }
        return;
      }

      const activeDraw = drawRef.current;
      if (activeDraw && pageFrameRef.current) {
        const bounds = pageFrameRef.current.getBoundingClientRect();
        const ptX = Math.max(
          0,
          Math.min(pageMetrics.widthPt, (e.clientX - bounds.left) / Math.max(0.1, effectiveScale)),
        );
        const ptY = Math.max(
          0,
          Math.min(pageMetrics.heightPt, (e.clientY - bounds.top) / Math.max(0.1, effectiveScale)),
        );
        setDrawDraft({
          ...activeDraw,
          curX: ptX,
          curY: ptY,
        });
      }
    };

    const handleMouseUp = () => {
      const activeDrag = dragRef.current;
      if (activeDrag) {
        setDragState(null);
        if (activeDrag.moved) {
          onMoveOrResizeField(activeDrag.field, {
            x: activeDrag.curX,
            y: activeDrag.curY,
            width: activeDrag.curW,
            height: activeDrag.curH,
          });
        }
        return;
      }

      const activeDraw = drawRef.current;
      if (activeDraw && drawTool !== 'none') {
        setDrawDraft(null);
        const x0 = Math.min(activeDraw.startX, activeDraw.curX);
        const y0 = Math.min(activeDraw.startY, activeDraw.curY);
        let w = Math.abs(activeDraw.curX - activeDraw.startX);
        let h = Math.abs(activeDraw.curY - activeDraw.startY);

        // Support single-click placement for checkboxes or quick drag for text boxes
        if (drawTool === 'check' || drawTool === 'cross') {
          if (w < 8 && h < 8) {
            w = 16;
            h = 16;
          } else {
            w = Math.max(12, w);
            h = Math.max(12, h);
          }
          onCreateDrawnField({
            x: Number(x0.toFixed(1)),
            y: Number(y0.toFixed(1)),
            width: Number(w.toFixed(1)),
            height: Number(h.toFixed(1)),
            field_type: 'checkbox',
            checkbox_style: drawTool,
          });
        } else {
          if (w < 14 && h < 8) {
            w = 160;
            h = 18;
          } else {
            w = Math.max(20, w);
            h = Math.max(12, h);
          }
          onCreateDrawnField({
            x: Number(x0.toFixed(1)),
            y: Number(y0.toFixed(1)),
            width: Number(w.toFixed(1)),
            height: Number(h.toFixed(1)),
            field_type: h >= 38 ? 'multiline' : 'text',
          });
        }
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [effectiveScale, pageMetrics, drawTool, onMoveOrResizeField, onCreateDrawnField]);

  // Render PDF page onto <canvas> via pdfjs-dist using HiDPI transform supersampling
  useEffect(() => {
    if (!isPdf) return;
    let cancelled = false;
    let loadingTask: { destroy: () => Promise<void> } | null = null;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;

    async function renderPdfPage() {
      setLoading(true);
      setLoadError(null);

      try {
        let bytes =
          bytesCacheRef.current.key === docCacheKey ? bytesCacheRef.current.bytes : null;
        if (!bytes) {
          bytes = await onReadWorkingFileBytes(document.id);
          bytesCacheRef.current = { key: docCacheKey, bytes };
        }

        if (cancelled) return;

        if (!bytes || bytes.byteLength === 0) {
          setLoadError(
            'No se encontraron los bytes del PDF en el workspace. Si estás en vista web, vuelve a cargar el archivo.',
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
        loadingTask = task;

        const pdfDoc = await task.promise;
        if (cancelled) return;

        const numPages = Math.max(1, pdfDoc.numPages);
        onTotalPagesDetected(numPages);

        const safePage = Math.min(numPages, Math.max(1, activePage));
        const page = await pdfDoc.getPage(safePage);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        setPageMetrics({
          widthPt: baseViewport.width,
          heightPt: baseViewport.height,
        });

        const cssViewport = page.getViewport({ scale: effectiveScale });
        const cssWidth = Math.max(1, Math.floor(cssViewport.width));
        const cssHeight = Math.max(1, Math.floor(cssViewport.height));
        const outputScale = computeCrispOutputScale(cssWidth, cssHeight);

        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;

        canvas.width = Math.max(1, Math.floor(cssWidth * outputScale));
        canvas.height = Math.max(1, Math.floor(cssHeight * outputScale));

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) {
          setLoadError('No se pudo inicializar el lienzo 2D para mostrar el PDF.');
          setLoading(false);
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const transform =
          outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

        const rTask = page.render({
          canvas,
          canvasContext: ctx,
          viewport: cssViewport,
          transform,
          intent: 'display',
        });
        renderTask = rTask;
        await rTask.promise;

        if (!cancelled) {
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled && (err as { name?: string })?.name !== 'RenderingCancelledException') {
          const message = err instanceof Error ? err.message : String(err);
          setLoadError(
            document.diagnosis_type === 'PDF_ENCRYPTED_OPEN'
              ? 'Este PDF requiere contraseña de apertura. Desbloquéalo primero desde Inicio para visualizar sus páginas.'
              : `No se pudo renderizar la página del PDF: ${message}`,
          );
          setLoading(false);
        }
      } finally {
        if (loadingTask) {
          void loadingTask.destroy();
        }
      }
    }

    void renderPdfPage();

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
  }, [
    isPdf,
    docCacheKey,
    document.id,
    document.diagnosis_type,
    activePage,
    effectiveScale,
    onReadWorkingFileBytes,
    onTotalPagesDetected,
  ]);

  // Load Image preview via Blob URL
  useEffect(() => {
    if (!isImage) {
      setImageUrl(null);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;

    async function loadImage() {
      setLoading(true);
      setLoadError(null);
      try {
        const bytes = await onReadWorkingFileBytes(document.id);
        if (cancelled) return;
        if (!bytes || bytes.byteLength === 0) {
          setLoadError('No se pudo cargar la imagen desde el workspace.');
          setLoading(false);
          return;
        }

        const mime = fileType === 'png' ? 'image/png' : 'image/jpeg';
        const blob = new Blob([new Uint8Array(bytes)], { type: mime });
        createdUrl = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = () => {
          if (cancelled) return;
          const naturalW = Math.max(1, img.naturalWidth);
          const naturalH = Math.max(1, img.naturalHeight);
          const scaledHeightPt = Math.round((naturalH / naturalW) * 612);
          setPageMetrics({ widthPt: 612, heightPt: Math.max(240, scaledHeightPt) });
          onTotalPagesDetected(1);
          setImageUrl(createdUrl);
          setLoading(false);
        };
        img.onerror = () => {
          if (!cancelled) {
            setLoadError('No se pudo decodificar el archivo de imagen.');
            setLoading(false);
          }
        };
        img.src = createdUrl;
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Error cargando imagen.');
          setLoading(false);
        }
      }
    }

    void loadImage();

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [isImage, docCacheKey, document.id, fileType, onReadWorkingFileBytes, onTotalPagesDetected]);

  // Load DOCX real paragraph preview via JSZip
  useEffect(() => {
    if (!isDocx) {
      setDocxParagraphs(null);
      return;
    }

    let cancelled = false;

    async function loadDocx() {
      setLoading(true);
      setLoadError(null);
      try {
        const bytes = await onReadWorkingFileBytes(document.id);
        if (cancelled) return;
        if (!bytes || bytes.byteLength === 0) {
          setDocxParagraphs([]);
          setLoading(false);
          return;
        }

        const zip = await JSZip.loadAsync(bytes);
        const xmlFile = zip.file('word/document.xml');
        if (!xmlFile) {
          setDocxParagraphs([]);
          setLoading(false);
          return;
        }

        const xml = await xmlFile.async('string');
        if (!cancelled) {
          setDocxParagraphs(extractParagraphsFromDocxXml(xml));
          setPageMetrics(DEFAULT_PAGE_METRICS);
          onTotalPagesDetected(1);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Error leyendo contenido del Word.');
          setLoading(false);
        }
      }
    }

    void loadDocx();

    return () => {
      cancelled = true;
    };
  }, [isDocx, docCacheKey, document.id, onReadWorkingFileBytes, onTotalPagesDetected]);

  useEffect(() => {
    if (isPlainText) {
      setPageMetrics(DEFAULT_PAGE_METRICS);
      onTotalPagesDetected(1);
    }
  }, [isPlainText, onTotalPagesDetected]);

  const activeField = useMemo(
    () => fieldsOnPage.find((f) => f.id === activeFieldId) ?? null,
    [fieldsOnPage, activeFieldId],
  );

  const displayWidthPx = Math.floor(pageMetrics.widthPt * effectiveScale);
  const displayHeightPx = Math.floor(pageMetrics.heightPt * effectiveScale);

  const handleStartDraw = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (drawTool === 'none' || e.button !== 0 || !pageFrameRef.current) return;
    e.preventDefault();
    const bounds = pageFrameRef.current.getBoundingClientRect();
    const ptX = Math.max(
      0,
      Math.min(pageMetrics.widthPt, (e.clientX - bounds.left) / Math.max(0.1, effectiveScale)),
    );
    const ptY = Math.max(
      0,
      Math.min(pageMetrics.heightPt, (e.clientY - bounds.top) / Math.max(0.1, effectiveScale)),
    );
    setDrawDraft({ startX: ptX, startY: ptY, curX: ptX, curY: ptY });
  };

  const handleStartFieldDrag = (
    e: ReactMouseEvent<HTMLElement>,
    field: DocumentField,
    mode: 'move' | 'resize',
  ) => {
    if (drawTool !== 'none' || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelectFieldFromPreview(field.id);
    setDragState({
      mode,
      field,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: field.x,
      origY: field.y,
      origW: field.width,
      origH: field.height,
      curX: field.x,
      curY: field.y,
      curW: field.width,
      curH: field.height,
      moved: false,
    });
  };

  return (
    <div className="flex flex-col items-center gap-3 w-full">
      <div
        ref={pageFrameRef}
        onMouseDown={handleStartDraw}
        style={{
          width: `${displayWidthPx}px`,
          minHeight: `${displayHeightPx}px`,
        }}
        className={`relative bg-white text-slate-900 border border-slate-300 dark:border-slate-700 rounded-md shadow-md overflow-hidden shrink-0 select-none ${
          drawTool !== 'none' ? 'cursor-crosshair' : ''
        }`}
      >
        {/* 1. Real PDF Canvas */}
        {isPdf && (
          <canvas
            ref={canvasRef}
            style={{
              width: `${displayWidthPx}px`,
              height: `${displayHeightPx}px`,
            }}
            className="block bg-white"
          />
        )}

        {/* 2. Real Image Preview */}
        {isImage && imageUrl && (
          <img
            src={imageUrl}
            alt={document.original_name}
            style={{
              width: `${displayWidthPx}px`,
              height: `${displayHeightPx}px`,
            }}
            className="block object-contain bg-white select-none"
            draggable={false}
          />
        )}

        {/* 3. Real DOCX Extracted Visual Sheet */}
        {isDocx && (
          <div className="p-10 space-y-4 min-h-full bg-white text-slate-900 select-text">
            <div className="pb-4 border-b border-slate-200 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[11px] font-mono uppercase tracking-wide text-slate-500">
                  Vista previa Word (.docx)
                </p>
                <h3 className="text-base font-semibold text-slate-900 truncate">
                  {document.original_name}
                </h3>
              </div>
              <span className="text-xs font-mono text-slate-400 shrink-0">
                {docxParagraphs?.length ?? 0} párrafos
              </span>
            </div>

            {docxParagraphs && docxParagraphs.length > 0 ? (
              <div className="space-y-3 text-sm leading-relaxed text-slate-800">
                {docxParagraphs.map((para, idx) => {
                  const matchesActiveField =
                    activeField &&
                    activeField.label.trim().length >= 3 &&
                    para.toLowerCase().includes(activeField.label.trim().toLowerCase());
                  return (
                    <p
                      key={idx}
                      className={`rounded px-2 py-1 transition-colors ${
                        matchesActiveField
                          ? 'bg-blue-50 border-l-4 border-blue-600 text-slate-900 font-medium'
                          : ''
                      }`}
                    >
                      {para}
                    </p>
                  );
                })}
              </div>
            ) : (
              !loading && (
                <p className="text-sm text-slate-500">
                  No se detectó texto plano en este archivo .docx o la copia local aún no está disponible.
                </p>
              )
            )}
          </div>
        )}

        {/* 4. Real Plain Text Preview */}
        {isPlainText && (
          <div className="p-8 space-y-3 bg-white text-slate-900 min-h-full select-text">
            <div className="pb-3 border-b border-slate-200 flex items-center justify-between text-xs text-slate-500 font-mono">
              <span className="truncate font-semibold text-slate-800">
                {document.original_name}
              </span>
              {plainTextData && (
                <span className="shrink-0 ml-3">
                  {plainTextData.encoding} · {plainTextData.lineCount} líneas
                </span>
              )}
            </div>
            {plainTextData ? (
              <pre className="text-xs font-mono leading-relaxed text-slate-800 whitespace-pre-wrap break-words">
                {plainTextData.content}
              </pre>
            ) : (
              <p className="text-xs text-slate-500">Cargando contenido del archivo de texto...</p>
            )}
          </div>
        )}

        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 bg-white/85 flex flex-col items-center justify-center gap-2.5 z-30">
            <Loader2 className="w-6 h-6 text-blue-600 animate-spin" aria-hidden="true" />
            <p className="text-xs font-medium text-slate-700">
              Renderizando vista del archivo...
            </p>
          </div>
        )}

        {/* Error fallback overlay */}
        {!loading && loadError && (
          <div className="absolute inset-0 bg-slate-50/95 flex flex-col items-center justify-center p-8 text-center gap-3 z-20">
            <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center">
              <AlertCircle className="w-5 h-5" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-slate-800 max-w-md">{loadError}</p>
            <p className="text-xs text-slate-500 max-w-sm">
              Los campos editables siguen visibles y sincronizados en tiempo real.
            </p>
          </div>
        )}

        {/* Phase 4 Interactive AcroForm Overlay Layer (Blue = Text, Green = Checkbox) */}
        {fieldsOnPage.length > 0 && (
          <div
            aria-label="Espacios editables marcados sobre el documento"
            className="absolute inset-0 pointer-events-none z-10"
          >
            {fieldsOnPage.map((field) => {
              const isDraggingThis = dragState?.field.id === field.id;
              const fx = isDraggingThis ? dragState.curX : field.x;
              const fy = isDraggingThis ? dragState.curY : field.y;
              const fw = isDraggingThis ? dragState.curW : field.width;
              const fh = isDraggingThis ? dragState.curH : field.height;

              const rawValue = draftValues[field.id] ?? field.value;
              const isCheckbox = field.field_type === 'checkbox';
              const isChecked = isCheckbox && rawValue === 'true';
              const hasValue = isCheckbox ? isChecked : rawValue.trim().length > 0;
              const isActive = activeFieldId === field.id;
              const isHovered = hoveredFieldId === field.id;
              const coverDashes = field.cover_dashes === 1;
              const alignment = field.alignment ?? 'left';

              const leftPx = fx * effectiveScale;
              const topPx = fy * effectiveScale;
              const widthPx = Math.max(10, fw * effectiveScale);
              const heightPx = Math.max(10, fh * effectiveScale);

              const scaledFontSize = Math.max(
                8,
                Math.min(22, Number(((field.font_size || 9.5) * effectiveScale).toFixed(1))),
              );

              let boxStyleClasses = 'border-transparent bg-transparent';
              if (isActive) {
                boxStyleClasses = isCheckbox
                  ? 'border-2 border-emerald-600 bg-emerald-500/20 ring-2 ring-emerald-500/35 z-20'
                  : 'border-2 border-blue-600 bg-blue-500/18 ring-2 ring-blue-500/35 z-20';
              } else if (isHovered) {
                boxStyleClasses = isCheckbox
                  ? 'border-2 border-emerald-500 bg-emerald-500/15 z-10'
                  : 'border-2 border-blue-500 bg-blue-500/12 z-10';
              } else if (showFieldHighlights) {
                if (isCheckbox) {
                  boxStyleClasses = isChecked
                    ? 'border border-emerald-700 bg-emerald-500/18 hover:bg-emerald-500/25'
                    : 'border border-emerald-600/80 bg-emerald-500/10 hover:bg-emerald-500/20';
                } else {
                  boxStyleClasses = coverDashes
                    ? 'border-b border-slate-700 bg-white/95 hover:border-blue-600'
                    : hasValue
                      ? 'border border-blue-600/70 bg-blue-500/10 hover:bg-blue-500/18'
                      : 'border border-dashed border-blue-500/85 bg-blue-400/10 hover:bg-blue-500/18';
                }
              } else if (coverDashes) {
                boxStyleClasses = 'border-b border-slate-700 bg-white';
              }

              const justifyClass =
                alignment === 'center'
                  ? 'justify-center text-center'
                  : alignment === 'right'
                    ? 'justify-end text-right'
                    : 'justify-start text-left';

              return (
                <div
                  key={field.id}
                  ref={(el) => {
                    if (el) fieldBoxRefs.current.set(field.id, el);
                    else fieldBoxRefs.current.delete(field.id);
                  }}
                  role="button"
                  tabIndex={0}
                  onMouseDown={(e) => handleStartFieldDrag(e, field, 'move')}
                  onClick={(e) => {
                    if (drawTool !== 'none') return;
                    e.stopPropagation();
                    onSelectFieldFromPreview(field.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectFieldFromPreview(field.id);
                    }
                  }}
                  onMouseEnter={() => onHoverField(field.id)}
                  onMouseLeave={() => onHoverField(null)}
                  title={`${field.label} — Arrastra para mover o haz clic para editar`}
                  style={{
                    left: `${leftPx}px`,
                    top: `${topPx}px`,
                    width: `${widthPx}px`,
                    height: `${heightPx}px`,
                  }}
                  className={`${
                    drawTool === 'none' ? 'pointer-events-auto cursor-move' : 'pointer-events-none'
                  } absolute rounded-[2px] flex items-center px-1 overflow-visible focus:outline-none ${justifyClass} ${boxStyleClasses}`}
                >
                  {/* Floating active/hovered tag + quick X delete button */}
                  {(isActive || isHovered) && drawTool === 'none' && (
                    <div
                      className={`absolute -top-6 left-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap shadow-sm ${
                        isCheckbox
                          ? 'bg-emerald-700 text-white'
                          : isActive
                            ? 'bg-blue-600 text-white'
                            : 'bg-slate-900 text-white'
                      }`}
                    >
                      <span className="max-w-[180px] truncate">{field.label}</span>
                      {isActive && (
                        <button
                          type="button"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteField(field.id);
                          }}
                          aria-label={`Eliminar ${field.label}`}
                          title="Eliminar casilla (Supr)"
                          className="ml-0.5 p-0.5 rounded hover:bg-white/25 transition-colors"
                        >
                          <X className="w-2.5 h-2.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  )}

                  {/* Live value preview inside the box */}
                  {isCheckbox ? (
                    <span className="inline-flex items-center justify-center w-full h-full leading-none">
                      {isChecked ? (
                        field.checkbox_style === 'cross' ? (
                          <X
                            style={{
                              width: `${Math.max(10, Math.min(widthPx, heightPx) * 0.65)}px`,
                              height: `${Math.max(10, Math.min(widthPx, heightPx) * 0.65)}px`,
                            }}
                            className="text-slate-900 stroke-[2.75]"
                            aria-hidden="true"
                          />
                        ) : (
                          <Check
                            style={{
                              width: `${Math.max(10, Math.min(widthPx, heightPx) * 0.72)}px`,
                              height: `${Math.max(10, Math.min(widthPx, heightPx) * 0.72)}px`,
                            }}
                            className="text-blue-700 stroke-[3]"
                            aria-hidden="true"
                          />
                        )
                      ) : (
                        showFieldHighlights && (
                          <span className="text-[9px] font-mono text-emerald-800/80 select-none">
                            {field.checkbox_style === 'cross' ? '✕' : '✓'}
                          </span>
                        )
                      )}
                    </span>
                  ) : hasValue ? (
                    <span
                      style={{ fontSize: `${scaledFontSize}px` }}
                      className={`w-full font-medium text-slate-950 leading-tight ${
                        field.field_type === 'multiline'
                          ? 'whitespace-pre-wrap break-words self-start py-0.5 overflow-hidden h-full'
                          : 'truncate'
                      } ${coverDashes ? 'bg-white' : 'bg-white/75 px-0.5 rounded-[2px]'}`}
                    >
                      {rawValue}
                    </span>
                  ) : (
                    showFieldHighlights &&
                    !coverDashes && (
                      <span className="w-full truncate text-[9px] font-medium text-blue-900/65 leading-tight">
                        {field.label}
                      </span>
                    )
                  )}

                  {/* Bottom-right resize handle on active field */}
                  {isActive && drawTool === 'none' && (
                    <div
                      onMouseDown={(e) => handleStartFieldDrag(e, field, 'resize')}
                      title="Arrastra para redimensionar"
                      className={`absolute -right-1.5 -bottom-1.5 w-3 h-3 rounded-xs border border-white cursor-nwse-resize shadow-xs ${
                        isCheckbox ? 'bg-emerald-600' : 'bg-blue-600'
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Live rubber-band rectangle while drawing a new field with the mouse */}
        {drawDraft && drawTool !== 'none' && (
          <div
            style={{
              left: `${Math.min(drawDraft.startX, drawDraft.curX) * effectiveScale}px`,
              top: `${Math.min(drawDraft.startY, drawDraft.curY) * effectiveScale}px`,
              width: `${Math.max(4, Math.abs(drawDraft.curX - drawDraft.startX) * effectiveScale)}px`,
              height: `${Math.max(4, Math.abs(drawDraft.curY - drawDraft.startY) * effectiveScale)}px`,
            }}
            className={`absolute z-30 pointer-events-none border-2 border-dashed rounded-[2px] ${
              drawTool === 'text'
                ? 'border-blue-600 bg-blue-500/20'
                : 'border-emerald-600 bg-emerald-500/20'
            }`}
          />
        )}

        {/* Empty document placeholder when unsupported type */}
        {!isPdf && !isImage && !isDocx && !isPlainText && (
          <div className="p-12 flex flex-col items-center justify-center text-center gap-3 min-h-[420px]">
            <FileText className="w-8 h-8 text-slate-400" aria-hidden="true" />
            <p className="text-sm font-medium text-slate-700">{document.original_name}</p>
            <p className="text-xs text-slate-500 max-w-sm">
              Vista previa directa disponible para PDF, imágenes (PNG/JPG), Word (.docx) y archivos
              de texto.
            </p>
          </div>
        )}
      </div>

      {/* Color-coded legend under the page */}
      {showFieldHighlights && (
        <div className="flex flex-wrap items-center justify-center gap-4 text-[11px] text-slate-500 dark:text-slate-400 pb-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-[2px] border border-blue-600 bg-blue-500/20" />
            Texto / línea (arrastra para mover o redimensionar)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-[2px] border border-emerald-600 bg-emerald-500/20" />
            Casilla (✓ / ✕)
          </span>
          {drawTool !== 'none' && (
            <span className="font-medium text-blue-700 dark:text-blue-400">
              Modo dibujo activo: haz clic o arrastra sobre el PDF para crear una casilla
            </span>
          )}
        </div>
      )}
    </div>
  );
}
