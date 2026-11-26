import fs from 'fs';
import path from 'path';
import {
  PDFArray,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFRadioGroup,
  PDFTextField,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import { createWorker, OEM } from 'tesseract.js';
import type {
  DocumentRecord,
  FieldType,
  OcrProgressEvent,
  RenderedPagePayload,
  TessdataStatus,
  UpsertFieldInput,
} from '../../shared/types';

export interface OcrLineBox {
  pageNumber: number;
  text: string;
  confidence: number;
  /** Top-left PDF point coordinates */
  x: number;
  y: number;
  width: number;
  height: number;
  pageWidthPt: number;
  pageHeightPt: number;
}

export interface OcrPipelineOutput {
  editablePdfPath: string;
  fields: UpsertFieldInput[];
  lines: OcrLineBox[];
  pagesProcessed: number;
  avgConfidence: number;
}

const KNOWN_FORM_KEYWORDS = [
  'nombre',
  'apellidos',
  'apellido',
  'rut',
  'run',
  'dni',
  'cédula',
  'cedula',
  'fecha',
  'nacimiento',
  'correo',
  'email',
  'e-mail',
  'teléfono',
  'telefono',
  'celular',
  'dirección',
  'direccion',
  'domicilio',
  'comuna',
  'ciudad',
  'región',
  'region',
  'país',
  'pais',
  'institución',
  'institucion',
  'universidad',
  'colegio',
  'carrera',
  'curso',
  'promedio',
  'beca',
  'postulante',
  'apoderado',
  'firma',
  'observaciones',
  'motivo',
  'cargo',
  'empresa',
  'profesión',
  'profesion',
  'estado civil',
  'nacionalidad',
  'sexo',
  'género',
  'genero',
  'edad',
];

const SECTION_KEYWORDS = [
  'datos personales',
  'antecedentes',
  'información',
  'informacion',
  'sección',
  'seccion',
  'identificación',
  'identificacion',
  'declaración',
  'declaracion',
  'académicos',
  'academicos',
  'socioeconómicos',
  'socioeconomicos',
  'contacto',
  'domicilio',
  'familia',
  'resumen',
  'firma',
];

export function locateTessdata(): TessdataStatus {
  const expectedPath = path.join(process.cwd(), 'resources', 'tessdata');
  const candidates: string[] = [];

  if (typeof process.resourcesPath === 'string') {
    candidates.push(path.join(process.resourcesPath, 'tessdata'));
  }
  candidates.push(expectedPath);

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const hasSpa = fs.existsSync(path.join(dir, 'spa.traineddata'));
    const hasEng = fs.existsSync(path.join(dir, 'eng.traineddata'));
    if (hasSpa && hasEng) {
      return {
        available: true,
        dirPath: dir,
        hasSpa,
        hasEng,
        expectedPath,
      };
    }
  }

  const devHasSpa = fs.existsSync(path.join(expectedPath, 'spa.traineddata'));
  const devHasEng = fs.existsSync(path.join(expectedPath, 'eng.traineddata'));

  return {
    available: false,
    dirPath: null,
    hasSpa: devHasSpa,
    hasEng: devHasEng,
    expectedPath,
  };
}

function sanitizeForWinAnsi(input: string): string {
  // pdf-lib StandardFonts (WinAnsi) supports printable ASCII + Latin-1 supplement (0x20..0xFF)
  return input
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ')
    .trim();
}

function sanitizePdfFieldName(raw: string, fallbackIndex: number): string {
  const cleaned = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 32);
  return cleaned || `campo_${fallbackIndex}`;
}

function inferFieldTypeFromLabel(label: string, availableHeightPt = 24): FieldType {
  const lower = label.toLowerCase();
  if (/fecha|nacimiento|emisi[oó]n|vencimiento|plazo|d[ií]a\/mes/i.test(lower)) {
    return 'date';
  }
  if (
    /observaci[oó]n|comentario|motivo|descripci[oó]n|justificaci[oó]n|fundamento|direcci[oó]n completa|detalle|resumen/i.test(
      lower,
    ) ||
    availableHeightPt >= 46
  ) {
    return 'multiline';
  }
  return 'text';
}

