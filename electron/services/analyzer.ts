import { XMLParser } from 'fast-xml-parser';
import fs from 'fs';
import JSZip from 'jszip';
import path from 'path';
import type {
  DiagnosisType,
  DocumentAnalysisDetails,
  DocumentAnalysisResult,
  PlainTextContentResult,
  QpdfStatus,
} from '../../shared/types';
import { locateQpdf, runQpdfCommand } from './qpdfLocator';

export const SUPPORTED_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'txt',
  'rtf',
  'md',
  'csv',
  'json',
  'png',
  'jpg',
  'jpeg',
]);

const PLAIN_TEXT_EXTENSIONS = new Set(['txt', 'rtf', 'md', 'csv', 'json']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

// Dynamic ESM loader that survives esbuild CommonJS bundling cleanly on Node 20+
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as <T>(
  specifier: string,
) => Promise<T>;

interface PdfJsModule {
  getDocument: (params: Record<string, unknown>) => {
    promise: Promise<{
      numPages: number;
      getPermissions: () => Promise<number[] | null>;
      getPage: (pageNum: number) => Promise<{
        getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
        getOperatorList: () => Promise<{ fnArray: number[] }>;
        getAnnotations: () => Promise<Array<{ subtype?: string }>>;
      }>;
      destroy?: () => Promise<void>;
    }>;
    destroy: () => Promise<void>;
  };
  OPS: {
    paintImageXObject?: number;
    paintInlineImageXObject?: number;
    paintImageMaskXObject?: number;
    paintImageXObjectRepeat?: number;
  };
  PermissionFlag?: {
    MODIFY_CONTENTS?: number;
    COPY?: number;
    MODIFY_ANNOTATIONS?: number;
    FILL_INTERACTIVE_FORMS?: number;
    ASSEMBLE?: number;
  };
}

let cachedPdfJs: PdfJsModule | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!cachedPdfJs) {
    cachedPdfJs = await nativeDynamicImport<PdfJsModule>('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return cachedPdfJs;
}

interface QpdfEncryptionInfo {
  checked: boolean;
  requiresOpenPassword: boolean;
  isEncrypted: boolean;
  hasPermissionRestrictions: boolean;
  restrictions: string[];
}

function parseQpdfEncryptionOutput(
  exitCode: number,
  stdout: string,
  stderr: string,
): QpdfEncryptionInfo {
  const combined = `${stdout}\n${stderr}`;
  const lower = combined.toLowerCase();

  if (
    exitCode !== 0 &&
    (lower.includes('invalid password') || lower.includes('password is required'))
  ) {
    return {
      checked: true,
      requiresOpenPassword: true,
      isEncrypted: true,
      hasPermissionRestrictions: true,
      restrictions: ['Requiere contraseña de apertura (user password)'],
    };
  }

  if (lower.includes('file is not encrypted')) {
    return {
      checked: true,
      requiresOpenPassword: false,
      isEncrypted: false,
      hasPermissionRestrictions: false,
      restrictions: [],
    };
  }

  if (lower.includes('file is encrypted')) {
    const restrictions: string[] = [];
    const lines = stdout.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const l = line.toLowerCase();
      if (l.startsWith('extract for accessibility:') && l.includes('not allowed')) {
        restrictions.push('Extracción de accesibilidad bloqueada');
      } else if (l.startsWith('extract text:') && l.includes('not allowed')) {
        restrictions.push('Copia de texto bloqueada');
      } else if (l.startsWith('modify assembly:') && l.includes('not allowed')) {
        restrictions.push('Reordenamiento de páginas bloqueado');
      } else if (l.startsWith('modify forms:') && l.includes('not allowed')) {
        restrictions.push('Rellenado de formularios bloqueado');
      } else if (l.startsWith('modify annotations:') && l.includes('not allowed')) {
        restrictions.push('Anotaciones bloqueadas');
      } else if (l.startsWith('modify other:') && l.includes('not allowed')) {
        restrictions.push('Modificación de contenido bloqueada');
      } else if (l.startsWith('modify:') && (l.includes('none') || l.includes('not allowed'))) {
        restrictions.push('Edición de documento bloqueada');
      } else if (l.startsWith('print:') && (l.includes('none') || l.includes('not allowed'))) {
        restrictions.push('Impresión bloqueada');
      }
    }

    // Even if all individual flags are allowed, an encrypted owner-protected PDF still benefits from clean decryption
    if (restrictions.length === 0) {
      restrictions.push('Protegido por permisos de propietario (owner password)');
    }

    return {
      checked: true,
      requiresOpenPassword: false,
      isEncrypted: true,
      hasPermissionRestrictions: true,
      restrictions,
    };
  }

  return {
    checked: false,
    requiresOpenPassword: false,
    isEncrypted: false,
    hasPermissionRestrictions: false,
    restrictions: [],
  };
}

