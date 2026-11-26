import JSZip from 'jszip';
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFRadioGroup, PDFTextField } from 'pdf-lib';
import { buildAcroFormPdf } from '../../shared/acroFormBuilder';
import type {
  AcroFormExportResult,
  AcroFormExtractionResult,
  AppMeta,
  CreateDocumentInput,
  DocumentField,
  DocumentRecord,
  FieldType,
  LibreDocAPI,
  MigrationRecord,
  OcrRunResult,
  PlainTextContentResult,
  SessionState,
  SessionStatePatch,
  StorageDiagnostics,
  UnlockResult,
  UpdaterProgressPayload,
  UpdaterState,
  UpsertFieldInput,
  VersionHistoryRecord,
} from '../../shared/types';
import {
  analyzeBrowserFile,
  decodeTextArrayBuffer,
  detectBrowserDocxProtections,
  stripBrowserDocxProtections,
} from './browserAnalyzer';

const PREVIEW_STORAGE_KEY = 'libredoc_studio_preview_db_v3';
const APP_VERSION = '0.2.1';

// Keep uploaded browser-preview file buffers in memory during the web preview session
const previewFileBuffers = new Map<string, ArrayBuffer>();

interface BrowserPreviewStore {
  app_meta: AppMeta;
  schema_migrations: MigrationRecord[];
  documents: DocumentRecord[];
  document_fields: DocumentField[];
  session_state: SessionState;
  version_history: VersionHistoryRecord[];
}

function createInitialPreviewStore(): BrowserPreviewStore {
  const now = new Date().toISOString();
  return {
    app_meta: {
      schema_version: 5,
      last_installed_version: APP_VERSION,
      last_updated_at: now,
      auto_check_updates: 1,
      last_update_check_at: '',
      pending_update_banner_version: '',
    },
    schema_migrations: [
      { version: 1, name: '001_initial_schema', applied_at: now },
      { version: 2, name: '002_session_theme_preference', applied_at: now },
      { version: 3, name: '003_document_analysis_metadata', applied_at: now },
      { version: 4, name: '004_updater_preferences_and_restore_banner', applied_at: now },
      { version: 5, name: '005_field_acroform_properties', applied_at: now },
    ],
    documents: [],
    document_fields: [],
    session_state: {
      active_document_id: null,
      active_route: 'workspace',
      active_page: 1,
      zoom_level: 1,
      sidebar_tab: 'fields',
      scroll_position: 0,
      pending_restore: 0,
      theme: 'light',
    },
    version_history: [
      {
        id: 1,
        version: APP_VERSION,
        installed_at: now,
        release_notes:
          'Actualización v0.2.1: Nuevo ícono oficial de LibreDoc Studio para Windows y conversor automático de PDF estático a PDF rellenable (AcroForm) de alta precisión con detección híbrida de texto, vectores CTM y capa raster, casillas interactivas arrastrables y exportación estándar.',
        changelog_seen: 0,
      },
    ],
  };
}

function readPreviewStore(): BrowserPreviewStore {
  try {
    const raw = window.localStorage.getItem(PREVIEW_STORAGE_KEY);
    if (!raw) {
      const initial = createInitialPreviewStore();
      window.localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(initial));
      return initial;
    }
    const parsed = JSON.parse(raw) as Partial<BrowserPreviewStore>;
    const fallback = createInitialPreviewStore();
    const migrations = Array.isArray(parsed.schema_migrations)
      ? [...parsed.schema_migrations]
      : [...fallback.schema_migrations];
    if (!migrations.some((m) => m.version === 4)) {
      migrations.push({
        version: 4,
        name: '004_updater_preferences_and_restore_banner',
        applied_at: new Date().toISOString(),
      });
    }
    if (!migrations.some((m) => m.version === 5)) {
      migrations.push({
        version: 5,
        name: '005_field_acroform_properties',
        applied_at: new Date().toISOString(),
      });
    }
    return {
      app_meta: {
        ...fallback.app_meta,
        ...(parsed.app_meta ?? {}),
        schema_version: 5,
      },
      schema_migrations: migrations,
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      document_fields: Array.isArray(parsed.document_fields) ? parsed.document_fields : [],
      session_state: { ...fallback.session_state, ...(parsed.session_state ?? {}) },
      version_history: Array.isArray(parsed.version_history)
        ? parsed.version_history
        : fallback.version_history,
    };
  } catch {
    return createInitialPreviewStore();
  }
}

