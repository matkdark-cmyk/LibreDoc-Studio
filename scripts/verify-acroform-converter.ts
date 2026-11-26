import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import { buildAcroFormPdf } from '../shared/acroFormBuilder';
import {
  classifyPageFormFields,
  extractVectorsWithCtm,
  type PageRasterProvider,
  type PdfJsOpsMap,
  type PdfTextToken,
} from '../shared/pdfFormClassifier';
import type { DocumentField, UpsertFieldInput } from '../shared/types';

/**
 * Pure-Node 150 DPI grayscale raster provider backed by PGM (P5) output from pdftoppm or ImageMagick `convert`.
 * Requires zero DOM / browser canvas dependencies.
 */
class PgmRasterProvider implements PageRasterProvider {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pageWidthPt: number;
  readonly pageHeightPt: number;
  private readonly pixels: Uint8Array;

  constructor(pgmBuffer: Buffer, pageWidthPt: number, pageHeightPt: number) {
    // Parse binary PGM (P5): magic, optional comments, width, height, maxval, then 1 byte per pixel
    let offset = 0;
    const readToken = (): string => {
      while (offset < pgmBuffer.length) {
        const b = pgmBuffer[offset];
        if (b === 0x23) {
          // '#' comment until newline
          while (offset < pgmBuffer.length && pgmBuffer[offset] !== 0x0a) offset++;
        } else if (b <= 0x20) {
          offset++;
        } else {
          break;
        }
      }
      const start = offset;
      while (offset < pgmBuffer.length && pgmBuffer[offset] > 0x20) offset++;
      return pgmBuffer.subarray(start, offset).toString('ascii');
    };

    const magic = readToken();
    if (magic !== 'P5') {
      throw new Error(`Unsupported PGM format: ${magic}`);
    }
    const width = Number(readToken());
    const height = Number(readToken());
    const maxVal = Number(readToken());
    // Skip single whitespace delimiter after maxVal
    offset++;
    if (!Number.isFinite(width) || !Number.isFinite(height) || maxVal <= 0) {
      throw new Error('Invalid PGM header.');
    }

    this.widthPx = width;
    this.heightPx = height;
    this.pageWidthPt = pageWidthPt;
    this.pageHeightPt = pageHeightPt;
    this.pixels = new Uint8Array(
      pgmBuffer.buffer,
      pgmBuffer.byteOffset + offset,
      Math.min(width * height, pgmBuffer.length - offset),
    );
  }

