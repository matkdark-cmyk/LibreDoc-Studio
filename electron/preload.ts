import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  CreateDocumentInput,
  DocumentField,
  DocumentRecord,
  LibreDocAPI,
  OcrProgressEvent,
  RenderedPagePayload,
  SessionStatePatch,
  UpdaterProgressPayload,
  UpdaterState,
  UpsertFieldInput,
} from '../shared/types';

const api: LibreDocAPI = {
  getDiagnostics: () => ipcRenderer.invoke('app:get-diagnostics'),
  openUserDataFolder: () => ipcRenderer.invoke('app:open-userdata-folder'),
  revealDocumentInFolder: (documentId: string) =>
    ipcRenderer.invoke('documents:reveal-in-folder', documentId),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  getSessionState: () => ipcRenderer.invoke('session:get'),
  saveSessionState: (patch: SessionStatePatch) => ipcRenderer.invoke('session:save', patch),
  acknowledgeSessionRestore: () => ipcRenderer.invoke('session:ack-restore'),
  flushSessionSync: (patch?: SessionStatePatch) =>
    Boolean(ipcRenderer.sendSync('session:flush-sync', patch)),

  listDocuments: () => ipcRenderer.invoke('documents:list'),
  getDocument: (id: string) => ipcRenderer.invoke('documents:get', id),
  createDocument: (input: CreateDocumentInput) => ipcRenderer.invoke('documents:create', input),
  pickAndRegisterDocument: () => ipcRenderer.invoke('documents:pick-and-register'),
  ingestFilePath: (filePath: string) => ipcRenderer.invoke('documents:ingest-path', filePath),
  reanalyzeDocument: (documentId: string) => ipcRenderer.invoke('documents:reanalyze', documentId),
  unlockDocument: (documentId: string, password?: string) =>
    ipcRenderer.invoke('documents:unlock', documentId, password),
  readPlainTextDocument: (documentId: string) =>
    ipcRenderer.invoke('documents:read-plain-text', documentId),
  readWorkingFileBytes: (documentId: string) =>
    ipcRenderer.invoke('documents:read-working-bytes', documentId),
  runLocalOcr: (documentId: string, renderedPages?: RenderedPagePayload[]) =>
    ipcRenderer.invoke('ocr:run-document', documentId, renderedPages),
  extractAcroFormFields: (documentId: string) =>
    ipcRenderer.invoke('pdf:extract-acroform', documentId),
  onOcrProgress: (callback: (event: OcrProgressEvent) => void) => {
    const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: OcrProgressEvent) => {
      callback(payload);
    };
    ipcRenderer.on('ocr:progress', listener);
    return () => {
      ipcRenderer.removeListener('ocr:progress', listener);
    };
  },

  updateDocument: (
    id: string,
    patch: Partial<
      Pick<DocumentRecord, 'original_name' | 'diagnosis_type' | 'status' | 'analysis'>
    >,
  ) => ipcRenderer.invoke('documents:update', id, patch),
  deleteDocument: (id: string) => ipcRenderer.invoke('documents:delete', id),

  listDocumentFields: (documentId: string) => ipcRenderer.invoke('fields:list', documentId),
  replaceDocumentFields: (documentId: string, inputs: UpsertFieldInput[]) =>
    ipcRenderer.invoke('fields:replace-all', documentId, inputs),
  upsertDocumentField: (input: UpsertFieldInput) => ipcRenderer.invoke('fields:upsert', input),
  updateFieldValue: (fieldId: string, value: string) =>
    ipcRenderer.invoke('fields:update-value', fieldId, value),
  deleteDocumentField: (fieldId: string) => ipcRenderer.invoke('fields:delete', fieldId),
  exportAcroFormPdf: (documentId: string, fields?: DocumentField[]) =>
    ipcRenderer.invoke('pdf:export-acroform', documentId, fields),

  listVersionHistory: () => ipcRenderer.invoke('versions:list'),
  markVersionChangelogSeen: (version: string) => ipcRenderer.invoke('versions:mark-seen', version),

  getUpdaterState: () => ipcRenderer.invoke('updater:get-state'),
  setAutoCheckUpdates: (enabled: boolean) => ipcRenderer.invoke('updater:set-auto-check', enabled),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  acceptAndInstallUpdate: (patch?: SessionStatePatch) =>
    ipcRenderer.invoke('updater:accept-install', patch),
  triggerDevUpdatePrompt: () => ipcRenderer.invoke('updater:dev-trigger-prompt'),
  startDevUpdateSimulation: (patch?: SessionStatePatch) =>
    ipcRenderer.invoke('updater:dev-start-sim', patch),
  cancelUpdaterAndReturn: () => ipcRenderer.invoke('updater:cancel-return'),
  getUpdaterSplashState: () => ipcRenderer.invoke('updater:get-splash-state'),
  onUpdaterStateChange: (callback: (state: UpdaterState) => void) => {
    const listener = (_ipcEvent: Electron.IpcRendererEvent, state: UpdaterState) => {
      callback(state);
    };
    ipcRenderer.on('updater:state-changed', listener);
    return () => {
      ipcRenderer.removeListener('updater:state-changed', listener);
    };
  },
  onUpdaterProgress: (callback: (payload: UpdaterProgressPayload) => void) => {
    const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: UpdaterProgressPayload) => {
      callback(payload);
    };
    ipcRenderer.on('updater:progress', listener);
    return () => {
      ipcRenderer.removeListener('updater:progress', listener);
    };
  },
};

contextBridge.exposeInMainWorld('libredoc', api);
