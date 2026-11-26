import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  AppMeta,
  AppRoute,
  CheckboxStyle,
  CreateDocumentInput,
  DiagnosisType,
  DocumentAnalysisResult,
  DocumentField,
  DocumentRecord,
  DocumentStatus,
  FieldAlignment,
  FieldSource,
  FieldType,
  MigrationRecord,
  SessionState,
  SessionStatePatch,
  StorageDiagnostics,
  ThemeMode,
  UpsertFieldInput,
  VersionHistoryRecord,
} from '../../shared/types';

interface DocumentDbRow {
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
  analysis_json: string;
}

function hydrateDocumentRow(row: DocumentDbRow): DocumentRecord {
  let analysis: DocumentAnalysisResult | null = null;
  if (row.analysis_json && row.analysis_json.trim() !== '') {
    try {
      analysis = JSON.parse(row.analysis_json) as DocumentAnalysisResult;
    } catch {
      analysis = null;
    }
  }
  return {
    id: row.id,
    original_name: row.original_name,
    original_path: row.original_path,
    working_path: row.working_path,
    file_type: row.file_type,
    diagnosis_type: row.diagnosis_type,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_in_version: row.created_in_version,
    analysis,
  };
}

interface MigrationDefinition {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const DEFAULT_RELEASE_NOTES: Record<string, string> = {
  '0.1.0':
    'Estructura base de LibreDoc Studio para Windows, base de datos SQLite versionada en userData con migraciones automáticas y restauración exacta de sesión.',
  '0.2.0':
    'Nueva vista previa en vivo del archivo en el costado derecho del Editor (PDF, imágenes, Word .docx y texto) con marcado interactivo en tiempo real de los espacios que se están editando y sincronización bidireccional.',
  '0.2.1':
    'Nuevo ícono oficial de LibreDoc Studio + conversor automático de alta precisión de PDF estático a PDF rellenable (AcroForm) con detección híbrida de tablas, checkboxes ✓/✕, prefijos $, fechas, guiones tapados y ajuste interactivo sobre el documento.',
};

const MIGRATIONS: MigrationDefinition[] = [
  {
    version: 1,
    name: '001_initial_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          schema_version INTEGER NOT NULL DEFAULT 1,
          last_installed_version TEXT NOT NULL DEFAULT '0.1.0',
          last_updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          original_name TEXT NOT NULL,
          original_path TEXT NOT NULL,
          working_path TEXT NOT NULL,
          file_type TEXT NOT NULL,
          diagnosis_type TEXT NOT NULL DEFAULT 'PENDING_ANALYSIS',
          status TEXT NOT NULL DEFAULT 'registered',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          created_in_version TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS document_fields (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          page_number INTEGER NOT NULL DEFAULT 1,
          label TEXT NOT NULL,
          value TEXT NOT NULL DEFAULT '',
          field_type TEXT NOT NULL DEFAULT 'text',
          x REAL NOT NULL DEFAULT 64,
          y REAL NOT NULL DEFAULT 96,
          width REAL NOT NULL DEFAULT 220,
          height REAL NOT NULL DEFAULT 32,
          font_size REAL NOT NULL DEFAULT 12,
          group_name TEXT NOT NULL DEFAULT 'General',
          sort_order INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS session_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          active_document_id TEXT,
          active_route TEXT NOT NULL DEFAULT 'workspace',
          active_page INTEGER NOT NULL DEFAULT 1,
          zoom_level REAL NOT NULL DEFAULT 1.0,
          sidebar_tab TEXT NOT NULL DEFAULT 'fields',
          scroll_position INTEGER NOT NULL DEFAULT 0,
          pending_restore INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (active_document_id) REFERENCES documents(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS version_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version TEXT NOT NULL UNIQUE,
          installed_at TEXT NOT NULL,
          release_notes TEXT NOT NULL DEFAULT '',
          changelog_seen INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_documents_updated_at
          ON documents(updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_document_fields_doc_order
          ON document_fields(document_id, page_number, sort_order);
      `);

      const now = new Date().toISOString();
      db.prepare(
        `INSERT OR IGNORE INTO app_meta (id, schema_version, last_installed_version, last_updated_at)
         VALUES (1, 1, '0.1.0', ?)`,
      ).run(now);

      db.prepare(
        `INSERT OR IGNORE INTO session_state (
          id, active_document_id, active_route, active_page, zoom_level, sidebar_tab, scroll_position, pending_restore
        ) VALUES (1, NULL, 'workspace', 1, 1.0, 'fields', 0, 0)`,
      ).run();
    },
  },
  {
    version: 2,
    name: '002_session_theme_preference',
    up: (db) => {
      const columns = db
        .prepare(`PRAGMA table_info(session_state)`)
        .all() as Array<{ name: string }>;
      const hasTheme = columns.some((col) => col.name === 'theme');
      if (!hasTheme) {
        db.exec(
          `ALTER TABLE session_state ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'`,
        );
      }
    },
  },
  {
    version: 3,
    name: '003_document_analysis_metadata',
    up: (db) => {
      const columns = db
        .prepare(`PRAGMA table_info(documents)`)
        .all() as Array<{ name: string }>;
      const hasAnalysisJson = columns.some((col) => col.name === 'analysis_json');
      if (!hasAnalysisJson) {
        db.exec(
          `ALTER TABLE documents ADD COLUMN analysis_json TEXT NOT NULL DEFAULT ''`,
        );
      }
    },
  },
  {
    version: 4,
    name: '004_updater_preferences_and_restore_banner',
    up: (db) => {
      const columns = db
        .prepare(`PRAGMA table_info(app_meta)`)
        .all() as Array<{ name: string }>;
      const colNames = new Set(columns.map((c) => c.name));
      if (!colNames.has('auto_check_updates')) {
        db.exec(
          `ALTER TABLE app_meta ADD COLUMN auto_check_updates INTEGER NOT NULL DEFAULT 1`,
        );
      }
      if (!colNames.has('last_update_check_at')) {
        db.exec(
          `ALTER TABLE app_meta ADD COLUMN last_update_check_at TEXT NOT NULL DEFAULT ''`,
        );
      }
      if (!colNames.has('pending_update_banner_version')) {
        db.exec(
          `ALTER TABLE app_meta ADD COLUMN pending_update_banner_version TEXT NOT NULL DEFAULT ''`,
        );
      }
    },
  },
  {
    version: 5,
    name: '005_field_acroform_properties',
    up: (db) => {
      const columns = db
        .prepare(`PRAGMA table_info(document_fields)`)
        .all() as Array<{ name: string }>;
      const colNames = new Set(columns.map((c) => c.name));
      if (!colNames.has('font_size')) {
        db.exec(`ALTER TABLE document_fields ADD COLUMN font_size REAL NOT NULL DEFAULT 10`);
      }
      if (!colNames.has('checkbox_style')) {
        db.exec(
          `ALTER TABLE document_fields ADD COLUMN checkbox_style TEXT NOT NULL DEFAULT 'check'`,
        );
      }
      if (!colNames.has('alignment')) {
        db.exec(`ALTER TABLE document_fields ADD COLUMN alignment TEXT NOT NULL DEFAULT 'left'`);
      }
      if (!colNames.has('cover_dashes')) {
        db.exec(`ALTER TABLE document_fields ADD COLUMN cover_dashes INTEGER NOT NULL DEFAULT 0`);
      }
      if (!colNames.has('field_name')) {
        db.exec(`ALTER TABLE document_fields ADD COLUMN field_name TEXT NOT NULL DEFAULT ''`);
      }
      if (!colNames.has('tooltip')) {
        db.exec(`ALTER TABLE document_fields ADD COLUMN tooltip TEXT NOT NULL DEFAULT ''`);
      }
      if (!colNames.has('source')) {
        db.exec(`ALTER TABLE document_fields ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
      }
    },
  },
];

const VALID_ROUTES = new Set<AppRoute>(['workspace', 'editor', 'updates']);
const VALID_THEMES = new Set<ThemeMode>(['light', 'dark']);
const VALID_FIELD_TYPES = new Set<FieldType>(['text', 'checkbox', 'date', 'multiline']);
const VALID_CHECKBOX_STYLES = new Set<CheckboxStyle>(['check', 'cross']);
const VALID_ALIGNMENTS = new Set<FieldAlignment>(['left', 'center', 'right']);
const VALID_SOURCES = new Set<FieldSource>(['auto', 'manual']);

export class DatabaseService {
  private readonly db: Database.Database;
  private readonly userDataDir: string;
  private readonly dataDir: string;
  private readonly dbPath: string;
  private readonly workspacesDir: string;
  private readonly backupsDir: string;
  private readonly appVersion: string;
  private restoredFromSession = false;
  private restoredAfterUpdateVersion: string | null = null;
  private previousVersion: string | null = null;

  constructor(userDataDir: string, appVersion: string) {
    this.userDataDir = userDataDir;
    this.appVersion = appVersion;
    this.dataDir = path.join(userDataDir, 'data');
    this.dbPath = path.join(this.dataDir, 'libredoc.db');
    this.workspacesDir = path.join(userDataDir, 'workspaces');
    this.backupsDir = path.join(userDataDir, 'backups');

    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.workspacesDir, { recursive: true });
    fs.mkdirSync(this.backupsDir, { recursive: true });

    const dbExistedBeforeOpen = fs.existsSync(this.dbPath);

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');

    this.runMigrations(dbExistedBeforeOpen);
    this.syncVersionMetadata();
    this.captureBootRestoreState();
  }

  private runMigrations(dbExistedBeforeOpen: boolean): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = this.db
      .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{ version: number }>;
    const appliedSet = new Set(appliedRows.map((row) => row.version));

    const pending = MIGRATIONS.filter((migration) => !appliedSet.has(migration.version));
    if (pending.length === 0) {
      return;
    }

    if (dbExistedBeforeOpen && appliedRows.length > 0) {
      const latestApplied = appliedRows[appliedRows.length - 1].version;
      const backupFile = path.join(
        this.backupsDir,
        `libredoc.v${latestApplied}.${Date.now()}.bak.db`,
      );
      try {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
        fs.copyFileSync(this.dbPath, backupFile);
      } catch {
        // Backup failure must not block forward migration, but we tried safely.
      }
    }

    const insertMigration = this.db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    );

    const applyAll = this.db.transaction(() => {
      for (const migration of pending) {
        migration.up(this.db);
        insertMigration.run(migration.version, migration.name, new Date().toISOString());
      }
      const latestVersion = MIGRATIONS[MIGRATIONS.length - 1].version;
      this.db
        .prepare('UPDATE app_meta SET schema_version = ?, last_updated_at = ? WHERE id = 1')
        .run(latestVersion, new Date().toISOString());
    });

    applyAll();
  }

  private syncVersionMetadata(): void {
    const now = new Date().toISOString();
    const meta = this.getAppMeta();
    const latestSchemaVersion = MIGRATIONS[MIGRATIONS.length - 1].version;

    if (meta.last_installed_version !== this.appVersion) {
      this.previousVersion = meta.last_installed_version;
      this.restoredAfterUpdateVersion = this.appVersion;
      this.db
        .prepare(
          `UPDATE app_meta
           SET schema_version = ?, last_installed_version = ?, last_updated_at = ?
           WHERE id = 1`,
        )
        .run(latestSchemaVersion, this.appVersion, now);
    } else if (meta.schema_version !== latestSchemaVersion) {
      this.db
        .prepare('UPDATE app_meta SET schema_version = ?, last_updated_at = ? WHERE id = 1')
        .run(latestSchemaVersion, now);
    }

    if (meta.pending_update_banner_version) {
      this.restoredAfterUpdateVersion = meta.pending_update_banner_version;
    }

    const notes =
      DEFAULT_RELEASE_NOTES[this.appVersion] ??
      `Versión ${this.appVersion} instalada con preservación de datos y migraciones locales.`;

    this.db
      .prepare(
        `INSERT OR IGNORE INTO version_history (version, installed_at, release_notes, changelog_seen)
         VALUES (?, ?, ?, 0)`,
      )
      .run(this.appVersion, now, notes);
  }

  private captureBootRestoreState(): void {
    const session = this.getSessionState();
    this.restoredFromSession = session.pending_restore === 1;

    // Validate that active_document_id still exists; if deleted externally, fall back cleanly.
    if (session.active_document_id) {
      const existing = this.getDocument(session.active_document_id);
      if (!existing) {
        this.saveSessionState({
          active_document_id: null,
          active_route: session.active_route === 'editor' ? 'workspace' : session.active_route,
        });
      }
    }
  }

  public getUserDataPath(): string {
    return this.userDataDir;
  }

  public getWorkspacesPath(): string {
    return this.workspacesDir;
  }

  public getAppMeta(): AppMeta {
    const row = this.db
      .prepare(
        `SELECT schema_version, last_installed_version, last_updated_at,
                auto_check_updates, last_update_check_at, pending_update_banner_version
         FROM app_meta WHERE id = 1`,
      )
      .get() as AppMeta | undefined;

    if (!row) {
      const fallback: AppMeta = {
        schema_version: MIGRATIONS[MIGRATIONS.length - 1].version,
        last_installed_version: this.appVersion,
        last_updated_at: new Date().toISOString(),
        auto_check_updates: 1,
        last_update_check_at: '',
        pending_update_banner_version: '',
      };
      this.db
        .prepare(
          `INSERT OR REPLACE INTO app_meta (
            id, schema_version, last_installed_version, last_updated_at,
            auto_check_updates, last_update_check_at, pending_update_banner_version
          ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fallback.schema_version,
          fallback.last_installed_version,
          fallback.last_updated_at,
          fallback.auto_check_updates,
          fallback.last_update_check_at,
          fallback.pending_update_banner_version,
        );
      return fallback;
    }

    return {
      schema_version: row.schema_version,
      last_installed_version: row.last_installed_version,
      last_updated_at: row.last_updated_at,
      auto_check_updates: row.auto_check_updates === 0 ? 0 : 1,
      last_update_check_at: row.last_update_check_at ?? '',
      pending_update_banner_version: row.pending_update_banner_version ?? '',
    };
  }

  public setAutoCheckUpdates(enabled: boolean): AppMeta {
    this.db
      .prepare('UPDATE app_meta SET auto_check_updates = ? WHERE id = 1')
      .run(enabled ? 1 : 0);
    return this.getAppMeta();
  }

  public setLastUpdateCheckAt(isoTimestamp: string): AppMeta {
    this.db
      .prepare('UPDATE app_meta SET last_update_check_at = ? WHERE id = 1')
      .run(isoTimestamp);
    return this.getAppMeta();
  }

  public setPendingUpdateBannerVersion(version: string): void {
    this.restoredAfterUpdateVersion = version || null;
    this.db
      .prepare('UPDATE app_meta SET pending_update_banner_version = ? WHERE id = 1')
      .run(version);
  }

  public recordVersionHistory(version: string, releaseNotes: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO version_history (version, installed_at, release_notes, changelog_seen)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(version) DO UPDATE SET
           installed_at = excluded.installed_at,
           release_notes = CASE
             WHEN excluded.release_notes != '' THEN excluded.release_notes
             ELSE version_history.release_notes
           END`,
      )
      .run(version, now, releaseNotes);
  }

  public listMigrations(): MigrationRecord[] {
    return this.db
      .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC')
      .all() as MigrationRecord[];
  }

  public getDiagnostics(): StorageDiagnostics {
    const appMeta = this.getAppMeta();
    const bannerVersion =
      this.restoredAfterUpdateVersion ||
      (appMeta.pending_update_banner_version ? appMeta.pending_update_banner_version : null);
    return {
      runtime: 'electron',
      appVersion: this.appVersion,
      userDataPath: this.userDataDir,
      dbPath: this.dbPath,
      workspacesPath: this.workspacesDir,
      schemaVersion: appMeta.schema_version,
      migrations: this.listMigrations(),
      appMeta,
      restoredFromSession: this.restoredFromSession || Boolean(bannerVersion),
      previousVersion: this.previousVersion,
      updatedToVersion: bannerVersion,
    };
  }

  public getSessionState(): SessionState {
    const row = this.db
      .prepare(
        `SELECT active_document_id, active_route, active_page, zoom_level, sidebar_tab, scroll_position, pending_restore, theme
         FROM session_state WHERE id = 1`,
      )
      .get() as SessionState | undefined;

    if (!row) {
      return {
        active_document_id: null,
        active_route: 'workspace',
        active_page: 1,
        zoom_level: 1,
        sidebar_tab: 'fields',
        scroll_position: 0,
        pending_restore: 0,
        theme: 'light',
      };
    }

    return {
      active_document_id: row.active_document_id ?? null,
      active_route: VALID_ROUTES.has(row.active_route) ? row.active_route : 'workspace',
      active_page: Math.max(1, Number(row.active_page) || 1),
      zoom_level: Math.min(2, Math.max(0.5, Number(row.zoom_level) || 1)),
      sidebar_tab: row.sidebar_tab === 'info' ? 'info' : 'fields',
      scroll_position: Math.max(0, Number(row.scroll_position) || 0),
      pending_restore: row.pending_restore === 1 ? 1 : 0,
      theme: VALID_THEMES.has(row.theme) ? row.theme : 'light',
    };
  }

  public saveSessionState(patch: SessionStatePatch): SessionState {
    const current = this.getSessionState();
    const next: SessionState = {
      active_document_id:
        patch.active_document_id !== undefined
          ? patch.active_document_id
          : current.active_document_id,
      active_route:
        patch.active_route && VALID_ROUTES.has(patch.active_route)
          ? patch.active_route
          : current.active_route,
      active_page:
        patch.active_page !== undefined
          ? Math.max(1, Math.round(patch.active_page))
          : current.active_page,
      zoom_level:
        patch.zoom_level !== undefined
          ? Math.min(2, Math.max(0.5, Number(patch.zoom_level)))
          : current.zoom_level,
      sidebar_tab:
        patch.sidebar_tab === 'info' || patch.sidebar_tab === 'fields'
          ? patch.sidebar_tab
          : current.sidebar_tab,
      scroll_position:
        patch.scroll_position !== undefined
          ? Math.max(0, Math.round(patch.scroll_position))
          : current.scroll_position,
      pending_restore:
        patch.pending_restore !== undefined ? (patch.pending_restore === 1 ? 1 : 0) : current.pending_restore,
      theme:
        patch.theme && VALID_THEMES.has(patch.theme) ? patch.theme : current.theme,
    };

    if (next.active_document_id) {
      const exists = this.getDocument(next.active_document_id);
      if (!exists) {
        next.active_document_id = null;
      }
    }

    this.db
      .prepare(
        `UPDATE session_state
         SET active_document_id = ?,
             active_route = ?,
             active_page = ?,
             zoom_level = ?,
             sidebar_tab = ?,
             scroll_position = ?,
             pending_restore = ?,
             theme = ?
         WHERE id = 1`,
      )
      .run(
        next.active_document_id,
        next.active_route,
        next.active_page,
        next.zoom_level,
        next.sidebar_tab,
        next.scroll_position,
        next.pending_restore,
        next.theme,
      );

    return next;
  }

  public acknowledgeSessionRestore(): void {
    this.restoredFromSession = false;
    this.restoredAfterUpdateVersion = null;
    this.db.prepare('UPDATE session_state SET pending_restore = 0 WHERE id = 1').run();
    this.db
      .prepare("UPDATE app_meta SET pending_update_banner_version = '' WHERE id = 1")
      .run();
  }

  public flushSessionSync(patch?: SessionStatePatch): boolean {
    this.saveSessionState({
      ...(patch ?? {}),
      pending_restore: 1,
    });
    this.db.pragma('wal_checkpoint(PASSIVE)');
    return true;
  }

  public prepareUpdateRestore(targetVersion: string, patch?: SessionStatePatch): void {
    const tx = this.db.transaction(() => {
      this.saveSessionState({
        ...(patch ?? {}),
        pending_restore: 1,
      });
      this.setPendingUpdateBannerVersion(targetVersion);
    });
    tx();
    this.restoredFromSession = true;
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  public listDocuments(): DocumentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, original_name, original_path, working_path, file_type,
                diagnosis_type, status, created_at, updated_at, created_in_version, analysis_json
         FROM documents
         ORDER BY updated_at DESC`,
      )
      .all() as DocumentDbRow[];
    return rows.map(hydrateDocumentRow);
  }

  public getDocument(id: string): DocumentRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, original_name, original_path, working_path, file_type,
                diagnosis_type, status, created_at, updated_at, created_in_version, analysis_json
         FROM documents
         WHERE id = ?`,
      )
      .get(id) as DocumentDbRow | undefined;
    return row ? hydrateDocumentRow(row) : null;
  }

  public createDocument(input: CreateDocumentInput): DocumentRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const safeName = path.basename(input.original_name.trim() || 'documento-sin-nombre');
    const docWorkspaceDir = path.join(this.workspacesDir, id);
    fs.mkdirSync(docWorkspaceDir, { recursive: true });

    const originalPath = input.original_path?.trim() || path.join(docWorkspaceDir, safeName);
    const workingPath = path.join(docWorkspaceDir, safeName);

    // If a real local file was selected, copy it into the isolated workspace so the original is never altered.
    if (input.original_path && fs.existsSync(input.original_path)) {
      try {
        fs.copyFileSync(input.original_path, workingPath);
      } catch {
        // Keep workingPath reference even if copy fails due to external permissions.
      }
    }

    const fileType = (input.file_type || path.extname(safeName).replace('.', '') || 'pdf')
      .toLowerCase()
      .slice(0, 16);

    const analysis = input.analysis ?? null;
    const analysisJson = analysis ? JSON.stringify(analysis) : '';

    const record: DocumentRecord = {
      id,
      original_name: safeName,
      original_path: originalPath,
      working_path: workingPath,
      file_type: fileType,
      diagnosis_type: (input.diagnosis_type ?? 'PENDING_ANALYSIS') as DiagnosisType,
      status: (input.status ?? 'registered') as DocumentStatus,
      created_at: now,
      updated_at: now,
      created_in_version: this.appVersion,
      analysis,
    };

    this.db
      .prepare(
        `INSERT INTO documents (
          id, original_name, original_path, working_path, file_type,
          diagnosis_type, status, created_at, updated_at, created_in_version, analysis_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.original_name,
        record.original_path,
        record.working_path,
        record.file_type,
        record.diagnosis_type,
        record.status,
        record.created_at,
        record.updated_at,
        record.created_in_version,
        analysisJson,
      );

    return record;
  }

  public updateDocument(
    id: string,
    patch: Partial<
      Pick<DocumentRecord, 'original_name' | 'working_path' | 'diagnosis_type' | 'status' | 'analysis'>
    >,
  ): DocumentRecord | null {
    const existing = this.getDocument(id);
    if (!existing) return null;

    const updatedAt = new Date().toISOString();
    const nextAnalysis = patch.analysis !== undefined ? patch.analysis : existing.analysis ?? null;
    const next: DocumentRecord = {
      ...existing,
      original_name: patch.original_name?.trim() || existing.original_name,
      working_path: patch.working_path?.trim() || existing.working_path,
      diagnosis_type: patch.diagnosis_type ?? existing.diagnosis_type,
      status: patch.status ?? existing.status,
      updated_at: updatedAt,
      analysis: nextAnalysis,
    };

    this.db
      .prepare(
        `UPDATE documents
         SET original_name = ?, working_path = ?, diagnosis_type = ?, status = ?, updated_at = ?, analysis_json = ?
         WHERE id = ?`,
      )
      .run(
        next.original_name,
        next.working_path,
        next.diagnosis_type,
        next.status,
        next.updated_at,
        nextAnalysis ? JSON.stringify(nextAnalysis) : '',
        id,
      );

    return next;
  }

  public deleteDocument(id: string): boolean {
    const existing = this.getDocument(id);
    if (!existing) return false;

    const session = this.getSessionState();
    const removeTx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
      if (session.active_document_id === id) {
        this.db
          .prepare(
            `UPDATE session_state
             SET active_document_id = NULL, active_page = 1, scroll_position = 0
             WHERE id = 1`,
          )
          .run();
      }
    });
    removeTx();