function isLikelySectionHeader(
  line: OcrLineBox,
  medianHeight: number,
  gapAbove: number,
): boolean {
  const text = line.text.trim();
  if (text.length < 3 || text.length > 72) return false;
  if (text.includes(':') || /_{3,}|\.{4,}|\[[\sxX]?\]|☐|□/.test(text)) return false;

  const lower = text.toLowerCase();
  if (/^([ivx]{1,4}\.|[0-9]{1,2}\.)\s+[A-ZÁÉÍÓÚÑ]/i.test(text)) {
    return true;
  }
  if (SECTION_KEYWORDS.some((kw) => lower.includes(kw)) && text.split(/\s+/).length <= 7) {
    return true;
  }

  const lettersOnly = text.replace(/[^a-zA-ZáéíóúñÁÉÍÓÚÑ]/g, '');
  const isAllCaps = lettersOnly.length >= 4 && lettersOnly === lettersOnly.toUpperCase();
  if (isAllCaps && (line.height >= medianHeight * 1.12 || gapAbove >= medianHeight * 1.35)) {
    return true;
  }

  return false;
}

function cleanLabelText(raw: string): string {
  return raw
    .replace(/^[\s•·\-*]+/, '')
    .replace(/[:_\.\-\s]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanBlankValue(raw: string): string {
  const trimmed = raw.trim();
  // Pure underlines, dots, slashes or empty brackets mean an empty fillable blank
  if (/^[_\.\-\/\s\[\]\(\)☐□]+$/.test(trimmed)) {
    return '';
  }
  return trimmed.replace(/_{3,}/g, '').replace(/\.{4,}/g, '').trim();
}

/**
 * Deterministic layout grouping, reading-order sorting (top-to-bottom, left-to-right),
 * and fillable field detection algorithm operating on OCR bounding boxes.
 */
export function extractAndOrderFieldsFromOcrLines(
  documentId: string,
  allLines: OcrLineBox[],
): UpsertFieldInput[] {
  const pagesMap = new Map<number, OcrLineBox[]>();
  for (const line of allLines) {
    const clean = line.text.trim();
    if (!clean) continue;
    const list = pagesMap.get(line.pageNumber) ?? [];
    list.push({ ...line, text: clean });
    pagesMap.set(line.pageNumber, list);
  }

  const pageNumbers = Array.from(pagesMap.keys()).sort((a, b) => a - b);
  const extractedFields: UpsertFieldInput[] = [];
  let globalSortOrder = 0;

  for (const pageNumber of pageNumbers) {
    const pageLines = pagesMap.get(pageNumber) ?? [];
    if (pageLines.length === 0) continue;

    const heights = pageLines.map((l) => Math.max(8, l.height)).sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 12;
    const rowTolerance = Math.max(6, medianHeight * 0.65);

    // 1. Cluster lines into visual rows (top-to-bottom), sorting columns left-to-right inside each row
    const sortedByY = [...pageLines].sort((a, b) => a.y - b.y || a.x - b.x);
    const rows: OcrLineBox[][] = [];

    for (const line of sortedByY) {
      const lastRow = rows[rows.length - 1];
      if (lastRow) {
        const rowAnchorY = lastRow[0].y;
        if (Math.abs(line.y - rowAnchorY) <= rowTolerance) {
          lastRow.push(line);
          continue;
        }
      }
      rows.push([line]);
    }

    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
    }

    let currentGroup = pageNumbers.length > 1 ? `Página ${pageNumber}` : 'Datos generales';
    const pageDetected: UpsertFieldInput[] = [];

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      const prevRow = rIdx > 0 ? rows[rIdx - 1] : null;
      const nextRow = rIdx + 1 < rows.length ? rows[rIdx + 1] : null;
      const rowY = Math.min(...row.map((l) => l.y));
      const rowBottom = Math.max(...row.map((l) => l.y + l.height));
      const prevBottom = prevRow ? Math.max(...prevRow.map((l) => l.y + l.height)) : 0;
      const nextTop = nextRow ? Math.min(...nextRow.map((l) => l.y)) : row[0].pageHeightPt - 36;
      const gapAbove = prevRow ? Math.max(0, rowY - prevBottom) : 0;
      const gapBelow = Math.max(0, nextTop - rowBottom);

      // Single-item section heading check
      if (row.length === 1 && isLikelySectionHeader(row[0], medianHeight, gapAbove)) {
        currentGroup = cleanLabelText(row[0].text) || currentGroup;
        continue;
      }

      for (let cIdx = 0; cIdx < row.length; cIdx++) {
        const item = row[cIdx];
        const nextCol = cIdx + 1 < row.length ? row[cIdx + 1] : null;
        const rightBoundary = nextCol ? nextCol.x - 10 : item.pageWidthPt - 36;
        const text = item.text;

        // Pattern A: Checkbox markers ([ ], [x], ☐, □, ☑, ( ))
        const checkboxRegex = /(\[[\sxX]?\]|\(\s?[xX]?\s?\)|[☐□☑✓])/g;
        const checkboxMatches = Array.from(text.matchAll(checkboxRegex));
        if (checkboxMatches.length > 0) {
          // Split segments if multiple checkboxes live on one line
          const segments = text.split(/(?=\[[\sxX]?\]|\(\s?[xX]?\s?\)|[☐□☑✓])/g);
          const segWidth = Math.max(90, (rightBoundary - item.x) / Math.max(1, segments.length));
          segments.forEach((seg, sIdx) => {
            const trimmedSeg = seg.trim();
            if (!trimmedSeg) return;
            const isChecked = /\[[xX]\]|\([xX]\)|☑|✓/.test(trimmedSeg);
            const label = cleanLabelText(
              trimmedSeg.replace(/\[[\sxX]?\]|\(\s?[xX]?\s?\)|[☐□☑✓]/g, ''),
            );
            if (label.length < 2) return;
            const boxX = Math.max(16, item.x + sIdx * segWidth);
            pageDetected.push({
              document_id: documentId,
              page_number: pageNumber,
              label,
              value: isChecked ? 'true' : 'false',
              field_type: 'checkbox',
              x: Math.round(boxX),
              y: Math.round(item.y),
              width: 18,
              height: 18,
              font_size: 11,
              group_name: currentGroup,
              sort_order: globalSortOrder++,
            });
          });
          continue;
        }

        // Pattern B: Label with colon (e.g. "Nombre: ______", "RUT: 12.345.678-9", "Correo:")
        const colonIndex = text.indexOf(':');
        if (colonIndex >= 2 && colonIndex <= 48) {
          const rawLabel = text.slice(0, colonIndex);
          const rawAfter = text.slice(colonIndex + 1);
          const label = cleanLabelText(rawLabel);

          if (label.length >= 2) {
            const cleanedValue = cleanBlankValue(rawAfter);
            const labelRatio = Math.min(0.85, Math.max(0.2, (colonIndex + 1) / Math.max(text.length, colonIndex + 4)));
            const estimatedLabelWidth =
              cleanedValue === '' && rawAfter.trim().length === 0
                ? item.width
                : item.width * labelRatio;

            const fieldX = Math.min(item.pageWidthPt - 110, item.x + estimatedLabelWidth + 8);
            const fieldWidth = Math.max(95, rightBoundary - fieldX);
            const fieldHeight =
              gapBelow >= medianHeight * 2.2
                ? Math.min(72, Math.max(22, Math.round(item.height + gapBelow * 0.6)))
                : Math.max(20, Math.round(item.height * 1.45));
            const fieldType = inferFieldTypeFromLabel(label, fieldHeight);

            pageDetected.push({
              document_id: documentId,
              page_number: pageNumber,
              label,
              value: cleanedValue,
              field_type: fieldType,
              x: Math.round(fieldX),
              y: Math.round(Math.max(12, item.y - 2)),
              width: Math.round(fieldWidth),
              height: fieldHeight,
              font_size: Math.min(13, Math.max(9, Math.round(medianHeight * 0.85))),
              group_name: currentGroup,
              sort_order: globalSortOrder++,
            });
            continue;
          }
        }

        // Pattern C: Underlined or dotted blanks ("Nombre _________" or standalone "_________" below label)
        const blankMatch = text.match(/^(.*?)\s*([_]{3,}|[\.]{4,}|[-]{4,})(.*)$/);
        if (blankMatch) {
          let label = cleanLabelText(blankMatch[1] || '');
          if (!label && prevRow && prevRow.length > 0) {
            // Find closest label above in previous row
            const closestAbove = prevRow.reduce((best, cand) =>
              Math.abs(cand.x - item.x) < Math.abs(best.x - item.x) ? cand : best,
            );
            label = cleanLabelText(closestAbove.text);
          }
          if (label.length >= 2) {
            const blankStartRatio = blankMatch[1]
              ? Math.min(0.7, blankMatch[1].length / Math.max(1, text.length))
              : 0;
            const fieldX = item.x + item.width * blankStartRatio;
            const fieldWidth = Math.max(110, rightBoundary - fieldX);
            pageDetected.push({
              document_id: documentId,
              page_number: pageNumber,
              label,
              value: '',
              field_type: inferFieldTypeFromLabel(label),
              x: Math.round(fieldX),
              y: Math.round(Math.max(12, item.y - 4)),
              width: Math.round(fieldWidth),
              height: Math.max(20, Math.round(item.height * 1.4)),
              font_size: Math.min(13, Math.max(9, Math.round(medianHeight * 0.85))),
              group_name: currentGroup,
              sort_order: globalSortOrder++,
            });
            continue;
          }
        }

        // Pattern D: Recognized form keyword label without colon, with empty space right or below
        const lowerText = text.toLowerCase();
        const isFormLabelKeyword =
          text.length <= 36 &&
          KNOWN_FORM_KEYWORDS.some((kw) => lowerText === kw || lowerText.startsWith(`${kw} `));

        if (isFormLabelKeyword) {
          const rightSpace = rightBoundary - (item.x + item.width);
          const putBelow = rightSpace < 80 && gapBelow >= medianHeight * 1.1;
          const fieldX = putBelow ? item.x : item.x + item.width + 8;
          const fieldY = putBelow ? item.y + item.height + 4 : Math.max(12, item.y - 2);
          const fieldWidth = Math.max(110, rightBoundary - fieldX);

          pageDetected.push({
            document_id: documentId,
            page_number: pageNumber,
            label: cleanLabelText(text),
            value: '',
            field_type: inferFieldTypeFromLabel(text),
            x: Math.round(fieldX),
            y: Math.round(fieldY),
            width: Math.round(fieldWidth),
            height: Math.max(20, Math.round(item.height * 1.4)),
            font_size: Math.min(13, Math.max(9, Math.round(medianHeight * 0.85))),
            group_name: currentGroup,
            sort_order: globalSortOrder++,
          });
        }
      }
    }

    // Fallback for scanned letters / documents without explicit blank form patterns:
    // Group recognized lines by vertical proximity into clean ordered text blocks.
    if (pageDetected.length === 0 && rows.length > 0) {
      let blockLines: OcrLineBox[] = [];
      let blockIndex = 1;

      const flushBlock = () => {
        if (blockLines.length === 0) return;
        const x0 = Math.min(...blockLines.map((l) => l.x));
        const y0 = Math.min(...blockLines.map((l) => l.y));
        const x1 = Math.max(...blockLines.map((l) => l.x + l.width));
        const y1 = Math.max(...blockLines.map((l) => l.y + l.height));
        const combinedText = blockLines.map((l) => l.text).join('\n');

        pageDetected.push({
          document_id: documentId,
          page_number: pageNumber,
          label: `Bloque de texto ${blockIndex}`,
          value: combinedText,
          field_type: blockLines.length > 1 ? 'multiline' : 'text',
          x: Math.round(x0),
          y: Math.round(y0),
          width: Math.max(140, Math.round(x1 - x0)),
          height: Math.max(24, Math.round(y1 - y0 + 6)),
          font_size: Math.min(12, Math.max(9, Math.round(medianHeight * 0.8))),
          group_name: `Texto reconocido · Pág. ${pageNumber}`,
          sort_order: globalSortOrder++,
        });
        blockIndex += 1;
        blockLines = [];
      };

      for (let i = 0; i < rows.length; i++) {
        const mergedLineText = rows[i].map((l) => l.text).join('  ');
        const merged: OcrLineBox = {
          pageNumber,
          text: mergedLineText,
          confidence: rows[i][0].confidence,
          x: Math.min(...rows[i].map((l) => l.x)),
          y: Math.min(...rows[i].map((l) => l.y)),
          width:
            Math.max(...rows[i].map((l) => l.x + l.width)) -
            Math.min(...rows[i].map((l) => l.x)),
          height: Math.max(...rows[i].map((l) => l.height)),
          pageWidthPt: rows[i][0].pageWidthPt,
          pageHeightPt: rows[i][0].pageHeightPt,
        };

        if (blockLines.length > 0) {
          const prev = blockLines[blockLines.length - 1];
          const gap = merged.y - (prev.y + prev.height);
          if (gap > medianHeight * 1.6) {
            flushBlock();
          }
        }
        blockLines.push(merged);
      }
      flushBlock();
    }

    extractedFields.push(...pageDetected);
  }

  return extractedFields;
}

