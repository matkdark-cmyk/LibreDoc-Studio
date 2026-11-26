import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  FileText,
  Loader2,
  MousePointer2,
  Plus,
  Printer,
  Save,
  Search,
  Sparkles,
  Square,
  Trash2,
  Type,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  AcroFormExportResult,
  CheckboxStyle,
  DocumentField,
  DocumentRecord,
  FieldAlignment,
  FieldType,
  PlainTextContentResult,
  PrintDocumentOptions,
  PrintRenderedPage,
  PrintResult,
  SessionState,
  SessionStatePatch,
  SidebarTab,
  SystemPrinterInfo,
  UpsertFieldInput,
} from '../../shared/types';
import {
  DocumentLivePreview,
  type DrawnFieldRect,
  type PreviewDrawTool,
} from '../components/DocumentLivePreview';
import {
  SaveOrPrintModal,
  type SaveOrPrintInitialTab,
} from '../components/SaveOrPrintModal';

interface EditorPageProps {
  document: DocumentRecord | null;
  recentDocuments: DocumentRecord[];
  fields: DocumentField[];
  session: SessionState;
  isElectron: boolean;
  detectingFields: boolean;
  detectProgress: { currentPage: number; totalPages: number } | null;
  exportingPdf: boolean;
  editorFeedback: { success: boolean; message: string; error?: string } | null;
  onClearEditorFeedback: () => void;
  onSelectDocument: (documentId: string) => void;
  onGoToWorkspace: () => void;
  onPatchSession: (patch: SessionStatePatch) => void;
  onUpsertField: (input: UpsertFieldInput) => Promise<void>;
  onUpdateFieldValue: (fieldId: string, value: string) => Promise<void>;
  onDeleteField: (fieldId: string) => Promise<void>;
  onDetectPdfFields: (documentId: string) => Promise<void>;
  onExportAcroForm: (documentId: string, currentFields?: DocumentField[]) => Promise<AcroFormExportResult>;
  onListPrinters: () => Promise<SystemPrinterInfo[]>;
  onPrintRenderedDocument: (
    pages: PrintRenderedPage[],
    options: PrintDocumentOptions,
    documentTitle: string,
  ) => Promise<PrintResult>;
  onReadPlainText: (documentId: string) => Promise<PlainTextContentResult | null>;
  onReadWorkingFileBytes: (documentId: string) => Promise<Uint8Array | null>;
}

const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 1.75];

