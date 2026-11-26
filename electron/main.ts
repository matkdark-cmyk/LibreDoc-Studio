import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import type {
  AcroFormExtractionResult,
  CreateDocumentInput,
  DocumentRecord,
  DocumentStatus,
  OcrRunResult,
  PlainTextContentResult,
  RenderedPagePayload,
  SessionStatePatch,
  UnlockResult,
  UpsertFieldInput,
} from '../shared/types';
import {
  analyzeDocumentFile,
  decodePlainTextBuffer,
  SUPPORTED_EXTENSIONS,
} from './services/analyzer';
import { DatabaseService } from './services/database';
import {
  extractAcroFormFieldsFromPdf,
  locateTessdata,
  runLocalOcrPipeline,
} from './services/ocrEngine';
import { locateQpdf } from './services/qpdfLocator';
import { unlockDocumentByDiagnosis } from './services/unlocker';
import { UpdaterService } from './services/updaterService';

// Keep userData cleanly isolated under %APPDATA%\LibreDocStudio on Windows
// regardless of installation directory or future NSIS updates.
app.setName('LibreDocStudio');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.libredoc.studio');
}

let mainWindow: BrowserWindow | null = null;
let dbService: DatabaseService | null = null;
let updaterService: UpdaterService | null = null;

function getDb(): DatabaseService {
  if (!dbService) {
    throw new Error('DatabaseService is not initialized.');
  }
  return dbService;
}

function getUpdater(): UpdaterService {
  if (!updaterService) {
    throw new Error('UpdaterService is not initialized.');
  }
  return updaterService;
}

function initialStatusForDiagnosis(diagnosis: DocumentRecord['diagnosis_type']): DocumentStatus {
  if (
    diagnosis === 'PDF_NATIVE_EDITABLE' ||
    diagnosis === 'DOCX_EDITABLE' ||
    diagnosis === 'PLAIN_TEXT'
  ) {
    return 'ready';
  }
  return 'registered';
}

async function ingestAndAnalyzeFile(selectedPath: string): Promise<DocumentRecord> {
  if (!selectedPath || !fs.existsSync(selectedPath)) {
    throw new Error('No se encontró el archivo seleccionado en disco.');
  }

  const fileName = path.basename(selectedPath);
  const fileType = path.extname(selectedPath).replace('.', '').toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(fileType)) {
    throw new Error(
      `Formato no soportado (.${fileType || 'sin extensión'}). Usa PDF, DOCX, TXT, RTF, MD, PNG o JPG.`,
    );
  }

  const created = getDb().createDocument({
    original_name: fileName,
    original_path: selectedPath,
    file_type: fileType,
    diagnosis_type: 'PENDING_ANALYSIS',
    status: 'registered',
  });

  const targetPath = fs.existsSync(created.working_path) ? created.working_path : selectedPath;
  const analysis = await analyzeDocumentFile(targetPath);

  const updated = getDb().updateDocument(created.id, {
    diagnosis_type: analysis.diagnosis_type,
    status: initialStatusForDiagnosis(analysis.diagnosis_type),
    analysis,
  });

  return updated ?? created;
}