  getGrayscale(px: number, py: number): number {
    const cx = Math.max(0, Math.min(this.widthPx - 1, px | 0));
    const cy = Math.max(0, Math.min(this.heightPx - 1, py | 0));
    return this.pixels[cy * this.widthPx + cx] ?? 255;
  }
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_GS = commandExists('gs');
const HAS_PDFTOPPM = commandExists('pdftoppm');
const HAS_CONVERT = commandExists('convert');

function renderPdfPageToGrayscalePgm(
  pdfPath: string,
  pageNumber: number,
  tmpDir: string,
): Buffer | null {
  const outPrefix = path.join(tmpDir, `page_${pageNumber}`);
  const pgmPath = `${outPrefix}.pgm`;

  if (HAS_GS) {
    execFileSync(
      'gs',
      [
        '-q',
        '-dNOPAUSE',
        '-dBATCH',
        '-sDEVICE=pgmraw',
        '-r150',
        `-dFirstPage=${pageNumber}`,
        `-dLastPage=${pageNumber}`,
        `-sOutputFile=${pgmPath}`,
        pdfPath,
      ],
      { stdio: 'ignore' },
    );
    if (fs.existsSync(pgmPath)) {
      return fs.readFileSync(pgmPath);
    }
  }
  if (HAS_PDFTOPPM) {
    execFileSync(
      'pdftoppm',
      ['-r', '150', '-gray', '-f', String(pageNumber), '-l', String(pageNumber), '-singlefile', pdfPath, outPrefix],
      { stdio: 'ignore' },
    );
    if (fs.existsSync(pgmPath)) {
      return fs.readFileSync(pgmPath);
    }
  }
  if (HAS_CONVERT) {
    execFileSync(
      'convert',
      [
        '-density',
        '150',
        `${pdfPath}[${pageNumber - 1}]`,
        '-background',
        'white',
        '-alpha',
        'remove',
        '-colorspace',
        'Gray',
        '-depth',
        '8',
        `pgm:${pgmPath}`,
      ],
      { stdio: 'ignore' },
    );
    if (fs.existsSync(pgmPath)) {
      return fs.readFileSync(pgmPath);
    }
  }
  return null;
}

function renderPdfPageToPng(pdfPath: string, pageNumber: number, outPngPath: string): boolean {
  try {
    if (HAS_GS) {
      execFileSync(
        'gs',
        [
          '-q',
          '-dNOPAUSE',
          '-dBATCH',
          '-sDEVICE=png16m',
          '-r150',
          `-dFirstPage=${pageNumber}`,
          `-dLastPage=${pageNumber}`,
          `-sOutputFile=${outPngPath}`,
          pdfPath,
        ],
        { stdio: 'ignore' },
      );
      return fs.existsSync(outPngPath) && fs.statSync(outPngPath).size > 500;
    }
    if (HAS_PDFTOPPM) {
      const prefix = outPngPath.replace(/\.png$/i, '');
      execFileSync(
        'pdftoppm',
        ['-r', '150', '-png', '-f', String(pageNumber), '-l', String(pageNumber), '-singlefile', pdfPath, prefix],
        { stdio: 'ignore' },
      );
      return fs.existsSync(outPngPath) && fs.statSync(outPngPath).size > 500;
    }
    if (HAS_CONVERT) {
      execFileSync(
        'convert',
        [
          '-density',
          '150',
          `${pdfPath}[${pageNumber - 1}]`,
          '-background',
          'white',
          '-alpha',
          'remove',
          outPngPath,
        ],
        { stdio: 'ignore' },
      );
      return fs.existsSync(outPngPath) && fs.statSync(outPngPath).size > 500;
    }
    return false;
  } catch {
    return false;
  }
}

function splitTextItemIntoTokens(
  rawStr: string,
  x0: number,
  y0: number,
  totalWidth: number,
  height: number,
  fontSize: number,
): PdfTextToken[] {
  if (!rawStr || rawStr.trim().length === 0) return [];
  const len = rawStr.length;
  if (len === 0 || totalWidth <= 0) return [];
  const tokens: PdfTextToken[] = [];
  const regex = /[☐□▢]|[^\s☐□▢]+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawStr)) !== null) {
    const piece = match[0];
    const startRatio = match.index / len;
    const endRatio = (match.index + piece.length) / len;
    const tx0 = x0 + totalWidth * startRatio;
    const tx1 = Math.max(tx0 + 2, x0 + totalWidth * endRatio);
    tokens.push({
      text: piece,
      x0: tx0,
      y0,
      x1: tx1,
      y1: y0 + Math.max(6, height),
      fontSize,
    });
  }
  return tokens;
}

async function detectFieldsInNode(
  pdfPath: string,
  documentId: string,
  tmpDir: string,
): Promise<{ fields: UpsertFieldInput[]; pageCount: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const rawBytes = fs.readFileSync(pdfPath);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength),
    useSystemFonts: true,
    verbosity: 0,
  });

  const allFields: UpsertFieldInput[] = [];
  const usedNames = new Set<string>();

  try {
    const pdfDoc = await loadingTask.promise;
    const totalPages = pdfDoc.numPages;

    for (let p = 1; p <= totalPages; p++) {
      const page = await pdfDoc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const viewBox = page.view ?? [0, 0, viewport.width, viewport.height];
      const cropX = viewBox[0] ?? 0;
      const cropY = viewBox[1] ?? 0;

      const textContent = await page.getTextContent();
      const tokens: PdfTextToken[] = [];
      for (const rawItem of textContent.items) {
        if (!('str' in rawItem) || !rawItem.str || rawItem.str.trim().length === 0) continue;
        const tx = pdfjs.Util.transform(viewport.transform, rawItem.transform);
        const fontHeight = Math.max(6, Math.hypot(tx[2], tx[3]) || Math.abs(rawItem.height) || 10);
        const itemWidth = Math.max(
          4,
          rawItem.width > 0 ? rawItem.width : rawItem.str.length * fontHeight * 0.5,
        );
        const x0 = tx[4];
        const baselineY = tx[5];
        const y0 = baselineY - fontHeight * 0.85;
        tokens.push(...splitTextItemIntoTokens(rawItem.str, x0, y0, itemWidth, fontHeight, fontHeight));
      }

      const opList = await page.getOperatorList();
      const vectors = extractVectorsWithCtm(
        opList,
        pdfjs.OPS as unknown as PdfJsOpsMap,
        viewport.width,
        viewport.height,
        cropX,
        cropY,
      );

      let raster: PageRasterProvider | null = null;
      try {
        const pgm = renderPdfPageToGrayscalePgm(pdfPath, p, tmpDir);
        if (pgm) {
          raster = new PgmRasterProvider(pgm, viewport.width, viewport.height);
        }
      } catch {
        raster = null;
      }

      const pageFields = classifyPageFormFields(
        {
          documentId,
          pageNumber: p,
          pageWidthPt: viewport.width,
          pageHeightPt: viewport.height,
          tokens,
          vectors,
          raster,
        },
        usedNames,
      );
      allFields.push(...pageFields);
    }

    return { fields: allFields, pageCount: totalPages };
  } finally {
    await loadingTask.destroy();
  }
}

