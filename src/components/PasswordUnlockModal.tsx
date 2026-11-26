import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, Loader2, X } from 'lucide-react';
import type { DocumentRecord } from '../../shared/types';

interface PasswordUnlockModalProps {
  document: DocumentRecord | null;
  submitting: boolean;
  errorMessage: string | null;
  onSubmit: (password: string) => Promise<void>;
  onClose: () => void;
}

export function PasswordUnlockModal({
  document,
  submitting,
  errorMessage,
  onSubmit,
  onClose,
}: PasswordUnlockModalProps) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!document) return;
    setPassword('');
    setShowPassword(false);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [document, submitting, onClose]);

  if (!document) return null;

  const handleFormSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || submitting) return;
    await onSubmit(password);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="unlock-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
    >
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <KeyRound
              className="w-4 h-4 text-blue-700 dark:text-blue-400 shrink-0"
              aria-hidden="true"
            />
            <h2
              id="unlock-modal-title"
              className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate"
            >
              Desbloquear PDF cifrado
            </h2>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            aria-label="Cerrar modal de contraseña"
            className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleFormSubmit} className="p-5 space-y-4">
          <div className="space-y-1">
            <p className="text-xs text-slate-500 dark:text-slate-400">Documento</p>
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100 break-words">
              {document.original_name}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-400 pt-1">
              Ingresa la contraseña de apertura. LibreDoc Studio ejecutará{' '}
              <span className="font-mono">qpdf --decrypt</span> localmente para crear una copia
              permanentemente libre de contraseña sin guardar tu clave.
            </p>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="pdf-open-password"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Contraseña de apertura
            </label>
            <div className="relative">
              <input
                id="pdf-open-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                autoFocus
                autoComplete="off"
                placeholder="Escribe la contraseña del PDF..."
                className="w-full h-10 pl-3 pr-10 rounded-lg text-sm bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 dark:focus:ring-blue-400"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" aria-hidden="true" />
                ) : (
                  <Eye className="w-4 h-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          {errorMessage && (
            <p
              role="alert"
              className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900/70 rounded-lg px-3 py-2"
            >
              {errorMessage}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="px-3.5 py-2 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || password.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              <span>Desbloquear copia</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
