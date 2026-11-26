import { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  FolderOpen,
  FormInput,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  ScanText,
  Unlock,
  X,
} from 'lucide-react';
import type {
  DiagnosisType,
  DocumentRecord,
  OcrProgressEvent,
  TessdataStatus,
} from '../../shared/types';

export interface CardFeedback {
  success: boolean;
  message: string;
  error?: string;
}

interface DiagnosisCardProps {
  document: DocumentRecord;
  isElectron: boolean;
  tessdataStatus?: TessdataStatus;
  unlocking: boolean;
  runningOcr: boolean;
  extractingAcroForm: boolean;
  reanalyzing: boolean;
  ocrProgress: OcrProgressEvent | null;
  feedback: CardFeedback | null;
  onUnlockPermissionsOrDocx: (documentId: string) => Promise<void>;
  onOpenPasswordModal: (document: DocumentRecord) => void;
  onRunOcr: (documentId: string, enhanceContrast: boolean) => Promise<void>;
  onExtractAcroForm: (documentId: string) => Promise<void>;
  onOpenEditor: (documentId: string) => void;
  onReanalyze: (documentId: string) => Promise<void>;
  onRevealInFolder: (documentId: string) => Promise<void>;
  onClose: () => void;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getDiagnosisPresentation(type: DiagnosisType) {
  switch (type) {
    case 'PDF_LOCKED_PERMISSIONS':
      return {
        Icon: Lock,
        iconTone: 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/60',
        statusLabel: 'Bloqueo de permisos detectado',
      };
    case 'PDF_ENCRYPTED_OPEN':
      return {
        Icon: KeyRound,
        iconTone: 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/60',
        statusLabel: 'Cifrado con contraseña de apertura',
      };
    case 'PDF_SCANNED_IMAGE':
    case 'IMAGE_DOCUMENT':
      return {
        Icon: ScanText,
        iconTone: 'text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/60',
        statusLabel: 'Documento basado en imagen · Requiere OCR local',
      };
    case 'DOCX_LOCKED':
      return {
        Icon: Lock,
        iconTone: 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/60',
        statusLabel: 'Protección de edición en Word',
      };
    case 'PDF_NATIVE_EDITABLE':
    case 'DOCX_EDITABLE':
    case 'PLAIN_TEXT':
      return {
        Icon: CheckCircle2,
        iconTone: 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60',
        statusLabel: 'Libre de restricciones',
      };
    default:
      return {
        Icon: FileText,
        iconTone: 'text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800',
        statusLabel: 'Pendiente de análisis',
      };
  }
}

export function DiagnosisCard({
  document,
  isElectron,
  tessdataStatus,
  unlocking,
  runningOcr,
  extractingAcroForm,
  reanalyzing,
  ocrProgress,
  feedback,
  onUnlockPermissionsOrDocx,
  onOpenPasswordModal,
  onRunOcr,
  onExtractAcroForm,
  onOpenEditor,
  onReanalyze,
  onRevealInFolder,
  onClose,
}: DiagnosisCardProps) {
  const [enhanceContrast, setEnhanceContrast] = useState(true);

  const analysis = document.analysis;
  const details = analysis?.details;
  const presentation = getDiagnosisPresentation(document.diagnosis_type);
  const StatusIcon = presentation.Icon;

  const isUnlockableDirectly =
    document.diagnosis_type === 'PDF_LOCKED_PERMISSIONS' ||
    document.diagnosis_type === 'DOCX_LOCKED';
  const requiresPassword = document.diagnosis_type === 'PDF_ENCRYPTED_OPEN';
  const needsOcr =
    document.diagnosis_type === 'PDF_SCANNED_IMAGE' ||
    document.diagnosis_type === 'IMAGE_DOCUMENT';
  const isNativePdf = document.diagnosis_type === 'PDF_NATIVE_EDITABLE';
  const hasAcroFormFields = (details?.acroFormFieldCount ?? 0) > 0;
  const isBusy = unlocking || runningOcr || extractingAcroForm || reanalyzing;

  const activeOcrProgress =
    ocrProgress && ocrProgress.documentId === document.id ? ocrProgress : null;

  const metadataItems: string[] = [
    document.diagnosis_type,
    `.${document.file_type}`,
    formatBytes(details?.fileSizeBytes),
  ];

  if (typeof details?.pageCount === 'number' && details.pageCount > 0) {
    metadataItems.push(
      `${details.pageCount} ${details.pageCount === 1 ? 'página' : 'páginas'}`,
    );
  }
  if (typeof details?.avgCharsPerPage === 'number') {
    metadataItems.push(`${details.avgCharsPerPage} car./pág.`);
  }
  if (typeof details?.acroFormFieldCount === 'number' && details.acroFormFieldCount > 0) {
    metadataItems.push(`${details.acroFormFieldCount} campos AcroForm`);
  }
  if (details?.encoding) {
    metadataItems.push(details.encoding);
  }
  if (details?.imageWidth && details?.imageHeight) {
    metadataItems.push(`${details.imageWidth} × ${details.imageHeight} px`);
  }

  return (
    <section
      aria-label="Tarjeta de diagnóstico del documento"
      className="p-6 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3.5 min-w-0">
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${presentation.iconTone}`}
          >
            <StatusIcon className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {presentation.statusLabel}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{document.diagnosis_type}</span>
              {document.status === 'unlocked' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                    Copia liberada en workspace
                  </span>
                </>
              )}
              {document.status === 'ocr_completed' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                    PDF editable generado con OCR
                  </span>
                </>
              )}
            </div>

            <h2 className="mt-1 text-base font-semibold text-slate-900 dark:text-slate-100 break-words">
              {document.original_name}
            </h2>

            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-3xl">
              {analysis?.summary ??
                'El archivo fue registrado en SQLite. Ejecuta el análisis para inspeccionar su estructura y permisos.'}
            </p>
          </div>
        </div>

        <button
          type="button"
          disabled={runningOcr}
          onClick={onClose}
          aria-label="Cerrar tarjeta de diagnóstico"
          className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-40 shrink-0"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {/* Unboxed technical metadata line */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums border-t border-slate-200 dark:border-slate-800 pt-3.5">
        {metadataItems.map((item, idx) => (
          <span key={`${item}-${idx}`} className="inline-flex items-center gap-2">
            {idx > 0 && <span aria-hidden="true">·</span>}
            <span>{item}</span>
          </span>
        ))}
      </div>

      {/* Detected restrictions or DOCX protection nodes */}
      {((details?.restrictions && details.restrictions.length > 0) ||
        (details?.docxProtections && details.docxProtections.length > 0)) && (
        <div className="text-xs text-slate-600 dark:text-slate-300 space-y-1">
          <p className="font-medium text-slate-800 dark:text-slate-200">
            Restricciones detectadas:
          </p>
          <ul className="list-disc list-inside space-y-0.5 text-slate-600 dark:text-slate-400">
            {(details.restrictions ?? []).map((item) => (
              <li key={item}>{item}</li>
            ))}
            {(details.docxProtections ?? []).map((item) => (
              <li key={item} className="font-mono text-[11px]">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Missing qpdf warning */}
      {(document.diagnosis_type === 'PDF_LOCKED_PERMISSIONS' ||
        document.diagnosis_type === 'PDF_ENCRYPTED_OPEN') &&
        details?.qpdfAvailable === false && (
          <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/70 flex items-start gap-2.5 text-xs text-amber-900 dark:text-amber-200">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-0.5">
              <p className="font-medium">Binario local de qpdf no detectado</p>
              <p className="text-amber-800 dark:text-amber-300">
                Para ejecutar <span className="font-mono">qpdf --decrypt</span> en Windows, ejecuta{' '}
                <span className="font-mono font-semibold">npm run setup:qpdf</span> o coloca{' '}
                <span className="font-mono">qpdf.exe</span> y sus DLLs en{' '}
                <span className="font-mono">resources/bin/win/qpdf/</span>.
              </p>
            </div>
          </div>
        )}

      {/* Missing local tessdata warning when OCR is needed */}
      {needsOcr && isElectron && tessdataStatus && !tessdataStatus.available && (
        <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/70 flex items-start gap-2.5 text-xs text-amber-900 dark:text-amber-200">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="space-y-0.5">
            <p className="font-medium">Modelos OCR offline no encontrados</p>
            <p className="text-amber-800 dark:text-amber-300">
              Para ejecutar OCR 100% local sin conexión, ejecuta{' '}
              <span className="font-mono font-semibold">npm run setup:tessdata</span> para descargar{' '}
              <span className="font-mono">spa.traineddata</span> y{' '}
              <span className="font-mono">eng.traineddata</span> en{' '}
              <span className="font-mono">resources/tessdata/</span>.
            </p>
          </div>
        </div>
      )}

      {/* Real-time per-page OCR progress bar */}
      {runningOcr && activeOcrProgress && (
        <div
          role="progressbar"
          aria-valuenow={activeOcrProgress.overallProgress}
          aria-valuemin={0}
          aria-valuemax={100}
          className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2.5"
        >
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
              {activeOcrProgress.message}
            </span>
            <span className="font-mono tabular-nums font-semibold text-blue-700 dark:text-blue-400 shrink-0">
              {activeOcrProgress.overallProgress}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-blue-700 dark:bg-blue-500 transition-[width] duration-200"
              style={{ width: `${Math.min(100, Math.max(3, activeOcrProgress.overallProgress))}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
            <span>
              Página {activeOcrProgress.currentPage} de {activeOcrProgress.totalPages}
            </span>
            <span>Progreso página: {activeOcrProgress.pageProgress}%</span>
          </div>
        </div>
      )}

