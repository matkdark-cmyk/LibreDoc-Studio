import { ArrowRight, Download, ShieldCheck, X } from 'lucide-react';
import type { AvailableUpdateInfo } from '../../shared/types';

interface UpdateAvailableDialogProps {
  currentVersion: string;
  updateInfo: AvailableUpdateInfo;
  starting: boolean;
  onAccept: () => Promise<void>;
  onLater: () => void;
}

function formatReleaseDate(iso?: string): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat('es-CL', {
      dateStyle: 'medium',
    }).format(new Date(iso));
  } catch {
    return null;
  }
}

export function UpdateAvailableDialog({
  currentVersion,
  updateInfo,
  starting,
  onAccept,
  onLater,
}: UpdateAvailableDialogProps) {
  const formattedDate = formatReleaseDate(updateInfo.releaseDate);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
    >
      <div className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2
              id="update-dialog-title"
              className="text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              Nueva versión disponible
            </h2>
            <div className="mt-1 flex items-center gap-2 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
              <span>v{currentVersion}</span>
              <ArrowRight className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
              <span className="font-semibold text-blue-600 dark:text-blue-400">
                v{updateInfo.version}
              </span>
              {formattedDate && (
                <>
                  <span className="text-slate-400" aria-hidden="true">
                    ·
                  </span>
                  <span className="font-sans">{formattedDate}</span>
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onLater}
            disabled={starting}
            aria-label="Cerrar aviso de actualización"
            className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            ¿Deseas descargar e instalar la versión{' '}
            <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
              v{updateInfo.version}
            </span>{' '}
            ahora?
          </p>

          <div className="rounded-lg bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 p-4 max-h-52 overflow-y-auto">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
              Notas de esta versión
            </p>
            <p className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-line leading-relaxed">
              {updateInfo.releaseNotes}
            </p>
          </div>

          <div className="flex items-start gap-2.5 p-3 rounded-lg bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-900/60 text-xs text-emerald-900 dark:text-emerald-200">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              Al actualizar, tu documento activo, página, zoom y todos los campos editados se
              guardarán en SQLite para reabrir exactamente en el mismo punto al finalizar.
            </span>
          </div>
        </div>

        <div className="px-6 py-4 bg-slate-50 dark:bg-slate-900/80 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onLater}
            disabled={starting}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            Más tarde
          </button>
          <button
            type="button"
            onClick={() => void onAccept()}
            disabled={starting}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-60"
          >
            <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{starting ? 'Preparando descarga...' : 'Actualizar ahora'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
