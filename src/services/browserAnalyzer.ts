import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import type {
  DocumentAnalysisDetails,
  DocumentAnalysisResult,
  PlainTextContentResult,
} from '../../shared/types';

const PLAIN_TEXT_EXTS = new Set(['txt', 'rtf', 'md', 'csv', 'json']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg']);

export function decodeTextArrayBuffer(buffer: ArrayBuffer): PlainTextContentResult {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const content = new TextDecoder('utf-8').decode(bytes.subarray(3));
    return {
      content,
      encoding: 'UTF-8 (BOM)',
      lineCount: content === '' ? 0 : content.split(/\r?\n/).length,
    };
  }
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return {
      content,
      encoding: 'UTF-8',
      lineCount: content === '' ? 0 : content.split(/\r?\n/).length,
    };
  } catch {
    const content = new TextDecoder('iso-8859-1').decode(bytes);
    return {
      content,
      encoding: 'Latin-1',
      lineCount: content === '' ? 0 : content.split(/\r?\n/).length,
    };
  }
}

export function detectBrowserDocxProtections(settingsXml: string): string[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });
  const parsed = parser.parse(settingsXml) as Record<string, unknown>;
  const settings = (parsed?.['w:settings'] ?? parsed?.settings) as
    | Record<string, unknown>
    | undefined;
  if (!settings || typeof settings !== 'object') return [];

  const protections: string[] = [];
  if ('w:documentProtection' in settings && settings['w:documentProtection'] !== undefined) {
    protections.push('w:documentProtection');
  }
  if ('w:writeProtection' in settings && settings['w:writeProtection'] !== undefined) {
    protections.push('w:writeProtection');
  }
  return protections;
}

export function stripBrowserDocxProtections(settingsXml: string): string {
  return settingsXml
    .replace(/<w:documentProtection\b[^>]*\/>/gi, '')
    .replace(/<w:documentProtection\b[^>]*>[\s\S]*?<\/w:documentProtection>/gi, '')
    .replace(/<w:writeProtection\b[^>]*\/>/gi, '')
    .replace(/<w:writeProtection\b[^>]*>[\s\S]*?<\/w:writeProtection>/gi, '');
}

function readImageSizeFromBytes(bytes: Uint8Array, ext: string): { width?: number; height?: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (ext === 'png' && bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
      return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
    }
    if ((ext === 'jpg' || ext === 'jpeg') && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        const isSof =
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf);
        if (isSof) {
          return {
            height: view.getUint16(offset + 5, false),
            width: view.getUint16(offset + 7, false),
          };
        }
        if (marker === 0xd9 || marker === 0xda) break;
        const len = view.getUint16(offset + 2, false);
        if (len < 2) break;
        offset += 2 + len;
      }
    }
  } catch {
    // Ignore non-fatal dimension parsing errors
  }
  return {};
}

