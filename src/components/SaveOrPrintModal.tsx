import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FolderDown,
  Loader2,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type {
  AcroFormExportResult,
  DocumentField,
  DocumentRecord,
  PrintDocumentOptions,
  PrintDuplexMode,
  PrintPaperSize,
  PrintResult,
  SystemPrinterInfo,
} from '../../shared/types';
import {
  parsePageRange,
  renderImageBytesForPrint,
  renderPdfPagesForPrint,
} from '../services/pdfPrintRenderer';

export type SaveOrPrintInitialTab = 'save' | 'print';

interface SaveOrPrintModalProps {
  open: boolean;
  initialTab: SaveOrPrintInitialTab;
  allowSave: boolean;
  isElectron: boolean;
  document: DocumentRecord;
  fields?: DocumentField[];
  currentPage: number;
  totalPages: number;
  onClose: () => void;
  onSaveToDisk?: () => Promise<AcroFormExportResult>;
  onListPrinters: () => Promise<SystemPrinterInfo[]>;
  onReadWorkingFileBytes: (documentId: string) => Promise<Uint8Array | null>;
  onPrintRenderedDocument: (
    pages: Awaited<ReturnType<typeof renderPdfPagesForPrint>>,
    options: PrintDocumentOptions,
    documentTitle: string,
  ) => Promise<PrintResult>;
}

