import fs from 'fs';
import JSZip from 'jszip';
import path from 'path';
import type { DocumentRecord, UnlockResult } from '../../shared/types';
import { analyzeDocumentFile, detectDocxProtectionsFromXml } from './analyzer';
import { locateQpdf, runQpdfCommand } from './qpdfLocator';

function buildUnlockedOutputPath(workingPath: string, suffix = 'unlocked'): string {
  const dir = path.dirname(workingPath);
  const ext = path.extname(workingPath);
  const base = path.basename(workingPath, ext).replace(/_unlocked(_\d+)?$/i, '');
  const timestamp = Date.now();
  return path.join(dir, `${base}_${suffix}_${timestamp}${ext}`);
}

export function stripDocxProtectionXml(settingsXml: string): string {
  // Remove self-closing and paired w:documentProtection and w:writeProtection tags
  // without touching any other XML declarations, namespaces, or layout settings.
  return settingsXml
    .replace(/<w:documentProtection\b[^>]*\/>/gi, '')
    .replace(/<w:documentProtection\b[^>]*>[\s\S]*?<\/w:documentProtection>/gi, '')
    .replace(/<w:writeProtection\b[^>]*\/>/gi, '')
    .replace(/<w:writeProtection\b[^>]*>[\s\S]*?<\/w:writeProtection>/gi, '');
}

async function verifyPdfDecrypted(qpdfPath: string, pdfPath: string): Promise<boolean> {
  const check = await runQpdfCommand(qpdfPath, ['--show-encryption', pdfPath]);
  return check.stdout.toLowerCase().includes('file is not encrypted');
}

export async function unlockPdfPermissions(doc: DocumentRecord): Promise<UnlockResult> {
  const qpdf = await locateQpdf();
  if (!qpdf.available || !qpdf.executablePath) {
    return {
      success: false,
      qpdfMissing: true,
      message: 'No se encontró el binario de qpdf para Windows.',
      error: `Ejecuta "npm run setup:qpdf" o coloca qpdf.exe y sus DLLs en ${qpdf.expectedPath}`,
    };
  }

  if (!fs.existsSync(doc.working_path)) {
    return {
      success: false,
      message: 'Archivo de trabajo no encontrado.',
      error: `No se encontró la copia local en ${doc.working_path}`,
    };
  }

  const outputPath = buildUnlockedOutputPath(doc.working_path);
  const result = await runQpdfCommand(qpdf.executablePath, [
    '--decrypt',
    doc.working_path,
    outputPath,
  ]);

  // qpdf exit code 0 = ok, 3 = succeeded with non-fatal PDF structure warnings
  const succeeded = (result.exitCode === 0 || result.exitCode === 3) && fs.existsSync(outputPath);

  if (!succeeded) {
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    if (combined.toLowerCase().includes('invalid password')) {
      return {
        success: false,
        invalidPassword: true,
        message: 'Este PDF exige contraseña de apertura.',
        error: 'El documento requiere clave de usuario para descifrarse.',
      };
    }
    return {
      success: false,
      message: 'qpdf no pudo liberar el documento.',
      error: combined || `qpdf finalizó con código ${result.exitCode}`,
    };
  }

  const cleanVerified = await verifyPdfDecrypted(qpdf.executablePath, outputPath);
  if (!cleanVerified) {
    return {
      success: false,
      message: 'La verificación posterior indicó que el PDF aún conserva cifrado.',
      error: 'El archivo resultante no superó la comprobación --show-encryption.',
    };
  }

  const postAnalysis = await analyzeDocumentFile(outputPath);
  const message =
    postAnalysis.diagnosis_type === 'PDF_SCANNED_IMAGE'
      ? 'Restricciones eliminadas con qpdf. Además se detectó que el PDF es una imagen escaneada, lista para OCR en el Paso 3.'
      : 'PDF liberado permanentemente con qpdf (--decrypt). Todas las restricciones de edición y copia fueron eliminadas.';

  return {
    success: true,
    unlockedPath: outputPath,
    analysis: postAnalysis,
    message,
  };
}