async function analyzeBrowserPdf(buffer: ArrayBuffer): Promise<DocumentAnalysisResult> {
  const analyzedAt = new Date().toISOString();
  const pdfjs = await import('pdfjs-dist');
  // Disable worker inside preview analysis fallback to avoid external worker URL issues
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
  }

  try {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer.slice(0)),
      useSystemFonts: true,
      verbosity: 0,
    });
    const pdfDoc = await loadingTask.promise;
    try {
      const pageCount = pdfDoc.numPages;
      const permissions = await pdfDoc.getPermissions();
      const restrictions: string[] = [];
      let restricted = false;

      if (permissions && Array.isArray(permissions)) {
        const set = new Set(permissions);
        if (!set.has(pdfjs.PermissionFlag.MODIFY_CONTENTS)) {
          restricted = true;
          restrictions.push('Modificación de contenido bloqueada');
        }
        if (!set.has(pdfjs.PermissionFlag.COPY)) {
          restricted = true;
          restrictions.push('Copia de texto bloqueada');
        }
        if (!set.has(pdfjs.PermissionFlag.FILL_INTERACTIVE_FORMS)) {
          restricted = true;
          restrictions.push('Rellenado de formularios bloqueado');
        }
      }

      const imageOps = new Set<number>([
        pdfjs.OPS.paintImageXObject,
        pdfjs.OPS.paintInlineImageXObject,
        pdfjs.OPS.paintImageMaskXObject,
      ]);

      const maxPages = Math.min(pageCount, 12);
      let totalUsefulChars = 0;
      let pagesWithImages = 0;
      let acroFormFieldCount = 0;

      for (let p = 1; p <= maxPages; p++) {
        const page = await pdfDoc.getPage(p);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item) => ('str' in item ? item.str : ''))
          .join('')
          .replace(/\s+/g, '');
        totalUsefulChars += pageText.length;

        const opList = await page.getOperatorList();
        if (opList.fnArray.some((fn) => imageOps.has(fn))) {
          pagesWithImages += 1;
        }

        const annotations = await page.getAnnotations();
        for (const ann of annotations) {
          if (ann?.subtype === 'Widget') {
            acroFormFieldCount += 1;
          }
        }
      }

      const avgCharsPerPage =
        maxPages > 0 ? Math.round((totalUsefulChars / maxPages) * 10) / 10 : 0;

      const details: DocumentAnalysisDetails = {
        fileSizeBytes: buffer.byteLength,
        pageCount,
        analyzedPages: maxPages,
        avgCharsPerPage,
        totalUsefulChars,
        hasEmbeddedImages: pagesWithImages > 0,
        pagesWithImages,
        acroFormFieldCount,
        isEncrypted: restricted,
        restrictions,
        qpdfAvailable: false,
        qpdfVersion: null,
      };

      if (restricted) {
        return {
          diagnosis_type: 'PDF_LOCKED_PERMISSIONS',
          title: 'PDF con bloqueo de permisos de edición',
          summary:
            'Se detectaron restricciones de permisos. Ejecuta LibreDoc Studio en Electron (Windows) con qpdf para liberar este PDF localmente.',
          recommended_action: 'unlock_permissions',
          recommended_action_label: 'Liberar documento',
          analyzed_at: analyzedAt,
          details,
        };
      }

      if (maxPages > 0 && avgCharsPerPage < 20 && (pagesWithImages > 0 || totalUsefulChars === 0)) {
        return {
          diagnosis_type: 'PDF_SCANNED_IMAGE',
          title: 'Documento escaneado (foto convertida a PDF)',
          summary: `Densidad de texto seleccionable casi nula (${avgCharsPerPage} caracteres/página) con imágenes embebidas en ${pagesWithImages} páginas. Listo para OCR local en el Paso 3.`,
          recommended_action: 'run_ocr',
          recommended_action_label: 'Listo para OCR local (Paso 3)',
          analyzed_at: analyzedAt,
          details,
        };
      }

      return {
        diagnosis_type: 'PDF_NATIVE_EDITABLE',
        title: 'PDF nativo sin bloqueos',
        summary: `PDF libre de restricciones con capa de texto seleccionable (${avgCharsPerPage} caracteres/página).`,
        recommended_action: 'open_editor',
        recommended_action_label: 'Abrir en Editor',
        analyzed_at: analyzedAt,
        details,
      };
    } finally {
      await loadingTask.destroy();
    }
  } catch (err: unknown) {
    const errorObj = err as { name?: string; code?: number };
    if (errorObj?.name === 'PasswordException' || errorObj?.code === 1) {
      return {
        diagnosis_type: 'PDF_ENCRYPTED_OPEN',
        title: 'PDF cifrado con clave de apertura',
        summary:
          'Este PDF exige contraseña para abrirse. Ingresa la clave en la app de escritorio (Electron + qpdf) para generar una copia liberada.',
        recommended_action: 'unlock_password',
        recommended_action_label: 'Ingresar contraseña y liberar',
        analyzed_at: analyzedAt,
        details: {
          fileSizeBytes: buffer.byteLength,
          isEncrypted: true,
          restrictions: ['Requiere contraseña de apertura (user password)'],
          qpdfAvailable: false,
          qpdfVersion: null,
        },
      };
    }
    throw err;
  }
}