function readImageDimensionsSync(buffer: Buffer, ext: string): { width: number; height: number } {
  if (ext === 'png' && buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if ((ext === 'jpg' || ext === 'jpeg') && buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
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
      const len = buffer.readUInt16BE(offset + 2);
      if (len < 2) break;
      offset += 2 + len;
    }
  }
  return { width: 1240, height: 1754 };
}

/**
 * Builds an editable PDF in the workspace preserving the original scanned PDF or image background,
 * embedding an invisible searchable OCR text layer and real interactive AcroForm fields.
 */
export async function buildEditablePdfFromOcr(params: {
  sourcePath: string;
  sourceExt: string;
  outputPath: string;
  lines: OcrLineBox[];
  fields: UpsertFieldInput[];
}): Promise<string> {
  const { sourcePath, sourceExt, outputPath, lines, fields } = params;
  const sourceBytes = fs.readFileSync(sourcePath);

  let pdfDoc: PDFDocument;
  if (sourceExt === 'pdf') {
    pdfDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  } else {
    pdfDoc = await PDFDocument.create();
    const embeddedImage =
      sourceExt === 'png'
        ? await pdfDoc.embedPng(sourceBytes)
        : await pdfDoc.embedJpg(sourceBytes);

    // Normalize page width to standard A4 width (595pt) preserving exact aspect ratio
    const aspect = embeddedImage.height / Math.max(1, embeddedImage.width);
    const pageWidth = 595;
    const pageHeight = Math.round(pageWidth * aspect);
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    page.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: pageWidth,
      height: pageHeight,
    });
  }

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  // 1. Draw invisible searchable OCR text layer on each page preserving original background image
  for (const line of lines) {
    const page = pages[line.pageNumber - 1];
    if (!page) continue;
    const safeText = sanitizeForWinAnsi(line.text);
    if (!safeText) continue;

    const { height: pageHeight } = page.getSize();
    const fontSize = Math.min(24, Math.max(6, line.height * 0.78));
    const pdfY = Math.max(4, pageHeight - line.y - line.height * 0.85);

    try {
      page.drawText(safeText, {
        x: Math.max(2, line.x),
        y: pdfY,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
        opacity: 0,
      });
    } catch {
      // Skip unencodable OCR glyph cleanly
    }
  }

  // 2. Insert real interactive AcroForm fields mapped to document_fields
  const form = pdfDoc.getForm();
  const usedNames = new Set<string>();

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const pageIdx = Math.max(0, (f.page_number ?? 1) - 1);
    const page = pages[pageIdx];
    if (!page) continue;

    const { width: pageWidth, height: pageHeight } = page.getSize();
    const baseName = `p${pageIdx + 1}_${sanitizePdfFieldName(f.label, i + 1)}`;
    let uniqueName = baseName;
    let suffix = 2;
    while (usedNames.has(uniqueName)) {
      uniqueName = `${baseName}_${suffix++}`;
    }
    usedNames.add(uniqueName);

    const w = Math.min(pageWidth - 16, Math.max(16, f.width ?? 180));
    const h = Math.min(pageHeight - 16, Math.max(14, f.height ?? 22));
    const x = Math.min(pageWidth - w - 8, Math.max(8, f.x ?? 48));
    const yTop = Math.max(8, f.y ?? 48);
    const pdfY = Math.max(8, pageHeight - yTop - h);

    if (f.field_type === 'checkbox') {
      const checkBox = form.createCheckBox(uniqueName);
      checkBox.addToPage(page, {
        x,
        y: pdfY,
        width: Math.min(20, Math.max(12, w)),
        height: Math.min(20, Math.max(12, h)),
        borderWidth: 0.75,
        borderColor: rgb(0.25, 0.35, 0.55),
        backgroundColor: rgb(1, 1, 1),
      });
      if (f.value === 'true') {
        checkBox.check();
      }
    } else {
      const textField = form.createTextField(uniqueName);
      if (f.field_type === 'multiline') {
        textField.enableMultiline();
      }
      const initialText = sanitizeForWinAnsi(f.value ?? '');
      if (initialText) {
        textField.setText(initialText);
      }
      textField.addToPage(page, {
        x,
        y: pdfY,
        width: w,
        height: h,
        font,
        borderWidth: 0.5,
        borderColor: rgb(0.25, 0.4, 0.75),
        backgroundColor: rgb(0.97, 0.98, 1),
      });
      if (f.font_size) {
        textField.setFontSize(Math.min(16, Math.max(8, f.font_size)));
      }
    }
  }

  try {
    form.updateFieldAppearances(font);
  } catch {
    // Non-fatal if PDF has unusual font dictionaries
  }

  const outBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, Buffer.from(outBytes));
  return outputPath;
}