export function decodePlainTextBuffer(buffer: Buffer): PlainTextContentResult {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    const content = buffer.subarray(3).toString('utf8');
    return {
      content,
      encoding: 'UTF-8 (BOM)',
      lineCount: content === '' ? 0 : content.split(/\r?\n/).length,
    };
  }

  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    const content = utf8Decoder.decode(buffer);
    return {
      content,
      encoding: 'UTF-8',
      lineCount: content === '' ? 0 : content.split(/\r?\n/).length,
    };
  } catch {
    const content = buffer.toString('latin1');
    return {
      content,
      encoding: 'Latin-1',
      lineCount: content === '' ? 0 : content.split(/\r?\n/).length,
    };
  }
}

function readImageDimensions(buffer: Buffer, ext: string): { width?: number; height?: number } {
  try {
    if (ext === 'png' && buffer.length >= 24) {
      // PNG signature + IHDR chunk
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return {
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20),
        };
      }
    }

    if ((ext === 'jpg' || ext === 'jpeg') && buffer.length >= 4) {
      if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
          if (buffer[offset] !== 0xff) {
            offset += 1;
            continue;
          }
          const marker = buffer[offset + 1];
          // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
          const isSof =
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf);
          if (isSof) {
            return {
              height: buffer.readUInt16BE(offset + 5),
              width: buffer.readUInt16BE(offset + 7),
            };
          }
          if (marker === 0xd9 || marker === 0xda) break;
          const segmentLength = buffer.readUInt16BE(offset + 2);
          if (segmentLength < 2) break;
          offset += 2 + segmentLength;
        }
      }
    }
  } catch {
    // Non-fatal metadata parsing
  }
  return {};
}

