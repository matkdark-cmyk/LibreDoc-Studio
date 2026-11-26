import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  FlaskConical,
  FolderOpen,
  GitBranch,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type {
  StorageDiagnostics,
  UpdaterState,
  VersionHistoryRecord,
} from '../../shared/types';

interface UpdatesPageProps {
  diagnostics: StorageDiagnostics | null;
  versionHistory: VersionHistoryRecord[];
  updaterState: UpdaterState | null;
  checkingUpdates: boolean;
  startingInstall: boolean;
  onCheckForUpdates: () => Promise<void>;
  onToggleAutoCheck: (enabled: boolean) => Promise<void>;
  onAcceptInstallUpdate: () => Promise<void>;
  onTriggerDevPrompt: () => Promise<void>;
  onStartDevSimulation: () => Promise<void>;
  onMarkChangelogSeen: (version: string) => Promise<void>;
  onOpenUserDataFolder: () => Promise<void>;
}

function formatDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('es-CL', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function UpdatesPage({
  diagnostics,
  versionHistory,
  updaterState,
  checkingUpdates,
  startingInstall,
  onCheckForUpdates,
  onToggleAutoCheck,
  onAcceptInstallUpdate,
  onTriggerDevPrompt,
  onStartDevSimulation,
  onMarkChangelogSeen,
  onOpenUserDataFolder,
}: UpdatesPageProps) {
  const isBusyChecking = checkingUpdates || updaterState?.status === 'checking';
  const autoCheckEnabled =
    updaterState?.autoCheckOnStartup ?? diagnostics?.appMeta.auto_check_updates !== 0;

  return (
    <div className="max-w-5xl mx-auto px-8 py-7 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 text-balance">
            Actualizaciones y compatibilidad de datos
          </h1>
          <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400 max-w-2xl">
            Actualiza LibreDoc Studio directamente desde GitHub Releases conservando intactos tu
            historial SQLite, copias de trabajo y sesión exacta.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {diagnostics?.runtime === 'electron' && (
            <button
              type="button"
              onClick={() => void onOpenUserDataFolder()}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              <FolderOpen className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Carpeta de datos</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void onCheckForUpdates()}
            disabled={isBusyChecking}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-60 whitespace-nowrap"
          >
            {isBusyChecking ? (
              <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
            ) : (
              <RefreshCw className="w-4 h-4 shrink-0" aria-hidden="true" />
            )}
            <span>{isBusyChecking ? 'Buscando...' : 'Buscar actualizaciones ahora'}</span>
          </button>
        </div>
      </div>

      {/* Summary metrics */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <p className="text-xs text-slate-500 dark:text-slate-400">Versión instalada</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            v{updaterState?.currentVersion ?? diagnostics?.appVersion ?? '0.1.0'}
          </p>
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            Instalada: {diagnostics ? formatDateTime(diagnostics.appMeta.last_updated_at) : '—'}
          </p>
        </div>

        <div className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <p className="text-xs text-slate-500 dark:text-slate-400">Repositorio GitHub Releases</p>
          <div className="mt-2 flex items-center gap-2 min-w-0">
            <GitBranch className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" aria-hidden="true" />
            <p className="text-sm font-semibold font-mono text-slate-900 dark:text-slate-100 truncate">
              {updaterState?.githubRepo.configured
                ? updaterState.githubRepo.label
                : 'GitHub Releases (NSIS)'}
            </p>
          </div>
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 truncate">
            {updaterState?.lastCheckedAt
              ? `Última comprobación: ${formatDateTime(updaterState.lastCheckedAt)}`
              : updaterState?.githubRepo.configured
                ? 'Conectado para descarga automática'
                : 'Configura owner/repo en electron-builder.yml al publicar'}
          </p>
        </div>

        <div className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <p className="text-xs text-slate-500 dark:text-slate-400">Esquema SQLite</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            v{diagnostics?.schemaVersion ?? 4}
          </p>
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            {diagnostics?.migrations.length ?? 0} migraciones aplicadas sin pérdida de datos
          </p>
        </div>
      </section>

      {/* Live update status & startup auto-check preference */}
      <section className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 divide-y divide-slate-200 dark:divide-slate-800">
        <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            {updaterState?.status === 'error' ? (
              <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
            ) : updaterState?.status === 'available' ? (
              <Download className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {updaterState?.message ?? 'Listo para comprobar actualizaciones desde GitHub Releases.'}
              </p>
              {updaterState?.error && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400 break-words">
                  {updaterState.error}
                </p>
              )}
            </div>
          </div>

          {updaterState?.status === 'available' && updaterState.availableUpdate && (
            <button
              type="button"
              onClick={() => void onAcceptInstallUpdate()}
              disabled={startingInstall}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>
                {startingInstall
                  ? 'Abriendo actualizador...'
                  : `Actualizar a v${updaterState.availableUpdate.version}`}
              </span>
            </button>
          )}
        </div>

        {updaterState?.status === 'available' && updaterState.availableUpdate && (
          <div className="p-5 bg-slate-50/70 dark:bg-slate-950/40 space-y-2">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Notas de la versión v{updaterState.availableUpdate.version}
            </p>
            <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line leading-relaxed">
              {updaterState.availableUpdate.releaseNotes}
            </p>
          </div>
        )}

        <div className="p-5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Buscar actualizaciones automáticamente al iniciar
            </p>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Consulta GitHub Releases al abrir la aplicación y te pregunta antes de descargar.
              Preferencia guardada en SQLite (<span className="font-mono">app_meta</span>).
            </p>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={autoCheckEnabled}
            aria-label="Buscar actualizaciones automáticamente al iniciar"
            onClick={() => void onToggleAutoCheck(!autoCheckEnabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${
              autoCheckEnabled ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-700'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                autoCheckEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </section>

      {/* DEV-ONLY visual test panel */}
      {updaterState?.isDevMode && (
        <section className="rounded-xl bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-800/80 p-5 space-y-4">
          <div className="flex items-start gap-3">
            <FlaskConical
              className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Modo de prueba local del actualizador (solo entorno de desarrollo)
              </h2>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Este panel se oculta automáticamente en los instaladores compilados para producción.
                Te permite validar el aviso de nueva versión, el guardado real en SQLite con{' '}
                <span className="font-mono">pending_restore = 1</span>, la ventana dedicada de
                descarga (0% a 100%, velocidad y MB) y la restauración exacta de tu sesión.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void onTriggerDevPrompt()}
              className="px-3.5 py-2 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              Probar aviso de nueva versión (Dev)
            </button>
            <button
              type="button"
              onClick={() => void onStartDevSimulation()}
              disabled={startingInstall}
              className="px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 transition-colors disabled:opacity-60"
            >
              Probar ventana de descarga y restauración (Dev)
            </button>
          </div>
        </section>
      )}

      {/* Version history from SQLite */}
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Historial de versiones instaladas
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Registro persistido en la tabla local <span className="font-mono">version_history</span>.
          </p>
        </div>

        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
          {versionHistory.length === 0 ? (
            <div className="p-6 text-sm text-slate-500 dark:text-slate-400">
              Aún no hay registros en el historial de versiones.
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {versionHistory.map((item) => (
                <div
                  key={item.id}
                  className="p-5 flex flex-col sm:flex-row sm:items-start justify-between gap-4"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-mono font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                        v{item.version}
                      </span>
                      <span className="text-slate-400" aria-hidden="true">
                        ·
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        Instalada el {formatDateTime(item.installed_at)}
                      </span>
                    </div>
                    <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                      {item.release_notes}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {item.changelog_seen === 1 ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        <Check
                          className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400"
                          aria-hidden="true"
                        />
                        Notas revisadas
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void onMarkChangelogSeen(item.version)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                      >
                        Marcar como revisado
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Schema migrations table */}
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Migraciones de esquema aplicadas
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Registro auditable en <span className="font-mono">schema_migrations</span> dentro de{' '}
            <span className="font-mono break-all">{diagnostics?.dbPath ?? 'libredoc.db'}</span>.
          </p>
        </div>

        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-3 px-4 w-24">Versión</th>
                <th className="py-3 px-4">Migración</th>
                <th className="py-3 px-4 text-right">Aplicada</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
              {(diagnostics?.migrations ?? []).map((mig) => (
                <tr key={mig.version} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                  <td className="py-3 px-4 font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    v{mig.version}
                  </td>
                  <td className="py-3 px-4 font-mono text-xs text-slate-700 dark:text-slate-300">
                    {mig.name}
                  </td>
                  <td className="py-3 px-4 text-right text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {formatDateTime(mig.applied_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