export async function analyzeBrowserFile(file: File): Promise<{
  analysis: DocumentAnalysisResult;
  buffer: ArrayBuffer;
}> {
  const buffer = await file.arrayBuffer();
  const ext = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() ?? '' : '';
  const analyzedAt = new Date().toISOString();

  if (ext === 'pdf') {
    const analysis = await analyzeBrowserPdf(buffer);
    return { analysis, buffer };
  }

  if (ext === 'docx') {
    const zip = await JSZip.loadAsync(buffer);
    const settingsFile = zip.file('word/settings.xml');
    let protections: string[] = [];
    if (settingsFile) {
      const xml = await settingsFile.async('string');
      protections = detectBrowserDocxProtections(xml);
    }

    const analysis: DocumentAnalysisResult =
      protections.length > 0
        ? {
            diagnosis_type: 'DOCX_LOCKED',
            title: 'Documento Word (.docx) con protección de edición',
            summary: `Se detectó restricción en word/settings.xml (${protections.join(' y ')}). Puedes eliminar el bloqueo conservando el diseño intacto.`,
            recommended_action: 'unlock_docx',
            recommended_action_label: 'Desbloquear Word (.docx)',
            analyzed_at: analyzedAt,
            details: {
              fileSizeBytes: buffer.byteLength,
              docxProtections: protections,
            },
          }
        : {
            diagnosis_type: 'DOCX_EDITABLE',
            title: 'Documento Word (.docx) sin bloqueos',
            summary: 'El archivo Word no presenta protección de edición en word/settings.xml.',
            recommended_action: 'open_editor',
            recommended_action_label: 'Abrir en Editor',
            analyzed_at: analyzedAt,
            details: {
              fileSizeBytes: buffer.byteLength,
              docxProtections: [],
            },
          };
    return { analysis, buffer };
  }

  if (PLAIN_TEXT_EXTS.has(ext)) {
    const decoded = decodeTextArrayBuffer(buffer);
    return {
      buffer,
      analysis: {
        diagnosis_type: 'PLAIN_TEXT',
        title: 'Archivo de texto plano',
        summary: `Codificación detectada: ${decoded.encoding} (${decoded.lineCount} líneas).`,
        recommended_action: 'open_editor',
        recommended_action_label: 'Abrir en Editor',
        analyzed_at: analyzedAt,
        details: {
          fileSizeBytes: buffer.byteLength,
          encoding: decoded.encoding,
          lineCount: decoded.lineCount,
          charCount: decoded.content.length,
          textPreview: decoded.content.slice(0, 400),
        },
      },
    };
  }

  if (IMAGE_EXTS.has(ext)) {
    const dims = readImageSizeFromBytes(new Uint8Array(buffer), ext);
    const dimText =
      dims.width && dims.height ? `${dims.width} × ${dims.height} px` : 'resolución estándar';
    return {
      buffer,
      analysis: {
        diagnosis_type: 'IMAGE_DOCUMENT',
        title: 'Imagen de documento',
        summary: `Imagen .${ext} (${dimText}) lista para flujo OCR local en el Paso 3.`,
        recommended_action: 'run_ocr',
        recommended_action_label: 'Listo para OCR local (Paso 3)',
        analyzed_at: analyzedAt,
        details: {
          fileSizeBytes: buffer.byteLength,
          imageWidth: dims.width,
          imageHeight: dims.height,
        },
      },
    };
  }

  return {
    buffer,
    analysis: {
      diagnosis_type: 'PENDING_ANALYSIS',
      title: 'Formato no clasificado',
      summary: `La extensión .${ext || 'desconocida'} no corresponde a un formato soportado.`,
      recommended_action: 'none',
      recommended_action_label: 'Formato no soportado',
      analyzed_at: analyzedAt,
      details: {
        fileSizeBytes: buffer.byteLength,
      },
    },
  };
}