async function analyzePdf(
  filePath: string,
  fileSizeBytes: number,
  qpdfStatus: QpdfStatus,
): Promise<DocumentAnalysisResult> {
  const analyzedAt = new Date().toISOString();
  let qpdfInfo: QpdfEncryptionInfo = {
    checked: false,
    requiresOpenPassword: false,
    isEncrypted: false,
    hasPermissionRestrictions: false,
    restrictions: [],
  };

  if (qpdfStatus.available && qpdfStatus.executablePath) {
    try {
      const res = await runQpdfCommand(qpdfStatus.executablePath, [
        '--show-encryption',
        filePath,
      ]);
      qpdfInfo = parseQpdfEncryptionOutput(res.exitCode, res.stdout, res.stderr);
    } catch {
      // Fallback to pdfjs-dist inspection below
    }
  }

  if (qpdfInfo.requiresOpenPassword) {
    return {
      diagnosis_type: 'PDF_ENCRYPTED_OPEN',
      title: 'PDF cifrado con clave de apertura',
      summary:
        'Este archivo exige una contraseña para abrirse. Ingresa la clave para generar una copia permanentemente liberada en tu espacio de trabajo.',
      recommended_action: 'unlock_password',
      recommended_action_label: 'Ingresar contraseña y liberar',
      analyzed_at: analyzedAt,
      details: {
        fileSizeBytes,
        isEncrypted: true,
        restrictions: qpdfInfo.restrictions,
        qpdfAvailable: qpdfStatus.available,
        qpdfVersion: qpdfStatus.version,
      },
    };
  }

  // Inspect PDF structure, text density, embedded images, and AcroForm fields with pdfjs-dist
  let pageCount = 0;
  let analyzedPages = 0;
  let totalUsefulChars = 0;
  let pagesWithImages = 0;
  let acroFormFieldCount = 0;
  let pdfJsRestricted = false;
  const pdfJsRestrictions: string[] = [];

  try {
    const pdfjs = await loadPdfJs();
    const rawBuffer = fs.readFileSync(filePath);
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(rawBuffer),
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    });

    const pdfDoc = await loadingTask.promise;
    try {
      pageCount = pdfDoc.numPages;

      const permissions = await pdfDoc.getPermissions();
      if (permissions && Array.isArray(permissions)) {
        const permSet = new Set(permissions);
        const flag = pdfjs.PermissionFlag;
        const modifyFlag = flag?.MODIFY_CONTENTS ?? 8;
        const copyFlag = flag?.COPY ?? 16;
        const formsFlag = flag?.FILL_INTERACTIVE_FORMS ?? 256;
        const annotFlag = flag?.MODIFY_ANNOTATIONS ?? 32;

        if (!permSet.has(modifyFlag)) {
          pdfJsRestricted = true;
          pdfJsRestrictions.push('Modificación de contenido bloqueada');
        }
        if (!permSet.has(copyFlag)) {
          pdfJsRestricted = true;
          pdfJsRestrictions.push('Copia de texto bloqueada');
        }
        if (!permSet.has(formsFlag)) {
          pdfJsRestricted = true;
          pdfJsRestrictions.push('Rellenado de formularios bloqueado');
        }
        if (!permSet.has(annotFlag)) {
          pdfJsRestricted = true;
          pdfJsRestrictions.push('Anotaciones bloqueadas');
        }
      }

      const imageOps = new Set(
        [
          pdfjs.OPS.paintImageXObject,
          pdfjs.OPS.paintInlineImageXObject,
          pdfjs.OPS.paintImageMaskXObject,
          pdfjs.OPS.paintImageXObjectRepeat,
        ].filter((op): op is number => typeof op === 'number'),
      );

      const maxPagesToInspect = Math.min(pageCount, 12);
      for (let p = 1; p <= maxPagesToInspect; p++) {
        const page = await pdfDoc.getPage(p);
        analyzedPages += 1;

        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item) => (typeof item.str === 'string' ? item.str : ''))
          .join('')
          .replace(/\s+/g, '');
        totalUsefulChars += pageText.length;

        const opList = await page.getOperatorList();
        const hasImageOnPage = opList.fnArray.some((fn) => imageOps.has(fn));
        if (hasImageOnPage) {
          pagesWithImages += 1;
        }

        const annotations = await page.getAnnotations();
        for (const ann of annotations) {
          if (ann?.subtype === 'Widget') {
            acroFormFieldCount += 1;
          }
        }
      }
    } finally {
      await loadingTask.destroy();
    }
  } catch (err: unknown) {
    const errorObj = err as { name?: string; code?: number; message?: string };
    if (
      errorObj?.name === 'PasswordException' ||
      errorObj?.code === 1 ||
      (typeof errorObj?.message === 'string' &&
        errorObj.message.toLowerCase().includes('no password given'))
    ) {
      return {
        diagnosis_type: 'PDF_ENCRYPTED_OPEN',
        title: 'PDF cifrado con clave de apertura',
        summary:
          'Este archivo está cifrado con contraseña de usuario. Ingresa la clave para desbloquearlo y guardar una copia editable.',
        recommended_action: 'unlock_password',
        recommended_action_label: 'Ingresar contraseña y liberar',
        analyzed_at: analyzedAt,
        details: {
          fileSizeBytes,
          isEncrypted: true,
          restrictions: ['Requiere contraseña de apertura (user password)'],
          qpdfAvailable: qpdfStatus.available,
          qpdfVersion: qpdfStatus.version,
        },
      };
    }
  }

  const avgCharsPerPage =
    analyzedPages > 0 ? Math.round((totalUsefulChars / analyzedPages) * 10) / 10 : 0;
  const hasEmbeddedImages = pagesWithImages > 0;
  const combinedRestrictions =
    qpdfInfo.restrictions.length > 0 ? qpdfInfo.restrictions : pdfJsRestrictions;

  const details: DocumentAnalysisDetails = {
    fileSizeBytes,
    pageCount,
    analyzedPages,
    avgCharsPerPage,
    totalUsefulChars,
    hasEmbeddedImages,
    pagesWithImages,
    acroFormFieldCount,
    isEncrypted: qpdfInfo.isEncrypted || pdfJsRestricted,
    restrictions: combinedRestrictions,
    qpdfAvailable: qpdfStatus.available,
    qpdfVersion: qpdfStatus.version,
  };

  if (qpdfInfo.hasPermissionRestrictions || pdfJsRestricted) {
    return {
      diagnosis_type: 'PDF_LOCKED_PERMISSIONS',
      title: 'PDF con bloqueo de permisos de edición',
      summary:
        'Se detectaron restricciones de propietario (owner password) que impiden editar o copiar el documento. Puedes liberarlo localmente sin necesidad de contraseña.',
      recommended_action: 'unlock_permissions',
      recommended_action_label: 'Liberar documento',
      analyzed_at: analyzedAt,
      details,
    };
  }

  // SPEC rule: density < 20 useful characters per page with embedded images => scanned/photo PDF
  if (analyzedPages > 0 && avgCharsPerPage < 20 && (hasEmbeddedImages || totalUsefulChars === 0)) {
    return {
      diagnosis_type: 'PDF_SCANNED_IMAGE',
      title: 'Documento escaneado (foto convertida a PDF)',
      summary: `Densidad de texto seleccionable casi nula (${avgCharsPerPage} caracteres útiles/página) con imágenes embebidas en ${pagesWithImages} de ${analyzedPages} páginas analizadas. Requiere OCR local para volverlo editable.`,
      recommended_action: 'run_ocr',
      recommended_action_label: 'Listo para OCR local (Paso 3)',
      analyzed_at: analyzedAt,
      details,
    };
  }

  return {
    diagnosis_type: 'PDF_NATIVE_EDITABLE',
    title: 'PDF nativo sin bloqueos',
    summary:
      acroFormFieldCount > 0
        ? `PDF libre de restricciones con capa de texto (${avgCharsPerPage} caracteres/página) y ${acroFormFieldCount} campos de formulario detectados.`
        : `PDF libre de restricciones con capa de texto seleccionable (${avgCharsPerPage} caracteres/página). Listo para trabajar en el editor.`,
    recommended_action: 'open_editor',
    recommended_action_label: 'Abrir en Editor',
    analyzed_at: analyzedAt,
    details,
  };
}