export function EditorPage({
  document,
  recentDocuments,
  fields,
  session,
  isElectron,
  detectingFields,
  detectProgress,
  exportingPdf,
  editorFeedback,
  onClearEditorFeedback,
  onSelectDocument,
  onGoToWorkspace,
  onPatchSession,
  onUpsertField,
  onUpdateFieldValue,
  onDeleteField,
  onDetectPdfFields,
  onExportAcroForm,
  onListPrinters,
  onPrintRenderedDocument,
  onReadPlainText,
  onReadWorkingFileBytes,
}: EditorPageProps) {
  const [fieldSearch, setFieldSearch] = useState('');
  const [showAddField, setShowAddField] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newGroup, setNewGroup] = useState('Datos personales');
  const [newType, setNewType] = useState<FieldType>('text');
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [saveIndicator, setSaveIndicator] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [plainTextData, setPlainTextData] = useState<PlainTextContentResult | null>(null);
  const [detectedPages, setDetectedPages] = useState<number | null>(null);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [hoveredFieldId, setHoveredFieldId] = useState<string | null>(null);
  const [showFieldHighlights, setShowFieldHighlights] = useState(true);
  const [drawTool, setDrawTool] = useState<PreviewDrawTool>('none');
  const [saveOrPrintTab, setSaveOrPrintTab] = useState<SaveOrPrintInitialTab | null>(null);

  const timersRef = useRef<Map<string, number>>(new Map());
  const scrollTimerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const fieldInputRefs = useRef<Map<string, HTMLInputElement | HTMLTextAreaElement>>(new Map());
  const restoredScrollForDocRef = useRef<string | null>(null);

  const isPdfDoc = document?.file_type.toLowerCase() === 'pdf';
  const totalPages = Math.max(
    1,
    detectedPages ?? document?.analysis?.details.pageCount ?? 1,
  );

  // Reset per-document UI state when switching documents
  useEffect(() => {
    setDetectedPages(null);
    setActiveFieldId(null);
    setHoveredFieldId(null);
    setDrawTool('none');
  }, [document?.id]);

  // Escape key exits drawing tool mode
  useEffect(() => {
    if (drawTool === 'none') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawTool('none');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawTool]);

  // Load plain text content when viewing PLAIN_TEXT documents
  useEffect(() => {
    let active = true;
    if (!document || document.diagnosis_type !== 'PLAIN_TEXT') {
      setPlainTextData(null);
      return;
    }

    onReadPlainText(document.id).then((res) => {
      if (active) {
        setPlainTextData(res);
      }
    });

    return () => {
      active = false;
    };
  }, [document, onReadPlainText]);

  // Sync draft field values when document or fields reload from SQLite
  useEffect(() => {
    const nextDrafts: Record<string, string> = {};
    for (const field of fields) {
      nextDrafts[field.id] = field.value;
    }
    setDraftValues(nextDrafts);
  }, [fields]);

  // Clear pending debounce timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timeoutId of timers.values()) {
        window.clearTimeout(timeoutId);
      }
      timers.clear();
      if (scrollTimerRef.current !== null) {
        window.clearTimeout(scrollTimerRef.current);
      }
    };
  }, []);

  // Restore saved scroll_position once when document opens
  useEffect(() => {
    if (!document || !canvasRef.current) return;
    const key = `${document.id}:${session.active_page}`;
    if (restoredScrollForDocRef.current === key) return;
    restoredScrollForDocRef.current = key;
    canvasRef.current.scrollTop = session.scroll_position;
  }, [document, session.active_page, session.scroll_position]);

  const filteredFields = useMemo(() => {
    const q = fieldSearch.trim().toLowerCase();
    return fields.filter((field) => {
      if (!q) return true;
      return (
        field.label.toLowerCase().includes(q) ||
        field.group_name.toLowerCase().includes(q) ||
        (draftValues[field.id] ?? field.value).toLowerCase().includes(q)
      );
    });
  }, [fields, fieldSearch, draftValues]);

  const groupedFields = useMemo(() => {
    const map = new Map<string, DocumentField[]>();
    for (const field of filteredFields) {
      const group = field.group_name || 'Datos generales';
      const existing = map.get(group) ?? [];
      existing.push(field);
      map.set(group, existing);
    }
    return Array.from(map.entries());
  }, [filteredFields]);

  const activePageFields = useMemo(
    () => fields.filter((field) => field.page_number === session.active_page),
    [fields, session.active_page],
  );

  const completedCount = useMemo(() => {
    return fields.filter((field) => {
      const val = draftValues[field.id] ?? field.value;
      return field.field_type === 'checkbox' ? val === 'true' : val.trim().length > 0;
    }).length;
  }, [fields, draftValues]);

  const activeFieldObj = useMemo(
    () => fields.find((f) => f.id === activeFieldId) ?? null,
    [fields, activeFieldId],
  );

  const scheduleFieldSave = (fieldId: string, nextValue: string) => {
    setDraftValues((prev) => ({ ...prev, [fieldId]: nextValue }));
    setSaveIndicator('saving');

    const prevTimer = timersRef.current.get(fieldId);
    if (prevTimer !== undefined) {
      window.clearTimeout(prevTimer);
    }

    const timerId = window.setTimeout(async () => {
      timersRef.current.delete(fieldId);
      await onUpdateFieldValue(fieldId, nextValue);
      setSaveIndicator('saved');
    }, 350);

    timersRef.current.set(fieldId, timerId);
  };

  const flushFieldNow = async (fieldId: string) => {
    const prevTimer = timersRef.current.get(fieldId);
    if (prevTimer !== undefined) {
      window.clearTimeout(prevTimer);
      timersRef.current.delete(fieldId);
      const val = draftValues[fieldId] ?? '';
      await onUpdateFieldValue(fieldId, val);
      setSaveIndicator('saved');
    }
  };

  const handleFocusFieldInPanel = (field: DocumentField) => {
    setActiveFieldId(field.id);
    if (field.page_number !== session.active_page) {
      onPatchSession({ active_page: field.page_number, scroll_position: 0 });
    }
  };

  const handleSelectFieldFromPreview = useCallback(
    (fieldId: string) => {
      setActiveFieldId(fieldId);
      if (session.sidebar_tab !== 'fields') {
        onPatchSession({ sidebar_tab: 'fields' });
      }
      window.setTimeout(() => {
        const inputEl = fieldInputRefs.current.get(fieldId);
        if (inputEl) {
          inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 30);
    },
    [session.sidebar_tab, onPatchSession],
  );

  const handleAddField = async (event: FormEvent) => {
    event.preventDefault();
    if (!document || newLabel.trim() === '') return;

    const samePageCount = fields.filter((f) => f.page_number === session.active_page).length;
    await onUpsertField({
      document_id: document.id,
      page_number: session.active_page,
      label: newLabel.trim(),
      value: newType === 'checkbox' ? 'false' : '',
      field_type: newType,
      x: 56,
      y: Math.min(700, 84 + samePageCount * 42),
      width: newType === 'checkbox' ? 18 : 220,
      height: newType === 'multiline' ? 56 : newType === 'checkbox' ? 18 : 20,
      font_size: 9.5,
      checkbox_style: 'check',
      alignment: newType === 'checkbox' ? 'center' : 'left',
      cover_dashes: 0,
      group_name: newGroup.trim() || 'Datos generales',
      source: 'manual',
    });

    setNewLabel('');
    setShowAddField(false);
    setSaveIndicator('saved');
  };

  const handleMoveOrResizeField = useCallback(
    async (
      field: DocumentField,
      geometry: { x: number; y: number; width: number; height: number },
    ) => {
      setSaveIndicator('saving');
      await onUpsertField({
        ...field,
        value: draftValues[field.id] ?? field.value,
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        source: 'manual',
      });
      setSaveIndicator('saved');
    },
    [draftValues, onUpsertField],
  );

  const handleCreateDrawnField = useCallback(
    async (rect: DrawnFieldRect) => {
      if (!document) return;
      const samePageCount = fields.filter((f) => f.page_number === session.active_page).length;
      const isCheck = rect.field_type === 'checkbox';
      const defaultLabel = isCheck
        ? rect.checkbox_style === 'cross'
          ? `Casilla X (Pág. ${session.active_page} #${samePageCount + 1})`
          : `Casilla ✓ (Pág. ${session.active_page} #${samePageCount + 1})`
        : `Campo manual (Pág. ${session.active_page} #${samePageCount + 1})`;

      const dynamicFont = Number(
        Math.max(6.5, Math.min(10, rect.height * 0.62)).toFixed(1),
      );

      setSaveIndicator('saving');
      await onUpsertField({
        document_id: document.id,
        page_number: session.active_page,
        label: defaultLabel,
        value: isCheck ? 'false' : '',
        field_type: rect.field_type,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        font_size: rect.field_type === 'multiline' ? 9.5 : dynamicFont,
        checkbox_style: rect.checkbox_style ?? 'check',
        alignment: isCheck ? 'center' : 'left',
        cover_dashes: 0,
        group_name: `Página ${session.active_page} (Manual)`,
        tooltip: defaultLabel,
        source: 'manual',
      });
      setSaveIndicator('saved');
      setDrawTool('none');
    },
    [document, fields, session.active_page, onUpsertField],
  );

  const handleUpdateFieldProperty = useCallback(
    async (
      field: DocumentField,
      patch: Partial<
        Pick<
          DocumentField,
          'field_type' | 'checkbox_style' | 'alignment' | 'font_size' | 'cover_dashes' | 'label'
        >
      >,
    ) => {
      setSaveIndicator('saving');
      const nextType = patch.field_type ?? field.field_type;
      const currentVal = draftValues[field.id] ?? field.value;
      const nextVal =
        nextType === 'checkbox'
          ? currentVal === 'true'
            ? 'true'
            : 'false'
          : field.field_type === 'checkbox'
            ? ''
            : currentVal;

      await onUpsertField({
        ...field,
        ...patch,
        value: nextVal,
        source: 'manual',
      });
      setSaveIndicator('saved');
    },
    [draftValues, onUpsertField],
  );

  const handleDeleteFieldSafe = useCallback(
    async (fieldId: string) => {
      await onDeleteField(fieldId);
      setActiveFieldId((prev) => (prev === fieldId ? null : prev));
    },
    [onDeleteField],
  );

  const flushPendingDrafts = useCallback(async (): Promise<DocumentField[]> => {
    for (const [fId, timer] of timersRef.current.entries()) {
      window.clearTimeout(timer);
      timersRef.current.delete(fId);
      const val = draftValues[fId];
      if (val !== undefined) {
        await onUpdateFieldValue(fId, val);
      }
    }
    return fields.map((f) => ({
      ...f,
      value: draftValues[f.id] ?? f.value,
    }));
  }, [draftValues, fields, onUpdateFieldValue]);

  const mergedFieldsForOutput = useMemo<DocumentField[]>(
    () =>
      fields.map((f) => ({
        ...f,
        value: draftValues[f.id] ?? f.value,
      })),
    [fields, draftValues],
  );

  const handleOpenSaveOrPrint = async (tab: SaveOrPrintInitialTab) => {
    if (!document) return;
    await flushPendingDrafts();
    setSaveOrPrintTab(tab);
  };

  const handleExportWithDrafts = async (): Promise<AcroFormExportResult> => {
    if (!document) {
      return {
        success: false,
        fieldsExported: 0,
        message: 'No hay ningún documento activo.',
      };
    }
    const mergedFields = await flushPendingDrafts();
    return onExportAcroForm(document.id, mergedFields);
  };

  const handleCanvasScroll = () => {
    if (!canvasRef.current) return;
    const top = Math.round(canvasRef.current.scrollTop);

    if (scrollTimerRef.current !== null) {
      window.clearTimeout(scrollTimerRef.current);
    }
    scrollTimerRef.current = window.setTimeout(() => {
      onPatchSession({ scroll_position: top });
    }, 250);
  };

  const handleSetZoom = (nextZoom: number) => {
    const clamped = Math.min(1.75, Math.max(0.75, Number(nextZoom.toFixed(2))));
    onPatchSession({ zoom_level: clamped });
  };

  const handleSetPage = (nextPage: number) => {
    const clamped = Math.min(totalPages, Math.max(1, nextPage));
    onPatchSession({ active_page: clamped, scroll_position: 0 });
    if (canvasRef.current) {
      canvasRef.current.scrollTop = 0;
    }
  };

  const handleSetSidebarTab = (tab: SidebarTab) => {
    onPatchSession({ sidebar_tab: tab });
  };

  const handleTotalPagesDetected = useCallback((count: number) => {
    setDetectedPages(count);
  }, []);

  if (!document) {
    return (
      <div className="max-w-3xl mx-auto px-8 py-14">
        <div className="p-8 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-center">
          <div className="w-11 h-11 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 mx-auto flex items-center justify-center">
            <FileText className="w-5 h-5" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
            Ningún documento activo en el editor
          </h1>
          <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
            Selecciona un documento reciente o carga un PDF en Inicio para detectar sus casillas y
            editarlo con vista previa en vivo.
          </p>

          {recentDocuments.length > 0 && (
            <div className="mt-6 text-left border-t border-slate-200 dark:border-slate-800 pt-5 space-y-2">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Documentos recientes guardados
              </p>
              <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
                {recentDocuments.slice(0, 5).map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => onSelectDocument(doc.id)}
                    className="w-full px-4 py-2.5 flex items-center justify-between text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
                  >
                    <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
                      {doc.original_name}
                    </span>
                    <span className="font-mono text-xs text-slate-500 dark:text-slate-400 shrink-0 ml-3">
                      {doc.diagnosis_type}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-6">
            <button
              type="button"
              onClick={onGoToWorkspace}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors"
            >
              Ir a Inicio / Documentos
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col lg:flex-row min-h-0">
      {/* Left Panel: Vista General de Datos (Editable Fields & Actions) */}
      <section className="w-full lg:w-[390px] shrink-0 flex flex-col bg-white dark:bg-slate-900 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 min-h-0">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
              Vista General de Datos
            </h2>
            <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
              {saveIndicator === 'saving' ? (
                'Guardando...'
              ) : saveIndicator === 'saved' ? (
                <span className="inline-flex items-center gap-1 font-sans text-emerald-700 dark:text-emerald-400">
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  Guardado
                </span>
              ) : (
                `${completedCount}/${fields.length} completados`
              )}
            </span>
          </div>

          {/* Primary AcroForm Auto-Detect & Export Action Buttons for PDFs */}
          {isPdfDoc && (
            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                disabled={detectingFields || exportingPdf}
                onClick={() => void onDetectPdfFields(document.id)}
                className="w-full inline-flex items-center justify-center gap-2 h-8 px-3 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-white text-white dark:text-slate-950 disabled:opacity-55 transition-colors"
              >
                {detectingFields ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    <span>
                      {detectProgress
                        ? `Analizando pág. ${detectProgress.currentPage}/${detectProgress.totalPages}...`
                        : 'Detectando casillas...'}
                    </span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Detectar casillas automáticamente</span>
                  </>
                )}
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={exportingPdf || detectingFields}
                  onClick={() =>
                    void handleOpenSaveOrPrint(fields.length > 0 ? 'save' : 'print')
                  }
                  className="flex-1 inline-flex items-center justify-center gap-2 h-8 px-3 rounded-lg text-xs font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  {exportingPdf ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
                      <span>Guardando PDF...</span>
                    </>
                  ) : (
                    <>
                      <Save className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      <span>Guardar o imprimir</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  disabled={exportingPdf || detectingFields}
                  onClick={() => void handleOpenSaveOrPrint('print')}
                  title="Imprimir documento con cambios"
                  className="inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <Printer className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>Imprimir</span>
                </button>
              </div>
            </div>
          )}

          {/* Feedback alert for detection / export */}
          {editorFeedback && (
            <div
              role="status"
              className={`p-2.5 rounded-lg border text-xs flex items-start justify-between gap-2 ${
                editorFeedback.success
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                  : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-900 dark:text-red-200'
              }`}
            >
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium leading-snug">{editorFeedback.message}</p>
                {editorFeedback.error && (
                  <p className="opacity-85 break-words">{editorFeedback.error}</p>
                )}
              </div>
              <button
                type="button"
                onClick={onClearEditorFeedback}
                aria-label="Cerrar aviso"
                className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 shrink-0"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          <div
            role="tablist"
            aria-label="Pestañas del panel de datos"
            className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800"
          >
            <button
              type="button"
              role="tab"
              aria-selected={session.sidebar_tab === 'fields'}
              onClick={() => handleSetSidebarTab('fields')}
              className={`py-1.5 px-3 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                session.sidebar_tab === 'fields'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Campos ({fields.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={session.sidebar_tab === 'info'}
              onClick={() => handleSetSidebarTab('info')}
              className={`py-1.5 px-3 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                session.sidebar_tab === 'info'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Información
            </button>
          </div>
        </div>

        {session.sidebar_tab === 'fields' ? (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <div className="relative flex-1">
                <Search
                  className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={fieldSearch}
                  onChange={(e) => setFieldSearch(e.target.value)}
                  placeholder="Filtrar campos..."
                  aria-label="Filtrar campos"
                  className="w-full h-8 pl-8 pr-2.5 rounded-md text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
                />
              </div>

              <button
                type="button"
                onClick={() => setShowAddField((prev) => !prev)}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-xs font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700 transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Campo</span>
              </button>
            </div>

            {showAddField && (
              <form
                onSubmit={handleAddField}
                className="p-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 space-y-2.5"
              >
                <div>
                  <label
                    htmlFor="new-field-label"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Etiqueta del campo (Página {session.active_page})
                  </label>
                  <input
                    id="new-field-label"
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="Ej. Nombre completo, RUT, Correo..."
                    className="w-full h-8 px-2.5 rounded-md text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
                    autoFocus
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label
                      htmlFor="new-field-group"
                      className="block text-xs text-slate-600 dark:text-slate-400 mb-1"
                    >
                      Sección
                    </label>
                    <input
                      id="new-field-group"
                      type="text"
                      value={newGroup}
                      onChange={(e) => setNewGroup(e.target.value)}
                      className="w-full h-8 px-2.5 rounded-md text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="new-field-type"
                      className="block text-xs text-slate-600 dark:text-slate-400 mb-1"
                    >
                      Tipo
                    </label>
                    <select
                      id="new-field-type"
                      value={newType}
                      onChange={(e) => setNewType(e.target.value as FieldType)}
                      className="w-full h-8 px-2 rounded-md text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
                    >
                      <option value="text">Texto</option>
                      <option value="date">Fecha</option>
                      <option value="multiline">Párrafo</option>
                      <option value="checkbox">Casilla</option>
                    </select>
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowAddField(false)}
                    className="px-2.5 py-1 rounded-md text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={newLabel.trim() === ''}
                    className="px-3 py-1 rounded-md text-xs font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white disabled:opacity-50"
                  >
                    Guardar campo
                  </button>
                </div>
              </form>
            )}

            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              {groupedFields.length === 0 ? (
                <div className="py-10 text-center space-y-2">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                    Sin campos registrados todavía
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs mx-auto">
                    Pulsa «Detectar casillas automáticamente» o dibuja casillas directamente sobre
                    el documento en el panel derecho.
                  </p>
                </div>
              ) : (
                groupedFields.map(([groupName, groupItems]) => (
                  <div key={groupName} className="space-y-2.5">
                    <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 pb-1.5">
                      <span className="font-medium text-slate-700 dark:text-slate-300 truncate">
                        {groupName}
                      </span>
                      <span className="font-mono tabular-nums shrink-0 ml-2">
                        {groupItems.length}
                      </span>
                    </div>

                    <div className="space-y-2.5">
                      {groupItems.map((field) => {
                        const val = draftValues[field.id] ?? field.value;
                        const isActive = activeFieldId === field.id;
                        const isHovered = hoveredFieldId === field.id;
                        const isCheckbox = field.field_type === 'checkbox';
                        const isFilled = isCheckbox ? val === 'true' : val.trim().length > 0;

                        return (
                          <div
                            key={field.id}
                            onMouseEnter={() => setHoveredFieldId(field.id)}
                            onMouseLeave={() => setHoveredFieldId(null)}
                            className={`p-2.5 rounded-lg border transition-colors space-y-1.5 ${
                              isActive
                                ? isCheckbox
                                  ? 'border-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/30 dark:border-emerald-500'
                                  : 'border-blue-500 bg-blue-50/70 dark:bg-blue-950/35 dark:border-blue-500'
                                : isHovered
                                  ? 'border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40'
                                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <label
                                htmlFor={`field-${field.id}`}
                                className="flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 truncate cursor-pointer"
                              >
                                <span
                                  className={`w-2 h-2 rounded-full shrink-0 ${
                                    isCheckbox
                                      ? isFilled
                                        ? 'bg-emerald-600'
                                        : 'bg-emerald-400'
                                      : isActive
                                        ? 'bg-blue-600'
                                        : isFilled
                                          ? 'bg-blue-500'
                                          : 'bg-amber-400'
                                  }`}
                                  aria-hidden="true"
                                />
                                <span className="truncate">{field.label}</span>
                              </label>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => handleFocusFieldInPanel(field)}
                                  title="Resaltar este espacio en la vista del documento"
                                  className="inline-flex items-center gap-1 text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                                >
                                  <Crosshair className="w-3 h-3" aria-hidden="true" />
                                  <span>Pág. {field.page_number}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteFieldSafe(field.id)}
                                  aria-label={`Eliminar campo ${field.label}`}
                                  className="text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                                >
                                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                              </div>
                            </div>

                            {field.field_type === 'multiline' ? (
                              <textarea
                                ref={(el) => {
                                  if (el) fieldInputRefs.current.set(field.id, el);
                                  else fieldInputRefs.current.delete(field.id);
                                }}
                                id={`field-${field.id}`}
                                rows={3}
                                value={val}
                                onFocus={() => handleFocusFieldInPanel(field)}
                                onChange={(e) => scheduleFieldSave(field.id, e.target.value)}
                                onBlur={() => void flushFieldNow(field.id)}
                                placeholder="Escribe el contenido del campo..."
                                className="w-full px-2.5 py-2 rounded-md text-sm bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
                              />
                            ) : isCheckbox ? (
                              <label className="flex items-center gap-2 py-1 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                                <input
                                  ref={(el) => {
                                    if (el) fieldInputRefs.current.set(field.id, el);
                                    else fieldInputRefs.current.delete(field.id);
                                  }}
                                  id={`field-${field.id}`}
                                  type="checkbox"
                                  checked={val === 'true'}
                                  onFocus={() => handleFocusFieldInPanel(field)}
                                  onChange={(e) =>
                                    scheduleFieldSave(field.id, e.target.checked ? 'true' : 'false')
                                  }
                                  className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-emerald-600 focus:ring-emerald-600"
                                />
                                <span>
                                  {val === 'true'
                                    ? field.checkbox_style === 'cross'
                                      ? 'Marcado (✕)'
                                      : 'Marcado (✓)'
                                    : 'Sin marcar'}
                                </span>
                              </label>
                            ) : (
                              <input
                                ref={(el) => {
                                  if (el) fieldInputRefs.current.set(field.id, el);
                                  else fieldInputRefs.current.delete(field.id);
                                }}
                                id={`field-${field.id}`}
                                type={field.field_type === 'date' ? 'date' : 'text'}
                                value={val}
                                onFocus={() => handleFocusFieldInPanel(field)}
                                onChange={(e) => scheduleFieldSave(field.id, e.target.value)}
                                onBlur={() => void flushFieldNow(field.id)}
                                placeholder="Escribe un valor..."
                                className="w-full h-9 px-2.5 rounded-md text-sm bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
            <dl className="space-y-3">
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Nombre original</dt>
                <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100 break-words">
                  {document.original_name}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Diagnóstico</dt>
                <dd className="mt-0.5 font-mono text-slate-800 dark:text-slate-200">
                  {document.diagnosis_type}
                </dd>
                {document.analysis?.summary && (
                  <p className="mt-1 text-slate-600 dark:text-slate-400 leading-relaxed">
                    {document.analysis.summary}
                  </p>
                )}
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Ruta de origen</dt>
                <dd className="mt-0.5 font-mono text-slate-700 dark:text-slate-300 break-all">
                  {document.original_path}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Copia activa en workspace</dt>
                <dd className="mt-0.5 font-mono text-slate-700 dark:text-slate-300 break-all">
                  {document.working_path}
                </dd>
              </div>
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Formato</dt>
                  <dd className="mt-0.5 font-mono text-slate-900 dark:text-slate-100">
                    .{document.file_type}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Versión origen</dt>
                  <dd className="mt-0.5 font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    v{document.created_in_version}
                  </dd>
                </div>
              </div>
            </dl>
          </div>
        )}
      </section>

      {/* Right Panel: Interactive Visual PDF Editor + Draw Tools + Quick Properties Bar */}
      <section className="flex-1 flex flex-col min-w-0 min-h-0 bg-slate-100 dark:bg-slate-950">
        {/* Top Toolbar: Pagination + Draw Tools + Highlights Toggle + Zoom */}
        <div className="min-h-12 px-4 py-1.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 shrink-0">
          {/* Page navigation */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleSetPage(session.active_page - 1)}
              disabled={session.active_page <= 1}
              aria-label="Página anterior"
              className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" aria-hidden="true" />
            </button>
            <span className="text-xs font-mono tabular-nums text-slate-700 dark:text-slate-200 whitespace-nowrap">
              Pág. {Math.min(session.active_page, totalPages)} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => handleSetPage(session.active_page + 1)}
              disabled={session.active_page >= totalPages}
              aria-label="Página siguiente"
              className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
            >
              <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>

          {/* Draw tools (Mover / + Texto / + Check ✓ / + Cruz ✕) */}
          {isPdfDoc && (
            <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-950 p-0.5 rounded-lg border border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setDrawTool('none')}
                title="Seleccionar, mover y redimensionar casillas"
                className={`inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  drawTool === 'none'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <MousePointer2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden xl:inline">Mover</span>
              </button>
              <button
                type="button"
                onClick={() => setDrawTool((prev) => (prev === 'text' ? 'none' : 'text'))}
                title="Dibujar nuevo campo de texto con el mouse"
                className={`inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  drawTool === 'text'
                    ? 'bg-blue-700 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-blue-700 dark:hover:text-blue-400'
                }`}
              >
                <Type className="w-3.5 h-3.5" aria-hidden="true" />
                <span>+ Texto</span>
              </button>
              <button
                type="button"
                onClick={() => setDrawTool((prev) => (prev === 'check' ? 'none' : 'check'))}
                title="Dibujar casilla de verificación (✓)"
                className={`inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  drawTool === 'check'
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-emerald-700 dark:hover:text-emerald-400'
                }`}
              >
                <CheckSquare className="w-3.5 h-3.5" aria-hidden="true" />
                <span>+ Check ✓</span>
              </button>
              <button
                type="button"
                onClick={() => setDrawTool((prev) => (prev === 'cross' ? 'none' : 'cross'))}
                title="Dibujar casilla con cruz (✕)"
                className={`inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  drawTool === 'cross'
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-emerald-700 dark:hover:text-emerald-400'
                }`}
              >
                <Square className="w-3.5 h-3.5" aria-hidden="true" />
                <span>+ Cruz ✕</span>
              </button>
            </div>
          )}

          {/* Visibility & Zoom */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowFieldHighlights((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium border transition-colors whitespace-nowrap ${
                showFieldHighlights
                  ? 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              {showFieldHighlights ? (
                <Eye className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <EyeOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">Capas</span>
            </button>

            <div className="flex items-center gap-1 border-l border-slate-200 dark:border-slate-800 pl-2">
              <button
                type="button"
                onClick={() => handleSetZoom(session.zoom_level - 0.25)}
                disabled={session.zoom_level <= 0.75}
                aria-label="Reducir zoom"
                className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
              >
                <ZoomOut className="w-4 h-4" aria-hidden="true" />
              </button>
              <select
                aria-label="Nivel de zoom"
                value={session.zoom_level}
                onChange={(e) => handleSetZoom(Number(e.target.value))}
                className="h-7 px-2 rounded-md text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200"
              >
                {ZOOM_STEPS.map((z) => (
                  <option key={z} value={z}>
                    {Math.round(z * 100)}%
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => handleSetZoom(session.zoom_level + 0.25)}
                disabled={session.zoom_level >= 1.75}
                aria-label="Aumentar zoom"
                className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
              >
                <ZoomIn className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        {/* Quick Properties Bar when a field is selected */}
        {activeFieldObj && (
          <div className="px-4 py-2 bg-slate-50 dark:bg-slate-900/90 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
            <div className="flex flex-wrap items-center gap-2.5 min-w-0">
              <span className="font-medium text-slate-700 dark:text-slate-200 truncate max-w-[180px]">
                {activeFieldObj.label}
              </span>

              {/* Type selector */}
              <select
                aria-label="Tipo de campo"
                value={
                  activeFieldObj.field_type === 'checkbox'
                    ? activeFieldObj.checkbox_style === 'cross'
                      ? 'checkbox_cross'
                      : 'checkbox_check'
                    : activeFieldObj.field_type
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'checkbox_check' || v === 'checkbox_cross') {
                    const style: CheckboxStyle = v === 'checkbox_cross' ? 'cross' : 'check';
                    void handleUpdateFieldProperty(activeFieldObj, {
                      field_type: 'checkbox',
                      checkbox_style: style,
                      alignment: 'center',
                    });
                  } else {
                    void handleUpdateFieldProperty(activeFieldObj, {
                      field_type: v as FieldType,
                    });
                  }
                }}
                className="h-7 px-2 rounded-md bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200"
              >
                <option value="text">Texto</option>
                <option value="multiline">Multilínea</option>
                <option value="date">Fecha</option>
                <option value="checkbox_check">Casilla (✓)</option>
                <option value="checkbox_cross">Casilla (✕)</option>
              </select>

              {/* Alignment controls (for text fields) */}
              {activeFieldObj.field_type !== 'checkbox' && (
                <>
                  <div className="inline-flex items-center rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 overflow-hidden">
                    {(['left', 'center', 'right'] as FieldAlignment[]).map((align) => {
                      const active = (activeFieldObj.alignment ?? 'left') === align;
                      return (
                        <button
                          key={align}
                          type="button"
                          onClick={() =>
                            void handleUpdateFieldProperty(activeFieldObj, { alignment: align })
                          }
                          title={
                            align === 'left'
                              ? 'Alinear a la izquierda'
                              : align === 'center'
                                ? 'Centrar'
                                : 'Alinear a la derecha'
                          }
                          className={`p-1.5 transition-colors ${
                            active
                              ? 'bg-blue-600 text-white'
                              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          {align === 'left' ? (
                            <AlignLeft className="w-3.5 h-3.5" aria-hidden="true" />
                          ) : align === 'center' ? (
                            <AlignCenter className="w-3.5 h-3.5" aria-hidden="true" />
                          ) : (
                            <AlignRight className="w-3.5 h-3.5" aria-hidden="true" />
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Font size selector */}
                  <label className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-400">
                    <span>Fuente</span>
                    <input
                      type="number"
                      min={6}
                      max={18}
                      step={0.5}
                      value={activeFieldObj.font_size || 9.5}
                      onChange={(e) => {
                        const parsed = Number(e.target.value);
                        if (Number.isFinite(parsed) && parsed >= 6 && parsed <= 18) {
                          void handleUpdateFieldProperty(activeFieldObj, { font_size: parsed });
                        }
                      }}
                      className="w-14 h-7 px-1.5 rounded-md font-mono tabular-nums bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100"
                    />
                    <span>pt</span>
                  </label>

                  {/* Cover dashes toggle */}
                  <label className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={activeFieldObj.cover_dashes === 1}
                      onChange={(e) =>
                        void handleUpdateFieldProperty(activeFieldObj, {
                          cover_dashes: e.target.checked ? 1 : 0,
                        })
                      }
                      className="w-3.5 h-3.5 rounded border-slate-300 dark:border-slate-700 text-blue-600"
                    />
                    <span>Tapar guiones</span>
                  </label>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => void handleDeleteFieldSafe(activeFieldObj.id)}
              className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 border border-transparent hover:border-red-200 dark:hover:border-red-900 transition-colors shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Eliminar</span>
            </button>
          </div>
        )}

        <div
          ref={canvasRef}
          onScroll={handleCanvasScroll}
          className="flex-1 overflow-auto p-6 sm:p-8 flex justify-center items-start"
        >
          <DocumentLivePreview
            document={document}
            activePage={Math.min(session.active_page, totalPages)}
            zoomLevel={session.zoom_level}
            fieldsOnPage={activePageFields}
            draftValues={draftValues}
            activeFieldId={activeFieldId}
            hoveredFieldId={hoveredFieldId}
            showFieldHighlights={showFieldHighlights}
            drawTool={drawTool}
            plainTextData={plainTextData}
            onReadWorkingFileBytes={onReadWorkingFileBytes}
            onTotalPagesDetected={handleTotalPagesDetected}
            onSelectFieldFromPreview={handleSelectFieldFromPreview}
            onHoverField={setHoveredFieldId}
            onMoveOrResizeField={handleMoveOrResizeField}
            onCreateDrawnField={handleCreateDrawnField}
            onDeleteField={(id) => void handleDeleteFieldSafe(id)}
          />
        </div>
      </section>

      <SaveOrPrintModal
        open={saveOrPrintTab !== null}
        initialTab={saveOrPrintTab ?? 'save'}
        allowSave={isPdfDoc && fields.length > 0}
        isElectron={isElectron}
        document={document}
        fields={mergedFieldsForOutput}
        currentPage={Math.min(session.active_page, totalPages)}
        totalPages={totalPages}
        onClose={() => setSaveOrPrintTab(null)}
        onSaveToDisk={handleExportWithDrafts}
        onListPrinters={onListPrinters}
        onReadWorkingFileBytes={onReadWorkingFileBytes}
        onPrintRenderedDocument={onPrintRenderedDocument}
      />
    </div>
  );
}