export function SaveOrPrintModal({
  open,
  initialTab,
  allowSave,
  isElectron,
  document,
  fields,
  currentPage,
  totalPages,
  onClose,
  onSaveToDisk,
  onListPrinters,
  onReadWorkingFileBytes,
  onPrintRenderedDocument,
}: SaveOrPrintModalProps) {
  const [activeTab, setActiveTab] = useState<SaveOrPrintInitialTab>(
    allowSave ? initialTab : 'print',
  );

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<AcroFormExportResult | null>(null);

  // Printers & Print options state
  const [printers, setPrinters] = useState<SystemPrinterInfo[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(false);
  const [selectedPrinter, setSelectedPrinter] = useState<string>('');
  const [copies, setCopies] = useState<number>(1);
  const [collate, setCollate] = useState<boolean>(true);
  const [color, setColor] = useState<boolean>(true);
  const [landscape, setLandscape] = useState<boolean>(false);
  const [pageSize, setPageSize] = useState<PrintPaperSize>('Letter');
  const [duplexMode, setDuplexMode] = useState<PrintDuplexMode>('simplex');
  const [pageRangeMode, setPageRangeMode] = useState<'all' | 'current' | 'custom'>('all');
  const [customPageRange, setCustomPageRange] = useState<string>(
    totalPages > 1 ? `1-${totalPages}` : '1',
  );

  const [printing, setPrinting] = useState(false);
  const [printProgressText, setPrintProgressText] = useState<string>('');
  const [printResult, setPrintResult] = useState<PrintResult | null>(null);

  const safeTotalPages = Math.max(1, totalPages);
  const safeCurrentPage = Math.max(1, Math.min(safeTotalPages, currentPage));
  const fileType = document.file_type.toLowerCase();
  const isPdf = fileType === 'pdf';
  const isImage = fileType === 'png' || fileType === 'jpg' || fileType === 'jpeg';
  const canPrintDocument = isPdf || isImage;

  const filledFieldsCount = useMemo(() => {
    if (!fields) return 0;
    return fields.filter((f) =>
      f.field_type === 'checkbox' ? f.value === 'true' : f.value.trim().length > 0,
    ).length;
  }, [fields]);

  const loadPrinters = useCallback(async () => {
    setLoadingPrinters(true);
    try {
      const list = await onListPrinters();
      setPrinters(list);
      setSelectedPrinter((prev) => {
        if (prev && list.some((p) => p.name === prev)) return prev;
        const defaultPrinter = list.find((p) => p.isDefault) ?? list[0];
        return defaultPrinter?.name ?? '';
      });
    } finally {
      setLoadingPrinters(false);
    }
  }, [onListPrinters]);

  // Reset modal state each time it opens
  useEffect(() => {
    if (!open) return;
    setActiveTab(allowSave ? initialTab : 'print');
    setSaveResult(null);
    setPrintResult(null);
    setPrintProgressText('');
    setPageRangeMode('all');
    setCustomPageRange(safeTotalPages > 1 ? `1-${safeTotalPages}` : '1');
    void loadPrinters();
  }, [open, allowSave, initialTab, safeTotalPages, loadPrinters]);

  // Close with Escape when idle
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving && !printing) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, saving, printing, onClose]);

  const resolvedPages = useMemo(() => {
    if (!isPdf || pageRangeMode === 'all') {
      return {
        valid: true,
        pages: Array.from({ length: safeTotalPages }, (_, idx) => idx + 1),
      };
    }
    if (pageRangeMode === 'current') {
      return {
        valid: true,
        pages: [safeCurrentPage],
      };
    }
    return parsePageRange(customPageRange, safeTotalPages);
  }, [isPdf, pageRangeMode, safeTotalPages, safeCurrentPage, customPageRange]);

  const selectedPrinterObj = useMemo(
    () => printers.find((p) => p.name === selectedPrinter) ?? null,
    [printers, selectedPrinter],
  );

  if (!open) return null;

  const handleSaveClick = async () => {
    if (!onSaveToDisk) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await onSaveToDisk();
      if (!res.canceled) {
        setSaveResult(res);
      }
    } finally {
      setSaving(false);
    }
  };

  const handlePrintClick = async (useSystemDialog: boolean) => {
    if (!canPrintDocument) {
      setPrintResult({
        success: false,
        message: 'La impresión directa está disponible para documentos PDF e imágenes (PNG/JPG).',
      });
      return;
    }

    if (!resolvedPages.valid) {
      setPrintResult({
        success: false,
        message: resolvedPages.error || 'El rango de páginas ingresado no es válido.',
      });
      return;
    }

    setPrinting(true);
    setPrintResult(null);
    setPrintProgressText('Leyendo documento...');

    try {
      const bytes = await onReadWorkingFileBytes(document.id);
      if (!bytes || bytes.byteLength === 0) {
        throw new Error('No se encontraron los bytes del documento en el almacenamiento local.');
      }

      const renderedPages = isPdf
        ? await renderPdfPagesForPrint({
            pdfBytes: bytes,
            fields: fields && fields.length > 0 ? fields : undefined,
            pageNumbers: resolvedPages.pages,
            onProgress: (done, total) => {
              setPrintProgressText(`Preparando página ${done} de ${total} en alta resolución...`);
            },
          })
        : await renderImageBytesForPrint(bytes, fileType);

      setPrintProgressText(
        useSystemDialog
          ? 'Abriendo diálogo de impresión del sistema...'
          : 'Enviando documento a la impresora...',
      );

      const options: PrintDocumentOptions = {
        printerName: selectedPrinter || undefined,
        copies: Math.max(1, Math.min(99, copies)),
        color,
        landscape,
        duplexMode,
        pageSize,
        collate,
        pageRangeMode,
        customPageRange: pageRangeMode === 'custom' ? customPageRange : undefined,
        useSystemDialog,
      };

      const res = await onPrintRenderedDocument(renderedPages, options, document.original_name);
      if (!res.canceled) {
        setPrintResult(res);
      }
    } catch (err) {
      setPrintResult({
        success: false,
        message: 'No se pudo enviar el documento a imprimir.',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPrinting(false);
      setPrintProgressText('');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-or-print-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving && !printing) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-xl rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h2
              id="save-or-print-title"
              className="text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              {allowSave ? 'Guardar o imprimir documento' : 'Imprimir documento'}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 truncate">
              {document.original_name}
              <span aria-hidden="true"> · </span>
              <span className="font-mono tabular-nums">
                {safeTotalPages} {safeTotalPages === 1 ? 'página' : 'páginas'}
              </span>
              {fields && fields.length > 0 && (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="font-mono tabular-nums">
                    {filledFieldsCount}/{fields.length} campos completados
                  </span>
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            disabled={saving || printing}
            onClick={onClose}
            aria-label="Cerrar ventana"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors shrink-0"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Mode selector: Guardar vs Imprimir (when opened from Editor) */}
        {allowSave && (
          <div className="px-6 pt-4 shrink-0">
            <div
              role="tablist"
              aria-label="Elegir destino del documento"
              className="grid grid-cols-2 gap-1.5 p-1 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'save'}
                disabled={saving || printing}
                onClick={() => setActiveTab('save')}
                className={`flex items-center justify-center gap-2 py-2 px-3 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  activeTab === 'save'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <FolderDown className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>Guardar en el equipo</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'print'}
                disabled={saving || printing}
                onClick={() => setActiveTab('print')}
                className={`flex items-center justify-center gap-2 py-2 px-3 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  activeTab === 'print'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Printer className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>Imprimir documento</span>
              </button>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto space-y-5">
          {activeTab === 'save' && allowSave ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 p-4 space-y-2">
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Guardar copia PDF rellenable (AcroForm) en cualquier carpeta
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  {isElectron
                    ? 'Se abrirá el explorador de Windows para que elijas la carpeta y el nombre del archivo. Se conservarán todos los textos escritos, casillas marcadas y campos editables.'
                    : 'Se descargará el archivo PDF rellenable con todos los cambios y campos editables aplicados.'}
                </p>
                {fields && fields.length > 0 && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 pt-1 font-mono tabular-nums">
                    {fields.length} campo(s) AcroForm · {filledFieldsCount} con datos ingresados
                  </p>
                )}
              </div>

              {saveResult && (
                <div
                  role="status"
                  className={`p-3.5 rounded-lg border text-xs flex items-start gap-2.5 ${
                    saveResult.success
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/70 text-emerald-900 dark:text-emerald-200'
                      : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/70 text-red-900 dark:text-red-200'
                  }`}
                >
                  {saveResult.success ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                  ) : (
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                  )}
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">{saveResult.message}</p>
                    {saveResult.outputPath && (
                      <p className="font-mono text-[11px] opacity-85 break-all">
                        {saveResult.outputPath}
                      </p>
                    )}
                    {saveResult.error && <p className="opacity-85">{saveResult.error}</p>}
                  </div>
                </div>
              )}

              {saveResult?.success && (
                <div className="flex items-center justify-between gap-3 pt-1">
                  <span className="text-xs text-slate-600 dark:text-slate-400">
                    ¿También necesitas imprimir una copia en papel?
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveTab('print')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Ir a imprimir</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Printer selector */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="print-device-select"
                    className="text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Impresora disponible
                  </label>
                  <button
                    type="button"
                    disabled={loadingPrinters || printing}
                    onClick={() => void loadPrinters()}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 dark:text-blue-400 hover:underline disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`w-3 h-3 ${loadingPrinters ? 'animate-spin' : ''}`}
                      aria-hidden="true"
                    />
                    <span>Actualizar lista</span>
                  </button>
                </div>

                {loadingPrinters ? (
                  <div className="h-9 px-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex items-center gap-2 text-xs text-slate-500">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    <span>Buscando impresoras instaladas en el equipo...</span>
                  </div>
                ) : printers.length > 0 ? (
                  <>
                    <select
                      id="print-device-select"
                      value={selectedPrinter}
                      disabled={printing}
                      onChange={(e) => setSelectedPrinter(e.target.value)}
                      className="w-full h-9 px-3 rounded-lg text-xs font-medium bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
                    >
                      {printers.map((printer) => (
                        <option key={printer.name} value={printer.name}>
                          {printer.displayName}
                          {printer.isDefault ? ' (Predeterminada)' : ''}
                        </option>
                      ))}
                    </select>
                    {selectedPrinterObj?.description && (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        {selectedPrinterObj.description}
                      </p>
                    )}
                  </>
                ) : (
                  <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/70 text-xs text-amber-900 dark:text-amber-200">
                    No se detectaron impresoras locales automáticamente. Puedes usar el botón{' '}
                    <strong>Diálogo de Windows</strong> para elegir una impresora del sistema.
                  </div>
                )}
              </div>

              {/* Pages & Copies row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Page range */}
                <div className="space-y-1.5">
                  <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Páginas
                  </span>
                  <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                    <button
                      type="button"
                      disabled={printing}
                      onClick={() => setPageRangeMode('all')}
                      className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                        pageRangeMode === 'all'
                          ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      Todas
                    </button>
                    <button
                      type="button"
                      disabled={printing || !isPdf}
                      onClick={() => setPageRangeMode('current')}
                      className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-40 ${
                        pageRangeMode === 'current'
                          ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      Actual ({safeCurrentPage})
                    </button>
                    <button
                      type="button"
                      disabled={printing || !isPdf || safeTotalPages <= 1}
                      onClick={() => setPageRangeMode('custom')}
                      className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-40 ${
                        pageRangeMode === 'custom'
                          ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      Rango
                    </button>
                  </div>

                  {pageRangeMode === 'custom' && (
                    <div className="space-y-1">
                      <input
                        type="text"
                        value={customPageRange}
                        disabled={printing}
                        onChange={(e) => setCustomPageRange(e.target.value)}
                        placeholder={`Ej. 1-${Math.min(3, safeTotalPages)}, ${safeTotalPages}`}
                        aria-label="Rango personalizado de páginas"
                        className="w-full h-8 px-2.5 rounded-lg text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
                      />
                      {resolvedPages.valid ? (
                        <p className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                          Se imprimirán {resolvedPages.pages.length} página(s):{' '}
                          {resolvedPages.pages.join(', ')}
                        </p>
                      ) : (
                        <p className="text-[11px] text-red-600 dark:text-red-400">
                          {resolvedPages.error}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Copies & Collate */}
                <div className="space-y-1.5">
                  <label
                    htmlFor="print-copies-input"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Copias
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="inline-flex items-center border border-slate-300 dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-950 overflow-hidden">
                      <button
                        type="button"
                        disabled={printing || copies <= 1}
                        onClick={() => setCopies((c) => Math.max(1, c - 1))}
                        aria-label="Reducir copias"
                        className="h-8 w-8 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
                      >
                        <Minus className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                      <input
                        id="print-copies-input"
                        type="number"
                        min={1}
                        max={99}
                        disabled={printing}
                        value={copies}
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value, 10);
                          setCopies(Number.isFinite(n) ? Math.max(1, Math.min(99, n)) : 1);
                        }}
                        className="w-12 h-8 text-center text-xs font-mono tabular-nums bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={printing || copies >= 99}
                        onClick={() => setCopies((c) => Math.min(99, c + 1))}
                        aria-label="Aumentar copias"
                        className="h-8 w-8 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </div>

                    {copies > 1 && (
                      <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={collate}
                          disabled={printing}
                          onChange={(e) => setCollate(e.target.checked)}
                          className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600"
                        />
                        <span>Intercalar</span>
                      </label>
                    )}
                  </div>
                </div>
              </div>

              {/* Orientation & Color row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Orientación
                  </span>
                  <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                    <button
                      type="button"
                      disabled={printing}
                      onClick={() => setLandscape(false)}
                      className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                        !landscape
                          ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      Vertical
                    </button>
                    <button
                      type="button"
                      disabled={printing}
                      onClick={() => setLandscape(true)}
                      className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                        landscape
                          ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      Horizontal
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Color
                  </span>
                  <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                    <button
                      type="button"
                      disabled={printing}
                      onClick={() => setColor(true)}
                      className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                        color
                          ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      Color
                    </button>
                    <button
                      type="button"
                      disabled={printing}
                      onClick={() => setColor(false)}
                      className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                        !color
                          ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      Blanco y negro
                    </button>
                  </div>
                </div>
              </div>

              {/* Paper size & Duplex row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="print-paper-size"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Tamaño de papel
                  </label>
                  <select
                    id="print-paper-size"
                    value={pageSize}
                    disabled={printing}
                    onChange={(e) => setPageSize(e.target.value as PrintPaperSize)}
                    className="w-full h-9 px-3 rounded-lg text-xs font-medium bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
                  >
                    <option value="Letter">Carta (Letter · 216 × 279 mm)</option>
                    <option value="A4">A4 (210 × 297 mm)</option>
                    <option value="Legal">Oficio (Legal · 216 × 356 mm)</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="print-duplex-mode"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Impresión a doble cara
                  </label>
                  <select
                    id="print-duplex-mode"
                    value={duplexMode}
                    disabled={printing}
                    onChange={(e) => setDuplexMode(e.target.value as PrintDuplexMode)}
                    className="w-full h-9 px-3 rounded-lg text-xs font-medium bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
                  >
                    <option value="simplex">Una cara</option>
                    <option value="longEdge">Doble cara (girar por borde largo)</option>
                    <option value="shortEdge">Doble cara (girar por borde corto)</option>
                  </select>
                </div>
              </div>

              {/* Active progress or print feedback */}
              {printing && printProgressText && (
                <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900/70 flex items-center gap-2.5 text-xs text-blue-900 dark:text-blue-200">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
                  <span>{printProgressText}</span>
                </div>
              )}

              {printResult && (
                <div
                  role="status"
                  className={`p-3.5 rounded-lg border text-xs flex items-start gap-2.5 ${
                    printResult.success
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/70 text-emerald-900 dark:text-emerald-200'
                      : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/70 text-red-900 dark:text-red-200'
                  }`}
                >
                  {printResult.success ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                  ) : (
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                  )}
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-medium">{printResult.message}</p>
                    {printResult.error && <p className="opacity-85">{printResult.error}</p>}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 flex flex-wrap items-center justify-between gap-3 shrink-0">
          {activeTab === 'print' && isElectron ? (
            <button
              type="button"
              disabled={printing || !canPrintDocument || !resolvedPages.valid}
              onClick={() => void handlePrintClick(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Diálogo de Windows</span>
            </button>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              disabled={saving || printing}
              onClick={onClose}
              className="px-3.5 py-2 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap"
            >
              {saveResult?.success || printResult?.success ? 'Cerrar' : 'Cancelar'}
            </button>

            {activeTab === 'save' && allowSave ? (
              <button
                type="button"
                disabled={saving || !onSaveToDisk}
                onClick={() => void handleSaveClick()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white disabled:opacity-55 transition-colors whitespace-nowrap"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
                    <span>Guardando...</span>
                  </>
                ) : (
                  <>
                    <FolderDown className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>Elegir carpeta y guardar</span>
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                disabled={printing || !canPrintDocument || !resolvedPages.valid}
                onClick={() => void handlePrintClick(false)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white disabled:opacity-55 transition-colors whitespace-nowrap"
              >
                {printing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
                    <span>Imprimiendo...</span>
                  </>
                ) : (
                  <>
                    <Printer className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>Imprimir</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
