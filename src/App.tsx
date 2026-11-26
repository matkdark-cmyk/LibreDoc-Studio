import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, RotateCcw, X } from 'lucide-react';
import type {
  AcroFormExportResult,
  AppRoute,
  CreateDocumentInput,
  DocumentField,
  DocumentRecord,
  OcrProgressEvent,
  PrintDocumentOptions,
  PrintRenderedPage,
  RenderedPagePayload,
  SessionState,
  SessionStatePatch,
  StorageDiagnostics,
  ThemeMode,
  UnlockResult,
  UpdaterProgressPayload,
  UpdaterState,
  UpsertFieldInput,
  VersionHistoryRecord,
} from '../shared/types';
import type { CardFeedback } from './components/DiagnosisCard';
import { Sidebar } from './components/Sidebar';
import { UpdateAvailableDialog } from './components/UpdateAvailableDialog';
import { EditorPage } from './pages/EditorPage';
import { PreviewPage } from './pages/PreviewPage';
import { UpdaterSplash } from './pages/UpdaterSplash';
import { UpdatesPage } from './pages/UpdatesPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { detectStaticPdfFormFields } from './services/pdfFormDetector';
import { renderPdfPagesForOcr } from './services/pdfPageRenderer';
import {
  getLibreDocBridge,
  ingestBrowserPreviewFile,
  isElectronRuntime,
} from './services/storageBridge';

const DEFAULT_SESSION: SessionState = {
  active_document_id: null,
  active_route: 'workspace',
  active_page: 1,
  zoom_level: 1,
  sidebar_tab: 'fields',
  scroll_position: 0,
  pending_restore: 0,
  theme: 'light',
};

const ROUTE_TITLES: Record<AppRoute, string> = {
  workspace: 'Inicio / Documentos',
  preview: 'Vista previa',
  editor: 'Editor',
  updates: 'Actualizaciones',
};

export default function App() {
  const isUpdaterSplashRoute =
    typeof window !== 'undefined' && window.location.hash.startsWith('#/updater-splash');

  if (isUpdaterSplashRoute) {
    return <UpdaterSplash />;
  }

  return <MainApp />;
}