/**
 * Runs 100% local offline OCR using tesseract.js against resources/tessdata/ (spa+eng),
 * groups & orders fields, and produces an editable PDF preserving the original visual background.
 */
export async function runLocalOcrPipeline(params: {
  document: DocumentRecord;
  renderedPages?: RenderedPagePayload[];
  onProgress?: (event: OcrProgressEvent) => void;
}): Promise<OcrPipelineOutput> {
  const { document, renderedPages, onProgress } = params;
  const tessdata = locateTessdata();
  if (!tessdata.available || !tessdata.dirPath) {
    throw new Error(
      `TESSDATA_MISSING::Faltan los modelos OCR offline (spa.traineddata y eng.traineddata) en ${tessdata.expectedPath}. Ejecuta "npm run setup:tessdata".`,
    );
  }

  if (!fs.existsSync(document.working_path)) {
    throw new Error(`No se encontró el archivo de trabajo: ${document.working_path}`);
  }

  const sourceExt = path.extname(document.working_path).replace('.', '').toLowerCase();
  let pagesToProcess: RenderedPagePayload[] = [];

  if (sourceExt === 'pdf') {
    if (!renderedPages || renderedPages.length === 0) {
      throw new Error(
        'No se recibieron las páginas renderizadas del PDF para ejecutar OCR local.',
      );
    }
    pagesToProcess = renderedPages;
  } else {
    const imgBuffer = fs.readFileSync(document.working_path);
    const dims = readImageDimensionsSync(imgBuffer, sourceExt);
    const pageWidthPt = 595;
    const pageHeightPt = Math.round(pageWidthPt * (dims.height / Math.max(1, dims.width)));
    pagesToProcess = [
      {
        pageNumber: 1,
        pngBytes: new Uint8Array(imgBuffer),
        pdfWidthPt: pageWidthPt,
        pdfHeightPt: pageHeightPt,
        imageWidthPx: dims.width,
        imageHeightPx: dims.height,
      },
    ];
  }

  const totalPages = pagesToProcess.length;
  let activePageIndex = 0;

  onProgress?.({
    documentId: document.id,
    stage: 'initializing',
    currentPage: 1,
    totalPages,
    pageProgress: 0,
    overallProgress: 5,
    message: 'Cargando modelos OCR locales (spa + eng)...',
  });

  const worker = await createWorker(['spa', 'eng'], OEM.LSTM_ONLY, {
    langPath: tessdata.dirPath,
    gzip: false,
    cacheMethod: 'none',
    logger: (m) => {
      if (m.status === 'recognizing text') {
        const pct = Math.round(Math.min(1, Math.max(0, m.progress)) * 100);
        const overall = Math.round(
          10 + ((activePageIndex + m.progress) / Math.max(1, totalPages)) * 72,
        );
        onProgress?.({
          documentId: document.id,
          stage: 'recognizing',
          currentPage: activePageIndex + 1,
          totalPages,
          pageProgress: pct,
          overallProgress: Math.min(82, overall),
          message: `Página ${activePageIndex + 1} de ${totalPages} · Reconociendo texto (${pct}%)`,
        });
      }
    },
  });

  const allLines: OcrLineBox[] = [];
  let confidenceSum = 0;
  let confidenceCount = 0;

  try {
    for (let i = 0; i < pagesToProcess.length; i++) {
      activePageIndex = i;
      const pagePayload = pagesToProcess[i];
      const imgBuf = Buffer.from(pagePayload.pngBytes);

      onProgress?.({
        documentId: document.id,
        stage: 'recognizing',
        currentPage: i + 1,
        totalPages,
        pageProgress: 0,
        overallProgress: Math.round(10 + (i / Math.max(1, totalPages)) * 72),
        message: `Página ${i + 1} de ${totalPages} · Analizando imagen...`,
      });

      const result = await worker.recognize(imgBuf, {}, { text: true, blocks: true });
      const scaleX = pagePayload.pdfWidthPt / Math.max(1, pagePayload.imageWidthPx);
      const scaleY = pagePayload.pdfHeightPt / Math.max(1, pagePayload.imageHeightPx);

      const blocks = result.data.blocks ?? [];
      for (const block of blocks) {
        for (const para of block.paragraphs ?? []) {
          for (const line of para.lines ?? []) {
            const cleanedText = (line.text ?? '').replace(/\s+/g, ' ').trim();
            if (!cleanedText) continue;

            const x0 = line.bbox.x0 * scaleX;
            const y0 = line.bbox.y0 * scaleY;
            const w = Math.max(4, (line.bbox.x1 - line.bbox.x0) * scaleX);
            const h = Math.max(6, (line.bbox.y1 - line.bbox.y0) * scaleY);

            allLines.push({
              pageNumber: pagePayload.pageNumber,
              text: cleanedText,
              confidence: line.confidence ?? 0,
              x: x0,
              y: y0,
              width: w,
              height: h,
              pageWidthPt: pagePayload.pdfWidthPt,
              pageHeightPt: pagePayload.pdfHeightPt,
            });
            confidenceSum += line.confidence ?? 0;
            confidenceCount += 1;
          }
        }
      }
    }
  } finally {
    await worker.terminate();
  }

  onProgress?.({
    documentId: document.id,
    stage: 'grouping',
    currentPage: totalPages,
    totalPages,
    pageProgress: 100,
    overallProgress: 86,
    message: 'Agrupando secciones y ordenando campos detectados...',
  });

  const fields = extractAndOrderFieldsFromOcrLines(document.id, allLines);

  onProgress?.({
    documentId: document.id,
    stage: 'building_pdf',
    currentPage: totalPages,
    totalPages,
    pageProgress: 100,
    overallProgress: 93,
    message: 'Generando PDF editable conservando el fondo original...',
  });

  const dir = path.dirname(document.working_path);
  const baseName = path
    .basename(document.working_path, path.extname(document.working_path))
    .replace(/_ocr_editable(_\d+)?$/i, '');
  const editablePdfPath = path.join(dir, `${baseName}_ocr_editable_${Date.now()}.pdf`);

  await buildEditablePdfFromOcr({
    sourcePath: document.working_path,
    sourceExt,
    outputPath: editablePdfPath,
    lines: allLines,
    fields,
  });

  const avgConfidence =
    confidenceCount > 0 ? Math.round((confidenceSum / confidenceCount) * 10) / 10 : 0;

  onProgress?.({
    documentId: document.id,
    stage: 'completed',
    currentPage: totalPages,
    totalPages,
    pageProgress: 100,
    overallProgress: 100,
    message: `OCR completado: ${fields.length} campos detectados en ${totalPages} página(s).`,
  });

  return {
    editablePdfPath,
    fields,
    lines: allLines,
    pagesProcessed: totalPages,
    avgConfidence,
  };
}