function toDocumentFields(inputs: UpsertFieldInput[]): DocumentField[] {
  return inputs.map((inp, idx) => ({
    id: `f_${idx + 1}`,
    document_id: inp.document_id,
    page_number: inp.page_number ?? 1,
    label: inp.label,
    value: inp.value ?? '',
    field_type: inp.field_type ?? 'text',
    x: inp.x ?? 0,
    y: inp.y ?? 0,
    width: inp.width ?? 100,
    height: inp.height ?? 16,
    font_size: inp.font_size ?? 9,
    group_name: inp.group_name ?? 'General',
    sort_order: inp.sort_order ?? idx,
    checkbox_style: inp.checkbox_style ?? 'check',
    alignment: inp.alignment ?? 'left',
    cover_dashes: inp.cover_dashes ?? 0,
    field_name: inp.field_name ?? `field_${idx + 1}`,
    tooltip: inp.tooltip ?? inp.label,
    source: inp.source ?? 'auto',
  }));
}

async function generateSyntheticExcelPdf(outPath: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  page.drawText('PLANILLA DE POSTULACIÓN (FORMATO EXCEL)', {
    x: 60,
    y: 740,
    size: 13,
    font: bold,
    color: rgb(0.1, 0.1, 0.1),
  });

  // Draw a 5-row x 2-column table using explicit horizontal and vertical lines
  const colXs = [60, 240, 540];
  const rowYs = [710, 684, 658, 632, 606, 580]; // PDF bottom-up

  for (const y of rowYs) {
    page.drawLine({
      start: { x: colXs[0], y },
      end: { x: colXs[2], y },
      thickness: 0.9,
      color: rgb(0.15, 0.15, 0.15),
    });
  }
  for (const x of colXs) {
    page.drawLine({
      start: { x, y: rowYs[0] },
      end: { x, y: rowYs[rowYs.length - 1] },
      thickness: 0.9,
      color: rgb(0.15, 0.15, 0.15),
    });
  }

  // Row 0: Fixed header + fixed prefilled value (MUST be skipped!)
  page.drawText('Institución', { x: 68, y: 693, size: 10, font: bold });
  page.drawText('Colegio Demo Oficial 2026', { x: 248, y: 693, size: 10, font });

  // Row 1: Empty text cell
  page.drawText('Nombre del Estudiante', { x: 68, y: 667, size: 10, font: bold });

  // Row 2: Currency `$` cell
  page.drawText('Ingreso Mensual', { x: 68, y: 641, size: 10, font: bold });
  page.drawText('$', { x: 248, y: 641, size: 10, font });

  // Row 3: Date `/2026` cell
  page.drawText('Fecha de Ingreso', { x: 68, y: 615, size: 10, font: bold });
  page.drawText('/', { x: 295, y: 615, size: 10, font });
  page.drawText('/2026', { x: 350, y: 615, size: 10, font });

  // Row 4: Another empty cell
  page.drawText('Correo Electrónico', { x: 68, y: 589, size: 10, font: bold });

  const bytes = await doc.save();
  fs.writeFileSync(outPath, Buffer.from(bytes));
}