export async function unlockPdfWithPassword(
  doc: DocumentRecord,
  password: string,
): Promise<UnlockResult> {
  if (!password) {
    return {
      success: false,
      invalidPassword: true,
      message: 'Ingresa una contraseña para desbloquear el PDF.',
      error: 'La contraseña no puede estar vacía.',
    };
  }

  const qpdf = await locateQpdf();
  if (!qpdf.available || !qpdf.executablePath) {
    return {
      success: false,
      qpdfMissing: true,
      message: 'No se encontró el binario de qpdf para Windows.',
      error: `Ejecuta "npm run setup:qpdf" o coloca qpdf.exe y sus DLLs en ${qpdf.expectedPath}`,
    };
  }

  if (!fs.existsSync(doc.working_path)) {
    return {
      success: false,
      message: 'Archivo de trabajo no encontrado.',
      error: `No se encontró la copia local en ${doc.working_path}`,
    };
  }

  const outputPath = buildUnlockedOutputPath(doc.working_path);
  const result = await runQpdfCommand(qpdf.executablePath, [
    `--password=${password}`,
    '--decrypt',
    doc.working_path,
    outputPath,
  ]);

  const combined = `${result.stdout}\n${result.stderr}`.trim();
  const succeeded = (result.exitCode === 0 || result.exitCode === 3) && fs.existsSync(outputPath);

  if (!succeeded) {
    if (fs.existsSync(outputPath)) {
      fs.rmSync(outputPath, { force: true });
    }
    if (combined.toLowerCase().includes('invalid password')) {
      return {
        success: false,
        invalidPassword: true,
        message: 'Contraseña incorrecta.',
        error: 'La clave ingresada no coincide con la contraseña del PDF. Inténtalo nuevamente.',
      };
    }
    return {
      success: false,
      message: 'No se pudo descifrar el PDF.',
      error: combined || `qpdf finalizó con código ${result.exitCode}`,
    };
  }

  const cleanVerified = await verifyPdfDecrypted(qpdf.executablePath, outputPath);
  if (!cleanVerified) {
    return {
      success: false,
      message: 'No se pudo confirmar que el PDF quedó completamente sin contraseña.',
      error: 'La verificación posterior de cifrado falló.',
    };
  }

  const postAnalysis = await analyzeDocumentFile(outputPath);
  const message =
    postAnalysis.diagnosis_type === 'PDF_SCANNED_IMAGE'
      ? 'Contraseña validada y cifrado eliminado permanentemente. El contenido es un documento escaneado listo para OCR (Paso 3).'
      : 'Contraseña validada. Se generó una copia permanentemente liberada y sin clave en tu workspace.';

  return {
    success: true,
    unlockedPath: outputPath,
    analysis: postAnalysis,
    message,
  };
}

export async function unlockDocxDocument(doc: DocumentRecord): Promise<UnlockResult> {
  if (!fs.existsSync(doc.working_path)) {
    return {
      success: false,
      message: 'Archivo Word de trabajo no encontrado.',
      error: `No se encontró la copia local en ${doc.working_path}`,
    };
  }

  const buffer = fs.readFileSync(doc.working_path);
  const zip = await JSZip.loadAsync(buffer);
  const settingsEntry = zip.file('word/settings.xml');

  if (!settingsEntry) {
    return {
      success: false,
      message: 'El documento .docx no contiene word/settings.xml.',
      error: 'No se encontraron nodos de protección que eliminar.',
    };
  }

  const originalXml = await settingsEntry.async('string');
  const existingProtections = detectDocxProtectionsFromXml(originalXml);

  if (existingProtections.length === 0) {
    const analysis = await analyzeDocumentFile(doc.working_path);
    return {
      success: true,
      unlockedPath: doc.working_path,
      analysis,
      message: 'El documento Word ya se encontraba libre de bloqueos de edición.',
    };
  }

  const cleanedXml = stripDocxProtectionXml(originalXml);
  const remainingProtections = detectDocxProtectionsFromXml(cleanedXml);

  if (remainingProtections.length > 0) {
    return {
      success: false,
      message: 'No se pudieron eliminar todos los nodos de protección XML.',
      error: `Restantes: ${remainingProtections.join(', ')}`,
    };
  }

  zip.file('word/settings.xml', cleanedXml);

  const outputPath = buildUnlockedOutputPath(doc.working_path);
  const outputBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  fs.writeFileSync(outputPath, outputBuffer);

  const postAnalysis = await analyzeDocumentFile(outputPath);

  return {
    success: true,
    unlockedPath: outputPath,
    analysis: postAnalysis,
    message:
      'Documento Word (.docx) desbloqueado: se eliminaron los nodos de protección en word/settings.xml conservando intactos estilos, tablas e imágenes.',
  };
}

export async function unlockDocumentByDiagnosis(
  doc: DocumentRecord,
  password?: string,
): Promise<UnlockResult> {
  if (doc.diagnosis_type === 'PDF_LOCKED_PERMISSIONS') {
    return unlockPdfPermissions(doc);
  }
  if (doc.diagnosis_type === 'PDF_ENCRYPTED_OPEN') {
    return unlockPdfWithPassword(doc, password ?? '');
  }
  if (doc.diagnosis_type === 'DOCX_LOCKED') {
    return unlockDocxDocument(doc);
  }

  return {
    success: false,
    message: 'Este documento no requiere desbloqueo.',
    error: `El diagnóstico actual (${doc.diagnosis_type}) no corresponde a un documento bloqueado.`,
  };
}
