export type AppRoute = 'workspace' | 'editor' | 'updates';

export type ThemeMode = 'light' | 'dark';

export type SidebarTab = 'fields' | 'info';

export type DiagnosisType =
  | 'PDF_NATIVE_EDITABLE'
  | 'PDF_LOCKED_PERMISSIONS'
  | 'PDF_ENCRYPTED_OPEN'
  | 'PDF_SCANNED_IMAGE'
  | 'DOCX_LOCKED'
  | 'DOCX_EDITABLE'
  | 'PLAIN_TEXT'
  | 'IMAGE_DOCUMENT'
  | 'PENDING_ANALYSIS';

export type DocumentStatus =
  | 'registered'
  | 'ready'
  | 'unlocked'
  | 'ocr_completed'
  | 'exported'
  | 'error';

export type FieldType = 'text' | 'checkbox' | 'date' | 'multiline';

export type RecommendedAction =
  | 'unlock_permissions'
  | 'unlock_password'
  | 'unlock_docx'
  | 'run_ocr'
  | 'extract_acroform'
  | 'open_editor'
  | 'none';

export type UpdateChannelStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface AvailableUpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes: string;
  isSimulated?: boolean;
}

export interface GithubRepoStatus {
  configured: boolean;
  owner: string | null;
  repo: string | null;
  label: string;
}

export interface UpdaterState {
  status: UpdateChannelStatus;
  currentVersion: string;
  autoCheckOnStartup: boolean;
  lastCheckedAt: string | null;
  githubRepo: GithubRepoStatus;
  isDevMode: boolean;
  availableUpdate: AvailableUpdateInfo | null;
  message: string;
  error?: string | null;
}

export interface UpdaterProgressPayload {
  stage: 'preparing' | 'downloading' | 'verifying' | 'installing' | 'error';
  version: string;
  percent: number;
  bytesPerSecond: number;
  transferredBytes: number;
  totalBytes: number;
  statusMessage: string;
  theme: ThemeMode;
  isSimulated?: boolean;
  error?: string;
}

export interface QpdfStatus {
  available: boolean;
  executablePath: string | null;
  version: string | null;
  expectedPath: string;
}

export interface TessdataStatus {
  available: boolean;
  dirPath: string | null;
  hasSpa: boolean;
  hasEng: boolean;
  expectedPath: string;
}

export interface RenderedPagePayload {
  pageNumber: number;
  pngBytes: Uint8Array;
  pdfWidthPt: number;
  pdfHeightPt: number;
  imageWidthPx: number;
  imageHeightPx: number;
}

export interface OcrProgressEvent {
  documentId: string;
  stage: 'rendering' | 'initializing' | 'recognizing' | 'grouping' | 'building_pdf' | 'completed';
  currentPage: number;
  totalPages: number;
  pageProgress: number;
  overallProgress: number;
  message: string;
}

export interface OcrRunResult {
  success: boolean;
  tessdataMissing?: boolean;
  message: string;
  error?: string;
  document?: DocumentRecord;
  fields?: DocumentField[];
  editablePdfPath?: string;
  stats?: {
    pagesProcessed: number;
    fieldsDetected: number;
    linesRecognized: number;
    avgConfidence: number;
  };
}

export interface AcroFormExtractionResult {
  success: boolean;
  message: string;
  error?: string;
  document?: DocumentRecord;
  fields: DocumentField[];
}

export interface DocumentAnalysisDetails {
  fileSizeBytes: number;
  pageCount?: number;
  analyzedPages?: number;
  avgCharsPerPage?: number;
  totalUsefulChars?: number;
  hasEmbeddedImages?: boolean;
  pagesWithImages?: number;
  acroFormFieldCount?: number;
  isEncrypted?: boolean;
  restrictions?: string[];
  docxProtections?: string[];
  encoding?: 'UTF-8' | 'UTF-8 (BOM)' | 'Latin-1';
  lineCount?: number;
  charCount?: number;
  imageWidth?: number;
  imageHeight?: number;
  qpdfAvailable?: boolean;
  qpdfVersion?: string | null;
  textPreview?: string;
}

export interface DocumentAnalysisResult {
  diagnosis_type: DiagnosisType;
  title: string;
  summary: string;
  recommended_action: RecommendedAction;
  recommended_action_label: string;
  analyzed_at: string;
  details: DocumentAnalysisDetails;
}

export interface UnlockResult {
  success: boolean;
  invalidPassword?: boolean;
  qpdfMissing?: boolean;
  message: string;
  error?: string;
  document?: DocumentRecord;
  analysis?: DocumentAnalysisResult;
  unlockedPath?: string;
}

export interface PlainTextContentResult {
  content: string;
  encoding: 'UTF-8' | 'UTF-8 (BOM)' | 'Latin-1';
  lineCount: number;
}

export interface AppMeta {
  schema_version: number;
  last_installed_version: string;
  last_updated_at: string;
  auto_check_updates: 0 | 1;
  last_update_check_at: string;
  pending_update_banner_version: string;
}

export interface DocumentRecord {
  id: string;
  original_name: string;
  original_path: string;
  working_path: string;
  file_type: string;
  diagnosis_type: DiagnosisType;
  status: DocumentStatus;
  created_at: string;
  updated_at: string;
  created_in_version: string;
  analysis?: DocumentAnalysisResult | null;
}

