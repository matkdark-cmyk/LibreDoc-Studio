import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, FileText, Loader2, ShieldCheck } from 'lucide-react';
import type { UpdaterProgressPayload } from '../../shared/types';
import { getLibreDocBridge } from '../services/storageBridge';

interface UpdaterSplashProps {
  /** Optional controlled payload when rendered inside browser-preview simulation overlay */
  previewPayload?: UpdaterProgressPayload | null;
  onCancelPreview?: () => void;
}

const INITIAL_PAYLOAD: UpdaterProgressPayload = {
  stage: 'preparing',
  version: 'nueva',
  percent: 0,
  bytesPerSecond: 0,
  transferredBytes: 0,
  totalBytes: 0,
  statusMessage: 'Preparando descarga de la actualización...',
  theme: 'light',
};

function formatMegabytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0.0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '—';
  const mbps = bytesPerSecond / (1024 * 1024);
  if (mbps >= 1) {
    return `${mbps.toFixed(1)} MB/s`;
  }
  const kbps = bytesPerSecond / 1024;
  return `${Math.max(1, Math.round(kbps))} KB/s`;
}

export function UpdaterSplash({ previewPayload, onCancelPreview }: UpdaterSplashProps) {
  const bridge = useMemo(() => getLibreDocBridge(), []);
  const [livePayload, setLivePayload] = useState<UpdaterProgressPayload>(INITIAL_PAYLOAD);

  const isControlled = previewPayload !== undefined;
  const payload = isControlled ? (previewPayload ?? INITIAL_PAYLOAD) : livePayload;

  useEffect(() => {
    if (isControlled) return;

    let active = true;
    void bridge.getUpdaterSplashState().then((initial) => {
      if (active && initial) {
        setLivePayload(initial);
      }
    });

    const unsubscribe = bridge.onUpdaterProgress?.((nextPayload) => {
      if (active) {
        setLivePayload(nextPayload);
      }
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge, isControlled]);

  // Sync Tailwind v4 dark mode inside the standalone updater BrowserWindow
  useEffect(() => {
    if (isControlled) return;
    const root = document.documentElement;
    if (payload.theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [payload.theme, isControlled]);

  const clampedPercent = Math.min(100, Math.max(0, Math.round(payload.percent)));
  const isError = payload.stage === 'error';
  const isFinalizing = payload.stage === 'verifying' || payload.stage === 'installing';

  const handleCancelReturn = async () => {
    if (onCancelPreview) {
      onCancelPreview();
      return;
    }
    await bridge.cancelUpdaterAndReturn();
  };

  return (
    <div
      className={
        isControlled
          ? 'w-full max-w-[480px] rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden text-slate-900 dark:text-slate-100'
          : 'h-screen w-screen overflow-hidden flex flex-col justify-between bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 select-none'
      }
    >
      <div className="p-6 flex flex-col justify-between gap-5 h-full">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0">
              <FileText className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100 truncate">
                LibreDoc Studio
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                Actualizando a v{payload.version}
                {payload.isSimulated ? ' · Modo prueba Dev' : ''}
              </p>
            </div>
          </div>

          <div className="text-right shrink-0">
            <span
              className={`text-2xl font-semibold font-mono tabular-nums tracking-tight ${
                isError
                  ? 'text-red-600 dark:text-red-400'
                  : isFinalizing
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-blue-600 dark:text-blue-400'
              }`}
            >
              {clampedPercent}%
            </span>
          </div>
        </div>

        {/* Progress bar & live metrics */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 min-w-0">
            {isError ? (
              <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" aria-hidden="true" />
            ) : isFinalizing ? (
              <CheckCircle2
                className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0"
                aria-hidden="true"
              />
            ) : payload.stage === 'preparing' ? (
              <Loader2 className="w-4 h-4 text-blue-600 dark:text-blue-400 animate-spin shrink-0" aria-hidden="true" />
            ) : (
              <Download className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate font-medium">{payload.statusMessage}</span>
          </div>

          <div
            role="progressbar"
            aria-valuenow={clampedPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Progreso de descarga de actualización"
            className="w-full h-2.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-200 ease-out ${
                isError
                  ? 'bg-red-600 dark:bg-red-500'
                  : isFinalizing
                    ? 'bg-emerald-600 dark:bg-emerald-500'
                    : 'bg-blue-600 dark:bg-blue-500'
              }`}
              style={{ width: `${clampedPercent}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            <span>
              {payload.totalBytes > 0
                ? `${formatMegabytes(payload.transferredBytes)} / ${formatMegabytes(payload.totalBytes)}`
                : 'Calculando tamaño...'}
            </span>
            <span>
              {payload.stage === 'downloading'
                ? formatSpeed(payload.bytesPerSecond)
                : isFinalizing
                  ? 'Instalando silenciosamente'
                  : isError
                    ? 'Interrumpido'
                    : 'Conectando...'}
            </span>
          </div>

          {isError && payload.error && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900/70 text-xs text-red-800 dark:text-red-200 break-words">
              {payload.error}
            </div>
          )}
        </div>

        {/* Footer persistence guarantee or error action */}
        <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 min-w-0">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
            <span className="truncate">
              Sesión y base SQLite resguardadas; al reiniciar volverás exactamente donde quedaste.
            </span>
          </div>

          {isError && (
            <button
              type="button"
              onClick={() => void handleCancelReturn()}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
            >
              Volver a la app
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