export function detectDocxProtectionsFromXml(settingsXml: string): string[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });
  const parsed = parser.parse(settingsXml) as Record<string, unknown>;
  const settings = (parsed?.['w:settings'] ?? parsed?.settings) as
    | Record<string, unknown>
    | undefined;

  if (!settings || typeof settings !== 'object') {
    return [];
  }

  const protections: string[] = [];

  if ('w:documentProtection' in settings && settings['w:documentProtection'] !== undefined) {
    const node = settings['w:documentProtection'] as Record<string, unknown> | string;
    const editMode =
      typeof node === 'object' && node !== null ? String(node['@_w:edit'] ?? '') : '';
    const enforcement =
      typeof node === 'object' && node !== null ? String(node['@_w:enforcement'] ?? '') : '';
    const detail = [
      editMode ? `modo: ${editMode}` : '',
      enforcement === '1' || enforcement === 'true' ? 'activo' : '',
    ]
      .filter(Boolean)
      .join(', ');
    protections.push(
      detail ? `w:documentProtection (${detail})` : 'w:documentProtection',
    );
  }

  if ('w:writeProtection' in settings && settings['w:writeProtection'] !== undefined) {
    protections.push('w:writeProtection (solo lectura recomendada / protegida)');
  }

  return protections;
}

async function analyzeDocx(
  filePath: string,
  fileSizeBytes: number,
): Promise<DocumentAnalysisResult> {
  const analyzedAt = new Date().toISOString();
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const settingsFile = zip.file('word/settings.xml');

  let protections: string[] = [];
  if (settingsFile) {
    const settingsXml = await settingsFile.async('string');
    protections = detectDocxProtectionsFromXml(settingsXml);
  }

  if (protections.length > 0) {
    return {
      diagnosis_type: 'DOCX_LOCKED',
      title: 'Documento Word (.docx) con protección de edición',
      summary: `Se detectó restricción de edición en word/settings.xml (${protections.join(' y ')}). Puedes eliminar el bloqueo conservando estilos, tablas e imágenes intactos.`,
      recommended_action: 'unlock_docx',
      recommended_action_label: 'Desbloquear Word (.docx)',
      analyzed_at: analyzedAt,
      details: {
        fileSizeBytes,
        docxProtections: protections,
      },
    };
  }

  return {
    diagnosis_type: 'DOCX_EDITABLE',
    title: 'Documento Word (.docx) sin bloqueos',
    summary:
      'El archivo Word no presenta nodos de protección de edición en word/settings.xml y está listo para edición.',
    recommended_action: 'open_editor',
    recommended_action_label: 'Abrir en Editor',
    analyzed_at: analyzedAt,
    details: {
      fileSizeBytes,
      docxProtections: [],
    },
  };
}

