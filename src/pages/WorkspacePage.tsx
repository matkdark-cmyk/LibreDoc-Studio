import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import {
  AlertTriangle,
  ArrowRight,
  FilePlus2,
  FolderOpen,
  Loader2,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  CreateDocumentInput,
  DocumentRecord,
  OcrProgressEvent,
  StorageDiagnostics,
  UnlockResult,
} from '../../shared/types';
import { DiagnosisCard, type CardFeedback } from '../components/DiagnosisCard';
import { PasswordUnlockModal } from '../components/PasswordUnlockModal';

interface WorkspacePageProps {
  documents: DocumentRecord[];
  activeDocumentId: string | null;
  selectedDiagnosisDoc: DocumentRecord | null;
  loading: boolean;
  ingesting: boolean;
  unlocking: boolean;
  runningOcr: boolean;
  extractingAcroForm: boolean;
  reanalyzing: boolean;
  ocrProgress: OcrProgressEvent | null;
  ingestError: string | null;
  cardFeedback: CardFeedback | null;
  diagnostics: StorageDiagnostics | null;
  onPickNativeFile: () => Promise<void>;
  onIngestDroppedFiles: (files: FileList) => Promise<void>;
  onCreateDocument: (input: CreateDocumentInput, openImmediately?: boolean) => Promise<void>;
  onSelectDiagnosisDoc: (documentId: string | null) => void;
  onUnlockDocument: (documentId: string, password?: string) => Promise<UnlockResult>;
  onRunOcr: (documentId: string, enhanceContrast: boolean) => Promise<void>;
  onExtractAcroForm: (documentId: string) => Promise<void>;
  onReanalyzeDocument: (documentId: string) => Promise<void>;
  onRevealDocumentInFolder: (documentId: string) => Promise<void>;
  onOpenDocument: (documentId: string) => void;
  onDeleteDocument: (documentId: string) => Promise<void>;
  onOpenUserDataFolder: () => Promise<void>;
  onClearIngestError: () => void;
}

type TypeFilter = 'all' | 'pdf' | 'docx' | 'other';

const STATUS_LABELS: Record<DocumentRecord['status'], string> = {
  registered: 'Analizado',
  ready: 'Listo',
  unlocked: 'Liberado',
  ocr_completed: 'OCR aplicado',
  exported: 'Exportado',
  error: 'Error',
};