    const docWorkspaceDir = path.join(this.workspacesDir, id);
    if (fs.existsSync(docWorkspaceDir)) {
      try {
        fs.rmSync(docWorkspaceDir, { recursive: true, force: true });
      } catch {
        // Ignore locked file errors on cleanup.
      }
    }

    return true;
  }

  public listDocumentFields(documentId: string): DocumentField[] {
    const rows = this.db
      .prepare(
        `SELECT id, document_id, page_number, label, value, field_type,
                x, y, width, height, font_size, group_name, sort_order,
                checkbox_style, alignment, cover_dashes, field_name, tooltip, source
         FROM document_fields
         WHERE document_id = ?
         ORDER BY page_number ASC, sort_order ASC, label ASC`,
      )
      .all(documentId) as DocumentField[];

    return rows.map((row) => ({
      ...row,
      checkbox_style: VALID_CHECKBOX_STYLES.has(row.checkbox_style as CheckboxStyle)
        ? (row.checkbox_style as CheckboxStyle)
        : 'check',
      alignment: VALID_ALIGNMENTS.has(row.alignment as FieldAlignment)
        ? (row.alignment as FieldAlignment)
        : 'left',
      cover_dashes: row.cover_dashes === 1 ? 1 : 0,
      field_name: row.field_name ?? '',
      tooltip: row.tooltip ?? '',
      source: VALID_SOURCES.has(row.source as FieldSource) ? (row.source as FieldSource) : 'manual',
    }));
  }

  public replaceDocumentFields(
    documentId: string,
    inputs: UpsertFieldInput[],
  ): DocumentField[] {
    const deleteStmt = this.db.prepare('DELETE FROM document_fields WHERE document_id = ?');
    const insertStmt = this.db.prepare(
      `INSERT INTO document_fields (
        id, document_id, page_number, label, value, field_type,
        x, y, width, height, font_size, group_name, sort_order,
        checkbox_style, alignment, cover_dashes, field_name, tooltip, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const replaceTx = this.db.transaction(() => {
      deleteStmt.run(documentId);
      inputs.forEach((input, idx) => {
        const id = input.id || crypto.randomUUID();
        const fieldType: FieldType =
          input.field_type && VALID_FIELD_TYPES.has(input.field_type)
            ? input.field_type
            : 'text';
        const checkboxStyle: CheckboxStyle =
          input.checkbox_style && VALID_CHECKBOX_STYLES.has(input.checkbox_style)
            ? input.checkbox_style
            : 'check';
        const alignment: FieldAlignment =
          input.alignment && VALID_ALIGNMENTS.has(input.alignment) ? input.alignment : 'left';
        const coverDashes: 0 | 1 = input.cover_dashes === 1 ? 1 : 0;
        const source: FieldSource =
          input.source && VALID_SOURCES.has(input.source) ? input.source : 'auto';
        const label = input.label.trim() || `Campo ${idx + 1}`;

        insertStmt.run(
          id,
          documentId,
          Math.max(1, input.page_number ?? 1),
          label,
          input.value ?? '',
          fieldType,
          input.x ?? 56,
          input.y ?? 72 + idx * 42,
          input.width ?? 220,
          input.height ?? 28,
          input.font_size ?? 10,
          input.group_name?.trim() || 'Datos generales',
          input.sort_order ?? idx,
          checkboxStyle,
          alignment,
          coverDashes,
          input.field_name?.trim() || '',
          input.tooltip?.trim() || label,
          source,
        );
      });

      this.db
        .prepare('UPDATE documents SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), documentId);
    });

    replaceTx();
    return this.listDocumentFields(documentId);
  }

  public upsertDocumentField(input: UpsertFieldInput): DocumentField {
    const id = input.id || crypto.randomUUID();
    const existing = this.db
      .prepare(
        `SELECT id, document_id, page_number, label, value, field_type,
                x, y, width, height, font_size, group_name, sort_order,
                checkbox_style, alignment, cover_dashes, field_name, tooltip, source
         FROM document_fields WHERE id = ?`,
      )
      .get(id) as DocumentField | undefined;

    const countRow = this.db
      .prepare('SELECT COUNT(*) as count FROM document_fields WHERE document_id = ?')
      .get(input.document_id) as { count: number };

    const fieldType: FieldType =
      input.field_type && VALID_FIELD_TYPES.has(input.field_type)
        ? input.field_type
        : existing?.field_type ?? 'text';

    const checkboxStyle: CheckboxStyle =
      input.checkbox_style && VALID_CHECKBOX_STYLES.has(input.checkbox_style)
        ? input.checkbox_style
        : (existing?.checkbox_style as CheckboxStyle) ?? 'check';

    const alignment: FieldAlignment =
      input.alignment && VALID_ALIGNMENTS.has(input.alignment)
        ? input.alignment
        : (existing?.alignment as FieldAlignment) ?? 'left';

    const coverDashes: 0 | 1 =
      input.cover_dashes !== undefined
        ? input.cover_dashes === 1
          ? 1
          : 0
        : existing?.cover_dashes === 1
          ? 1
          : 0;

    const source: FieldSource =
      input.source && VALID_SOURCES.has(input.source)
        ? input.source
        : (existing?.source as FieldSource) ?? 'manual';

    const label = input.label.trim() || existing?.label || 'Campo sin título';

    const field: DocumentField = {
      id,
      document_id: input.document_id,
      page_number: Math.max(1, input.page_number ?? existing?.page_number ?? 1),
      label,
      value: input.value ?? existing?.value ?? '',
      field_type: fieldType,
      x: input.x ?? existing?.x ?? 56,
      y: input.y ?? existing?.y ?? 72 + countRow.count * 52,
      width: input.width ?? existing?.width ?? 240,
      height: input.height ?? existing?.height ?? 24,
      font_size: input.font_size ?? existing?.font_size ?? 10,
      group_name: input.group_name?.trim() || existing?.group_name || 'Datos generales',
      sort_order: input.sort_order ?? existing?.sort_order ?? countRow.count,
      checkbox_style: checkboxStyle,
      alignment,
      cover_dashes: coverDashes,
      field_name: input.field_name ?? existing?.field_name ?? '',
      tooltip: input.tooltip ?? existing?.tooltip ?? label,
      source,
    };

    const upsertTx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO document_fields (
            id, document_id, page_number, label, value, field_type,
            x, y, width, height, font_size, group_name, sort_order,
            checkbox_style, alignment, cover_dashes, field_name, tooltip, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            page_number = excluded.page_number,
            label = excluded.label,
            value = excluded.value,
            field_type = excluded.field_type,
            x = excluded.x,
            y = excluded.y,
            width = excluded.width,
            height = excluded.height,
            font_size = excluded.font_size,
            group_name = excluded.group_name,
            sort_order = excluded.sort_order,
            checkbox_style = excluded.checkbox_style,
            alignment = excluded.alignment,
            cover_dashes = excluded.cover_dashes,
            field_name = excluded.field_name,
            tooltip = excluded.tooltip,
            source = excluded.source`,
        )
        .run(
          field.id,
          field.document_id,
          field.page_number,
          field.label,
          field.value,
          field.field_type,
          field.x,
          field.y,
          field.width,
          field.height,
          field.font_size,
          field.group_name,
          field.sort_order,
          field.checkbox_style,
          field.alignment,
          field.cover_dashes,
          field.field_name,
          field.tooltip,
          field.source,
        );

      this.db
        .prepare('UPDATE documents SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), field.document_id);
    });

    upsertTx();
    return field;
  }

  public updateFieldValue(fieldId: string, value: string): DocumentField | null {
    const existing = this.db
      .prepare(
        `SELECT id, document_id, page_number, label, value, field_type,
                x, y, width, height, font_size, group_name, sort_order,
                checkbox_style, alignment, cover_dashes, field_name, tooltip, source
         FROM document_fields WHERE id = ?`,
      )
      .get(fieldId) as DocumentField | undefined;

    if (!existing) return null;

    const updateTx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE document_fields SET value = ? WHERE id = ?')
        .run(value, fieldId);
      this.db
        .prepare('UPDATE documents SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), existing.document_id);
    });
    updateTx();

    return {
      ...existing,
      value,
    };
  }

  public deleteDocumentField(fieldId: string): boolean {
    const existing = this.db
      .prepare('SELECT document_id FROM document_fields WHERE id = ?')
      .get(fieldId) as { document_id: string } | undefined;

    if (!existing) return false;

    const deleteTx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM document_fields WHERE id = ?').run(fieldId);
      this.db
        .prepare('UPDATE documents SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), existing.document_id);
    });
    deleteTx();

    return true;
  }

  public listVersionHistory(): VersionHistoryRecord[] {
    return this.db
      .prepare(
        `SELECT id, version, installed_at, release_notes, changelog_seen
         FROM version_history
         ORDER BY installed_at DESC, id DESC`,
      )
      .all() as VersionHistoryRecord[];
  }

  public markVersionChangelogSeen(version: string): void {
    this.db
      .prepare('UPDATE version_history SET changelog_seen = 1 WHERE version = ?')
      .run(version);
  }

  public close(): void {
    try {
      this.db.prepare('UPDATE session_state SET pending_restore = 1 WHERE id = 1').run();
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      this.db.close();
    }
  }
}