function humanizeAcroFormFieldName(rawName: string): { group: string; label: string } {
  const parts = rawName.split('.').filter(Boolean);
  let group = 'Formulario AcroForm';
  let leaf = rawName;

  if (parts.length > 1) {
    group = parts
      .slice(0, -1)
      .join(' · ')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
    leaf = parts[parts.length - 1];
  }

  const label = leaf
    .replace(/^p\d+_/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();

  const titledLabel = label ? label.charAt(0).toUpperCase() + label.slice(1) : rawName;
  return { group: group || 'Formulario AcroForm', label: titledLabel };
}

/**
 * Extracts existing AcroForm interactive fields from a native or freshly unlocked PDF
 * with exact page numbers, top-left coordinates, field types, values, and reading order.
 */
export async function extractAcroFormFieldsFromPdf(
  documentId: string,
  pdfPath: string,
): Promise<UpsertFieldInput[]> {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`No se encontró el PDF en ${pdfPath}`);
  }

  const bytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  // Map both page ref -> pageIndex AND annotation ref -> pageIndex for maximum compatibility
  const pageRefToIndex = new Map<string, number>();
  const annotRefToPageIndex = new Map<string, number>();

  pages.forEach((page, idx) => {
    pageRefToIndex.set(page.ref.toString(), idx);
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (annots) {
      for (let i = 0; i < annots.size(); i++) {
        const annotRef = annots.get(i);
        if (annotRef) {
          annotRefToPageIndex.set(annotRef.toString(), idx);
        }
      }
    }
  });

  const form = pdfDoc.getForm();
  const pdfFields = form.getFields();
  const extracted: Array<UpsertFieldInput & { _page: number; _y: number; _x: number }> = [];

  for (const pdfField of pdfFields) {
    const rawName = pdfField.getName();
    const { group, label } = humanizeAcroFormFieldName(rawName);
    const widgets = pdfField.acroField.getWidgets();

    let fieldType: FieldType = 'text';
    let value = '';

    if (pdfField instanceof PDFCheckBox) {
      fieldType = 'checkbox';
      value = pdfField.isChecked() ? 'true' : 'false';
    } else if (pdfField instanceof PDFTextField) {
      value = pdfField.getText() ?? '';
      fieldType = pdfField.isMultiline() ? 'multiline' : inferFieldTypeFromLabel(label);
    } else if (pdfField instanceof PDFDropdown) {
      value = pdfField.getSelected().join(', ');
      fieldType = 'text';
    } else if (pdfField instanceof PDFRadioGroup) {
      value = pdfField.getSelected() ?? '';
      fieldType = 'text';
    }

    if (widgets.length === 0) {
      extracted.push({
        document_id: documentId,
        page_number: 1,
        label,
        value,
        field_type: fieldType,
        x: 48,
        y: 64,
        width: 200,
        height: 24,
        font_size: 11,
        group_name: group,
        _page: 1,
        _y: 64,
        _x: 48,
      });
      continue;
    }

    const widget = widgets[0];
    let pageIdx = 0;
    const pRef = widget.P();
    if (pRef && pageRefToIndex.has(pRef.toString())) {
      pageIdx = pageRefToIndex.get(pRef.toString()) ?? 0;
    } else {
      // Fallback: inspect widget dict reference in annotRefToPageIndex
      const dictRef = pdfDoc.context.getObjectRef(widget.dict);
      if (dictRef && annotRefToPageIndex.has(dictRef.toString())) {
        pageIdx = annotRefToPageIndex.get(dictRef.toString()) ?? 0;
      }
    }

    const page = pages[pageIdx] ?? pages[0];
    const pageHeight = page ? page.getSize().height : 792;
    const rect = widget.getRectangle();
    const yTop = Math.max(0, Math.round(pageHeight - rect.y - rect.height));
    const xLeft = Math.max(0, Math.round(rect.x));
    const width = Math.max(16, Math.round(rect.width));
    const height = Math.max(14, Math.round(rect.height));

    extracted.push({
      document_id: documentId,
      page_number: pageIdx + 1,
      label,
      value,
      field_type: fieldType,
      x: xLeft,
      y: yTop,
      width,
      height,
      font_size: 11,
      group_name: group,
      _page: pageIdx + 1,
      _y: yTop,
      _x: xLeft,
    });
  }

  // Sort strictly by page, then top-to-bottom (with 10pt row tolerance), then left-to-right
  extracted.sort((a, b) => {
    if (a._page !== b._page) return a._page - b._page;
    if (Math.abs(a._y - b._y) > 10) return a._y - b._y;
    return a._x - b._x;
  });

  return extracted.map(({ _page, _y, _x, ...rest }, index) => ({
    ...rest,
    sort_order: index,
  }));
}
