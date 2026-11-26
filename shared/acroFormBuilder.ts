import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  StandardFonts,
} from 'pdf-lib';
import type { DocumentField } from './types';

// WinAnsiEncoding (Windows-1252) special code points outside ISO-8859-1 (0xA0..0xFF)
const WIN_ANSI_EXTRAS = new Set<number>([
  0x20ac, // €
  0x201a, // ‚
  0x0192, // ƒ
  0x201e, // „
  0x2026, // …
  0x2020, // †
  0x2021, // ‡
  0x02c6, // ˆ
  0x2030, // ‰
  0x0160, // Š
  0x2039, // ‹
  0x0152, // Œ
  0x017d, // Ž
  0x2018, // ‘
  0x2019, // ’
  0x201c, // “
  0x201d, // ”
  0x2022, // •
  0x2013, // –
  0x2014, // —
  0x02dc, // ˜
  0x2122, // ™
  0x0161, // š
  0x203a, // ›
  0x0153, // œ
  0x017e, // ž
  0x0178, // Ÿ
]);

/**
 * Sanitizes text for Helvetica / WinAnsiEncoding while preserving all Spanish accents,
 * ñ/Ñ, ü/Ü, ¿/¡, °/º/ª, $, and standard punctuation so pdf-lib never throws encoding errors.
 */
export function sanitizeWinAnsiText(input: string): string {
  if (!input) return '';
  let out = '';
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xff) ||
      WIN_ANSI_EXTRAS.has(code)
    ) {
      out += ch;
    } else if (ch === '✓' || ch === '✔') {
      out += 'X';
    } else if (ch === '✕' || ch === '✖') {
      out += 'X';
    } else if (ch === '☐' || ch === '□' || ch === '▢') {
      out += '';
    } else {
      // Try NFKD ASCII fallback (e.g. smart symbols) or space
      const fallback = ch.normalize('NFKD').replace(/[^\x20-\x7E]/g, '');
      out += fallback || ' ';
    }
  }
  return out;
}

function escapePdfLiteralString(winAnsiText: string): string {
  // Encode characters > 0x7E as octal escapes in PDF content stream for Helvetica WinAnsi
  let out = '';
  for (let i = 0; i < winAnsiText.length; i++) {
    const code = winAnsiText.charCodeAt(i);
    if (code === 0x5c) {
      out += '\\\\';
    } else if (code === 0x28) {
      out += '\\(';
    } else if (code === 0x29) {
      out += '\\)';
    } else if (code >= 0x20 && code <= 0x7e) {
      out += winAnsiText[i];
    } else if (code >= 0xa0 && code <= 0xff) {
      out += `\\${code.toString(8).padStart(3, '0')}`;
    } else {
      // Map WinAnsi extras if needed, otherwise fallback space
      const mapped = mapWinAnsiExtraByte(code);
      out += mapped ? `\\${mapped.toString(8).padStart(3, '0')}` : ' ';
    }
  }
  return out;
}

function mapWinAnsiExtraByte(codePoint: number): number | null {
  switch (codePoint) {
    case 0x20ac:
      return 0x80;
    case 0x2013:
      return 0x96;
    case 0x2014:
      return 0x97;
    case 0x2018:
      return 0x91;
    case 0x2019:
      return 0x92;
    case 0x201c:
      return 0x93;
    case 0x201d:
      return 0x94;
    case 0x2022:
      return 0x95;
    default:
      return null;
  }
}

function encodePdfTextValue(value: string): PDFString | PDFHexString {
  const safe = sanitizeWinAnsiText(value);
  // Use UTF-16BE BOM hex string whenever non-ASCII characters (accents, ñ, °, etc.) are present
  // so Adobe Acrobat, Edge, Chrome, Preview, and pdf-lib read exact Unicode characters.
  const hasNonAscii = /[^\x20-\x7E\r\n\t]/.test(safe);
  if (!hasNonAscii) {
    const escaped = safe
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
    return PDFString.of(escaped);
  }
  return PDFHexString.fromText(safe);
}

