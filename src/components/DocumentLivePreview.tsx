import { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { AlertCircle, Check, FileText, Loader2 } from 'lucide-react';
import type {
  DocumentField,
  DocumentRecord,
  PlainTextContentResult,
} from '../../shared/types';

interface DocumentLivePreviewProps {
  document: DocumentRecord;
  activePage: number;
  zoomLevel: number;
  fieldsOnPage: DocumentField[];
  draftValues: Record<string, string>;
  activeFieldId: string | null;
  hoveredFieldId: string | null;
  showFieldHighlights: boolean;
  plainTextData: PlainTextContentResult | null;
  onReadWorkingFileBytes: (documentId: string) => Promise<Uint8Array | null>;
  onTotalPagesDetected: (totalPages: number) => void;
  onSelectFieldFromPreview: (fieldId: string) => void;
  onHoverField: (fieldId: string | null) => void;
}

interface PdfPageMetrics {
  widthPt: number;
  heightPt: number;
}

const DEFAULT_PAGE_METRICS: PdfPageMetrics = {
  widthPt: 612,
  heightPt: 792,
};

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
  plainTextData,
  onReadWorkingFileBytes,
  onTotalPagesDetected,
  onSelectFieldFromPreview,
  onHoverField,
}: DocumentLivePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fieldBoxRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageMetrics, setPageMetrics] = useState<PdfPageMetrics>(DEFAULT_PAGE_METRICS);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [docxParagraphs, setDocxParagraphs] = useState<string[] | null>(null);

  const fileType = document.file_type.toLowerCase();
  const isPdf = fileType === 'pdf';
  const isImage = fileType === 'png' || fileType === 'jpg' || fileType === 'jpeg';
  const isDocx = fileType === 'docx';
  const isPlainText = document.diagnosis_type === 'PLAIN_TEXT';

  // Keep a cache of raw bytes per document version so page changes & zooms render instantly
  const bytesCacheRef = useRef<{ key: string; bytes: Uint8Array | null }>({
    key: '',
    bytes: null,
  });

  const docCacheKey = `${document.id}:${document.working_path}:${document.updated_at}`;

  // Scroll the highlighted overlay box into view whenever the active field changes
  useEffect(() => {
    if (!activeFieldId) return;
    const node = fieldBoxRefs.current.get(activeFieldId);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
  }, [activeFieldId, activePage]);

  // Render PDF page onto <canvas> via pdfjs-dist
  useEffect(() => {
    if (!isPdf) return;
    let cancelled = false;
    let loadingTask: { destroy: () => Promise<void> } | null = null;

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
          pdfjs.GlobalWorkerOptions.workerSrc = new URL(
            'pdfjs-dist/build/pdf.worker.min.mjs',
            import.meta.url,
          ).toString();
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

        const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
        const renderViewport = page.getViewport({ scale: zoomLevel * dpr });

        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;

        canvas.width = Math.max(1, Math.round(renderViewport.width));
        canvas.height = Math.max(1, Math.round(renderViewport.height));

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setLoadError('No se pudo inicializar el lienzo 2D para mostrar el PDF.');
          setLoading(false);
          return;
        }

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvas,
          canvasContext: ctx,
          viewport: renderViewport,
        }).promise;

        if (!cancelled) {
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
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
    };
  }, [
    isPdf,
    docCacheKey,
    document.id,
    document.diagnosis_type,
    activePage,
    zoomLevel,
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

  // Reset metrics for plain text or generic sheets
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

  const displayWidthPx = Math.round(pageMetrics.widthPt * zoomLevel);
  const displayHeightPx = Math.round(pageMetrics.heightPt * zoomLevel);

  return (
    <div className="flex flex-col items-center gap-3 w-full">
      {/* Main visual page frame with real document content + interactive highlighted field overlays */}
      <div
        style={{
          width: `${displayWidthPx}px`,
          minHeight: `${displayHeightPx}px`,
        }}
        className="relative bg-white text-slate-900 border border-slate-300 dark:border-slate-700 rounded-md shadow-md overflow-hidden shrink-0 transition-[width] duration-150"
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
          <div className="p-10 space-y-4 min-h-full bg-white text-slate-900">
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
          <div className="p-8 space-y-3 bg-white text-slate-900 min-h-full">
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

        {/* Interactive Field Highlight Layer (marks every editable space right on the document) */}
        {fieldsOnPage.length > 0 && (
          <div
            aria-label="Espacios editables marcados sobre el documento"
            className="absolute inset-0 pointer-events-none z-10"
          >
            {fieldsOnPage.map((field) => {
              const rawValue = draftValues[field.id] ?? field.value;
              const isChecked = field.field_type === 'checkbox' && rawValue === 'true';
              const hasValue =
                field.field_type === 'checkbox' ? isChecked : rawValue.trim().length > 0;
              const isActive = activeFieldId === field.id;
              const isHovered = hoveredFieldId === field.id;

              const leftPct = Math.max(
                0,
                Math.min(94, (field.x / Math.max(1, pageMetrics.widthPt)) * 100),
              );
              const topPct = Math.max(
                0,
                Math.min(95, (field.y / Math.max(1, pageMetrics.heightPt)) * 100),
              );
              const widthPct = Math.max(
                4,
                Math.min(100 - leftPct, (field.width / Math.max(1, pageMetrics.widthPt)) * 100),
              );
              const heightPct = Math.max(
                2.4,
                Math.min(100 - topPct, (field.height / Math.max(1, pageMetrics.heightPt)) * 100),
              );

              const scaledFontSize = Math.max(
                10,
                Math.min(20, Math.round((field.font_size || 11) * zoomLevel)),
              );

              let boxStyleClasses = 'border-transparent bg-transparent';
              if (isActive) {
                boxStyleClasses =
                  'border-2 border-blue-600 bg-blue-500/20 ring-4 ring-blue-500/25 shadow-sm z-20';
              } else if (isHovered) {
                boxStyleClasses =
                  'border-2 border-blue-500 bg-blue-500/12 shadow-xs z-10';
              } else if (showFieldHighlights) {
                boxStyleClasses = hasValue
                  ? 'border border-emerald-600/80 bg-emerald-500/12 hover:bg-emerald-500/20'
                  : 'border border-dashed border-amber-500/90 bg-amber-400/12 hover:bg-blue-500/12 hover:border-blue-500';
              }

              return (
                <button
                  key={field.id}
                  ref={(el) => {
                    if (el) {
                      fieldBoxRefs.current.set(field.id, el);
                    } else {
                      fieldBoxRefs.current.delete(field.id);
                    }
                  }}
                  type="button"
                  onClick={() => onSelectFieldFromPreview(field.id)}
                  onMouseEnter={() => onHoverField(field.id)}
                  onMouseLeave={() => onHoverField(null)}
                  title={`${field.label} — Haz clic para editar este espacio`}
                  style={{
                    left: `${leftPct}%`,
                    top: `${topPct}%`,
                    width: `${widthPct}%`,
                    height: `${heightPct}%`,
                  }}
                  className={`pointer-events-auto absolute rounded-[3px] text-left transition-all duration-150 flex items-center px-1.5 overflow-visible cursor-pointer focus:outline-none ${boxStyleClasses}`}
                >
                  {/* Floating active / hovered label tag */}
                  {(isActive || isHovered) && (
                    <span
                      className={`absolute -top-6 left-0 px-2 py-0.5 rounded text-[11px] font-medium whitespace-nowrap shadow-sm pointer-events-none ${
                        isActive
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-900 text-white'
                      }`}
                    >
                      {isActive ? `Editando: ${field.label}` : field.label}
                    </span>
                  )}

                  {/* Live value preview drawn directly inside the document space */}
                  {field.field_type === 'checkbox' ? (
                    <span className="inline-flex items-center justify-center w-full h-full">
                      {isChecked ? (
                        <Check
                          className="w-4 h-4 text-blue-700 stroke-[3]"
                          aria-hidden="true"
                        />
                      ) : (
                        showFieldHighlights && (
                          <span className="w-3 h-3 rounded-[2px] border border-slate-500/70 bg-white/70" />
                        )
                      )}
                    </span>
                  ) : hasValue ? (
                    <span
                      style={{ fontSize: `${scaledFontSize}px` }}
                      className="w-full truncate font-medium text-slate-950 bg-white/75 px-1 rounded-[2px] leading-tight"
                    >
                      {rawValue}
                    </span>
                  ) : (
                    showFieldHighlights && (
                      <span className="w-full truncate text-[10px] font-medium text-amber-900/80 leading-tight">
                        {field.label}
                      </span>
                    )
                  )}
                </button>
              );
            })}
          </div>
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

      {/* Subtle legend under the page when highlights are active */}
      {showFieldHighlights && fieldsOnPage.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-4 text-[11px] text-slate-500 dark:text-slate-400 pb-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-[2px] border-2 border-blue-600 bg-blue-500/20" />
            Editando ahora
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-[2px] border border-emerald-600 bg-emerald-500/15" />
            Completado
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-[2px] border border-dashed border-amber-500 bg-amber-400/15" />
            Pendiente (clic para editar)
          </span>
        </div>
      )}
    </div>
  );
}