function createMainWindow(): BrowserWindow {
  const session = getDb().getSessionState();

  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    title: 'LibreDoc Studio',
    backgroundColor: session.theme === 'dark' ? '#020617' : '#f8fafc',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('close', () => {
    try {
      dbService?.flushSessionSync();
    } catch {
      // Ensure closing never hangs if DB was already closed.
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  const devUrl = process.env.ELECTRON_DEV_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  return win;
}

function registerIpcHandlers(): void {
  ipcMain.handle('app:get-diagnostics', async () => {
    const base = getDb().getDiagnostics();
    const qpdfStatus = await locateQpdf();
    const tessdataStatus = locateTessdata();
    return {
      ...base,
      qpdfStatus,
      tessdataStatus,
    };
  });

  ipcMain.handle('app:open-userdata-folder', async () => {
    const targetPath = getDb().getUserDataPath();
    const error = await shell.openPath(targetPath);
    return { ok: error === '', path: targetPath };
  });

  ipcMain.handle('documents:reveal-in-folder', async (_event, documentId: string) => {
    const doc = getDb().getDocument(documentId);
    if (!doc) return { ok: false, path: '' };
    const targetPath = fs.existsSync(doc.working_path) ? doc.working_path : doc.original_path;
    if (!fs.existsSync(targetPath)) return { ok: false, path: targetPath };
    shell.showItemInFolder(targetPath);
    return { ok: true, path: targetPath };
  });

  ipcMain.handle('session:get', () => {
    return getDb().getSessionState();
  });

  ipcMain.handle('session:save', (_event, patch: SessionStatePatch) => {
    return getDb().saveSessionState(patch);
  });

  ipcMain.handle('session:ack-restore', () => {
    getDb().acknowledgeSessionRestore();
  });

  ipcMain.on('session:flush-sync', (event, patch?: SessionStatePatch) => {
    try {
      event.returnValue = getDb().flushSessionSync(patch);
    } catch {
      event.returnValue = false;
    }
  });

  ipcMain.handle('documents:list', () => {
    return getDb().listDocuments();
  });

  ipcMain.handle('documents:get', (_event, id: string) => {
    return getDb().getDocument(id);
  });

  ipcMain.handle('documents:create', (_event, input: CreateDocumentInput) => {
    return getDb().createDocument(input);
  });

  ipcMain.handle('documents:ingest-path', async (_event, filePath: string) => {
    return ingestAndAnalyzeFile(filePath);
  });

  ipcMain.handle('documents:pick-and-register', async (): Promise<DocumentRecord | null> => {
    const owner = mainWindow ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const dialogOptions: Electron.OpenDialogOptions = {
      title: 'Seleccionar documento para LibreDoc Studio',
      properties: ['openFile'],
      filters: [
        {
          name: 'Documentos compatibles',
          extensions: ['pdf', 'docx', 'txt', 'rtf', 'md', 'csv', 'json', 'png', 'jpg', 'jpeg'],
        },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Word (.docx)', extensions: ['docx'] },
        { name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg'] },
        { name: 'Texto', extensions: ['txt', 'rtf', 'md', 'csv', 'json'] },
      ],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return ingestAndAnalyzeFile(result.filePaths[0]);
  });

  ipcMain.handle('documents:reanalyze', async (_event, documentId: string) => {
    const doc = getDb().getDocument(documentId);
    if (!doc) return null;
    const targetPath = fs.existsSync(doc.working_path) ? doc.working_path : doc.original_path;
    if (!fs.existsSync(targetPath)) return doc;

    const analysis = await analyzeDocumentFile(targetPath);
    return getDb().updateDocument(doc.id, {
      diagnosis_type: analysis.diagnosis_type,
      status: doc.status === 'unlocked' ? 'unlocked' : initialStatusForDiagnosis(analysis.diagnosis_type),
      analysis,
    });
  });

  ipcMain.handle(
    'documents:unlock',
    async (_event, documentId: string, password?: string): Promise<UnlockResult> => {
      const doc = getDb().getDocument(documentId);
      if (!doc) {
        return {
          success: false,
          message: 'Documento no encontrado en SQLite.',
          error: 'El registro seleccionado ya no existe.',
        };
      }

      const unlockResult = await unlockDocumentByDiagnosis(doc, password);
      if (!unlockResult.success || !unlockResult.unlockedPath || !unlockResult.analysis) {
        return unlockResult;
      }

      const updatedDoc = getDb().updateDocument(doc.id, {
        working_path: unlockResult.unlockedPath,
        diagnosis_type: unlockResult.analysis.diagnosis_type,
        status: 'unlocked',
        analysis: unlockResult.analysis,
      });

      return {
        ...unlockResult,
        document: updatedDoc ?? doc,
      };
    },
  );

  ipcMain.handle(
    'documents:read-plain-text',
    async (_event, documentId: string): Promise<PlainTextContentResult | null> => {
      const doc = getDb().getDocument(documentId);
      if (!doc) return null;
      const targetPath = fs.existsSync(doc.working_path) ? doc.working_path : doc.original_path;
      if (!fs.existsSync(targetPath)) return null;
      const buffer = fs.readFileSync(targetPath);
      return decodePlainTextBuffer(buffer);
    },
  );

  ipcMain.handle(
    'documents:read-working-bytes',
    async (_event, documentId: string): Promise<Uint8Array | null> => {
      const doc = getDb().getDocument(documentId);
      if (!doc) return null;
      const targetPath = fs.existsSync(doc.working_path) ? doc.working_path : doc.original_path;
      if (!fs.existsSync(targetPath)) return null;
      const buf = fs.readFileSync(targetPath);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
  );

  ipcMain.handle(
    'ocr:run-document',
    async (
      event,
      documentId: string,
      renderedPages?: RenderedPagePayload[],
    ): Promise<OcrRunResult> => {
      const doc = getDb().getDocument(documentId);
      if (!doc) {
        return {
          success: false,
          message: 'Documento no encontrado.',
          error: 'El documento ya no existe en SQLite.',
        };
      }

      try {
        const ocrOut = await runLocalOcrPipeline({
          document: doc,
          renderedPages,
          onProgress: (progressEvent) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('ocr:progress', progressEvent);
            }
          },
        });

        const savedFields = getDb().replaceDocumentFields(doc.id, ocrOut.fields);
        const postAnalysis = await analyzeDocumentFile(ocrOut.editablePdfPath);

        const updatedDoc = getDb().updateDocument(doc.id, {
          working_path: ocrOut.editablePdfPath,
          diagnosis_type: 'PDF_NATIVE_EDITABLE',
          status: 'ocr_completed',
          analysis: {
            ...postAnalysis,
            diagnosis_type: 'PDF_NATIVE_EDITABLE',
            title: 'PDF editable generado mediante OCR local',
            summary: `OCR local completado en ${ocrOut.pagesProcessed} página(s): ${savedFields.length} campos detectados y agrupados, capa de texto buscable y campos AcroForm insertados conservando el fondo original.`,
            recommended_action: 'open_editor',
            recommended_action_label: 'Abrir en Editor',
          },
        });

        return {
          success: true,
          message: `OCR completado: ${savedFields.length} campos guardados y PDF editable generado en el workspace.`,
          document: updatedDoc ?? doc,
          fields: savedFields,
          editablePdfPath: ocrOut.editablePdfPath,
          stats: {
            pagesProcessed: ocrOut.pagesProcessed,
            fieldsDetected: savedFields.length,
            linesRecognized: ocrOut.lines.length,
            avgConfidence: ocrOut.avgConfidence,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('TESSDATA_MISSING::')) {
          return {
            success: false,
            tessdataMissing: true,
            message: 'Modelos OCR locales no encontrados.',
            error: msg.replace('TESSDATA_MISSING::', ''),
          };
        }
        return {
          success: false,
          message: 'Ocurrió un error al ejecutar OCR local.',
          error: msg,
        };
      }
    },
  );

  ipcMain.handle(
    'pdf:extract-acroform',
    async (_event, documentId: string): Promise<AcroFormExtractionResult> => {
      const doc = getDb().getDocument(documentId);
      if (!doc) {
        return {
          success: false,
          message: 'Documento no encontrado.',
          fields: [],
        };
      }

      const targetPath = fs.existsSync(doc.working_path) ? doc.working_path : doc.original_path;
      if (!fs.existsSync(targetPath)) {
        return {
          success: false,
          message: 'No se encontró el archivo PDF en el workspace.',
          fields: [],
        };
      }

      try {
        const extracted = await extractAcroFormFieldsFromPdf(doc.id, targetPath);
        if (extracted.length === 0) {
          return {
            success: true,
            message: 'Este PDF no contiene campos de formulario AcroForm preexistentes.',
            document: doc,
            fields: [],
          };
        }

        const savedFields = getDb().replaceDocumentFields(doc.id, extracted);
        const updatedDoc = getDb().updateDocument(doc.id, {
          status: doc.status === 'unlocked' ? 'unlocked' : 'ready',
        });

        return {
          success: true,
          message: `Se extrajeron ${savedFields.length} campos AcroForm nativos y se guardaron en SQLite.`,
          document: updatedDoc ?? doc,
          fields: savedFields,
        };
      } catch (err) {
        return {
          success: false,
          message: 'No se pudieron leer los campos AcroForm del PDF.',
          error: err instanceof Error ? err.message : String(err),
          fields: [],
        };
      }
    },
  );

  ipcMain.handle(
    'documents:update',
    (
      _event,
      id: string,
      patch: Partial<
        Pick<DocumentRecord, 'original_name' | 'diagnosis_type' | 'status' | 'analysis'>
      >,
    ) => {
      return getDb().updateDocument(id, patch);
    },
  );

  ipcMain.handle('documents:delete', (_event, id: string) => {
    return getDb().deleteDocument(id);
  });

  ipcMain.handle('fields:list', (_event, documentId: string) => {
    return getDb().listDocumentFields(documentId);
  });

  ipcMain.handle('fields:upsert', (_event, input: UpsertFieldInput) => {
    return getDb().upsertDocumentField(input);
  });

  ipcMain.handle('fields:update-value', (_event, fieldId: string, value: string) => {
    return getDb().updateFieldValue(fieldId, value);
  });

  ipcMain.handle('fields:delete', (_event, fieldId: string) => {
    return getDb().deleteDocumentField(fieldId);
  });

  ipcMain.handle('versions:list', () => {
    return getDb().listVersionHistory();
  });

  ipcMain.handle('versions:mark-seen', (_event, version: string) => {
    getDb().markVersionChangelogSeen(version);
  });

  // Paso 5: Auto-updater & dedicated updater splash window IPC
  ipcMain.handle('updater:get-state', () => {
    return getUpdater().getState();
  });

  ipcMain.handle('updater:set-auto-check', (_event, enabled: boolean) => {
    return getUpdater().setAutoCheckUpdates(Boolean(enabled));
  });

  ipcMain.handle('updater:check', () => {
    return getUpdater().checkForUpdates();
  });

  ipcMain.handle('updater:accept-install', (_event, patch?: SessionStatePatch) => {
    return getUpdater().acceptAndInstallUpdate(patch);
  });

  ipcMain.handle('updater:dev-trigger-prompt', () => {
    return getUpdater().triggerDevUpdatePrompt();
  });

  ipcMain.handle('updater:dev-start-sim', (_event, patch?: SessionStatePatch) => {
    return getUpdater().startDevUpdateSimulation(patch);
  });

  ipcMain.handle('updater:cancel-return', () => {
    getUpdater().cancelAndReturnToMain();
  });

  ipcMain.handle('updater:get-splash-state', () => {
    return getUpdater().getSplashState();
  });
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const userDataPath = app.getPath('userData');
    dbService = new DatabaseService(userDataPath, app.getVersion());
    updaterService = new UpdaterService({
      db: dbService,
      getMainWindow: () => mainWindow,
      onBeforeQuitForInstall: () => {
        if (dbService) {
          dbService.close();
          dbService = null;
        }
      },
    });

    registerIpcHandlers();
    mainWindow = createMainWindow();
    updaterService.scheduleStartupCheck();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  });

  app.on('before-quit', () => {
    if (updaterService && !updaterService.isInstallingUpdate()) {
      updaterService.dispose();
    }
    if (dbService) {
      dbService.close();
      dbService = null;
    }
  });

  app.on('window-all-closed', () => {
    if (updaterService?.isInstallingUpdate()) {
      return;
    }
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