      {/* OCR option toggle when scanned PDF */}
      {needsOcr && !runningOcr && document.file_type === 'pdf' && (
        <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={enhanceContrast}
            onChange={(e) => setEnhanceContrast(e.target.checked)}
            className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600"
          />
          <span>
            Mejorar contraste y escala de grises antes del OCR (recomendado para fotos y escaneos)
          </span>
        </label>
      )}

      {/* Action feedback notice */}
      {feedback && !runningOcr && (
        <div
          role="status"
          className={`p-3.5 rounded-lg border text-xs flex items-start gap-2.5 ${
            feedback.success
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/70 text-emerald-900 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/70 text-red-900 dark:text-red-200'
          }`}
        >
          {feedback.success ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          )}
          <div className="space-y-0.5 min-w-0">
            <p className="font-medium">{feedback.message}</p>
            {feedback.error && <p className="opacity-90 break-words">{feedback.error}</p>}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="flex flex-wrap items-center gap-2.5">
          {isUnlockableDirectly && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void onUnlockPermissionsOrDocx(document.id)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors disabled:opacity-60 whitespace-nowrap"
            >
              {unlocking ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <Unlock className="w-4 h-4" aria-hidden="true" />
              )}
              <span>
                {document.diagnosis_type === 'DOCX_LOCKED'
                  ? 'Desbloquear Word (.docx)'
                  : 'Liberar documento'}
              </span>
            </button>
          )}

          {requiresPassword && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onOpenPasswordModal(document)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors disabled:opacity-60 whitespace-nowrap"
            >
              <KeyRound className="w-4 h-4" aria-hidden="true" />
              <span>Ingresar contraseña y liberar</span>
            </button>
          )}

          {needsOcr && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void onRunOcr(document.id, enhanceContrast)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors disabled:opacity-60 whitespace-nowrap"
            >
              {runningOcr ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <ScanText className="w-4 h-4" aria-hidden="true" />
              )}
              <span>
                {runningOcr ? 'Ejecutando OCR local...' : 'Extraer datos con OCR y volver editable'}
              </span>
            </button>
          )}

          {isNativePdf && hasAcroFormFields && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void onExtractAcroForm(document.id)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors disabled:opacity-60 whitespace-nowrap"
            >
              {extractingAcroForm ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <FormInput className="w-4 h-4" aria-hidden="true" />
              )}
              <span>Extraer {details?.acroFormFieldCount} campos AcroForm</span>
            </button>
          )}

          {!isUnlockableDirectly && !requiresPassword && !needsOcr && !(isNativePdf && hasAcroFormFields) && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onOpenEditor(document.id)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors disabled:opacity-60 whitespace-nowrap"
            >
              <span>Abrir en Editor</span>
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
          )}

          {isNativePdf && !hasAcroFormFields && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void onExtractAcroForm(document.id)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {extractingAcroForm ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <FormInput className="w-4 h-4" aria-hidden="true" />
              )}
              <span>Buscar campos AcroForm</span>
            </button>
          )}

          {(isUnlockableDirectly || requiresPassword || needsOcr || (isNativePdf && hasAcroFormFields)) && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onOpenEditor(document.id)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              <span>Abrir en Editor</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isElectron && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void onRevealInFolder(document.id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Ver copia en carpeta</span>
            </button>
          )}

          <button
            type="button"
            disabled={isBusy}
            onClick={() => void onReanalyze(document.id)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${reanalyzing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>Reanalizar</span>
          </button>
        </div>
      </div>
    </section>
  );
}