export interface DocumentField {
  id: string;
  document_id: string;
  page_number: number;
  label: string;
  value: string;
  field_type: FieldType;
  x: number;
  y: number;
  width: number;
  height: number;
  font_size: number;
  group_name: string;
  sort_order: number;
}

export interface SessionState {
  active_document_id: string | null;
  active_route: AppRoute;
  active_page: number;
  zoom_level: number;
  sidebar_tab: SidebarTab;
  scroll_position: number;
  pending_restore: 0 | 1;
  theme: ThemeMode;
}

export interface VersionHistoryRecord {
  id: number;
  version: string;
  installed_at: string;
  release_notes: string;
  changelog_seen: 0 | 1;
}

export interface MigrationRecord {
  version: number;
  name: string;
  applied_at: string;
}

export interface StorageDiagnostics {
  runtime: 'electron' | 'browser-preview';
  appVersion: string;
  userDataPath: string;
  dbPath: string;
  workspacesPath: string;
  schemaVersion: number;
  migrations: MigrationRecord[];
  appMeta: AppMeta;
  restoredFromSession: boolean;
  previousVersion: string | null;
  updatedToVersion: string | null;
  qpdfStatus?: QpdfStatus;
  tessdataStatus?: TessdataStatus;
}

export interface CreateDocumentInput {
  original_name: string;
  original_path?: string;
  file_type: string;
  diagnosis_type?: DiagnosisType;
  status?: DocumentStatus;
  analysis?: DocumentAnalysisResult | null;
}

export interface UpsertFieldInput {
  id?: string;
  document_id: string;
  page_number?: number;
  label: string;
  value?: string;
  field_type?: FieldType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  font_size?: number;
  group_name?: string;
  sort_order?: number;
}

export type SessionStatePatch = Partial<Omit<SessionState, 'pending_restore'>> & {
  pending_restore?: 0 | 1;
};

export interface LibreDocAPI {
  getDiagnostics: () => Promise<StorageDiagnostics>;
  openUserDataFolder: () => Promise<{ ok: boolean; path: string }>;
  revealDocumentInFolder: (documentId: string) => Promise<{ ok: boolean; path: string }>;
  getPathForFile?: (file: File) => string;

  getSessionState: () => Promise<SessionState>;
  saveSessionState: (patch: SessionStatePatch) => Promise<SessionState>;
  acknowledgeSessionRestore: () => Promise<void>;
  flushSessionSync: (patch?: SessionStatePatch) => boolean;

  listDocuments: () => Promise<DocumentRecord[]>;
  getDocument: (id: string) => Promise<DocumentRecord | null>;
  createDocument: (input: CreateDocumentInput) => Promise<DocumentRecord>;
  pickAndRegisterDocument: () => Promise<DocumentRecord | null>;
  ingestFilePath: (filePath: string) => Promise<DocumentRecord>;
  reanalyzeDocument: (documentId: string) => Promise<DocumentRecord | null>;
  unlockDocument: (documentId: string, password?: string) => Promise<UnlockResult>;
  readPlainTextDocument: (documentId: string) => Promise<PlainTextContentResult | null>;
  readWorkingFileBytes: (documentId: string) => Promise<Uint8Array | null>;
  runLocalOcr: (
    documentId: string,
    renderedPages?: RenderedPagePayload[],
  ) => Promise<OcrRunResult>;
  extractAcroFormFields: (documentId: string) => Promise<AcroFormExtractionResult>;
  onOcrProgress?: (callback: (event: OcrProgressEvent) => void) => () => void;

  // Paso 5: Auto-updater & dedicated updater splash window
  getUpdaterState: () => Promise<UpdaterState>;
  setAutoCheckUpdates: (enabled: boolean) => Promise<UpdaterState>;
  checkForUpdates: () => Promise<UpdaterState>;
  acceptAndInstallUpdate: (patch?: SessionStatePatch) => Promise<{ ok: boolean; error?: string }>;
  triggerDevUpdatePrompt: () => Promise<UpdaterState>;
  startDevUpdateSimulation: (patch?: SessionStatePatch) => Promise<{ ok: boolean; error?: string }>;
  cancelUpdaterAndReturn: () => Promise<void>;
  getUpdaterSplashState: () => Promise<UpdaterProgressPayload | null>;
  onUpdaterStateChange?: (callback: (state: UpdaterState) => void) => () => void;
  onUpdaterProgress?: (callback: (payload: UpdaterProgressPayload) => void) => () => void;

  updateDocument: (
    id: string,
    patch: Partial<Pick<DocumentRecord, 'original_name' | 'diagnosis_type' | 'status' | 'analysis'>>,
  ) => Promise<DocumentRecord | null>;
  deleteDocument: (id: string) => Promise<boolean>;

  listDocumentFields: (documentId: string) => Promise<DocumentField[]>;
  upsertDocumentField: (input: UpsertFieldInput) => Promise<DocumentField>;
  updateFieldValue: (fieldId: string, value: string) => Promise<DocumentField | null>;
  deleteDocumentField: (fieldId: string) => Promise<boolean>;

  listVersionHistory: () => Promise<VersionHistoryRecord[]>;
  markVersionChangelogSeen: (version: string) => Promise<void>;
}