function analyzePlainText(filePath: string, fileSizeBytes: number): DocumentAnalysisResult {
  const analyzedAt = new Date().toISOString();
  const buffer = fs.readFileSync(filePath);
  const decoded = decodePlainTextBuffer(buffer);
  const preview = decoded.content.slice(0, 400);

  return {
    diagnosis_type: 'PLAIN_TEXT',
    title: 'Archivo de texto plano',
    summary: `Codificación detectada: ${decoded.encoding} (${decoded.lineCount} líneas, ${decoded.content.length} caracteres). Apertura directa sin restricciones.`,
    recommended_action: 'open_editor',
    recommended_action_label: 'Abrir en Editor',
    analyzed_at: analyzedAt,
    details: {
      fileSizeBytes,
      encoding: decoded.encoding,
      lineCount: decoded.lineCount,
      charCount: decoded.content.length,
      textPreview: preview,
    },
  };
}

function analyzeImage(
  filePath: string,
  fileSizeBytes: number,
  ext: string,
): DocumentAnalysisResult {
  const analyzedAt = new Date().toISOString();
  const buffer = fs.readFileSync(filePath);
  const dims = readImageDimensions(buffer, ext);
  const dimText =
    dims.width && dims.height ? `${dims.width} × ${dims.height} px` : 'resolución estándar';

  return {
    diagnosis_type: 'IMAGE_DOCUMENT',
    title: 'Imagen de documento',
    summary: `Imagen .${ext} (${dimText}) lista para convertirse a PDF editable mediante extracción OCR local en el siguiente paso.`,
    recommended_action: 'run_ocr',
    recommended_action_label: 'Listo para OCR local (Paso 3)',
    analyzed_at: analyzedAt,
    details: {
      fileSizeBytes,
      imageWidth: dims.width,
      imageHeight: dims.height,
    },
  };
}

export async function analyzeDocumentFile(filePath: string): Promise<DocumentAnalysisResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`El archivo no existe en la ruta especificada: ${filePath}`);
  }

  const stats = fs.statSync(filePath);
  const ext = path.extname(filePath).replace('.', '').toLowerCase();

  if (ext === 'pdf') {
    const qpdfStatus = await locateQpdf();
    return analyzePdf(filePath, stats.size, qpdfStatus);
  }

  if (ext === 'docx') {
    return analyzeDocx(filePath, stats.size);
  }

  if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
    return analyzePlainText(filePath, stats.size);
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return analyzeImage(filePath, stats.size, ext);
  }

  return {
    diagnosis_type: 'PENDING_ANALYSIS' as DiagnosisType,
    title: 'Formato no clasificado',
    summary: `La extensión .${ext || 'desconocida'} no corresponde a un formato soportado por el motor de diagnóstico.`,
    recommended_action: 'none',
    recommended_action_label: 'Formato no soportado',
    analyzed_at: new Date().toISOString(),
    details: {
      fileSizeBytes: stats.size,
    },
  };
}