function formatNum(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function buildCheckboxYesStream(
  width: number,
  height: number,
  style: 'check' | 'cross',
): string {
  const minSide = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const lineWidth = Math.max(1.1, Math.min(2.2, minSide * 0.13));

  if (style === 'cross') {
    // Centered crisp ✕ scaled to 28% of the minimum side
    const arm = Math.max(2.5, minSide * 0.28);
    return [
      'q',
      '0.08 0.12 0.22 RG',
      `${formatNum(lineWidth)} w`,
      '1 J 1 j',
      `${formatNum(cx - arm)} ${formatNum(cy - arm)} m ${formatNum(cx + arm)} ${formatNum(cy + arm)} l S`,
      `${formatNum(cx - arm)} ${formatNum(cy + arm)} m ${formatNum(cx + arm)} ${formatNum(cy - arm)} l S`,
      'Q',
    ].join('\n');
  }

  // Crisp ✓ vector polyline centered in the box
  const s = Math.max(3.2, minSide * 0.34);
  const x1 = cx - s * 0.85;
  const y1 = cy - s * 0.05;
  const x2 = cx - s * 0.2;
  const y2 = cy - s * 0.72;
  const x3 = cx + s * 0.92;
  const y3 = cy + s * 0.78;

  return [
    'q',
    '0.05 0.22 0.55 RG',
    `${formatNum(lineWidth)} w`,
    '1 J 1 j',
    `${formatNum(x1)} ${formatNum(y1)} m`,
    `${formatNum(x2)} ${formatNum(y2)} l`,
    `${formatNum(x3)} ${formatNum(y3)} l`,
    'S',
    'Q',
  ].join('\n');
}

function buildTextAppearanceStream(params: {
  width: number;
  height: number;
  fontSize: number;
  value: string;
  alignment: 'left' | 'center' | 'right';
  isMultiline: boolean;
  coverDashes: boolean;
}): string {
  const { width, height, fontSize, value, alignment, isMultiline, coverDashes } = params;
  const lines: string[] = [];

  if (coverDashes) {
    // Solid opaque white fill to mask underlying dashes + thin bottom underline
    lines.push('q');
    lines.push('1 1 1 rg');
    lines.push(`0 0 ${formatNum(width)} ${formatNum(height)} re f`);
    lines.push('0.2 0.2 0.2 RG 0.75 w');
    lines.push(`0 0.4 m ${formatNum(width)} 0.4 l S`);
    lines.push('Q');
  }

  const sanitized = sanitizeWinAnsiText(value);
  lines.push('/Tx BMC');
  lines.push('q');
  lines.push(`1 1 ${formatNum(Math.max(1, width - 2))} ${formatNum(Math.max(1, height - 2))} re W n`);

  if (sanitized.length > 0) {
    lines.push('BT');
    lines.push(`/Helv ${formatNum(fontSize)} Tf`);
    lines.push('0.06 0.09 0.16 rg');

    if (isMultiline) {
      const textLines = sanitized.split(/\r?\n/);
      const leading = fontSize * 1.25;
      let y = Math.max(2, height - fontSize - 2);
      for (const rawLine of textLines) {
        if (y < -fontSize) break;
        const escaped = escapePdfLiteralString(rawLine);
        lines.push(`1 0 0 1 2.5 ${formatNum(y)} Tm (${escaped}) Tj`);
        y -= leading;
      }
    } else {
      const singleLine = sanitized.replace(/\r?\n/g, ' ');
      const approxCharWidth = fontSize * 0.52;
      const approxTextW = singleLine.length * approxCharWidth;
      let tx = 2.5;
      if (alignment === 'center') {
        tx = Math.max(2, (width - approxTextW) / 2);
      } else if (alignment === 'right') {
        tx = Math.max(2, width - approxTextW - 2.5);
      }
      const ty = Math.max(1.8, (height - fontSize * 0.75) / 2);
      const escaped = escapePdfLiteralString(singleLine);
      lines.push(`1 0 0 1 ${formatNum(tx)} ${formatNum(ty)} Tm (${escaped}) Tj`);
    }

    lines.push('ET');
  }

  lines.push('Q');
  lines.push('EMC');
  return lines.join('\n');
}

export interface BuildAcroFormOptions {
  originalPdfBytes: Uint8Array;
  fields: DocumentField[];
}

export interface BuildAcroFormOutput {
  pdfBytes: Uint8Array;
  fieldsWritten: number;
}

/**
 * Phase 3: Clones the original PDF intact (no rasterization) and attaches 100% standard
 * AcroForm widgets (`/FT /Tx` and `/FT /Btn`) with exact bottom-up CropBox coordinates,
 * custom vector `/AP /N /Yes` (✓ / ✕) & `/Off` streams, WinAnsi-safe `/V` values, and
 * non-destructive append to existing page `/Annots` arrays.
 */
export async function buildAcroFormPdf(
  options: BuildAcroFormOptions,
): Promise<BuildAcroFormOutput> {
  const { originalPdfBytes, fields } = options;
  const pdfDoc = await PDFDocument.load(originalPdfBytes, { ignoreEncryption: true });
  const context = pdfDoc.context;
  const pages = pdfDoc.getPages();

  if (pages.length === 0) {
    throw new Error('El documento PDF no contiene páginas válidas.');
  }

  // Embed standard Helvetica (WinAnsi) & ZapfDingbats so /DR /Font is always complete
  const helvFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const zadbFont = await pdfDoc.embedFont(StandardFonts.ZapfDingbats);

  const fontDict = context.obj({
    Helv: helvFont.ref,
    ZaDb: zadbFont.ref,
  });
  const drDict = context.obj({
    Font: fontDict,
  });

  // Preserve any pre-existing AcroForm /Fields array if the original PDF already had fields
  const existingAcroForm = pdfDoc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const acroFieldsArray =
    existingAcroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray) ?? context.obj([]);

  // Sort fields by page_number, then reading/tab order (`round(y/4), x`)
  const sortedFields = [...fields].sort(
    (a, b) =>
      a.page_number - b.page_number ||
      Math.round(a.y / 4) - Math.round(b.y / 4) ||
      a.x - b.x ||
      a.sort_order - b.sort_order,
  );

  const usedNames = new Set<string>();
  let fieldsWritten = 0;

  for (let i = 0; i < sortedFields.length; i++) {
    const field = sortedFields[i];
    const pageIdx = Math.min(pages.length - 1, Math.max(0, (field.page_number || 1) - 1));
    const page = pages[pageIdx];

    // Respect CropBox origin & height when converting top-down -> bottom-up PDF coordinates
    const cropBox = page.getCropBox();
    const cropX = cropBox.x;
    const cropY = cropBox.y;
    const pageW = cropBox.width;
    const pageH = cropBox.height;

    const w = Math.max(6, Math.min(pageW - 4, field.width || 120));
    const h = Math.max(6, Math.min(pageH - 4, field.height || 16));
    const clampedTopX = Math.max(0, Math.min(pageW - w, field.x));
    const clampedTopY = Math.max(0, Math.min(pageH - h, field.y));

    const llx = cropX + clampedTopX;
    const lly = cropY + (pageH - (clampedTopY + h));
    const urx = llx + w;
    const ury = lly + h;

    // Guarantee unique /T name
    const rawName = sanitizeWinAnsiText(
      (field.field_name?.trim() || `p${pageIdx + 1}_campo_${i + 1}`).replace(/\./g, '_'),
    );
    let uniqueName = rawName || `p${pageIdx + 1}_campo_${i + 1}`;
    let dupCounter = 2;
    while (usedNames.has(uniqueName)) {
      uniqueName = `${rawName}_${dupCounter++}`;
    }
    usedNames.add(uniqueName);

    const tooltip = sanitizeWinAnsiText(field.tooltip?.trim() || field.label || uniqueName);

    let widgetRef: PDFRef;

    if (field.field_type === 'checkbox') {
      const style: 'check' | 'cross' = field.checkbox_style === 'cross' ? 'cross' : 'check';
      const isChecked = field.value === 'true';

      // Custom vector Appearance Streams: /AP /N /Yes and /AP /N /Off
      const yesContent = buildCheckboxYesStream(w, h, style);
      const yesStream = context.flateStream(yesContent, {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: [0, 0, w, h],
        Resources: {},
      });
      const yesRef = context.register(yesStream);

      const offStream = context.flateStream('', {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: [0, 0, w, h],
        Resources: {},
      });
      const offRef = context.register(offStream);

      const apDict = context.obj({
        N: context.obj({
          Yes: yesRef,
          Off: offRef,
        }),
      });

      const stateName = PDFName.of(isChecked ? 'Yes' : 'Off');

      const widgetDict = context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Btn'),
        T: encodePdfTextValue(uniqueName),
        TU: encodePdfTextValue(tooltip),
        Rect: [llx, lly, urx, ury],
        P: page.ref,
        F: PDFNumber.of(4), // Print flag
        BS: context.obj({ W: PDFNumber.of(0) }),
        V: stateName,
        AS: stateName,
        DV: PDFName.of('Off'),
        AP: apDict,
      });

      widgetRef = context.register(widgetDict);
    } else {
      const isMultiline = field.field_type === 'multiline';
      const coverDashes = field.cover_dashes === 1;
      const alignment: 'left' | 'center' | 'right' =
        field.alignment === 'center' || field.alignment === 'right' ? field.alignment : 'left';
      const quadding = alignment === 'center' ? 1 : alignment === 'right' ? 2 : 0;

      const dynamicFontSize =
        field.font_size && field.font_size >= 6 && field.font_size <= 18
          ? field.font_size
          : Number(Math.max(6.5, Math.min(10, h * 0.62)).toFixed(1));

      const daString = `/Helv ${formatNum(dynamicFontSize)} Tf 0.06 0.09 0.16 rg`;
      const sanitizedValue = sanitizeWinAnsiText(field.value ?? '');

      const bsDict = coverDashes
        ? context.obj({
            S: PDFName.of('U'),
            W: PDFNumber.of(0.75),
          })
        : context.obj({
            W: PDFNumber.of(0),
          });

      const mkDict = coverDashes
        ? context.obj({
            BG: [1, 1, 1],
            BC: [0.2, 0.2, 0.2],
          })
        : undefined;

      // Always write a clean /AP /N stream when cover_dashes is enabled or user filled a value
      // so every viewer (Acrobat, Edge, Chrome, Preview, ImageMagick/pdftoppm) renders it identically
      let apDict: PDFDict | undefined;
      if (coverDashes || sanitizedValue.length > 0) {
        const apStreamContent = buildTextAppearanceStream({
          width: w,
          height: h,
          fontSize: dynamicFontSize,
          value: sanitizedValue,
          alignment,
          isMultiline,
          coverDashes,
        });
        const apStream = context.flateStream(apStreamContent, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, w, h],
          Resources: context.obj({
            Font: context.obj({
              Helv: helvFont.ref,
            }),
          }),
        });
        const apRef = context.register(apStream);
        apDict = context.obj({ N: apRef });
      }

      const widgetDict = context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Tx'),
        T: encodePdfTextValue(uniqueName),
        TU: encodePdfTextValue(tooltip),
        Rect: [llx, lly, urx, ury],
        P: page.ref,
        F: PDFNumber.of(4), // Print flag
        Q: PDFNumber.of(quadding),
        DA: PDFString.of(daString),
        BS: bsDict,
        V: encodePdfTextValue(sanitizedValue),
      });

      if (isMultiline) {
        widgetDict.set(PDFName.of('Ff'), PDFNumber.of(4096)); // Multiline flag (bit 13)
      }
      if (mkDict) {
        widgetDict.set(PDFName.of('MK'), mkDict);
      }
      if (apDict) {
        widgetDict.set(PDFName.of('AP'), apDict);
      }

      widgetRef = context.register(widgetDict);
    }

    // Append to existing page /Annots array without ever overwriting existing annotations
    const existingAnnots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (existingAnnots) {
      existingAnnots.push(widgetRef);
    } else {
      page.node.set(PDFName.of('Annots'), context.obj([widgetRef]));
    }

    acroFieldsArray.push(widgetRef);
    fieldsWritten++;
  }

  // Register/update Catalog /AcroForm dictionary without calling updateFieldAppearances()
  // so custom vector /AP /N /Yes (✓ & ✕) and /Off streams are preserved intact.
  const acroFormDict = existingAcroForm ?? context.obj({});
  acroFormDict.set(PDFName.of('Fields'), acroFieldsArray);
  acroFormDict.set(PDFName.of('DR'), drDict);
  acroFormDict.set(PDFName.of('DA'), PDFString.of('/Helv 9 Tf 0.06 0.09 0.16 rg'));
  acroFormDict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  pdfDoc.catalog.set(PDFName.of('AcroForm'), acroFormDict);

  const savedBytes = await pdfDoc.save({ useObjectStreams: false });
  return {
    pdfBytes: savedBytes,
    fieldsWritten,
  };
}