async function validateAcroFormStructure(
  pdfBytes: Uint8Array,
  expectedMinFields: number,
  label: string,
): Promise<{ totalWidgets: number; checkboxCount: number; textCount: number; nonEmptyValues: number }> {
  const doc = await PDFDocument.load(pdfBytes);
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acroForm) {
    throw new Error(`[${label}] Missing Catalog /AcroForm dictionary.`);
  }

  const needAppearances = acroForm.lookup(PDFName.of('NeedAppearances'));
  if (needAppearances !== PDFBool.True) {
    throw new Error(`[${label}] /NeedAppearances must be true.`);
  }

  const fieldsArr = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fieldsArr || fieldsArr.size() < expectedMinFields) {
    throw new Error(
      `[${label}] Expected at least ${expectedMinFields} AcroForm fields, got ${fieldsArr?.size() ?? 0}.`,
    );
  }

  const pages = doc.getPages();
  let totalWidgets = 0;
  let checkboxCount = 0;
  let textCount = 0;
  let nonEmptyValues = 0;

  for (let pIdx = 0; pIdx < pages.length; pIdx++) {
    const page = pages[pIdx];
    const crop = page.getCropBox();
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;

    for (let i = 0; i < annots.size(); i++) {
      const widget = annots.lookupMaybe(i, PDFDict);
      if (!widget) continue;
      const subtype = widget.lookup(PDFName.of('Subtype'));
      if (subtype !== PDFName.of('Widget')) continue;
      totalWidgets++;

      // Assert Print flag /F 4
      const flags = widget.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0;
      if ((flags & 4) !== 4) {
        throw new Error(`[${label}] Widget on page ${pIdx + 1} missing Print flag (/F 4).`);
      }

      // Assert valid bounds inside page CropBox
      const rect = widget.lookupMaybe(PDFName.of('Rect'), PDFArray);
      if (!rect || rect.size() !== 4) {
        throw new Error(`[${label}] Widget on page ${pIdx + 1} missing valid /Rect.`);
      }
      const llx = (rect.lookup(0) as PDFNumber).asNumber();
      const lly = (rect.lookup(1) as PDFNumber).asNumber();
      const urx = (rect.lookup(2) as PDFNumber).asNumber();
      const ury = (rect.lookup(3) as PDFNumber).asNumber();
      if (
        urx <= llx ||
        ury <= lly ||
        llx < crop.x - 2 ||
        lly < crop.y - 2 ||
        urx > crop.x + crop.width + 2 ||
        ury > crop.y + crop.height + 2
      ) {
        throw new Error(
          `[${label}] Widget out of CropBox bounds on page ${pIdx + 1}: [${llx}, ${lly}, ${urx}, ${ury}]`,
        );
      }

      const ft = widget.lookup(PDFName.of('FT'));
      if (ft === PDFName.of('Btn')) {
        checkboxCount++;
        const ap = widget.lookupMaybe(PDFName.of('AP'), PDFDict);
        const apN = ap?.lookupMaybe(PDFName.of('N'), PDFDict);
        if (!apN?.has(PDFName.of('Yes')) || !apN?.has(PDFName.of('Off'))) {
          throw new Error(
            `[${label}] Checkbox widget on page ${pIdx + 1} missing custom /AP /N /Yes or /Off stream.`,
          );
        }
        const v = widget.lookup(PDFName.of('V'));
        if (v === PDFName.of('Yes')) {
          nonEmptyValues++;
          const as = widget.lookup(PDFName.of('AS'));
          if (as !== PDFName.of('Yes')) {
            throw new Error(`[${label}] Checked checkbox missing matching /AS /Yes.`);
          }
        }
      } else if (ft === PDFName.of('Tx')) {
        textCount++;
        const v = widget.lookup(PDFName.of('V'));
        if (v && v.toString().length > 2) {
          nonEmptyValues++;
        }
      }
    }
  }

  return { totalWidgets, checkboxCount, textCount, nonEmptyValues };
}