function writePreviewStore(store: BrowserPreviewStore): void {
  window.localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(store));
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function ingestBrowserPreviewFile(file: File): Promise<DocumentRecord> {
  const bridge = getLibreDocBridge();
  const ext = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() ?? '' : '';
  const { analysis, buffer } = await analyzeBrowserFile(file);

  const initialStatus =
    analysis.diagnosis_type === 'PDF_NATIVE_EDITABLE' ||
    analysis.diagnosis_type === 'DOCX_EDITABLE' ||
    analysis.diagnosis_type === 'PLAIN_TEXT'
      ? 'ready'
      : 'registered';

  const record = await bridge.createDocument({
    original_name: file.name,
    file_type: ext || 'bin',
    diagnosis_type: analysis.diagnosis_type,
    status: initialStatus,
    analysis,
  });

  previewFileBuffers.set(record.id, buffer);
  return record;
}

function createBrowserPreviewBridge(): LibreDocAPI {
  const initialStore = readPreviewStore();
  let restoredOnBoot =
    initialStore.session_state.pending_restore === 1 ||
    Boolean(initialStore.app_meta.pending_update_banner_version);
  let restoredUpdateVersionOnBoot: string | null =
    initialStore.app_meta.pending_update_banner_version || null;

  const stateListeners = new Set<(state: UpdaterState) => void>();
  const progressListeners = new Set<(payload: UpdaterProgressPayload) => void>();
  let latestSplashPayload: UpdaterProgressPayload | null = null;
  let previewSimTimer: number | null = null;

  let updaterState: UpdaterState = {
    status: 'idle',
    currentVersion: APP_VERSION,
    autoCheckOnStartup: initialStore.app_meta.auto_check_updates !== 0,
    lastCheckedAt: initialStore.app_meta.last_update_check_at || null,
    githubRepo: {
      configured: false,
      owner: null,
      repo: null,
      label: 'GitHub Releases (configurar owner/repo al publicar)',
    },
    isDevMode: true,
    availableUpdate: null,
    message: 'Listo para comprobar actualizaciones desde GitHub Releases.',
    error: null,
  };

  const emitUpdaterState = (patch: Partial<UpdaterState>) => {
    updaterState = { ...updaterState, ...patch };
    for (const listener of stateListeners) {
      listener(updaterState);
    }
  };

  const emitProgress = (payload: UpdaterProgressPayload) => {
    latestSplashPayload = payload;
    for (const listener of progressListeners) {
      listener(payload);
    }
  };

  return {
    async getDiagnostics(): Promise<StorageDiagnostics> {
      const store = readPreviewStore();
      const bannerVersion =
        restoredUpdateVersionOnBoot || store.app_meta.pending_update_banner_version || null;
      return {
        runtime: 'browser-preview',
        appVersion: APP_VERSION,
        userDataPath: '%APPDATA%\\LibreDocStudio (localStorage en vista web)',
        dbPath: '%APPDATA%\\LibreDocStudio\\data\\libredoc.db',
        workspacesPath: '%APPDATA%\\LibreDocStudio\\workspaces',
        schemaVersion: store.app_meta.schema_version,
        migrations: store.schema_migrations,
        appMeta: store.app_meta,
        restoredFromSession: restoredOnBoot || Boolean(bannerVersion),
        previousVersion: null,
        updatedToVersion: bannerVersion,
        qpdfStatus: {
          available: false,
          executablePath: null,
          version: null,
          expectedPath: 'resources\\bin\\win\\qpdf\\qpdf.exe',
        },
        tessdataStatus: {
          available: false,
          dirPath: null,
          hasSpa: false,
          hasEng: false,
          expectedPath: 'resources\\tessdata',
        },
      };
    },

    async openUserDataFolder() {
      return { ok: false, path: '%APPDATA%\\LibreDocStudio' };
    },

    async revealDocumentInFolder() {
      return { ok: false, path: '' };
    },

    async getSessionState(): Promise<SessionState> {
      return readPreviewStore().session_state;
    },

    async saveSessionState(patch: SessionStatePatch): Promise<SessionState> {
      const store = readPreviewStore();
      const next: SessionState = {
        ...store.session_state,
        ...patch,
      };
      if (next.active_document_id) {
        const exists = store.documents.some((d) => d.id === next.active_document_id);
        if (!exists) {
          next.active_document_id = null;
        }
      }
      store.session_state = next;
      writePreviewStore(store);
      return next;
    },

    async acknowledgeSessionRestore(): Promise<void> {
      restoredOnBoot = false;
      restoredUpdateVersionOnBoot = null;
      const store = readPreviewStore();
      store.session_state.pending_restore = 0;
      store.app_meta.pending_update_banner_version = '';
      writePreviewStore(store);
    },

    flushSessionSync(patch?: SessionStatePatch): boolean {
      try {
        const store = readPreviewStore();
        store.session_state = {
          ...store.session_state,
          ...(patch ?? {}),
          pending_restore: 1,
        };
        writePreviewStore(store);
        return true;
      } catch {
        return false;
      }
    },

    async listDocuments(): Promise<DocumentRecord[]> {
      const store = readPreviewStore();
      return [...store.documents].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },

    async getDocument(id: string): Promise<DocumentRecord | null> {
      const store = readPreviewStore();
      return store.documents.find((doc) => doc.id === id) ?? null;
    },

    async createDocument(input: CreateDocumentInput): Promise<DocumentRecord> {
      const store = readPreviewStore();
      const id = generateId();
      const now = new Date().toISOString();
      const safeName = input.original_name.trim() || 'documento-sin-nombre.pdf';
      const record: DocumentRecord = {
        id,
        original_name: safeName,
        original_path: input.original_path?.trim() || `C:\\Usuarios\\Documentos\\${safeName}`,
        working_path: `%APPDATA%\\LibreDocStudio\\workspaces\\${id}\\${safeName}`,
        file_type: input.file_type.toLowerCase(),
        diagnosis_type: input.diagnosis_type ?? 'PENDING_ANALYSIS',
        status: input.status ?? 'registered',
        created_at: now,
        updated_at: now,
        created_in_version: APP_VERSION,
        analysis: input.analysis ?? null,
      };
      store.documents.unshift(record);
      writePreviewStore(store);
      return record;
    },

    async pickAndRegisterDocument(): Promise<DocumentRecord | null> {
      return null;
    },

    async ingestFilePath(): Promise<DocumentRecord> {
      throw new Error('ingestFilePath solo está disponible en el runtime nativo de Electron.');
    },

    async reanalyzeDocument(documentId: string): Promise<DocumentRecord | null> {
      const store = readPreviewStore();
      return store.documents.find((d) => d.id === documentId) ?? null;
    },

    async unlockDocument(documentId: string): Promise<UnlockResult> {
      const store = readPreviewStore();
      const index = store.documents.findIndex((d) => d.id === documentId);
      if (index === -1) {
        return { success: false, message: 'Documento no encontrado.' };
      }

      const doc = store.documents[index];
      if (doc.diagnosis_type === 'DOCX_LOCKED') {
        const buffer = previewFileBuffers.get(doc.id);
        if (!buffer) {
          return {
            success: false,
            message: 'Vuelve a cargar el archivo .docx en la vista web o ejecútalo en Electron.',
          };
        }
        const zip = await JSZip.loadAsync(buffer);
        const settings = zip.file('word/settings.xml');
        if (settings) {
          const originalXml = await settings.async('string');
          const cleaned = stripBrowserDocxProtections(originalXml);
          const remaining = detectBrowserDocxProtections(cleaned);
          if (remaining.length > 0) {
            return { success: false, message: 'No se pudieron limpiar todos los nodos XML.' };
          }
          zip.file('word/settings.xml', cleaned);
          const unlockedBuf = await zip.generateAsync({ type: 'arraybuffer' });
          previewFileBuffers.set(doc.id, unlockedBuf);
        }

        const analysis = {
          diagnosis_type: 'DOCX_EDITABLE' as const,
          title: 'Documento Word (.docx) desbloqueado',
          summary:
            'Se eliminaron los nodos de protección en word/settings.xml conservando intactos estilos, tablas e imágenes.',
          recommended_action: 'open_editor' as const,
          recommended_action_label: 'Abrir en Editor',
          analyzed_at: new Date().toISOString(),
          details: {
            fileSizeBytes: previewFileBuffers.get(doc.id)?.byteLength ?? 0,
            docxProtections: [],
          },
        };

        const updated: DocumentRecord = {
          ...doc,
          diagnosis_type: 'DOCX_EDITABLE',
          status: 'unlocked',
          updated_at: new Date().toISOString(),
          analysis,
        };
        store.documents[index] = updated;
        writePreviewStore(store);

        return {
          success: true,
          message: 'Word (.docx) desbloqueado correctamente.',
          document: updated,
          analysis,
        };
      }

      return {
        success: false,
        qpdfMissing: true,
        message: 'El desbloqueo de PDF con qpdf requiere ejecutar LibreDoc Studio en Electron (Windows).',
        error: 'Usa "npm run setup:qpdf" y "npm run electron:dev" en Windows para ejecutar qpdf --decrypt.',
      };
    },

    async readPlainTextDocument(documentId: string): Promise<PlainTextContentResult | null> {
      const buffer = previewFileBuffers.get(documentId);
      if (!buffer) return null;
      return decodeTextArrayBuffer(buffer);
    },

    async readWorkingFileBytes(documentId: string): Promise<Uint8Array | null> {
      const buffer = previewFileBuffers.get(documentId);
      if (!buffer) return null;
      return new Uint8Array(buffer.slice(0));
    },

    async runLocalOcr(): Promise<OcrRunResult> {
      return {
        success: false,
        tessdataMissing: true,
        message: 'El OCR offline con modelos locales (spa/eng) se ejecuta en la app nativa Electron.',
        error: 'Ejecuta "npm run setup:tessdata" y "npm run electron:dev" en Windows para procesar OCR 100% offline.',
      };
    },

    async extractAcroFormFields(documentId: string): Promise<AcroFormExtractionResult> {
      const buffer = previewFileBuffers.get(documentId);
      if (!buffer) {
        return {
          success: false,
          message: 'Vuelve a cargar el PDF para leer sus campos AcroForm en la vista web.',
          fields: [],
        };
      }

      try {
        const pdfDoc = await PDFDocument.load(buffer.slice(0), { ignoreEncryption: true });
        const form = pdfDoc.getForm();
        const pdfFields = form.getFields();
        if (pdfFields.length === 0) {
          return {
            success: true,
            message: 'Este PDF no contiene campos AcroForm preexistentes.',
            fields: [],
          };
        }

        const store = readPreviewStore();
        store.document_fields = store.document_fields.filter((f) => f.document_id !== documentId);

        const extracted: DocumentField[] = pdfFields.map((field, idx) => {
          let fieldType: FieldType = 'text';
          let value = '';
          if (field instanceof PDFCheckBox) {
            fieldType = 'checkbox';
            value = field.isChecked() ? 'true' : 'false';
          } else if (field instanceof PDFTextField) {
            value = field.getText() ?? '';
            fieldType = field.isMultiline() ? 'multiline' : 'text';
          } else if (field instanceof PDFDropdown) {
            value = field.getSelected().join(', ');
          } else if (field instanceof PDFRadioGroup) {
            value = field.getSelected() ?? '';
          }

          return {
            id: generateId(),
            document_id: documentId,
            page_number: 1,
            label: field.getName(),
            value,
            field_type: fieldType,
            x: 56,
            y: 72 + idx * 42,
            width: 220,
            height: 28,
            font_size: 11,
            group_name: 'Formulario AcroForm',
            sort_order: idx,
          };
        });

        store.document_fields.push(...extracted);
        writePreviewStore(store);

        return {
          success: true,
          message: `Se extrajeron ${extracted.length} campos AcroForm del PDF.`,
          fields: extracted,
        };
      } catch (err) {
        return {
          success: false,
          message: 'Error leyendo los campos AcroForm del PDF.',
          error: err instanceof Error ? err.message : String(err),
          fields: [],
        };
      }
    },

    async updateDocument(id, patch): Promise<DocumentRecord | null> {
      const store = readPreviewStore();
      const index = store.documents.findIndex((doc) => doc.id === id);
      if (index === -1) return null;
      const updated: DocumentRecord = {
        ...store.documents[index],
        ...patch,
        updated_at: new Date().toISOString(),
      };
      store.documents[index] = updated;
      writePreviewStore(store);
      return updated;
    },

    async deleteDocument(id: string): Promise<boolean> {
      const store = readPreviewStore();
      const before = store.documents.length;
      store.documents = store.documents.filter((doc) => doc.id !== id);
      store.document_fields = store.document_fields.filter((f) => f.document_id !== id);
      previewFileBuffers.delete(id);
      if (store.session_state.active_document_id === id) {
        store.session_state.active_document_id = null;
        store.session_state.active_page = 1;
        store.session_state.scroll_position = 0;
      }
      writePreviewStore(store);
      return store.documents.length < before;
    },

    async listDocumentFields(documentId: string): Promise<DocumentField[]> {
      const store = readPreviewStore();
      return store.document_fields
        .filter((f) => f.document_id === documentId)
        .sort(
          (a, b) =>
            a.page_number - b.page_number ||
            a.sort_order - b.sort_order ||
            a.label.localeCompare(b.label),
        );
    },

    async replaceDocumentFields(
      documentId: string,
      inputs: UpsertFieldInput[],
    ): Promise<DocumentField[]> {
      const store = readPreviewStore();
      store.document_fields = store.document_fields.filter((f) => f.document_id !== documentId);

      const created: DocumentField[] = inputs.map((input, idx) => ({
        id: input.id || generateId(),
        document_id: documentId,
        page_number: Math.max(1, input.page_number ?? 1),
        label: input.label.trim() || `Campo ${idx + 1}`,
        value: input.value ?? '',
        field_type: input.field_type ?? 'text',
        x: input.x ?? 56,
        y: input.y ?? 72 + idx * 36,
        width: input.width ?? 220,
        height: input.height ?? 24,
        font_size: input.font_size ?? 9.5,
        group_name: input.group_name?.trim() || 'Datos generales',
        sort_order: input.sort_order ?? idx,
        checkbox_style: input.checkbox_style ?? 'check',
        alignment: input.alignment ?? 'left',
        cover_dashes: input.cover_dashes ?? 0,
        field_name: input.field_name?.trim() || '',
        tooltip: input.tooltip?.trim() || input.label.trim() || '',
        source: input.source ?? 'auto',
      }));

      store.document_fields.push(...created);
      const docIndex = store.documents.findIndex((d) => d.id === documentId);
      if (docIndex >= 0) {
        store.documents[docIndex].updated_at = new Date().toISOString();
      }
      writePreviewStore(store);
      return created;
    },

    async upsertDocumentField(input: UpsertFieldInput): Promise<DocumentField> {
      const store = readPreviewStore();
      const existingIndex = input.id
        ? store.document_fields.findIndex((f) => f.id === input.id)
        : -1;
      const existing = existingIndex >= 0 ? store.document_fields[existingIndex] : undefined;
      const docFieldCount = store.document_fields.filter(
        (f) => f.document_id === input.document_id,
      ).length;

      const field: DocumentField = {
        id: input.id || generateId(),
        document_id: input.document_id,
        page_number: Math.max(1, input.page_number ?? existing?.page_number ?? 1),
        label: input.label.trim() || existing?.label || 'Campo sin título',
        value: input.value ?? existing?.value ?? '',
        field_type: input.field_type ?? existing?.field_type ?? 'text',
        x: input.x ?? existing?.x ?? 56,
        y: input.y ?? existing?.y ?? 72 + docFieldCount * 52,
        width: input.width ?? existing?.width ?? 240,
        height: input.height ?? existing?.height ?? 32,
        font_size: input.font_size ?? existing?.font_size ?? 9.5,
        group_name: input.group_name?.trim() || existing?.group_name || 'Datos generales',
        sort_order: input.sort_order ?? existing?.sort_order ?? docFieldCount,
        checkbox_style: input.checkbox_style ?? existing?.checkbox_style ?? 'check',
        alignment: input.alignment ?? existing?.alignment ?? 'left',
        cover_dashes: input.cover_dashes ?? existing?.cover_dashes ?? 0,
        field_name: input.field_name ?? existing?.field_name ?? '',
        tooltip: input.tooltip ?? existing?.tooltip ?? input.label.trim() ?? '',
        source: input.source ?? existing?.source ?? 'manual',
      };

      if (existingIndex >= 0) {
        store.document_fields[existingIndex] = field;
      } else {
        store.document_fields.push(field);
      }

      const docIndex = store.documents.findIndex((d) => d.id === input.document_id);
      if (docIndex >= 0) {
        store.documents[docIndex].updated_at = new Date().toISOString();
      }
      writePreviewStore(store);
      return field;
    },

    async updateFieldValue(fieldId: string, value: string): Promise<DocumentField | null> {
      const store = readPreviewStore();
      const index = store.document_fields.findIndex((f) => f.id === fieldId);
      if (index === -1) return null;
      store.document_fields[index] = {
        ...store.document_fields[index],
        value,
      };
      const docId = store.document_fields[index].document_id;
      const docIndex = store.documents.findIndex((d) => d.id === docId);
      if (docIndex >= 0) {
        store.documents[docIndex].updated_at = new Date().toISOString();
      }
      writePreviewStore(store);
      return store.document_fields[index];
    },

    async deleteDocumentField(fieldId: string): Promise<boolean> {
      const store = readPreviewStore();
      const existing = store.document_fields.find((f) => f.id === fieldId);
      if (!existing) return false;
      store.document_fields = store.document_fields.filter((f) => f.id !== fieldId);
      const docIndex = store.documents.findIndex((d) => d.id === existing.document_id);
      if (docIndex >= 0) {
        store.documents[docIndex].updated_at = new Date().toISOString();
      }
      writePreviewStore(store);
      return true;
    },

    async exportAcroFormPdf(
      documentId: string,
      overrideFields?: DocumentField[],
    ): Promise<AcroFormExportResult> {
      const store = readPreviewStore();
      const doc = store.documents.find((d) => d.id === documentId);
      const buffer = previewFileBuffers.get(documentId);
      if (!doc || !buffer) {
        return {
          success: false,
          fieldsExported: 0,
          message: 'Vuelve a cargar el PDF para exportarlo en la vista web.',
        };
      }

      const fieldsToWrite =
        Array.isArray(overrideFields) && overrideFields.length > 0
          ? overrideFields
          : store.document_fields.filter((f) => f.document_id === documentId);

      if (fieldsToWrite.length === 0) {
        return {
          success: false,
          fieldsExported: 0,
          message: 'No hay campos definidos para exportar.',
        };
      }

      try {
        const { pdfBytes, fieldsWritten } = await buildAcroFormPdf({
          originalPdfBytes: new Uint8Array(buffer.slice(0)),
          fields: fieldsToWrite,
        });

        const baseName = doc.original_name.replace(/\.pdf$/i, '');
        const fileName = `${baseName}-rellenable.pdf`;
        const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const anchor = window.document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        window.document.body.appendChild(anchor);
        anchor.click();
        window.document.body.removeChild(anchor);
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);

        const docIdx = store.documents.findIndex((d) => d.id === documentId);
        if (docIdx >= 0) {
          store.documents[docIdx].status = 'exported';
          store.documents[docIdx].updated_at = new Date().toISOString();
          writePreviewStore(store);
        }

        return {
          success: true,
          outputPath: fileName,
          fieldsExported: fieldsWritten,
          message: `PDF rellenable descargado (${fileName}) con ${fieldsWritten} campo(s) AcroForm.`,
        };
      } catch (err) {
        return {
          success: false,
          fieldsExported: 0,
          message: 'No se pudo generar el PDF rellenable AcroForm.',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async listVersionHistory(): Promise<VersionHistoryRecord[]> {
      return readPreviewStore().version_history;
    },

    async markVersionChangelogSeen(version: string): Promise<void> {
      const store = readPreviewStore();
      store.version_history = store.version_history.map((item) =>
        item.version === version ? { ...item, changelog_seen: 1 } : item,
      );
      writePreviewStore(store);
    },

    async getUpdaterState(): Promise<UpdaterState> {
      return updaterState;
    },

    async setAutoCheckUpdates(enabled: boolean): Promise<UpdaterState> {
      const store = readPreviewStore();
      store.app_meta.auto_check_updates = enabled ? 1 : 0;
      writePreviewStore(store);
      emitUpdaterState({ autoCheckOnStartup: enabled });
      return updaterState;
    },

    async checkForUpdates(): Promise<UpdaterState> {
      const now = new Date().toISOString();
      const store = readPreviewStore();
      store.app_meta.last_update_check_at = now;
      writePreviewStore(store);
      emitUpdaterState({
        status: 'up-to-date',
        lastCheckedAt: now,
        availableUpdate: null,
        message:
          'Vista previa web en modo desarrollo. En la app nativa de Windows se consultan las releases reales de GitHub; aquí puedes usar el modo de prueba local debajo.',
        error: null,
      });
      return updaterState;
    },

    async acceptAndInstallUpdate(
      patch?: SessionStatePatch,
    ): Promise<{ ok: boolean; error?: string }> {
      return this.startDevUpdateSimulation(patch);
    },

    async triggerDevUpdatePrompt(): Promise<UpdaterState> {
      const simulatedVersion = '0.2.0-test';
      emitUpdaterState({
        status: 'available',
        availableUpdate: {
          version: simulatedVersion,
          releaseDate: new Date().toISOString(),
          releaseNotes:
            'Prueba visual en entorno de desarrollo (no instala archivos reales):\n• Guarda tu sesión actual con pending_restore = 1.\n• Muestra la ventana dedicada de descarga (0% a 100%, velocidad y MB).\n• Restaura tu documento, página, zoom y campos exactamente donde quedaste.',
          isSimulated: true,
        },
        message: `Aviso de prueba listo (v${simulatedVersion}).`,
        error: null,
      });
      return updaterState;
    },

    async startDevUpdateSimulation(
      patch?: SessionStatePatch,
    ): Promise<{ ok: boolean; error?: string }> {
      if (previewSimTimer !== null) {
        window.clearInterval(previewSimTimer);
        previewSimTimer = null;
      }

      const versionLabel = updaterState.availableUpdate?.version ?? '0.2.0-test';
      const store = readPreviewStore();
      store.session_state = {
        ...store.session_state,
        ...(patch ?? {}),
        pending_restore: 1,
      };
      store.app_meta.pending_update_banner_version = versionLabel;
      writePreviewStore(store);

      const theme = store.session_state.theme;
      const totalBytes = 68 * 1024 * 1024;
      let transferred = 0;

      emitProgress({
        stage: 'preparing',
        version: versionLabel,
        percent: 0,
        bytesPerSecond: 0,
        transferredBytes: 0,
        totalBytes,
        statusMessage: `Preparando descarga de v${versionLabel} (prueba local)...`,
        theme,
        isSimulated: true,
      });

      previewSimTimer = window.setInterval(() => {
        const speedBytes = Math.round((7.4 + Math.random() * 4.5) * 1024 * 1024);
        const stepBytes = Math.round(speedBytes * 0.22);
        transferred = Math.min(totalBytes, transferred + stepBytes);
        const percent = Math.min(100, Math.round((transferred / totalBytes) * 100));

        if (percent < 100) {
          emitProgress({
            stage: 'downloading',
            version: versionLabel,
            percent,
            bytesPerSecond: speedBytes,
            transferredBytes: transferred,
            totalBytes,
            statusMessage: `Descargando actualización v${versionLabel}...`,
            theme,
            isSimulated: true,
          });
          return;
        }

        if (previewSimTimer !== null) {
          window.clearInterval(previewSimTimer);
          previewSimTimer = null;
        }

        emitProgress({
          stage: 'verifying',
          version: versionLabel,
          percent: 100,
          bytesPerSecond: 0,
          transferredBytes: totalBytes,
          totalBytes,
          statusMessage: 'Verificando instalador NSIS y preparando reinicio...',
          theme,
          isSimulated: true,
        });

        window.setTimeout(() => {
          emitProgress({
            stage: 'installing',
            version: versionLabel,
            percent: 100,
            bytesPerSecond: 0,
            transferredBytes: totalBytes,
            totalBytes,
            statusMessage: 'Reiniciando y restaurando tu sesión guardada...',
            theme,
            isSimulated: true,
          });

          window.setTimeout(() => {
            window.location.reload();
          }, 650);
        }, 700);
      }, 180);

      return { ok: true };
    },

    async cancelUpdaterAndReturn(): Promise<void> {
      if (previewSimTimer !== null) {
        window.clearInterval(previewSimTimer);
        previewSimTimer = null;
      }
      latestSplashPayload = null;
    },

    async getUpdaterSplashState(): Promise<UpdaterProgressPayload | null> {
      return latestSplashPayload;
    },

    onUpdaterStateChange(callback: (state: UpdaterState) => void): () => void {
      stateListeners.add(callback);
      return () => {
        stateListeners.delete(callback);
      };
    },

    onUpdaterProgress(callback: (payload: UpdaterProgressPayload) => void): () => void {
      progressListeners.add(callback);
      return () => {
        progressListeners.delete(callback);
      };
    },
  };
}

let cachedBridge: LibreDocAPI | null = null;

export function getLibreDocBridge(): LibreDocAPI {
  if (typeof window !== 'undefined' && window.libredoc) {
    return window.libredoc;
  }
  if (!cachedBridge) {
    cachedBridge = createBrowserPreviewBridge();
  }
  return cachedBridge;
}

export function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.libredoc);
}
