import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Plus,
  Search,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  DocumentField,
  DocumentRecord,
  FieldType,
  PlainTextContentResult,
  SessionState,
  SessionStatePatch,
  SidebarTab,
  UpsertFieldInput,
} from '../../shared/types';

interface EditorPageProps {
  document: DocumentRecord | null;
  recentDocuments: DocumentRecord[];
  fields: DocumentField[];
  session: SessionState;
  onSelectDocument: (documentId: string) => void;
  onGoToWorkspace: () => void;
  onPatchSession: (patch: SessionStatePatch) => void;
  onUpsertField: (input: UpsertFieldInput) => Promise<void>;
  onUpdateFieldValue: (fieldId: string, value: string) => Promise<void>;
  onDeleteField: (fieldId: string) => Promise<void>;
  onReadPlainText: (documentId: string) => Promise<PlainTextContentResult | null>;
}

const ZOOM_STEPS = [0.75, 1, 1.25, 1.5];

export function EditorPage({
  document,
  recentDocuments,
  fields,
  session,
  onSelectDocument,
  onGoToWorkspace,
  onPatchSession,
  onUpsertField,
  onUpdateFieldValue,
  onDeleteField,
  onReadPlainText,
}: EditorPageProps) {
  const [fieldSearch, setFieldSearch] = useState('');
  const [showAddField, setShowAddField] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newGroup, setNewGroup] = useState('Datos personales');
  const [newType, setNewType] = useState<FieldType>('text');
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [saveIndicator, setSaveIndicator] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [scrollPx, setScrollPx] = useState(session.scroll_position);
  const [plainTextData, setPlainTextData] = useState<PlainTextContentResult | null>(null);

  const timersRef = useRef<Map<string, number>>(new Map());
  const scrollTimerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const restoredScrollForDocRef = useRef<string | null>(null);

  const totalPages = Math.max(1, document?.analysis?.details.pageCount ?? 5);

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
    setScrollPx(session.scroll_position);
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
    }, 500);

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

  const handleAddField = async (event: FormEvent) => {
    event.preventDefault();
    if (!document || newLabel.trim() === '') return;

    await onUpsertField({
      document_id: document.id,
      page_number: session.active_page,
      label: newLabel.trim(),
      value: newType === 'checkbox' ? 'false' : '',
      field_type: newType,
      group_name: newGroup.trim() || 'Datos generales',
    });

    setNewLabel('');
    setShowAddField(false);
    setSaveIndicator('saved');
  };

  const handleCanvasScroll = () => {
    if (!canvasRef.current) return;
    const top = Math.round(canvasRef.current.scrollTop);
    setScrollPx(top);

    if (scrollTimerRef.current !== null) {
      window.clearTimeout(scrollTimerRef.current);
    }
    scrollTimerRef.current = window.setTimeout(() => {
      onPatchSession({ scroll_position: top });
    }, 250);
  };

  const handleSetZoom = (nextZoom: number) => {
    const clamped = Math.min(1.5, Math.max(0.75, Number(nextZoom.toFixed(2))));
    onPatchSession({ zoom_level: clamped });
  };

  const handleSetPage = (nextPage: number) => {
    const clamped = Math.min(totalPages, Math.max(1, nextPage));
    onPatchSession({ active_page: clamped, scroll_position: 0 });
    if (canvasRef.current) {
      canvasRef.current.scrollTop = 0;
    }
    setScrollPx(0);
  };

  const handleSetSidebarTab = (tab: SidebarTab) => {
    onPatchSession({ sidebar_tab: tab });
  };

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
            Selecciona un documento reciente o carga uno en Inicio para diagnosticarlo y editar sus
            campos.
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
      {/* Left Panel: Vista General de Datos */}
      <section className="w-full lg:w-[370px] shrink-0 flex flex-col bg-white dark:bg-slate-900 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 min-h-0">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
              Vista General de Datos
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
              {saveIndicator === 'saving' ? (
                'Guardando...'
              ) : saveIndicator === 'saved' ? (
                <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  Guardado
                </span>
              ) : (
                `${fields.length} ${fields.length === 1 ? 'campo' : 'campos'}`
              )}
            </span>
          </div>

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
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-xs font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors whitespace-nowrap shrink-0"
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
                    Añade campos manualmente o espera la extracción automática OCR / AcroForm en los
                    próximos pasos.
                  </p>
                </div>
              ) : (
                groupedFields.map(([groupName, groupItems]) => (
                  <div key={groupName} className="space-y-3">
                    <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 pb-1.5">
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        {groupName}
                      </span>
                      <span className="font-mono tabular-nums">{groupItems.length}</span>
                    </div>

                    <div className="space-y-3">
                      {groupItems.map((field) => {
                        const val = draftValues[field.id] ?? field.value;
                        return (
                          <div key={field.id} className="space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <label
                                htmlFor={`field-${field.id}`}
                                className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate"
                              >
                                {field.label}
                              </label>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="text-[11px] font-mono tabular-nums text-slate-400">
                                  Pág. {field.page_number}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => void onDeleteField(field.id)}
                                  aria-label={`Eliminar campo ${field.label}`}
                                  className="text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                                >
                                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                              </div>
                            </div>

                            {field.field_type === 'multiline' ? (
                              <textarea
                                id={`field-${field.id}`}
                                rows={3}
                                value={val}
                                onChange={(e) => scheduleFieldSave(field.id, e.target.value)}
                                onBlur={() => void flushFieldNow(field.id)}
                                placeholder="Escribe el contenido del campo..."
                                className="w-full px-2.5 py-2 rounded-md text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
                              />
                            ) : field.field_type === 'checkbox' ? (
                              <label className="flex items-center gap-2 py-1 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                                <input
                                  id={`field-${field.id}`}
                                  type="checkbox"
                                  checked={val === 'true'}
                                  onChange={(e) =>
                                    scheduleFieldSave(field.id, e.target.checked ? 'true' : 'false')
                                  }
                                  className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600"
                                />
                                <span>{val === 'true' ? 'Marcado' : 'Sin marcar'}</span>
                              </label>
                            ) : (
                              <input
                                id={`field-${field.id}`}
                                type={field.field_type === 'date' ? 'date' : 'text'}
                                value={val}
                                onChange={(e) => scheduleFieldSave(field.id, e.target.value)}
                                onBlur={() => void flushFieldNow(field.id)}
                                placeholder="Escribe un valor..."
                                className="w-full h-9 px-2.5 rounded-md text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
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

      {/* Right Panel: Document Workspace Canvas */}
      <section className="flex-1 flex flex-col min-w-0 min-h-0 bg-slate-100 dark:bg-slate-950">
        <div className="h-12 px-5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2">
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
              Página {Math.min(session.active_page, totalPages)} / {totalPages}
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

          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
              Desplazamiento: {scrollPx} px
            </span>

            <div className="flex items-center gap-1 border-l border-slate-200 dark:border-slate-800 pl-3">
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
                disabled={session.zoom_level >= 1.5}
                aria-label="Aumentar zoom"
                className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
              >
                <ZoomIn className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <div
          ref={canvasRef}
          onScroll={handleCanvasScroll}
          className="flex-1 overflow-auto p-8 flex justify-center items-start"
        >
          <div
            style={{
              width: `${Math.round(680 * session.zoom_level)}px`,
              minHeight: `${Math.round(920 * session.zoom_level)}px`,
            }}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md shadow-xs p-10 transition-[width] duration-150 shrink-0"
          >
            <div className="pb-5 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                  {document.diagnosis_type} · Página {session.active_page}
                </p>
                <h3 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {document.original_name}
                </h3>
              </div>
              <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                {Math.round(session.zoom_level * 100)}%
              </span>
            </div>

            {document.diagnosis_type === 'PLAIN_TEXT' && plainTextData && (
              <div className="mt-6 space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-mono">
                  <span>Contenido original ({plainTextData.encoding})</span>
                  <span className="tabular-nums">{plainTextData.lineCount} líneas</span>
                </div>
                <pre className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs font-mono text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words overflow-x-auto max-h-[480px]">
                  {plainTextData.content}
                </pre>
              </div>
            )}

            <div className="mt-6 space-y-4">
              {activePageFields.length === 0 ? (
                document.diagnosis_type !== 'PLAIN_TEXT' && (
                  <div className="py-12 px-6 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 text-center space-y-1.5">
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                      Página {session.active_page} sin campos asignados
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                      Agrega un campo en el panel izquierdo para verlo sincronizado en tiempo real.
                      El renderizado visual página por página y la extracción OCR local se activarán
                      en los siguientes pasos.
                    </p>
                  </div>
                )
              ) : (
                activePageFields.map((field) => {
                  const liveValue = draftValues[field.id] ?? field.value;
                  return (
                    <div
                      key={field.id}
                      className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60"
                    >
                      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                        <span className="font-medium text-slate-700 dark:text-slate-300">
                          {field.label}
                        </span>
                        <span className="font-mono tabular-nums">
                          {field.group_name} · ({Math.round(field.x)}, {Math.round(field.y)})
                        </span>
                      </div>
                      <div className="mt-2 text-sm text-slate-900 dark:text-slate-100 min-h-[1.5rem] whitespace-pre-wrap break-words">
                        {field.field_type === 'checkbox' ? (
                          <span>{liveValue === 'true' ? '[X] Marcado' : '[ ] Sin marcar'}</span>
                        ) : liveValue ? (
                          liveValue
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500">Sin rellenar</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