async function runVerification(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libredoc-acroform-verify-'));
  console.log(`[Verify] Temporary verification folder: ${tmpDir}`);
  console.log(`[Verify] Raster backend: pdftoppm=${HAS_PDFTOPPM}, convert=${HAS_CONVERT}`);

  try {
    // =========================================================================
    // TEST 1: Synthetic Excel-style PDF (with fixed prefilled row, $, /2026)
    // =========================================================================
    const excelPdfPath = path.join(tmpDir, 'excel-synthetic.pdf');
    await generateSyntheticExcelPdf(excelPdfPath);

    const excelDet = await detectFieldsInNode(excelPdfPath, 'doc-excel', tmpDir);
    console.log(`[Test 1: Excel PDF] Detected ${excelDet.fields.length} fields:`);
    for (const f of excelDet.fields) {
      console.log(
        `  - p${f.page_number} [${f.field_type}] "${f.label}" @ (${f.x}, ${f.y}, ${f.width}x${f.height}) align=${f.alignment}`,
      );
    }

    // Must skip fixed prefilled row ("Colegio Demo Oficial 2026")
    const leakedFixedRow = excelDet.fields.some((f) => /instituci/i.test(f.label));
    if (leakedFixedRow) {
      throw new Error('[Test 1] Fixed prefilled row "Institución" should have been skipped!');
    }

    // Must detect currency cell starting AFTER the `$` sign (x > 252)
    const moneyField = excelDet.fields.find((f) => /ingreso mensual/i.test(f.label));
    if (!moneyField || (moneyField.x ?? 0) <= 252) {
      throw new Error(
        `[Test 1] Expected currency "$" field starting right of "$", got x=${moneyField?.x}`,
      );
    }

    // Must split `/2026` date cell into at least 2 centered parts (Día & Mes) without covering `/2026`
    const dateParts = excelDet.fields.filter((f) => /fecha de ingreso/i.test(f.label));
    if (dateParts.length < 2 || !dateParts.every((d) => d.alignment === 'center')) {
      throw new Error(
        `[Test 1] Expected >=2 centered date segments for "/2026" cell, got ${dateParts.length}`,
      );
    }

    // Fill with accented Spanish strings + export Phase 3 AcroForm
    const excelDocFields = toDocumentFields(excelDet.fields).map((f) => {
      if (/nombre/i.test(f.label)) return { ...f, value: 'María José González' };
      if (/ingreso/i.test(f.label)) return { ...f, value: '150.000' };
      if (/día/i.test(f.label)) return { ...f, value: '15' };
      if (/mes/i.test(f.label)) return { ...f, value: '04' };
      return { ...f, value: 'maria.gonzalez@correo.cl' };
    });

    const excelOut = await buildAcroFormPdf({
      originalPdfBytes: new Uint8Array(fs.readFileSync(excelPdfPath)),
      fields: excelDocFields,
    });
    const excelOutPath = path.join(tmpDir, 'excel-rellenable.pdf');
    fs.writeFileSync(excelOutPath, Buffer.from(excelOut.pdfBytes));

    const excelValidation = await validateAcroFormStructure(excelOut.pdfBytes, 5, 'Test 1 Excel');
    if (excelValidation.nonEmptyValues < 5) {
      throw new Error(`[Test 1] Expected >=5 filled values in exported PDF, got ${excelValidation.nonEmptyValues}`);
    }
    const excelPngPath = path.join(tmpDir, 'excel-p1.png');
    const excelRendered = renderPdfPageToPng(excelOutPath, 1, excelPngPath);
    console.log(
      `[Test 1: Excel PDF] PASS — widgets=${excelValidation.totalWidgets}, filled=${excelValidation.nonEmptyValues}, pngRendered=${excelRendered}`,
    );

    // =========================================================================
    // TEST 2: Real 7-Page Word PDF (REGLAMENTO INTERNO DE ASIGNACIÓN DE BECAS)
    // =========================================================================
    const wordPdfPath = path.resolve(
      process.cwd(),
      'public/assets/aistudio/REGLAMENTO_INTERNO_DE_ASIGNACI_N_DE_BECAS_2025-2026.docx_af4f397a.pdf',
    );
    if (!fs.existsSync(wordPdfPath)) {
      throw new Error(`[Test 2] Missing real Word PDF fixture at ${wordPdfPath}`);
    }

    const wordDet = await detectFieldsInNode(wordPdfPath, 'doc-word-7p', tmpDir);
    const byPage = new Map<number, UpsertFieldInput[]>();
    for (const f of wordDet.fields) {
      const p = f.page_number ?? 1;
      const arr = byPage.get(p) ?? [];
      arr.push(f);
      byPage.set(p, arr);
    }

    console.log(
      `[Test 2: 7-Page Word PDF] Detected ${wordDet.fields.length} total fields across ${wordDet.pageCount} pages:`,
    );
    for (let p = 1; p <= wordDet.pageCount; p++) {
      const pFields = byPage.get(p) ?? [];
      const checks = pFields.filter((f) => f.field_type === 'checkbox');
      const dashFields = pFields.filter((f) => f.cover_dashes === 1);
      const multi = pFields.filter((f) => f.field_type === 'multiline');
      console.log(
        `  Page ${p}: total=${pFields.length} (text=${pFields.length - checks.length - multi.length}, multiline=${multi.length}, checkboxes=${checks.length}, cover_dashes=${dashFields.length})`,
      );
    }

    // Assertions matching real 7-page Word PDF structure:
    const p3Checks = (byPage.get(3) ?? []).filter(
      (f) => f.field_type === 'checkbox' && f.checkbox_style === 'check',
    );
    if (p3Checks.length < 7) {
      throw new Error(`[Test 2] Expected >=7 Unicode checkboxes (✓) on Page 3, got ${p3Checks.length}`);
    }

    const p5Fields = byPage.get(5) ?? [];
    const p5Crosses = p5Fields.filter(
      (f) => f.field_type === 'checkbox' && f.checkbox_style === 'cross',
    );
    if (p5Crosses.length < 2) {
      throw new Error(`[Test 2] Expected >=2 Si/No cross checkboxes (✕) on Page 5, got ${p5Crosses.length}`);
    }
    if (p5Fields.length < 15) {
      throw new Error(`[Test 2] Expected >=15 fields on Page 5 (tables + V.1/V.2/V.3), got ${p5Fields.length}`);
    }

    // Verify top-left school logo box [80, 59, 68x66] was NOT turned into a form field on Page 5
    const logoFalsePositive = p5Fields.some(
      (f) => (f.x ?? 0) >= 65 && (f.x ?? 0) <= 105 && (f.y ?? 0) >= 45 && (f.y ?? 0) <= 95 && (f.height ?? 0) > 35,
    );
    if (logoFalsePositive) {
      throw new Error('[Test 2] School crest logo in top-left header was falsely classified as a field!');
    }

    const p6Fields = byPage.get(6) ?? [];
    const p6Crosses = p6Fields.filter(
      (f) => f.field_type === 'checkbox' && f.checkbox_style === 'cross',
    );
    const p6Dashes = p6Fields.filter((f) => f.cover_dashes === 1);
    if (p6Crosses.length < 4) {
      throw new Error(`[Test 2] Expected >=4 Si/No cross checkboxes on Page 6, got ${p6Crosses.length}`);
    }
    if (p6Dashes.length < 3) {
      throw new Error(`[Test 2] Expected >=3 mid-height dash fields (cover_dashes=1) on Page 6, got ${p6Dashes.length}`);
    }

    const p7Fields = byPage.get(7) ?? [];
    const p7Centered = p7Fields.filter((f) => f.alignment === 'center');
    const p7Dashes = p7Fields.filter((f) => f.cover_dashes === 1);
    if (p7Fields.length < 8 || p7Centered.length < 1 || p7Dashes.length < 1) {
      throw new Error(
        `[Test 2] Page 7 verification failed: total=${p7Fields.length}, centered=${p7Centered.length}, dashes=${p7Dashes.length}`,
      );
    }

    // Fill representative fields (Spanish accents + currency + checked ✓ and ✕ checkboxes) & build AcroForm
    const wordDocFields = toDocumentFields(wordDet.fields).map((f, idx) => {
      if (f.field_type === 'checkbox') {
        return { ...f, value: idx % 2 === 0 ? 'true' : 'false' };
      }
      if (/ingreso|monto|\$/i.test(f.label)) {
        return { ...f, value: '$150.000' };
      }
      if (f.field_type === 'multiline') {
        return { ...f, value: 'Observación familiar: María José González — situación acreditada.' };
      }
      return { ...f, value: idx % 3 === 0 ? 'María José González' : 'Antecedente verificado N° 42' };
    });

    const wordOut = await buildAcroFormPdf({
      originalPdfBytes: new Uint8Array(fs.readFileSync(wordPdfPath)),
      fields: wordDocFields,
    });
    const wordOutPath = path.join(tmpDir, 'reglamento-rellenable.pdf');
    fs.writeFileSync(wordOutPath, Buffer.from(wordOut.pdfBytes));

    const wordValidation = await validateAcroFormStructure(wordOut.pdfBytes, 35, 'Test 2 Word 7-Page');

    // Render pages 3, 5, 6, 7 to PNG to verify filled PDF renders cleanly without errors
    const renderedPages: number[] = [];
    for (const pNum of [3, 5, 6, 7]) {
      const ok = renderPdfPageToPng(wordOutPath, pNum, path.join(tmpDir, `word-p${pNum}.png`));
      if (ok) renderedPages.push(pNum);
    }

    console.log(
      `[Test 2: 7-Page Word PDF] PASS — widgets=${wordValidation.totalWidgets} (text=${wordValidation.textCount}, checkboxes=${wordValidation.checkboxCount}), filled=${wordValidation.nonEmptyValues}, renderedPNGs=[${renderedPages.join(',')}]`,
    );
    console.log('\n✅ ALL ACROFORM CONVERTER VERIFICATION CHECKS PASSED!');
  } finally {
    // Clean up temporary directory completely
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runVerification().catch((err) => {
  console.error('\n❌ ACROFORM VERIFICATION FAILED:', err);
  process.exit(1);
});