function MainApp() {
  const bridge = useMemo(() => getLibreDocBridge(), []);
  const electronMode = useMemo(() => isElectronRuntime(), []);

  const [booting, setBooting] = useState(true);
  const [diagnostics, setDiagnostics] = useState<StorageDiagnostics | null>(null);
  const [session, setSession] = useState<SessionState>(DEFAULT_SESSION);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [fields, setFields] = useState<DocumentField[]>([]);
  const [versionHistory, setVersionHistory] = useState<VersionHistoryRecord[]>([]);
  const [showRestoreNotice, setShowRestoreNotice] = useState(false);
  const [restoredUpdateVersion, setRestoredUpdateVersion] = useState<string | null>(null);

  const [updaterState, setUpdaterState] = useState<UpdaterState | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [startingInstall, setStartingInstall] = useState(false);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);
  const [previewSplashPayload, setPreviewSplashPayload] = useState<UpdaterProgressPayload | null>(
    null,
  );

  const [selectedDiagnosisDocId, setSelectedDiagnosisDocId] = useState<string | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [runningOcr, setRunningOcr] = useState(false);
  const [extractingAcroForm, setExtractingAcroForm] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [detectingFields, setDetectingFields] = useState(false);
  const [detectProgress, setDetectProgress] = useState<{
    currentPage: number;
    totalPages: number;
  } | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [editorFeedback, setEditorFeedback] = useState<{
    success: boolean;
    message: string;
    error?: string;
  } | null>(null);
  const [ocrProgress, setOcrProgress] = useState<OcrProgressEvent | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [cardFeedback, setCardFeedback] = useState<CardFeedback | null>(null);

  const sessionRef = useRef<SessionState>(DEFAULT_SESSION);
  sessionRef.current = session;

  const activeDocument = useMemo(
    () => documents.find((doc) => doc.id === session.active_document_id) ?? null,
    [documents, session.active_document_id],
  );

  const selectedDiagnosisDoc = useMemo(
    () => documents.find((doc) => doc.id === selectedDiagnosisDocId) ?? null,
    [documents, selectedDiagnosisDocId],
  );

  // Sync Tailwind v4 `.dark` class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (session.theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [session.theme]);

  // Subscribe to real-time OCR progress events from Electron main process
  useEffect(() => {
    if (!bridge.onOcrProgress) return;
    return bridge.onOcrProgress((progressEvent) => {
      setOcrProgress(progressEvent);
    });
  }, [bridge]);

  // Subscribe to updater state changes from Electron main process (or preview bridge)
  useEffect(() => {
    if (!bridge.onUpdaterStateChange) return;
    return bridge.onUpdaterStateChange((nextState) => {
      setUpdaterState(nextState);
      if (nextState.status === 'available' && nextState.availableUpdate) {
        setDismissedUpdateVersion((prev) =>
          prev === nextState.availableUpdate?.version ? null : prev,
        );
      }
      if (nextState.status !== 'downloading') {
        setStartingInstall(false);
      }
    });
  }, [bridge]);

  // In web preview mode, render the dedicated UpdaterSplash overlay when testing dev simulation
  useEffect(() => {
    if (electronMode || !bridge.onUpdaterProgress) return;
    return bridge.onUpdaterProgress((payload) => {
      setPreviewSplashPayload(payload);
    });
  }, [bridge, electronMode]);

  // Initial load & exact session restoration
  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        const [diag, loadedSession, docs, versions, initialUpdater] = await Promise.all([
          bridge.getDiagnostics(),
          bridge.getSessionState(),
          bridge.listDocuments(),
          bridge.listVersionHistory(),
          bridge.getUpdaterState(),
        ]);

        if (!active) return;

        setDiagnostics(diag);
        setSession(loadedSession);
        setDocuments(docs);
        setVersionHistory(versions);
        setUpdaterState(initialUpdater);

        if (loadedSession.active_document_id) {
          const loadedFields = await bridge.listDocumentFields(loadedSession.active_document_id);
          if (active) {
            setFields(loadedFields);
          }
        }

        if (diag.restoredFromSession || diag.updatedToVersion) {
          setShowRestoreNotice(true);
          setRestoredUpdateVersion(diag.updatedToVersion ?? null);
          await bridge.acknowledgeSessionRestore();
        }
      } finally {
        if (active) {
          setBooting(false);
        }
      }
    }

    void bootstrap();

    return () => {
      active = false;
    };
  }, [bridge]);

  // Synchronous flush of session_state before closing or reloading the app
  useEffect(() => {
    const handleBeforeUnload = () => {
      bridge.flushSessionSync({
        active_document_id: sessionRef.current.active_document_id,
        active_route: sessionRef.current.active_route,
        active_page: sessionRef.current.active_page,
        zoom_level: sessionRef.current.zoom_level,
        sidebar_tab: sessionRef.current.sidebar_tab,
        scroll_position: sessionRef.current.scroll_position,
        theme: sessionRef.current.theme,
        pending_restore: 1,
      });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [bridge]);

  const patchSession = useCallback(
    (patch: SessionStatePatch) => {
      setSession((prev) => {
        const next: SessionState = { ...prev, ...patch };
        sessionRef.current = next;
        return next;
      });
      void bridge.saveSessionState(patch);
    },
    [bridge],
  );

  const loadFieldsForDocument = useCallback(
    async (documentId: string | null) => {
      if (!documentId) {
        setFields([]);
        return;
      }
      const nextFields = await bridge.listDocumentFields(documentId);
      setFields(nextFields);
    },
    [bridge],
  );

  const handleNavigate = useCallback(
    (route: AppRoute) => {
      patchSession({ active_route: route });
      if (route === 'editor' && sessionRef.current.active_document_id) {
        void loadFieldsForDocument(sessionRef.current.active_document_id);
      }
    },
    [loadFieldsForDocument, patchSession],
  );

  const handleToggleTheme = useCallback(
    (theme: ThemeMode) => {
      patchSession({ theme });
    },
    [patchSession],
  );

  const runStaticPdfAutoDetection = useCallback(
    async (documentId: string, onlyIfEmpty: boolean) => {
      const targetDoc = (await bridge.getDocument(documentId)) ?? null;
      if (!targetDoc || targetDoc.file_type.toLowerCase() !== 'pdf') return;
      if (targetDoc.diagnosis_type === 'PDF_ENCRYPTED_OPEN') return;

      if (onlyIfEmpty) {
        const existingFields = await bridge.listDocumentFields(documentId);
        const nativeAcroCount = targetDoc.analysis?.details.acroFormFieldCount ?? 0;
        // Guardrail #1: never overwrite previously saved SQLite fields or native AcroForm fields
        if (existingFields.length > 0 || nativeAcroCount > 0) {
          return;
        }
      }

      setDetectingFields(true);
      setDetectProgress(null);
      setEditorFeedback(null);

      try {
        const pdfBytes = await bridge.readWorkingFileBytes(documentId);
        if (!pdfBytes || pdfBytes.byteLength === 0) {
          throw new Error('No se pudieron leer los bytes del PDF desde el workspace.');
        }

        const result = await detectStaticPdfFormFields({
          documentId,
          pdfBytes,
          onProgress: (currentPage, totalPages) => {
            setDetectProgress({ currentPage, totalPages });
          },
        });

        const saved = await bridge.replaceDocumentFields(documentId, result.fields);
        setFields(saved);
        const updatedDocs = await bridge.listDocuments();
        setDocuments(updatedDocs);

        const firstFieldPage = saved.length > 0 ? saved[0].page_number : 1;
        if (saved.length > 0 && onlyIfEmpty) {
          patchSession({ active_page: firstFieldPage, scroll_position: 0 });
        }

        setEditorFeedback({
          success: true,
          message:
            saved.length > 0
              ? `Se detectaron ${saved.length} casilla(s) en ${result.pageCount} página(s). Puedes moverlas, ajustarlas o exportar el PDF rellenable.`
              : `Análisis completado (${result.pageCount} páginas) sin casillas vacías detectadas. Puedes dibujarlas manualmente con + Texto / + Check.`,
        });
      } catch (err) {
        setEditorFeedback({
          success: false,
          message: 'No se pudo completar la detección automática de casillas.',
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setDetectingFields(false);
        setDetectProgress(null);
      }
    },
    [bridge, patchSession],
  );

  const handleOpenDocument = useCallback(
    async (documentId: string) => {
      setEditorFeedback(null);
      await loadFieldsForDocument(documentId);
      patchSession({
        active_document_id: documentId,
        active_route: 'editor',
        active_page: 1,
        scroll_position: 0,
      });
      await runStaticPdfAutoDetection(documentId, true);
    },
    [loadFieldsForDocument, patchSession, runStaticPdfAutoDetection],
  );

  const handlePreviewDocument = useCallback(
    (documentId: string) => {
      patchSession({
        active_document_id: documentId,
        active_route: 'preview',
        active_page: 1,
        scroll_position: 0,
      });
    },
    [patchSession],
  );

  const handleDetectPdfFields = useCallback(
    async (documentId: string) => {
      await runStaticPdfAutoDetection(documentId, false);
    },
    [runStaticPdfAutoDetection],
  );

  const handleExportAcroForm = useCallback(
    async (
      documentId: string,
      currentFields?: DocumentField[],
    ): Promise<AcroFormExportResult> => {
      setExportingPdf(true);
      setEditorFeedback(null);
      try {
        const result = await bridge.exportAcroFormPdf(documentId, currentFields);
        if (!result.canceled) {
          setEditorFeedback({
            success: result.success,
            message: result.message,
            error: result.error,
          });
        }
        if (result.success) {
          const updatedDocs = await bridge.listDocuments();
          setDocuments(updatedDocs);
        }
        return result;
      } catch (err) {
        const failed: AcroFormExportResult = {
          success: false,
          fieldsExported: 0,
          message: 'Error inesperado al exportar el PDF rellenable.',
          error: err instanceof Error ? err.message : String(err),
        };
        setEditorFeedback({
          success: false,
          message: failed.message,
          error: failed.error,
        });
        return failed;
      } finally {
        setExportingPdf(false);
      }
    },
    [bridge],
  );

  const handleCreateDocument = useCallback(
    async (input: CreateDocumentInput, openImmediately = true) => {
      const created = await bridge.createDocument(input);
      const updatedList = await bridge.listDocuments();
      setDocuments(updatedList);

      if (openImmediately) {
        await handleOpenDocument(created.id);
      } else {
        setSelectedDiagnosisDocId(created.id);
      }
    },
    [bridge, handleOpenDocument],
  );

  const handlePickNativeFile = useCallback(async () => {
    setIngestError(null);
    setCardFeedback(null);
    setIngesting(true);
    try {
      const created = await bridge.pickAndRegisterDocument();
      if (!created) return;
      const [updatedList, diag] = await Promise.all([
        bridge.listDocuments(),
        bridge.getDiagnostics(),
      ]);
      setDocuments(updatedList);
      setDiagnostics(diag);
      setSelectedDiagnosisDocId(created.id);

      // For ready static PDFs, open the visual Editor directly and auto-detect fields
      if (
        created.file_type.toLowerCase() === 'pdf' &&
        created.diagnosis_type === 'PDF_NATIVE_EDITABLE' &&
        (created.analysis?.details.acroFormFieldCount ?? 0) === 0
      ) {
        await handleOpenDocument(created.id);
      }
    } catch (err) {
      setIngestError(
        err instanceof Error ? err.message : 'No se pudo analizar el archivo seleccionado.',
      );
    } finally {
      setIngesting(false);
    }
  }, [bridge, handleOpenDocument]);

  const handleIngestDroppedFiles = useCallback(
    async (files: FileList) => {
      setIngestError(null);
      setCardFeedback(null);
      setIngesting(true);
      try {
        let lastCreated: DocumentRecord | null = null;
        for (const file of Array.from(files)) {
          if (electronMode) {
            const filePath =
              bridge.getPathForFile?.(file) ||
              (file as File & { path?: string }).path ||
              '';
            if (!filePath) {
              throw new Error(
                'No se pudo obtener la ruta local del archivo arrastrado. Usa el botón "Cargar archivo".',
              );
            }
            lastCreated = await bridge.ingestFilePath(filePath);
          } else {
            lastCreated = await ingestBrowserPreviewFile(file);
          }
        }

        const [updatedList, diag] = await Promise.all([
          bridge.listDocuments(),
          bridge.getDiagnostics(),
        ]);
        setDocuments(updatedList);
        setDiagnostics(diag);
        if (lastCreated) {
          setSelectedDiagnosisDocId(lastCreated.id);
          if (
            lastCreated.file_type.toLowerCase() === 'pdf' &&
            lastCreated.diagnosis_type === 'PDF_NATIVE_EDITABLE' &&
            (lastCreated.analysis?.details.acroFormFieldCount ?? 0) === 0
          ) {
            await handleOpenDocument(lastCreated.id);
          }
        }
      } catch (err) {
        setIngestError(
          err instanceof Error ? err.message : 'Ocurrió un error al procesar el archivo.',
        );
      } finally {
        setIngesting(false);
      }
    },
    [bridge, electronMode, handleOpenDocument],
  );

  const handlePickNativeFileForPreview = useCallback(async () => {
    setIngestError(null);
    setIngesting(true);
    try {
      const created = await bridge.pickAndRegisterDocument();
      if (!created) return;
      const [updatedList, diag] = await Promise.all([
        bridge.listDocuments(),
        bridge.getDiagnostics(),
      ]);
      setDocuments(updatedList);
      setDiagnostics(diag);
      handlePreviewDocument(created.id);
    } catch (err) {
      setIngestError(
        err instanceof Error ? err.message : 'No se pudo cargar el archivo para vista previa.',
      );
    } finally {
      setIngesting(false);
    }
  }, [bridge, handlePreviewDocument]);

  const handleIngestFilesForPreview = useCallback(
    async (files: FileList) => {
      setIngestError(null);
      setIngesting(true);
      try {
        let lastCreated: DocumentRecord | null = null;
        for (const file of Array.from(files)) {
          if (electronMode) {
            const filePath =
              bridge.getPathForFile?.(file) ||
              (file as File & { path?: string }).path ||
              '';
            if (!filePath) {
              throw new Error('No se pudo obtener la ruta local del archivo.');
            }
            lastCreated = await bridge.ingestFilePath(filePath);
          } else {
            lastCreated = await ingestBrowserPreviewFile(file);
          }
        }
        const [updatedList, diag] = await Promise.all([
          bridge.listDocuments(),
          bridge.getDiagnostics(),
        ]);
        setDocuments(updatedList);
        setDiagnostics(diag);
        if (lastCreated) {
          handlePreviewDocument(lastCreated.id);
        }
      } catch (err) {
        setIngestError(
          err instanceof Error ? err.message : 'Ocurrió un error al cargar el archivo.',
        );
      } finally {
        setIngesting(false);
      }
    },
    [bridge, electronMode, handlePreviewDocument],
  );

  const handleSelectDiagnosisDoc = useCallback((documentId: string | null) => {
    setCardFeedback(null);
    setSelectedDiagnosisDocId(documentId);
  }, []);

  const handleUnlockDocument = useCallback(
    async (documentId: string, password?: string): Promise<UnlockResult> => {
      setUnlocking(true);
      setCardFeedback(null);
      try {
        const result = await bridge.unlockDocument(documentId, password);
        setCardFeedback({
          success: result.success,
          message: result.message,
          error: result.error,
        });
        if (result.success) {
          const [updatedList, diag] = await Promise.all([
            bridge.listDocuments(),
            bridge.getDiagnostics(),
          ]);
          setDocuments(updatedList);
          setDiagnostics(diag);
          setSelectedDiagnosisDocId(documentId);
        }
        return result;
      } catch (err) {
        const failed: UnlockResult = {
          success: false,
          message: 'Error inesperado al intentar desbloquear el documento.',
          error: err instanceof Error ? err.message : String(err),
        };
        setCardFeedback(failed);
        return failed;
      } finally {
        setUnlocking(false);
      }
    },
    [bridge],
  );

  const handleRunOcr = useCallback(
    async (documentId: string, enhanceContrast: boolean) => {
      const targetDoc = documents.find((d) => d.id === documentId);
      if (!targetDoc) return;

      setRunningOcr(true);
      setCardFeedback(null);

      try {
        let renderedPages: RenderedPagePayload[] | undefined;

        if (targetDoc.file_type === 'pdf') {
          setOcrProgress({
            documentId,
            stage: 'rendering',
            currentPage: 1,
            totalPages: Math.max(1, targetDoc.analysis?.details.pageCount ?? 1),
            pageProgress: 0,
            overallProgress: 2,
            message: 'Leyendo PDF para renderizar páginas en alta resolución...',
          });

          const pdfBytes = await bridge.readWorkingFileBytes(documentId);
          if (!pdfBytes) {
            throw new Error('No se pudieron leer los bytes del PDF desde el workspace.');
          }

          renderedPages = await renderPdfPagesForOcr({
            pdfBytes,
            enhanceContrast,
            onPageProgress: (currentPage, totalPages) => {
              setOcrProgress({
                documentId,
                stage: 'rendering',
                currentPage,
                totalPages,
                pageProgress: Math.round((currentPage / Math.max(1, totalPages)) * 100),
                overallProgress: Math.min(10, Math.round((currentPage / Math.max(1, totalPages)) * 10)),
                message: `Renderizando página ${currentPage} de ${totalPages} (300 DPI aprox.)...`,
              });
            },
          });
        }

        const result = await bridge.runLocalOcr(documentId, renderedPages);
        setCardFeedback({
          success: result.success,
          message: result.stats
            ? `${result.message} (Confianza media: ${result.stats.avgConfidence}%)`
            : result.message,
          error: result.error,
        });

        if (result.success) {
          const [updatedList, diag] = await Promise.all([
            bridge.listDocuments(),
            bridge.getDiagnostics(),
          ]);
          setDocuments(updatedList);
          setDiagnostics(diag);
          if (sessionRef.current.active_document_id === documentId && result.fields) {
            setFields(result.fields);
          }
        }
      } catch (err) {
        setCardFeedback({
          success: false,
          message: 'Error durante el proceso OCR local.',
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setRunningOcr(false);
        setOcrProgress(null);
      }
    },
    [bridge, documents],
  );

  const handleExtractAcroForm = useCallback(
    async (documentId: string) => {
      setExtractingAcroForm(true);
      setCardFeedback(null);
      try {
        const result = await bridge.extractAcroFormFields(documentId);
        setCardFeedback({
          success: result.success,
          message: result.message,
          error: result.error,
        });
        if (result.success) {
          const updatedList = await bridge.listDocuments();
          setDocuments(updatedList);
          if (result.fields.length > 0) {
            setFields(result.fields);
            patchSession({
              active_document_id: documentId,
              active_route: 'editor',
              active_page: 1,
              scroll_position: 0,
            });
          }
        }
      } catch (err) {
        setCardFeedback({
          success: false,
          message: 'No se pudieron extraer los campos AcroForm.',
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setExtractingAcroForm(false);
      }
    },
    [bridge, patchSession],
  );

  const handleReanalyzeDocument = useCallback(
    async (documentId: string) => {
      setReanalyzing(true);
      setCardFeedback(null);
      try {
        await bridge.reanalyzeDocument(documentId);
        const [updatedList, diag] = await Promise.all([
          bridge.listDocuments(),
          bridge.getDiagnostics(),
        ]);
        setDocuments(updatedList);
        setDiagnostics(diag);
      } finally {
        setReanalyzing(false);
      }
    },
    [bridge],
  );

  const handleRevealDocumentInFolder = useCallback(
    async (documentId: string) => {
      await bridge.revealDocumentInFolder(documentId);
    },
    [bridge],
  );

  const handleDeleteDocument = useCallback(
    async (documentId: string) => {
      const deleted = await bridge.deleteDocument(documentId);
      if (!deleted) return;
      const [updatedList, updatedSession] = await Promise.all([
        bridge.listDocuments(),
        bridge.getSessionState(),
      ]);
      setDocuments(updatedList);
      setSession(updatedSession);
      if (selectedDiagnosisDocId === documentId) {
        setSelectedDiagnosisDocId(null);
        setCardFeedback(null);
      }
      if (sessionRef.current.active_document_id === documentId) {
        setFields([]);
      }
    },
    [bridge, selectedDiagnosisDocId],
  );

  const handleUpsertField = useCallback(
    async (input: UpsertFieldInput) => {
      await bridge.upsertDocumentField(input);
      const [updatedFields, updatedDocs] = await Promise.all([
        bridge.listDocumentFields(input.document_id),
        bridge.listDocuments(),
      ]);
      setFields(updatedFields);
      setDocuments(updatedDocs);
    },
    [bridge],
  );

  const handleUpdateFieldValue = useCallback(
    async (fieldId: string, value: string) => {
      const updated = await bridge.updateFieldValue(fieldId, value);
      if (!updated) return;
      setFields((prev) => prev.map((f) => (f.id === fieldId ? updated : f)));
      const updatedDocs = await bridge.listDocuments();
      setDocuments(updatedDocs);
    },
    [bridge],
  );

  const handleDeleteField = useCallback(
    async (fieldId: string) => {
      const removed = await bridge.deleteDocumentField(fieldId);
      if (!removed) return;
      setFields((prev) => prev.filter((f) => f.id !== fieldId));
      const updatedDocs = await bridge.listDocuments();
      setDocuments(updatedDocs);
    },
    [bridge],
  );

  const handleReadPlainText = useCallback(
    (documentId: string) => bridge.readPlainTextDocument(documentId),
    [bridge],
  );

  const handleReadWorkingFileBytes = useCallback(
    (documentId: string) => bridge.readWorkingFileBytes(documentId),
    [bridge],
  );

  const handleListPrinters = useCallback(() => bridge.listPrinters(), [bridge]);

  const handlePrintRenderedDocument = useCallback(
    (pages: PrintRenderedPage[], options: PrintDocumentOptions, documentTitle: string) =>
      bridge.printRenderedDocument(pages, options, documentTitle),
    [bridge],
  );

  const handleMarkChangelogSeen = useCallback(
    async (version: string) => {
      await bridge.markVersionChangelogSeen(version);
      const nextVersions = await bridge.listVersionHistory();
      setVersionHistory(nextVersions);
    },
    [bridge],
  );

  const handleOpenUserDataFolder = useCallback(async () => {
    await bridge.openUserDataFolder();
  }, [bridge]);

  const buildSessionSnapshot = useCallback(
    (): SessionStatePatch => ({
      active_document_id: sessionRef.current.active_document_id,
      active_route: sessionRef.current.active_route,
      active_page: sessionRef.current.active_page,
      zoom_level: sessionRef.current.zoom_level,
      sidebar_tab: sessionRef.current.sidebar_tab,
      scroll_position: sessionRef.current.scroll_position,
      theme: sessionRef.current.theme,
      pending_restore: 1,
    }),
    [],
  );

  const handleCheckForUpdates = useCallback(async () => {
    setCheckingUpdates(true);
    try {
      const next = await bridge.checkForUpdates();
      setUpdaterState(next);
      if (next.status === 'available' && next.availableUpdate) {
        setDismissedUpdateVersion(null);
      }
    } finally {
      setCheckingUpdates(false);
    }
  }, [bridge]);

  const handleToggleAutoCheck = useCallback(
    async (enabled: boolean) => {
      const next = await bridge.setAutoCheckUpdates(enabled);
      setUpdaterState(next);
      const diag = await bridge.getDiagnostics();
      setDiagnostics(diag);
    },
    [bridge],
  );

  const handleAcceptInstallUpdate = useCallback(async () => {
    setStartingInstall(true);
    try {
      const result = await bridge.acceptAndInstallUpdate(buildSessionSnapshot());
      if (!result.ok) {
        setStartingInstall(false);
      }
    } catch {
      setStartingInstall(false);
    }
  }, [bridge, buildSessionSnapshot]);

  const handleTriggerDevPrompt = useCallback(async () => {
    setDismissedUpdateVersion(null);
    const next = await bridge.triggerDevUpdatePrompt();
    setUpdaterState(next);
  }, [bridge]);

  const handleStartDevSimulation = useCallback(async () => {
    setStartingInstall(true);
    try {
      const result = await bridge.startDevUpdateSimulation(buildSessionSnapshot());
      if (!result.ok) {
        setStartingInstall(false);
      }
    } catch {
      setStartingInstall(false);
    }
  }, [bridge, buildSessionSnapshot]);

  const handleCancelPreviewSplash = useCallback(async () => {
    await bridge.cancelUpdaterAndReturn();
    setPreviewSplashPayload(null);
    setStartingInstall(false);
  }, [bridge]);

  const showUpdateDialog = Boolean(
    updaterState?.status === 'available' &&
      updaterState.availableUpdate &&
      dismissedUpdateVersion !== updaterState.availableUpdate.version &&
      !previewSplashPayload,
  );

  return (
    <div className="h-screen w-screen overflow-hidden flex bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <Sidebar
        activeRoute={session.active_route}
        onNavigate={handleNavigate}
        theme={session.theme}
        onToggleTheme={handleToggleTheme}
        activeDocument={activeDocument}
        documentsCount={documents.length}
        appVersion={diagnostics?.appVersion ?? '0.1.0'}
        runtime={diagnostics?.runtime ?? 'browser-preview'}
      />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="h-14 px-6 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-6 shrink-0">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
              {ROUTE_TITLES[session.active_route]}
            </span>
            {(session.active_route === 'editor' || session.active_route === 'preview') &&
              activeDocument && (
                <>
                  <span className="text-slate-400" aria-hidden="true">
                    /
                  </span>
                  <span className="text-slate-600 dark:text-slate-300 truncate">
                    {activeDocument.original_name}
                  </span>
                </>
              )}
          </div>

          <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 shrink-0">
            <span className="whitespace-nowrap">Procesamiento 100% local</span>
          </div>
        </header>

        {showRestoreNotice && (
          <div
            role="status"
            className={`px-6 py-2.5 border-b flex items-center justify-between gap-4 shrink-0 ${
              restoredUpdateVersion
                ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-900/70'
                : 'bg-blue-50 dark:bg-blue-950/60 border-blue-200 dark:border-blue-900/70'
            }`}
          >
            <div
              className={`flex items-center gap-2 text-xs min-w-0 ${
                restoredUpdateVersion
                  ? 'text-emerald-900 dark:text-emerald-200'
                  : 'text-blue-900 dark:text-blue-200'
              }`}
            >
              {restoredUpdateVersion ? (
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">
                {restoredUpdateVersion
                  ? `Actualizado a v${restoredUpdateVersion} — Tu sesión fue restaurada conservando todos los datos de versiones anteriores${
                      activeDocument ? ` (${activeDocument.original_name})` : ''
                    }.`
                  : `Sesión anterior restaurada automáticamente${
                      activeDocument ? ` — ${activeDocument.original_name}` : ''
                    }.`}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowRestoreNotice(false);
                setRestoredUpdateVersion(null);
              }}
              aria-label="Cerrar aviso de restauración"
              className={`p-1 rounded transition-colors shrink-0 ${
                restoredUpdateVersion
                  ? 'text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60'
                  : 'text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60'
              }`}
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        <main className="flex-1 min-h-0 overflow-y-auto">
          {session.active_route === 'workspace' && (
            <WorkspacePage
              documents={documents}
              activeDocumentId={session.active_document_id}
              selectedDiagnosisDoc={selectedDiagnosisDoc}
              loading={booting}
              ingesting={ingesting}
              unlocking={unlocking}
              runningOcr={runningOcr}
              extractingAcroForm={extractingAcroForm}
              reanalyzing={reanalyzing}
              ocrProgress={ocrProgress}
              ingestError={ingestError}
              cardFeedback={cardFeedback}
              diagnostics={diagnostics}
              onPickNativeFile={handlePickNativeFile}
              onIngestDroppedFiles={handleIngestDroppedFiles}
              onCreateDocument={handleCreateDocument}
              onSelectDiagnosisDoc={handleSelectDiagnosisDoc}
              onUnlockDocument={handleUnlockDocument}
              onRunOcr={handleRunOcr}
              onExtractAcroForm={handleExtractAcroForm}
              onReanalyzeDocument={handleReanalyzeDocument}
              onRevealDocumentInFolder={handleRevealDocumentInFolder}
              onPreviewDocument={handlePreviewDocument}
              onOpenDocument={(id) => void handleOpenDocument(id)}
              onDeleteDocument={handleDeleteDocument}
              onOpenUserDataFolder={handleOpenUserDataFolder}
              onClearIngestError={() => setIngestError(null)}
            />
          )}

          {session.active_route === 'preview' && (
            <PreviewPage
              document={activeDocument}
              recentDocuments={documents}
              session={session}
              isElectron={electronMode}
              ingesting={ingesting}
              onSelectDocumentForPreview={handlePreviewDocument}
              onPickFileForPreview={handlePickNativeFileForPreview}
              onIngestFilesForPreview={handleIngestFilesForPreview}
              onOpenInEditor={(id) => void handleOpenDocument(id)}
              onGoToWorkspace={() => handleNavigate('workspace')}
              onPatchSession={patchSession}
              onListPrinters={handleListPrinters}
              onPrintRenderedDocument={handlePrintRenderedDocument}
              onReadPlainText={handleReadPlainText}
              onReadWorkingFileBytes={handleReadWorkingFileBytes}
            />
          )}

          {session.active_route === 'editor' && (
            <EditorPage
              document={activeDocument}
              recentDocuments={documents}
              fields={fields}
              session={session}
              isElectron={electronMode}
              detectingFields={detectingFields}
              detectProgress={detectProgress}
              exportingPdf={exportingPdf}
              editorFeedback={editorFeedback}
              onClearEditorFeedback={() => setEditorFeedback(null)}
              onSelectDocument={(id) => void handleOpenDocument(id)}
              onGoToWorkspace={() => handleNavigate('workspace')}
              onPatchSession={patchSession}
              onUpsertField={handleUpsertField}
              onUpdateFieldValue={handleUpdateFieldValue}
              onDeleteField={handleDeleteField}
              onDetectPdfFields={handleDetectPdfFields}
              onExportAcroForm={handleExportAcroForm}
              onListPrinters={handleListPrinters}
              onPrintRenderedDocument={handlePrintRenderedDocument}
              onReadPlainText={handleReadPlainText}
              onReadWorkingFileBytes={handleReadWorkingFileBytes}
            />
          )}

          {session.active_route === 'updates' && (
            <UpdatesPage
              diagnostics={diagnostics}
              versionHistory={versionHistory}
              updaterState={updaterState}
              checkingUpdates={checkingUpdates}
              startingInstall={startingInstall}
              onCheckForUpdates={handleCheckForUpdates}
              onToggleAutoCheck={handleToggleAutoCheck}
              onAcceptInstallUpdate={handleAcceptInstallUpdate}
              onTriggerDevPrompt={handleTriggerDevPrompt}
              onStartDevSimulation={handleStartDevSimulation}
              onMarkChangelogSeen={handleMarkChangelogSeen}
              onOpenUserDataFolder={handleOpenUserDataFolder}
            />
          )}
        </main>
      </div>

      {showUpdateDialog && updaterState?.availableUpdate && (
        <UpdateAvailableDialog
          currentVersion={updaterState.currentVersion}
          updateInfo={updaterState.availableUpdate}
          starting={startingInstall}
          onAccept={handleAcceptInstallUpdate}
          onLater={() => setDismissedUpdateVersion(updaterState.availableUpdate?.version ?? null)}
        />
      )}

      {!electronMode && previewSplashPayload && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Ventana de descarga de actualización"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/75 backdrop-blur-sm"
        >
          <UpdaterSplash
            previewPayload={previewSplashPayload}
            onCancelPreview={() => void handleCancelPreviewSplash()}
          />
        </div>
      )}
    </div>
  );
}