const DIAGNOSIS_LABELS: Record<DocumentRecord['diagnosis_type'], string> = {
  PENDING_ANALYSIS: 'Pendiente de análisis',
  PDF_NATIVE_EDITABLE: 'PDF nativo editable',
  PDF_LOCKED_PERMISSIONS: 'PDF con bloqueo de permisos',
  PDF_ENCRYPTED_OPEN: 'PDF cifrado con clave',
  PDF_SCANNED_IMAGE: 'PDF escaneado (foto)',
  DOCX_LOCKED: 'Word protegido',
  DOCX_EDITABLE: 'Word editable',
  PLAIN_TEXT: 'Texto plano',
  IMAGE_DOCUMENT: 'Imagen',
};

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('es-CL', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function WorkspacePage({
  documents,
  activeDocumentId,
  selectedDiagnosisDoc,
  loading,
  ingesting,
  unlocking,
  runningOcr,
  extractingAcroForm,
  reanalyzing,
  ocrProgress,
  ingestError,
  cardFeedback,
  diagnostics,
  onPickNativeFile,
  onIngestDroppedFiles,
  onCreateDocument,
  onSelectDiagnosisDoc,
  onUnlockDocument,
  onRunOcr,
  onExtractAcroForm,
  onReanalyzeDocument,
  onRevealDocumentInFolder,
  onOpenDocument,
  onDeleteDocument,
  onOpenUserDataFolder,
  onClearIngestError,
}: WorkspacePageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [isDragging, setIsDragging] = useState(false);
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftType, setDraftType] = useState('pdf');
  const [submitting, setSubmitting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [passwordModalDoc, setPasswordModalDoc] = useState<DocumentRecord | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isElectron = diagnostics?.runtime === 'electron';

  const filteredDocuments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return documents.filter((doc) => {
      const matchesQuery =
        query === '' ||
        doc.original_name.toLowerCase().includes(query) ||
        doc.file_type.toLowerCase().includes(query) ||
        doc.diagnosis_type.toLowerCase().includes(query);

      if (!matchesQuery) return false;

      if (typeFilter === 'pdf') return doc.file_type === 'pdf';
      if (typeFilter === 'docx') return doc.file_type === 'docx' || doc.file_type === 'doc';
      if (typeFilter === 'other') {
        return doc.file_type !== 'pdf' && doc.file_type !== 'docx' && doc.file_type !== 'doc';
      }
      return true;
    });
  }, [documents, searchQuery, typeFilter]);

  const handlePrimaryRegisterClick = async () => {
    onClearIngestError();
    if (isElectron) {
      await onPickNativeFile();
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleBrowserFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    try {
      await onIngestDroppedFiles(files);
    } finally {
      event.target.value = '';
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragging(false);
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    onClearIngestError();
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    await onIngestDroppedFiles(files);
  };

  const handleQuickCreateSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const cleaned = draftName.trim();
    if (!cleaned) return;
    const hasExtension = /\.[a-z0-9]{2,5}$/i.test(cleaned);
    const fullName = hasExtension ? cleaned : `${cleaned}.${draftType}`;
    setSubmitting(true);
    try {
      await onCreateDocument(
        {
          original_name: fullName,
          file_type: draftType,
          diagnosis_type: 'PENDING_ANALYSIS',
          status: 'registered',
        },
        true,
      );
      setDraftName('');
      setShowQuickCreate(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handlePasswordSubmit = async (password: string) => {
    if (!passwordModalDoc) return;
    setPasswordError(null);
    const result = await onUnlockDocument(passwordModalDoc.id, password);
    if (result.success) {
      setPasswordModalDoc(null);
      setPasswordError(null);
    } else {
      setPasswordError(result.error || result.message);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-8 py-7 space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.docx,.txt,.rtf,.md,.csv,.json,.png,.jpg,.jpeg"
        onChange={handleBrowserFileSelected}
        className="hidden"
        aria-hidden="true"
      />

      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 text-balance">
            Documentos y diagnóstico local
          </h1>
          <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
            Arrastra o selecciona un archivo para detectar bloqueos, cifrado o escaneos y liberarlo
            sin salir de tu equipo.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setShowQuickCreate((prev) => !prev)}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Registro manual</span>
          </button>

          <button
            type="button"
            disabled={ingesting || submitting}
            onClick={() => void handlePrimaryRegisterClick()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            {ingesting ? (
              <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
            ) : (
              <Upload className="w-4 h-4 shrink-0" aria-hidden="true" />
            )}
            <span>{ingesting ? 'Analizando...' : 'Cargar archivo'}</span>
          </button>
        </div>
      </div>

      {/* Drag & Drop ingestion zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => void handleDrop(e)}
        className={`rounded-xl border border-dashed transition-colors px-6 py-7 text-center ${
          isDragging
            ? 'border-blue-600 dark:border-blue-400 bg-blue-50/70 dark:bg-blue-950/40'
            : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900'
        }`}
      >
        <div className="max-w-xl mx-auto flex flex-col items-center">
          <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 flex items-center justify-center">
            {ingesting ? (
              <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            ) : (
              <Upload className="w-5 h-5" aria-hidden="true" />
            )}
          </div>
          <p className="mt-3 text-sm font-medium text-slate-900 dark:text-slate-100">
            {isDragging
              ? 'Suelta el archivo aquí para iniciar el diagnóstico'
              : 'Arrastra y suelta un documento aquí, o selecciónalo desde tu equipo'}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono">
            .pdf · .docx · .txt · .rtf · .md · .png · .jpg
          </p>
          <button
            type="button"
            disabled={ingesting}
            onClick={() => void handlePrimaryRegisterClick()}
            className="mt-3.5 text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline disabled:opacity-50"
          >
            Explorar archivos en el equipo
          </button>
        </div>
      </div>

      {ingestError && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/70 flex items-start justify-between gap-3 text-xs text-red-900 dark:text-red-200"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{ingestError}</span>
          </div>
          <button
            type="button"
            onClick={onClearIngestError}
            className="text-red-700 dark:text-red-300 hover:underline shrink-0"
          >
            Cerrar
          </button>
        </div>
      )}

      {selectedDiagnosisDoc && (
        <DiagnosisCard
          document={selectedDiagnosisDoc}
          isElectron={isElectron}
          tessdataStatus={diagnostics?.tessdataStatus}
          unlocking={unlocking}
          runningOcr={runningOcr}
          extractingAcroForm={extractingAcroForm}
          reanalyzing={reanalyzing}
          ocrProgress={ocrProgress}
          feedback={cardFeedback}
          onUnlockPermissionsOrDocx={async (docId) => {
            await onUnlockDocument(docId);
          }}
          onOpenPasswordModal={(doc) => {
            setPasswordError(null);
            setPasswordModalDoc(doc);
          }}
          onRunOcr={onRunOcr}
          onExtractAcroForm={onExtractAcroForm}
          onOpenEditor={onOpenDocument}
          onReanalyze={onReanalyzeDocument}
          onRevealInFolder={onRevealDocumentInFolder}
          onClose={() => onSelectDiagnosisDoc(null)}
        />
      )}

      {showQuickCreate && (
        <form
          onSubmit={handleQuickCreateSubmit}
          className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex flex-col md:flex-row md:items-end gap-4"
        >
          <div className="flex-1 min-w-0">
            <label
              htmlFor="quick-doc-name"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              Nombre del registro manual
            </label>
            <input
              id="quick-doc-name"
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Ej. Formulario_Beca_2026.pdf"
              className="w-full h-10 px-3 rounded-lg text-sm bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
              autoFocus
            />
          </div>

          <div className="w-full md:w-44">
            <label
              htmlFor="quick-doc-type"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              Tipo de archivo
            </label>
            <select
              id="quick-doc-type"
              value={draftType}
              onChange={(e) => setDraftType(e.target.value)}
              className="w-full h-10 px-3 rounded-lg text-sm bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
            >
              <option value="pdf">PDF (.pdf)</option>
              <option value="docx">Word (.docx)</option>
              <option value="txt">Texto (.txt)</option>
              <option value="png">Imagen (.png)</option>
            </select>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setShowQuickCreate(false);
                setDraftName('');
              }}
              className="h-10 px-3.5 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || draftName.trim() === ''}
              className="h-10 px-4 rounded-lg text-sm font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              Crear y abrir
            </button>
          </div>
        </form>
      )}

      {/* History Table */}
      <section className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search
              className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar por nombre, extensión o diagnóstico..."
              aria-label="Buscar documentos en el historial"
              className="w-full h-9 pl-9 pr-3 rounded-lg text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
            />
          </div>

          <div
            role="group"
            aria-label="Filtrar por tipo de documento"
            className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 self-start md:self-auto"
          >
            {(
              [
                { id: 'all', label: 'Todos' },
                { id: 'pdf', label: 'PDF' },
                { id: 'docx', label: 'Word' },
                { id: 'other', label: 'Otros' },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setTypeFilter(option.id)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  typeFilter === option.id
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="p-5 space-y-3" aria-label="Cargando historial">
            {[1, 2, 3].map((row) => (
              <div
                key={row}
                className="h-11 rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse"
              />
            ))}
          </div>
        ) : documents.length === 0 ? (
          <div className="px-6 py-12 text-center max-w-md mx-auto">
            <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 mx-auto flex items-center justify-center">
              <FilePlus2 className="w-5 h-5" aria-hidden="true" />
            </div>
            <h2 className="mt-3.5 text-base font-semibold text-slate-900 dark:text-slate-100">
              Sin documentos procesados todavía
            </h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Arrastra un PDF bloqueado, un PDF escaneado o un Word protegido en el área superior
              para diagnosticarlo y registrarlo en SQLite.
            </p>
          </div>
        ) : filteredDocuments.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
            No se encontraron documentos que coincidan con el filtro actual.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-5">Documento</th>
                  <th className="py-3 px-4">Diagnóstico</th>
                  <th className="py-3 px-4">Estado</th>
                  <th className="py-3 px-4">Actualizado</th>
                  <th className="py-3 px-5 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                {filteredDocuments.map((doc) => {
                  const isActive = doc.id === activeDocumentId;
                  const isSelectedDiag = doc.id === selectedDiagnosisDoc?.id;
                  const needsUnlock =
                    doc.diagnosis_type === 'PDF_LOCKED_PERMISSIONS' ||
                    doc.diagnosis_type === 'PDF_ENCRYPTED_OPEN' ||
                    doc.diagnosis_type === 'DOCX_LOCKED';

                  return (
                    <tr
                      key={doc.id}
                      className={`transition-colors ${
                        isSelectedDiag || isActive
                          ? 'bg-blue-50/50 dark:bg-blue-500/10'
                          : 'hover:bg-slate-50/80 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <td className="py-3 px-5 min-w-[230px]">
                        <button
                          type="button"
                          onClick={() => onSelectDiagnosisDoc(doc.id)}
                          className="text-left group focus-visible:outline-none focus-visible:underline"
                        >
                          <div className="font-medium text-slate-900 dark:text-slate-100 group-hover:text-blue-700 dark:group-hover:text-blue-300 transition-colors">
                            {doc.original_name}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5 font-mono">
                            <span>.{doc.file_type}</span>
                            <span aria-hidden="true">·</span>
                            <span>v{doc.created_in_version}</span>
                            {isActive && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-sans text-blue-700 dark:text-blue-300 font-medium">
                                  En editor
                                </span>
                              </>
                            )}
                          </div>
                        </button>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                          {DIAGNOSIS_LABELS[doc.diagnosis_type]}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                          {doc.diagnosis_type}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-xs whitespace-nowrap">
                        <span
                          className={
                            doc.status === 'unlocked'
                              ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                              : needsUnlock
                                ? 'text-amber-700 dark:text-amber-400 font-medium'
                                : 'text-slate-700 dark:text-slate-300'
                          }
                        >
                          {STATUS_LABELS[doc.status]}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-xs tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {formatDate(doc.updated_at)}
                      </td>
                      <td className="py-3 px-5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onSelectDiagnosisDoc(doc.id)}
                            className="px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                          >
                            Diagnóstico
                          </button>

                          <button
                            type="button"
                            onClick={() => onOpenDocument(doc.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/15 transition-colors whitespace-nowrap"
                          >
                            <span>Editor</span>
                            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>

                          {confirmDeleteId === doc.id ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={async () => {
                                  await onDeleteDocument(doc.id);
                                  setConfirmDeleteId(null);
                                }}
                                className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-red-600 hover:bg-red-700 text-white transition-colors"
                              >
                                Confirmar
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-2 py-1.5 rounded-md text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(doc.id)}
                              aria-label={`Eliminar ${doc.original_name}`}
                              className="p-1.5 rounded-md text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                            >
                              <Trash2 className="w-4 h-4" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Persistence and local qpdf runtime status */}
      <section className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Almacenamiento local y motor de desbloqueo
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 font-mono break-all">
            {diagnostics?.dbPath ?? '%APPDATA%\\LibreDocStudio\\data\\libredoc.db'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            Esquema v{diagnostics?.schemaVersion ?? 3} ·{' '}
            {diagnostics?.qpdfStatus?.available
              ? `qpdf listo (${diagnostics.qpdfStatus.version})`
              : isElectron
                ? 'qpdf pendiente (npm run setup:qpdf)'
                : 'qpdf activo en Electron'}
            {' · '}
            {diagnostics?.tessdataStatus?.available
              ? 'OCR offline listo (spa + eng)'
              : isElectron
                ? 'tessdata pendiente (npm run setup:tessdata)'
                : 'OCR offline activo en Electron'}
          </p>
        </div>

        {isElectron && (
          <button
            type="button"
            onClick={() => void onOpenUserDataFolder()}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap self-start lg:self-center shrink-0"
          >
            <FolderOpen className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Abrir carpeta userData</span>
          </button>
        )}
      </section>

      <PasswordUnlockModal
        document={passwordModalDoc}
        submitting={unlocking}
        errorMessage={passwordError}
        onSubmit={handlePasswordSubmit}
        onClose={() => {
          setPasswordModalDoc(null);
          setPasswordError(null);
        }}
      />
    </div>
  );
}
