import { Download, FileEdit, FolderOpen, Moon, Sun } from 'lucide-react';
import type { AppRoute, DocumentRecord, ThemeMode } from '../../shared/types';

interface SidebarProps {
  activeRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
  theme: ThemeMode;
  onToggleTheme: (theme: ThemeMode) => void;
  activeDocument: DocumentRecord | null;
  documentsCount: number;
  appVersion: string;
  runtime: 'electron' | 'browser-preview';
}

export function Sidebar({
  activeRoute,
  onNavigate,
  theme,
  onToggleTheme,
  activeDocument,
  documentsCount,
  appVersion,
  runtime,
}: SidebarProps) {
  const navItems: Array<{
    id: AppRoute;
    label: string;
    detail?: string;
    icon: typeof FolderOpen;
  }> = [
    {
      id: 'workspace',
      label: 'Inicio / Documentos',
      detail: documentsCount > 0 ? String(documentsCount) : undefined,
      icon: FolderOpen,
    },
    {
      id: 'editor',
      label: 'Editor',
      detail: activeDocument ? activeDocument.original_name : undefined,
      icon: FileEdit,
    },
    {
      id: 'updates',
      label: 'Actualizaciones',
      icon: Download,
    },
  ];

  return (
    <aside className="w-64 shrink-0 flex flex-col justify-between bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 select-none">
      <div>
        <div className="h-14 px-5 flex items-center gap-3 border-b border-slate-200 dark:border-slate-800">
          <img
            src="./app-icon.png"
            alt="LibreDoc Studio"
            className="w-8 h-8 object-contain shrink-0"
            draggable={false}
          />
          <span className="font-display font-semibold text-[15px] tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
            LibreDoc Studio
          </span>
        </div>

        <nav aria-label="Navegación principal" className="p-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeRoute === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:focus-visible:ring-blue-400 ${
                  isActive
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/70 dark:hover:text-slate-100'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span className="truncate whitespace-nowrap">{item.label}</span>
                </span>
                {item.id === 'workspace' && item.detail && (
                  <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                    {item.detail}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {activeDocument && (
          <div className="mx-3 mt-2 pt-3 border-t border-slate-200 dark:border-slate-800 px-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">Documento activo</p>
            <button
              type="button"
              onClick={() => onNavigate('editor')}
              className="mt-1 w-full text-left text-xs font-medium text-slate-800 dark:text-slate-200 hover:text-blue-700 dark:hover:text-blue-300 truncate transition-colors"
              title={activeDocument.original_name}
            >
              {activeDocument.original_name}
            </button>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
        <div
          role="group"
          aria-label="Modo de apariencia"
          className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800"
        >
          <button
            type="button"
            onClick={() => onToggleTheme('light')}
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              theme === 'light'
                ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <Sun className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Claro</span>
          </button>
          <button
            type="button"
            onClick={() => onToggleTheme('dark')}
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              theme === 'dark'
                ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <Moon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Oscuro</span>
          </button>
        </div>

        <div className="px-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span className="font-mono tabular-nums">v{appVersion}</span>
          <span>{runtime === 'electron' ? 'SQLite local' : 'Vista web'}</span>
        </div>
      </div>
    </aside>
  );
}
