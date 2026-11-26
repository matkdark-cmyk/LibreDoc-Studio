import type {
  CheckboxStyle,
  FieldAlignment,
  FieldType,
  UpsertFieldInput,
} from './types';

export interface PdfTextToken {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fontSize?: number;
}

export interface VectorLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  thickness: number;
}

export interface VectorBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  source: 'rect' | 'path' | 'xobject' | 'raster';
}

export interface PageVectorLayer {
  hLines: VectorLine[];
  vLines: VectorLine[];
  boxes: VectorBox[];
  imageBoxes: VectorBox[];
}

/**
 * Injectable 150 DPI grayscale pixel provider.
 * Backed by HTML5 <canvas> in Electron/browser and by ImageMagick/pdftoppm in Node CLI tests.
 */
export interface PageRasterProvider {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pageWidthPt: number;
  readonly pageHeightPt: number;
  /** Returns grayscale luminance 0 (black) .. 255 (white) at pixel (px, py). */
  getGrayscale(px: number, py: number): number;
}

export interface PageExtractionInput {
  documentId: string;
  pageNumber: number;
  pageWidthPt: number;
  pageHeightPt: number;
  tokens: PdfTextToken[];
  vectors: PageVectorLayer;
  raster?: PageRasterProvider | null;
}

export interface PdfJsOperatorListLike {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown[] | null>;
}

export interface PdfJsOpsMap {
  save: number;
  restore: number;
  transform: number;
  moveTo: number;
  lineTo: number;
  rectangle: number;
  constructPath: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
  endPath: number;
  clip: number;
  eoClip: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  paintImageXObject: number;
  paintInlineImageXObject?: number;
  paintImageMaskXObject?: number;
  paintImageXObjectRepeat?: number;
}

type Matrix2D = [number, number, number, number, number, number];

const IDENTITY_MATRIX: Matrix2D = [1, 0, 0, 1, 0, 0];

function multiplyMatrix(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyMatrix(m: Matrix2D, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function transformRectToTopDown(
  m: Matrix2D,
  x: number,
  y: number,
  w: number,
  h: number,
  pageHeightPt: number,
  cropX: number,
  cropY: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const p1 = applyMatrix(m, x, y);
  const p2 = applyMatrix(m, x + w, y);
  const p3 = applyMatrix(m, x, y + h);
  const p4 = applyMatrix(m, x + w, y + h);

  const xs = [p1[0] - cropX, p2[0] - cropX, p3[0] - cropX, p4[0] - cropX];
  const ys = [
    pageHeightPt - (p1[1] - cropY),
    pageHeightPt - (p2[1] - cropY),
    pageHeightPt - (p3[1] - cropY),
    pageHeightPt - (p4[1] - cropY),
  ];

  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

function isArrayLikeNumeric(val: unknown): val is ArrayLike<number> {
  return (
    val !== null &&
    typeof val === 'object' &&
    typeof (val as ArrayLike<number>).length === 'number' &&
    (Array.isArray(val) || ArrayBuffer.isView(val))
  );
}

/**
 * Phase 1 (Layer 2): Extracts horizontal lines, vertical lines, boxes, and image/XObject bounds
 * using a real 2D affine CTM stack supporting both pdfjs-dist v6 interleaved `OPS.constructPath`
 * and legacy `OPS.constructPath`, plus direct path ops and `paintFormXObjectBegin/End`.
 */
export function extractVectorsWithCtm(
  opList: PdfJsOperatorListLike,
  OPS: PdfJsOpsMap,
  pageWidthPt: number,
  pageHeightPt: number,
  cropX = 0,
  cropY = 0,
): PageVectorLayer {
  const hLines: VectorLine[] = [];
  const vLines: VectorLine[] = [];
  const boxes: VectorBox[] = [];
  const imageBoxes: VectorBox[] = [];

  const stack: Matrix2D[] = [];
  let ctm: Matrix2D = [...IDENTITY_MATRIX];

  // Buffer for direct (non-constructPath) path commands
  let curX = 0;
  let curY = 0;
  let pendingSegments: Array<[number, number, number, number]> = [];
  let pendingRects: Array<[number, number, number, number]> = [];

  const toTopDownPoint = (px: number, py: number): [number, number] => {
    const [gx, gy] = applyMatrix(ctm, px, py);
    return [gx - cropX, pageHeightPt - (gy - cropY)];
  };

  const recordSegment = (ax: number, ay: number, bx: number, by: number) => {
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const y0 = Math.min(ay, by);
    const y1 = Math.max(ay, by);
    const dx = x1 - x0;
    const dy = y1 - y0;

    if (dy <= 2.5 && dx >= 10) {
      hLines.push({ x0, y0: (y0 + y1) / 2, x1, y1: (y0 + y1) / 2, thickness: Math.max(0.5, dy) });
    } else if (dx <= 2.5 && dy >= 8) {
      vLines.push({ x0: (x0 + x1) / 2, y0, x1: (x0 + x1) / 2, y1, thickness: Math.max(0.5, dx) });
    }
  };

  const recordBoxOrLine = (
    rect: { x0: number; y0: number; x1: number; y1: number },
    source: VectorBox['source'],
  ) => {
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    // Skip full-page background frames or off-page artifacts
    if (w > pageWidthPt * 0.94 && h > pageHeightPt * 0.94) return;
    if (rect.x1 < -5 || rect.x0 > pageWidthPt + 5 || rect.y1 < -5 || rect.y0 > pageHeightPt + 5) {
      return;
    }

    if (h <= 2.5 && w >= 10) {
      hLines.push({
        x0: rect.x0,
        y0: (rect.y0 + rect.y1) / 2,
        x1: rect.x1,
        y1: (rect.y0 + rect.y1) / 2,
        thickness: Math.max(0.5, h),
      });
    } else if (w <= 2.5 && h >= 8) {
      vLines.push({
        x0: (rect.x0 + rect.x1) / 2,
        y0: rect.y0,
        x1: (rect.x0 + rect.x1) / 2,
        y1: rect.y1,
        thickness: Math.max(0.5, w),
      });
    } else if (w > 5 && h > 5) {
      boxes.push({
        x0: rect.x0,
        y0: rect.y0,
        x1: rect.x1,
        y1: rect.y1,
        source,
      });
    }
  };

  const flushDirectPath = (paint: boolean) => {
    if (paint) {
      for (const [ax, ay, bx, by] of pendingSegments) {
        recordSegment(ax, ay, bx, by);
      }
      for (const [rx, ry, rw, rh] of pendingRects) {
        const rect = transformRectToTopDown(ctm, rx, ry, rw, rh, pageHeightPt, cropX, cropY);
        recordBoxOrLine(rect, 'rect');
      }
    }
    pendingSegments = [];
    pendingRects = [];
  };

  const isPaintDrawOp = (op: number): boolean =>
    op === OPS.stroke ||
    op === OPS.closeStroke ||
    op === OPS.fill ||
    op === OPS.eoFill ||
    op === OPS.fillStroke ||
    op === OPS.eoFillStroke ||
    op === OPS.closeFillStroke ||
    op === OPS.closeEOFillStroke;

  const parseInterleavedPath = (coords: ArrayLike<number>, drawOp: number) => {
    const isStroke =
      drawOp === OPS.stroke ||
      drawOp === OPS.closeStroke ||
      drawOp === OPS.fillStroke ||
      drawOp === OPS.eoFillStroke ||
      drawOp === OPS.closeFillStroke ||
      drawOp === OPS.closeEOFillStroke;

    let i = 0;
    let sx = 0;
    let sy = 0;
    let px = 0;
    let py = 0;
    let hasStart = false;
    let subPathSegs: Array<[number, number, number, number]> = [];

    const commitSubPath = () => {
      if (subPathSegs.length === 0) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let allOrtho = true;

      for (const [ax, ay, bx, by] of subPathSegs) {
        recordSegment(ax, ay, bx, by);
        minX = Math.min(minX, ax, bx);
        minY = Math.min(minY, ay, by);
        maxX = Math.max(maxX, ax, bx);
        maxY = Math.max(maxY, ay, by);
        if (Math.abs(ax - bx) > 2.5 && Math.abs(ay - by) > 2.5) {
          allOrtho = false;
        }
      }

      const w = maxX - minX;
      const h = maxY - minY;
      // Axis-aligned closed/4-segment orthogonal path represents a rectangle or thin line
      if (allOrtho && subPathSegs.length >= 3 && subPathSegs.length <= 6 && (w > 5 || h > 5)) {
        if (h <= 2.5 && w >= 10) {
          hLines.push({
            x0: minX,
            y0: (minY + maxY) / 2,
            x1: maxX,
            y1: (minY + maxY) / 2,
            thickness: Math.max(0.5, h),
          });
        } else if (w <= 2.5 && h >= 8) {
          vLines.push({
            x0: (minX + maxX) / 2,
            y0: minY,
            x1: (minX + maxX) / 2,
            y1: maxY,
            thickness: Math.max(0.5, w),
          });
        } else if (w > 5 && h > 5 && (isStroke || subPathSegs.length === 4)) {
          recordBoxOrLine({ x0: minX, y0: minY, x1: maxX, y1: maxY }, 'path');
        }
      }
      subPathSegs = [];
    };

    while (i < coords.length) {
      const cmd = coords[i++];
      if (cmd === 0) {
        // moveTo(x, y)
        commitSubPath();
        if (i + 1 >= coords.length) break;
        const [tx, ty] = toTopDownPoint(coords[i], coords[i + 1]);
        i += 2;
        sx = tx;
        sy = ty;
        px = tx;
        py = ty;
        hasStart = true;
      } else if (cmd === 1) {
        // lineTo(x, y)
        if (i + 1 >= coords.length) break;
        const [tx, ty] = toTopDownPoint(coords[i], coords[i + 1]);
        i += 2;
        if (hasStart) {
          subPathSegs.push([px, py, tx, ty]);
        }
        px = tx;
        py = ty;
      } else if (cmd === 2) {
        // curveTo(x1, y1, x2, y2, x3, y3)
        if (i + 5 >= coords.length) break;
        const [tx, ty] = toTopDownPoint(coords[i + 4], coords[i + 5]);
        i += 6;
        px = tx;
        py = ty;
      } else if (cmd === 3) {
        // quadraticCurveTo(x1, y1, x2, y2)
        if (i + 3 >= coords.length) break;
        const [tx, ty] = toTopDownPoint(coords[i + 2], coords[i + 3]);
        i += 4;
        px = tx;
        py = ty;
      } else if (cmd === 4) {
        // closePath
        if (hasStart && (Math.abs(px - sx) > 0.5 || Math.abs(py - sy) > 0.5)) {
          subPathSegs.push([px, py, sx, sy]);
        }
        px = sx;
        py = sy;
        commitSubPath();
      } else {
        break;
      }
    }
    commitSubPath();
  };

  const count = opList.fnArray.length;
  for (let idx = 0; idx < count; idx++) {
    const fn = opList.fnArray[idx];
    const args = opList.argsArray[idx] ?? [];

    if (fn === OPS.save) {
      stack.push([...ctm]);
      continue;
    }
    if (fn === OPS.restore) {
      const popped = stack.pop();
      if (popped) ctm = popped;
      continue;
    }
    if (fn === OPS.transform) {
      if (args.length >= 6) {
        const m: Matrix2D = [
          Number(args[0]),
          Number(args[1]),
          Number(args[2]),
          Number(args[3]),
          Number(args[4]),
          Number(args[5]),
        ];
        ctm = multiplyMatrix(ctm, m);
      }
      continue;
    }
    if (fn === OPS.paintFormXObjectBegin) {
      stack.push([...ctm]);
      const maybeMatrix = args[0];
      if (isArrayLikeNumeric(maybeMatrix) && maybeMatrix.length >= 6) {
        const m: Matrix2D = [
          Number(maybeMatrix[0]),
          Number(maybeMatrix[1]),
          Number(maybeMatrix[2]),
          Number(maybeMatrix[3]),
          Number(maybeMatrix[4]),
          Number(maybeMatrix[5]),
        ];
        ctm = multiplyMatrix(ctm, m);
      }
      const maybeBbox = args[1];
      if (isArrayLikeNumeric(maybeBbox) && maybeBbox.length >= 4) {
        const bx0 = Number(maybeBbox[0]);
        const by0 = Number(maybeBbox[1]);
        const bx1 = Number(maybeBbox[2]);
        const by1 = Number(maybeBbox[3]);
        const rect = transformRectToTopDown(
          ctm,
          bx0,
          by0,
          bx1 - bx0,
          by1 - by0,
          pageHeightPt,
          cropX,
          cropY,
        );
        const w = rect.x1 - rect.x0;
        const h = rect.y1 - rect.y0;
        // Word/Google Docs often export text boxes / Si-No boxes / $ boxes as Form XObjects
        if (w > 8 && h > 8 && w < pageWidthPt * 0.85 && h < pageHeightPt * 0.5) {
          recordBoxOrLine(rect, 'xobject');
        }
      }
      continue;
    }
    if (fn === OPS.paintFormXObjectEnd) {
      const popped = stack.pop();
      if (popped) ctm = popped;
      continue;
    }
    if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageMaskXObject ||
      fn === OPS.paintImageXObjectRepeat
    ) {
      const rect = transformRectToTopDown(ctm, 0, 0, 1, 1, pageHeightPt, cropX, cropY);
      const w = rect.x1 - rect.x0;
      const h = rect.y1 - rect.y0;
      if (w > 4 && h > 4 && !(w > pageWidthPt * 0.94 && h > pageHeightPt * 0.94)) {
        imageBoxes.push({ ...rect, source: 'xobject' });
      }
      continue;
    }

    if (fn === OPS.constructPath) {
      // pdfjs-dist v6 format: args = [drawOpNumber, [Float32Array], Float32Array(4) | null]
      if (typeof args[0] === 'number') {
        const drawOp = args[0];
        if (!isPaintDrawOp(drawOp)) {
          continue;
        }
        const pathContainer = args[1];
        const rawCoords =
          Array.isArray(pathContainer) && pathContainer.length > 0
            ? pathContainer[0]
            : pathContainer;
        if (isArrayLikeNumeric(rawCoords) && rawCoords.length > 0) {
          parseInterleavedPath(rawCoords, drawOp);
        } else if (isArrayLikeNumeric(args[2]) && args[2].length === 4) {
          const b = args[2];
          const rect = transformRectToTopDown(
            ctm,
            Number(b[0]),
            Number(b[1]),
            Number(b[2]) - Number(b[0]),
            Number(b[3]) - Number(b[1]),
            pageHeightPt,
            cropX,
            cropY,
          );
          recordBoxOrLine(rect, 'path');
        }
        continue;
      }

      // Legacy pdfjs-dist format: args = [subOps[], coords[]]
      if (Array.isArray(args[0]) && isArrayLikeNumeric(args[1])) {
        const subOps = args[0] as number[];
        const coords = args[1];
        let ci = 0;
        let sx = 0;
        let sy = 0;
        let lx = 0;
        let ly = 0;
        for (const sub of subOps) {
          if (sub === OPS.moveTo && ci + 1 < coords.length) {
            const [tx, ty] = toTopDownPoint(coords[ci], coords[ci + 1]);
            ci += 2;
            sx = tx;
            sy = ty;
            lx = tx;
            ly = ty;
          } else if (sub === OPS.lineTo && ci + 1 < coords.length) {
            const [tx, ty] = toTopDownPoint(coords[ci], coords[ci + 1]);
            ci += 2;
            pendingSegments.push([lx, ly, tx, ty]);
            lx = tx;
            ly = ty;
          } else if (sub === OPS.rectangle && ci + 3 < coords.length) {
            pendingRects.push([coords[ci], coords[ci + 1], coords[ci + 2], coords[ci + 3]]);
            ci += 4;
          } else if (sub === OPS.closeStroke) {
            pendingSegments.push([lx, ly, sx, sy]);
            lx = sx;
            ly = sy;
          }
        }
      }
      continue;
    }

    if (fn === OPS.moveTo && args.length >= 2) {
      const [tx, ty] = toTopDownPoint(Number(args[0]), Number(args[1]));
      curX = tx;
      curY = ty;
      continue;
    }
    if (fn === OPS.lineTo && args.length >= 2) {
      const [tx, ty] = toTopDownPoint(Number(args[0]), Number(args[1]));
      pendingSegments.push([curX, curY, tx, ty]);
      curX = tx;
      curY = ty;
      continue;
    }
    if (fn === OPS.rectangle && args.length >= 4) {
      pendingRects.push([Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3])]);
      continue;
    }
    if (isPaintDrawOp(fn)) {
      flushDirectPath(true);
      continue;
    }
    if (fn === OPS.endPath || fn === OPS.clip || fn === OPS.eoClip) {
      flushDirectPath(false);
    }
  }

  return { hLines, vLines, boxes, imageBoxes };
}

// ---------------------------------------------------------------------------
// Phase 1 (Layer 3): Grayscale 150 DPI Raster Analysis Helpers
// ---------------------------------------------------------------------------

interface InternalInkMetrics {
  darkPixels: number;
  totalPixels: number;
  darkRatio: number;
  minXPt: number;
  maxXPt: number;
  minYPt: number;
  maxYPt: number;
}

function measureInternalInkInBox(
  raster: PageRasterProvider,
  box: { x0: number; y0: number; x1: number; y1: number },
  insetPx = 5,
): InternalInkMetrics {
  const scaleX = raster.widthPx / Math.max(1, raster.pageWidthPt);
  const scaleY = raster.heightPx / Math.max(1, raster.pageHeightPt);

  const px0 = Math.max(0, Math.round(box.x0 * scaleX) + insetPx);
  const py0 = Math.max(0, Math.round(box.y0 * scaleY) + insetPx);
  const px1 = Math.min(raster.widthPx - 1, Math.round(box.x1 * scaleX) - insetPx);
  const py1 = Math.min(raster.heightPx - 1, Math.round(box.y1 * scaleY) - insetPx);

  if (px1 <= px0 || py1 <= py0) {
    return {
      darkPixels: 0,
      totalPixels: 0,
      darkRatio: 0,
      minXPt: box.x0,
      maxXPt: box.x0,
      minYPt: box.y0,
      maxYPt: box.y0,
    };
  }

  let darkPixels = 0;
  let totalPixels = 0;
  let minPx = px1;
  let maxPx = px0;
  let minPy = py1;
  let maxPy = py0;

  for (let py = py0; py <= py1; py++) {
    for (let px = px0; px <= px1; px++) {
      totalPixels++;
      const lum = raster.getGrayscale(px, py);
      if (lum < 150) {
        darkPixels++;
        if (px < minPx) minPx = px;
        if (px > maxPx) maxPx = px;
        if (py < minPy) minPy = py;
        if (py > maxPy) maxPy = py;
      }
    }
  }

  return {
    darkPixels,
    totalPixels,
    darkRatio: totalPixels > 0 ? darkPixels / totalPixels : 0,
    minXPt: darkPixels > 0 ? minPx / scaleX : box.x0,
    maxXPt: darkPixels > 0 ? maxPx / scaleX : box.x0,
    minYPt: darkPixels > 0 ? minPy / scaleY : box.y0,
    maxYPt: darkPixels > 0 ? maxPy / scaleY : box.y0,
  };
}

/**
 * Inspects the upper ascender band (top 42% of line height) to find where the actual label
 * ends before mid-height dashes (`Parentesco----`, `Fecha ----`) begin.
 */
function measureLabelEndBeforeDashesPt(
  raster: PageRasterProvider,
  searchX0Pt: number,
  searchX1Pt: number,
  lineY0Pt: number,
  lineY1Pt: number,
): number | null {
  const scaleX = raster.widthPx / Math.max(1, raster.pageWidthPt);
  const scaleY = raster.heightPx / Math.max(1, raster.pageHeightPt);

  const px0 = Math.max(0, Math.floor(searchX0Pt * scaleX));
  const px1 = Math.min(raster.widthPx - 1, Math.ceil(searchX1Pt * scaleX));
  const bandHeight = Math.max(4, lineY1Pt - lineY0Pt);
  const py0 = Math.max(0, Math.floor((lineY0Pt - 1) * scaleY));
  const py1 = Math.min(raster.heightPx - 1, Math.ceil((lineY0Pt + bandHeight * 0.42) * scaleY));

  if (px1 <= px0 || py1 <= py0) return null;

  let rightmostDarkPx = -1;
  for (let px = px1; px >= px0; px--) {
    let colDark = 0;
    for (let py = py0; py <= py1; py++) {
      if (raster.getGrayscale(px, py) < 155) {
        colDark++;
      }
    }
    if (colDark >= 2) {
      rightmostDarkPx = px;
      break;
    }
  }

  return rightmostDarkPx >= 0 ? rightmostDarkPx / scaleX : null;
}

/**
 * Raster morphological fallback for purely scanned pages with zero vector lines/boxes.
 */
function detectRasterFallbackVectors(raster: PageRasterProvider): {
  hLines: VectorLine[];
  vLines: VectorLine[];
} {
  const hLines: VectorLine[] = [];
  const vLines: VectorLine[] = [];
  const scaleX = raster.widthPx / Math.max(1, raster.pageWidthPt);
  const scaleY = raster.heightPx / Math.max(1, raster.pageHeightPt);
  const minRunH = Math.max(24, Math.round(32 * scaleX));
  const minRunV = Math.max(16, Math.round(14 * scaleY));

  // Detect horizontal runs
  for (let py = 4; py < raster.heightPx - 4; py += 2) {
    let runStart = -1;
    let gap = 0;
    for (let px = 4; px < raster.widthPx - 4; px++) {
      const dark = raster.getGrayscale(px, py) < 140;
      if (dark) {
        if (runStart < 0) runStart = px;
        gap = 0;
      } else if (runStart >= 0) {
        gap++;
        if (gap > 2) {
          const runEnd = px - gap;
          if (runEnd - runStart >= minRunH) {
            hLines.push({
              x0: runStart / scaleX,
              y0: py / scaleY,
              x1: runEnd / scaleX,
              y1: py / scaleY,
              thickness: 1,
            });
          }
          runStart = -1;
          gap = 0;
        }
      }
    }
  }

  // Detect vertical runs
  for (let px = 4; px < raster.widthPx - 4; px += 2) {
    let runStart = -1;
    let gap = 0;
    for (let py = 4; py < raster.heightPx - 4; py++) {
      const dark = raster.getGrayscale(px, py) < 140;
      if (dark) {
        if (runStart < 0) runStart = py;
        gap = 0;
      } else if (runStart >= 0) {
        gap++;
        if (gap > 2) {
          const runEnd = py - gap;
          if (runEnd - runStart >= minRunV) {
            vLines.push({
              x0: px / scaleX,
              y0: runStart / scaleY,
              x1: px / scaleX,
              y1: runEnd / scaleY,
              thickness: 1,
            });
          }
          runStart = -1;
          gap = 0;
        }
      }
    }
  }

  return { hLines, vLines };
}

// ---------------------------------------------------------------------------
// Phase 2: Geometry Reconstruction & Semantic Field Classification
// ---------------------------------------------------------------------------

interface Rect2D {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface CandidateField {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  field_type: FieldType;
  checkbox_style?: CheckboxStyle;
  alignment: FieldAlignment;
  cover_dashes: 0 | 1;
  font_size: number;
  label: string;
  group_name: string;
  origin: 'box' | 'table' | 'unicode_check' | 'line' | 'dashes';
}

function rectW(r: Rect2D): number {
  return Math.max(0, r.x1 - r.x0);
}

function rectH(r: Rect2D): number {
  return Math.max(0, r.y1 - r.y0);
}

function rectIoU(a: Rect2D, b: Rect2D): number {
  const ix0 = Math.max(a.x0, b.x0);
  const iy0 = Math.max(a.y0, b.y0);
  const ix1 = Math.min(a.x1, b.x1);
  const iy1 = Math.min(a.y1, b.y1);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const union = rectW(a) * rectH(a) + rectW(b) * rectH(b) - inter;
  return union > 0 ? inter / union : 0;
}

function rectContains(outer: Rect2D, inner: Rect2D, tol = 2.5): boolean {
  return (
    inner.x0 >= outer.x0 - tol &&
    inner.y0 >= outer.y0 - tol &&
    inner.x1 <= outer.x1 + tol &&
    inner.y1 <= outer.y1 + tol
  );
}

function clampFontSize(heightPt: number, isMultiline = false): number {
  if (isMultiline) {
    return 9.5;
  }
  const raw = heightPt * 0.62;
  return Number(Math.max(6.5, Math.min(10, raw)).toFixed(1));
}

function clusterValues(values: number[], tol = 2.5): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1];
    if (sorted[i] - last[last.length - 1] <= tol) {
      last.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }
  return clusters.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
}

/**
 * Reconstructs elementary table cells from horizontal & vertical line segments within ±2.5pt.
 */
function reconstructGridCells(
  hLines: VectorLine[],
  vLines: VectorLine[],
  tol = 3,
): VectorBox[] {
  if (hLines.length < 2 || vLines.length < 2) return [];

  // Merge collinear horizontal lines
  const hYs = clusterValues(
    hLines.map((l) => (l.y0 + l.y1) / 2),
    tol,
  );
  const mergedH: Array<{ y: number; x0: number; x1: number }> = [];
  for (const cy of hYs) {
    const segs = hLines
      .filter((l) => Math.abs((l.y0 + l.y1) / 2 - cy) <= tol)
      .sort((a, b) => a.x0 - b.x0);
    for (const seg of segs) {
      const prev = mergedH[mergedH.length - 1];
      if (prev && Math.abs(prev.y - cy) <= 0.1 && seg.x0 <= prev.x1 + tol) {
        prev.x1 = Math.max(prev.x1, seg.x1);
      } else {
        mergedH.push({ y: cy, x0: seg.x0, x1: seg.x1 });
      }
    }
  }

  // Merge collinear vertical lines
  const vXs = clusterValues(
    vLines.map((l) => (l.x0 + l.x1) / 2),
    tol,
  );
  const mergedV: Array<{ x: number; y0: number; y1: number }> = [];
  for (const cx of vXs) {
    const segs = vLines
      .filter((l) => Math.abs((l.x0 + l.x1) / 2 - cx) <= tol)
      .sort((a, b) => a.y0 - b.y0);
    for (const seg of segs) {
      const prev = mergedV[mergedV.length - 1];
      if (prev && Math.abs(prev.x - cx) <= 0.1 && seg.y0 <= prev.y1 + tol) {
        prev.y1 = Math.max(prev.y1, seg.y1);
      } else {
        mergedV.push({ x: cx, y0: seg.y0, y1: seg.y1 });
      }
    }
  }

  const hasHSegment = (y: number, x0: number, x1: number) =>
    mergedH.some((h) => Math.abs(h.y - y) <= tol && h.x0 <= x0 + tol && h.x1 >= x1 - tol);

  const hasVSegment = (x: number, y0: number, y1: number) =>
    mergedV.some((v) => Math.abs(v.x - x) <= tol && v.y0 <= y0 + tol && v.y1 >= y1 - tol);

  const cells: VectorBox[] = [];

  for (let yi = 0; yi < hYs.length - 1; yi++) {
    const topY = hYs[yi];
    for (let xi = 0; xi < vXs.length - 1; xi++) {
      const leftX = vXs[xi];

      // Find nearest right vertical boundary reachable along topY
      let rightX: number | null = null;
      for (let xj = xi + 1; xj < vXs.length; xj++) {
        if (!hasHSegment(topY, leftX, vXs[xj])) break;
        // Check if there's a vertical segment starting at (vXs[xj], topY)
        const hasRightDown = mergedV.some(
          (v) => Math.abs(v.x - vXs[xj]) <= tol && v.y0 <= topY + tol && v.y1 > topY + 6,
        );
        if (hasRightDown) {
          rightX = vXs[xj];
          break;
        }
      }
      if (rightX === null || rightX - leftX < 6) continue;

      // Find nearest bottom horizontal boundary closing [leftX, rightX]
      let bottomY: number | null = null;
      for (let yj = yi + 1; yj < hYs.length; yj++) {
        const candY = hYs[yj];
        if (!hasVSegment(leftX, topY, candY) || !hasVSegment(rightX, topY, candY)) break;
        if (hasHSegment(candY, leftX, rightX)) {
          bottomY = candY;
          break;
        }
      }
      if (bottomY === null || bottomY - topY < 6) continue;

      cells.push({
        x0: leftX,
        y0: topY,
        x1: rightX,
        y1: bottomY,
        source: 'rect',
      });
    }
  }

  return cells;
}

function deduplicateBoxes(rawBoxes: VectorBox[]): VectorBox[] {
  const unique: VectorBox[] = [];
  for (const box of rawBoxes) {
    const w = rectW(box);
    const h = rectH(box);
    if (w < 6 || h < 6) continue;
    const dupIdx = unique.findIndex(
      (u) =>
        rectIoU(u, box) > 0.72 ||
        (Math.abs(u.x0 - box.x0) <= 3 &&
          Math.abs(u.y0 - box.y0) <= 3 &&
          Math.abs(u.x1 - box.x1) <= 3 &&
          Math.abs(u.y1 - box.y1) <= 3),
    );
    if (dupIdx === -1) {
      unique.push(box);
    } else {
      // Prefer tighter rectangle/table cell over looser XObject wrapper
      const existing = unique[dupIdx];
      if (existing.source === 'xobject' && box.source !== 'xobject') {
        unique[dupIdx] = box;
      }
    }
  }

  // Drop outer frame containers that strictly enclose >= 2 inner boxes
  return unique.filter((outer, idx) => {
    let enclosedCount = 0;
    const outerArea = rectW(outer) * rectH(outer);
    for (let j = 0; j < unique.length; j++) {
      if (idx === j) continue;
      const inner = unique[j];
      const innerArea = rectW(inner) * rectH(inner);
      if (innerArea < outerArea * 0.85 && rectContains(outer, inner, 3)) {
        enclosedCount++;
        if (enclosedCount >= 2) return false;
      }
    }
    return true;
  });
}

function normalizePlainText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function slugifyFieldName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 42);
}

function isSiNoKeyword(text: string): 'Si' | 'No' | null {
  const clean = text.trim().replace(/[:.,;()]/g, '').toLowerCase();
  if (clean === 'si' || clean === 'sí') return 'Si';
  if (clean === 'no') return 'No';
  return null;
}

function isPurePunctuationOrDashes(text: string): boolean {
  return /^[\s_\-–—.:/]+$/.test(text);
}

interface TextLine {
  y0: number;
  y1: number;
  midY: number;
  x0: number;
  x1: number;
  text: string;
  tokens: PdfTextToken[];
}

function groupTokensIntoLines(tokens: PdfTextToken[]): TextLine[] {
  const sorted = [...tokens]
    .filter((t) => t.text.trim().length > 0)
    .sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);

  const lines: TextLine[] = [];
  for (const tok of sorted) {
    const midY = (tok.y0 + tok.y1) / 2;
    const match = lines.find((line) => Math.abs(line.midY - midY) <= Math.max(4, (line.y1 - line.y0) * 0.55));
    if (match) {
      match.tokens.push(tok);
      match.y0 = Math.min(match.y0, tok.y0);
      match.y1 = Math.max(match.y1, tok.y1);
      match.x0 = Math.min(match.x0, tok.x0);
      match.x1 = Math.max(match.x1, tok.x1);
      match.midY = (match.y0 + match.y1) / 2;
    } else {
      lines.push({
        y0: tok.y0,
        y1: tok.y1,
        midY,
        x0: tok.x0,
        x1: tok.x1,
        text: '',
        tokens: [tok],
      });
    }
  }

  for (const line of lines) {
    line.tokens.sort((a, b) => a.x0 - b.x0);
    line.text = normalizePlainText(line.tokens.map((t) => t.text).join(' '));
  }

  return lines.sort((a, b) => a.y0 - b.y0);
}

function findSectionHeadingAbove(lines: TextLine[], y0: number, fallback: string): string {
  let best: string | null = null;
  for (const line of lines) {
    if (line.y1 > y0 + 2) break;
    const t = line.text;
    if (
      /^(I|II|III|IV|V|VI|VII|VIII|IX|X)\.\s*\S/i.test(t) ||
      /^Comprobante de Recepci/i.test(t) ||
      /^Solicitud de /i.test(t) ||
      /^Otros antecedentes/i.test(t) ||
      /^Otras Situaciones/i.test(t) ||
      /^Documentaci[oó]n/i.test(t) ||
      /^Secci[oó]n\s/i.test(t)
    ) {
      best = t.replace(/[:.]+$/, '').slice(0, 56);
    }
  }
  return best ?? fallback;
}

function findNearestLabelForRect(
  rect: Rect2D,
  lines: TextLine[],
  tokens: PdfTextToken[],
  fallbackLabel: string,
): string {
  const midY = (rect.y0 + rect.y1) / 2;

  // 1. Look directly to the left on the same row (classic 2-column table or inline label)
  const leftTokens = tokens
    .filter(
      (t) =>
        t.x1 <= rect.x0 + 8 &&
        rect.x0 - t.x1 <= 260 &&
        Math.abs((t.y0 + t.y1) / 2 - midY) <= Math.max(11, rectH(rect) * 0.65) &&
        !isPurePunctuationOrDashes(t.text) &&
        !/^[☐□▢]$/.test(t.text.trim()),
    )
    .sort((a, b) => a.x0 - b.x0);

  if (leftTokens.length > 0) {
    const joined = normalizePlainText(leftTokens.map((t) => t.text).join(' '))
      .replace(/[:\-–—_]+$/, '')
      .trim();
    if (joined.length >= 2) return joined.slice(0, 68);
  }

  // 2. Look immediately above the box (header or question above answer box)
  const aboveLines = lines
    .filter(
      (l) =>
        l.y1 <= rect.y0 + 3 &&
        rect.y0 - l.y1 <= 28 &&
        l.x1 >= rect.x0 - 40 &&
        l.x0 <= rect.x1 + 40 &&
        !isPurePunctuationOrDashes(l.text),
    )
    .sort((a, b) => b.y1 - a.y1);

  if (aboveLines.length > 0) {
    const txt = aboveLines[0].text.replace(/[:\-–—_]+$/, '').trim();
    if (txt.length >= 2) return txt.slice(0, 68);
  }

  // 3. Look immediately below (signature lines like "Nombre y Firma del apoderado.")
  const belowLines = lines
    .filter(
      (l) =>
        l.y0 >= rect.y1 - 3 &&
        l.y0 - rect.y1 <= 22 &&
        l.x1 >= rect.x0 - 20 &&
        l.x0 <= rect.x1 + 20 &&
        !isPurePunctuationOrDashes(l.text),
    )
    .sort((a, b) => a.y0 - b.y0);

  if (belowLines.length > 0) {
    const txt = belowLines[0].text.replace(/[:.]+$/, '').trim();
    if (txt.length >= 2) return txt.slice(0, 68);
  }

  return fallbackLabel;
}

function findSiNoLabelNearBox(
  box: Rect2D,
  tokens: PdfTextToken[],
): { keyword: 'Si' | 'No'; token: PdfTextToken } | null {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  let best: { keyword: 'Si' | 'No'; token: PdfTextToken; dist: number } | null = null;

  for (const tok of tokens) {
    const kw = isSiNoKeyword(tok.text);
    if (!kw) continue;

    const tcx = (tok.x0 + tok.x1) / 2;
    const tcy = (tok.y0 + tok.y1) / 2;

    // Below or above box with horizontal alignment
    const alignedVert =
      tcx >= box.x0 - 20 &&
      tcx <= box.x1 + 20 &&
      ((tok.y0 >= box.y1 - 4 && tok.y0 - box.y1 <= 28) ||
        (box.y0 >= tok.y1 - 4 && box.y0 - tok.y1 <= 24));

    // Left or right of box on the same horizontal band
    const alignedHoriz =
      Math.abs(tcy - cy) <= Math.max(14, rectH(box) * 0.7) &&
      ((tok.x0 >= box.x1 - 4 && tok.x0 - box.x1 <= 24) ||
        (box.x0 >= tok.x1 - 4 && box.x0 - tok.x1 <= 24));

    if (!alignedVert && !alignedHoriz) continue;

    const dist = Math.hypot(tcx - cx, tcy - cy);
    if (!best || dist < best.dist) {
      best = { keyword: kw, token: tok, dist };
    }
  }

  return best ? { keyword: best.keyword, token: best.token } : null;
}

/**
 * Splits combined tokens like `Parentesco----------------------------------` or `Fecha______`
 * into separate label + dash/underscore tokens so mid-height dashes & underlines are always isolated.
 */
function normalizeInputTokens(rawTokens: PdfTextToken[]): PdfTextToken[] {
  const out: PdfTextToken[] = [];
  const pattern = /([-–—]{3,}|_{3,})/;

  for (const tok of rawTokens) {
    if (!tok.text || tok.text.trim().length === 0) continue;
    const match = pattern.exec(tok.text);
    if (!match || match[0].length === tok.text.length) {
      out.push(tok);
      continue;
    }

    // Split proportionally by character length
    const parts = tok.text.split(/([-–—]{3,}|_{3,})/).filter((p) => p.length > 0);
    const totalLen = tok.text.length;
    const totalW = Math.max(1, tok.x1 - tok.x0);
    let charOffset = 0;
    for (const part of parts) {
      const trimmed = part.trim();
      const startRatio = charOffset / totalLen;
      const endRatio = (charOffset + part.length) / totalLen;
      charOffset += part.length;
      if (!trimmed) continue;
      out.push({
        text: trimmed,
        x0: tok.x0 + totalW * startRatio,
        y0: tok.y0,
        x1: tok.x0 + totalW * endRatio,
        y1: tok.y1,
        fontSize: tok.fontSize,
      });
    }
  }

  return out;
}

/**
 * Phase 2: Classifies a single page's hybrid extraction layers (text + CTM vectors + optional raster)
 * into clean, non-overlapping, tab-ordered AcroForm field definitions (`UpsertFieldInput[]`).
 */
export function classifyPageFormFields(
  input: PageExtractionInput,
  usedFieldNames?: Set<string>,
): UpsertFieldInput[] {
  const { documentId, pageNumber, pageWidthPt, pageHeightPt, raster } = input;
  const tokens = normalizeInputTokens(input.tokens);
  let { hLines, vLines, boxes, imageBoxes } = input.vectors;

  // Raster morphological fallback if page has no vectors at all (scanned PDF)
  if (hLines.length === 0 && vLines.length === 0 && boxes.length === 0 && imageBoxes.length === 0 && raster) {
    const fallback = detectRasterFallbackVectors(raster);
    hLines = fallback.hLines;
    vLines = fallback.vLines;
  }

  // Promote Word/Google Docs form-shaped image XObjects (e.g. V.1/V.3 `$` boxes and Si/No boxes)
  // while rejecting header logos (y0 < 120 && h > 50) and dense raster illustrations/photos.
  const promotedImageBoxes: VectorBox[] = [];
  for (const img of imageBoxes) {
    const w = rectW(img);
    const h = rectH(img);
    // Reject top header logos / tall banners / tiny bullets
    if (w < 18 || h < 12 || h > 52 || w > pageWidthPt * 0.78) continue;
    if (img.y0 < 125 && h > 42) continue;

    if (raster) {
      const ink = measureInternalInkInBox(raster, img, 5);
      // Allow empty interior (Si/No box) OR small left-edge prefix symbol (`$` in V.1/V.3)
      const isEmptyInterior = ink.darkRatio < 0.015;
      const isLeftEdgePrefix =
        ink.darkPixels > 0 &&
        ink.darkRatio < 0.12 &&
        ink.maxXPt < img.x0 + w * 0.35 &&
        w >= 55;
      if (!isEmptyInterior && !isLeftEdgePrefix) {
        continue;
      }
    }

    promotedImageBoxes.push({ ...img, source: 'xobject' });
  }

  const lines = groupTokensIntoLines(tokens);
  const gridCells = reconstructGridCells(hLines, vLines, 3);
  const allBoxes = deduplicateBoxes([...gridCells, ...boxes, ...promotedImageBoxes]);

  const candidates: CandidateField[] = [];
  const usedBoxRects: Rect2D[] = [];

  // 1. Classify boxes & table cells
  for (const box of allBoxes) {
    const w = rectW(box);
    const h = rectH(box);
    if (w < 7 || h < 7) continue;

    // Filter out boxes sitting on top of non-promoted header logos / photos
    const overlapsNonFormImage = imageBoxes.some((img) => {
      const wasPromoted = promotedImageBoxes.some((p) => rectIoU(p, img) > 0.8);
      if (wasPromoted) return false;
      const iou = rectIoU(box, img);
      if (iou > 0.3) return true;
      const cx = (box.x0 + box.x1) / 2;
      const cy = (box.y0 + box.y1) / 2;
      return cx >= img.x0 && cx <= img.x1 && cy >= img.y0 && cy <= img.y1;
    });

    const insideTokens = tokens.filter((t) => {
      const cx = (t.x0 + t.x1) / 2;
      const cy = (t.y0 + t.y1) / 2;
      return (
        cx >= box.x0 + 1 &&
        cx <= box.x1 - 1 &&
        cy >= box.y0 + 1 &&
        cy <= box.y1 - 1 &&
        t.text.trim().length > 0
      );
    });

    const insideText = normalizePlainText(insideTokens.map((t) => t.text).join(' '));

    // Skip logos/pictures
    if (overlapsNonFormImage && insideTokens.length === 0) {
      continue;
    }

    // Also skip top-margin decorative logos even without imageBox record
    if (box.y0 < 120 && w < 200 && h > 42 && insideTokens.length === 0) {
      if (!raster || measureInternalInkInBox(raster, box, 4).darkRatio > 0.03) {
        continue;
      }
    }

    const sectionName = findSectionHeadingAbove(lines, box.y0, `Página ${pageNumber}`);

    // Case 1A: Box contains date mask like "/" or "/ /2026" or "/2026"
    if (
      insideTokens.length > 0 &&
      /^[\s/0-9]*\/[\s/0-9]*$/.test(insideText) &&
      !/[a-zA-Z]{2,}/.test(insideText)
    ) {
      const slashes = insideTokens
        .filter((t) => t.text.includes('/'))
        .sort((a, b) => a.x0 - b.x0);
      const baseLabel = findNearestLabelForRect(box, lines, tokens, 'Fecha');

      // Find exact X positions of `/` characters or fixed year tokens like `/2026`
      const splitParts: Array<{ x0: number; x1: number; suffix: string }> = [];
      let cursor = box.x0 + 2;
      const partNames = ['Día', 'Mes', 'Año'];
      let partIdx = 0;

      for (const tok of slashes) {
        const trimmed = tok.text.trim();
        // Token could be "/", "/2026", or "/ /2026"
        if (trimmed === '/') {
          if (tok.x0 - cursor >= 12) {
            splitParts.push({
              x0: cursor,
              x1: tok.x0 - 2,
              suffix: partNames[partIdx++] ?? `Parte ${partIdx}`,
            });
          }
          cursor = tok.x1 + 2;
        } else if (/^\/\s*20\d{2}$/.test(trimmed)) {
          // Fixed year e.g. "/2026": split remaining space before `/2026` into Día / Mes or single segment
          const gapW = tok.x0 - cursor;
          if (partIdx === 0 && gapW >= 36) {
            const mid = cursor + gapW / 2;
            splitParts.push({ x0: cursor, x1: mid - 2, suffix: 'Día' });
            splitParts.push({ x0: mid + 2, x1: tok.x0 - 2, suffix: 'Mes' });
          } else if (gapW >= 12) {
            splitParts.push({
              x0: cursor,
              x1: tok.x0 - 2,
              suffix: partNames[partIdx++] ?? 'Mes',
            });
          }
          cursor = box.x1; // year is pre-printed, do not cover it
        } else {
          // Multiple slashes in single token e.g. "  /   /2026"
          const slashCount = (trimmed.match(/\//g) ?? []).length;
          const hasFixedYear = /20\d{2}$/.test(trimmed);
          const usableEnd = hasFixedYear ? tok.x0 + (tok.x1 - tok.x0) * 0.55 : box.x1 - 2;
          const segCount = hasFixedYear ? Math.max(2, slashCount) : slashCount + 1;
          const segW = (usableEnd - (box.x0 + 2)) / segCount;
          for (let s = 0; s < segCount; s++) {
            const sx0 = box.x0 + 2 + s * segW;
            const sx1 = sx0 + segW - 6;
            if (sx1 - sx0 >= 10) {
              splitParts.push({
                x0: sx0,
                x1: sx1,
                suffix: partNames[s] ?? `Parte ${s + 1}`,
              });
            }
          }
          cursor = box.x1;
        }
      }

      if (box.x1 - 2 - cursor >= 14 && !/20\d{2}/.test(insideText)) {
        splitParts.push({
          x0: cursor,
          x1: box.x1 - 2,
          suffix: partNames[partIdx] ?? 'Año',
        });
      }

      if (splitParts.length > 0) {
        usedBoxRects.push(box);
        for (const part of splitParts) {
          candidates.push({
            x0: part.x0,
            y0: box.y0 + 1.5,
            x1: part.x1,
            y1: box.y1 - 1.5,
            field_type: 'text',
            alignment: 'center',
            cover_dashes: 0,
            font_size: clampFontSize(h - 3),
            label: `${baseLabel} (${part.suffix})`,
            group_name: sectionName,
            origin: 'table',
          });
        }
        continue;
      }
    }

    // Case 1B: Box contains only `$` or `N°`/`Nº` prefix -> fillable starting after prefix
    const onlyCurrencyPrefix =
      insideTokens.length > 0 &&
      insideTokens.every((t) => /^(\$|N[°º]?|\s)+$/i.test(t.text.trim()));

    if (onlyCurrencyPrefix) {
      const lastPrefix = insideTokens.reduce((max, t) => (t.x1 > max.x1 ? t : max), insideTokens[0]);
      const fx0 = Math.min(box.x1 - 14, lastPrefix.x1 + 3);
      const fx1 = box.x1 - 2;
      if (fx1 - fx0 >= 12) {
        usedBoxRects.push(box);
        candidates.push({
          x0: fx0,
          y0: box.y0 + 1.5,
          x1: fx1,
          y1: box.y1 - 1.5,
          field_type: 'text',
          alignment: 'left',
          cover_dashes: 0,
          font_size: clampFontSize(h - 3),
          label: findNearestLabelForRect(box, lines, tokens, 'Monto'),
          group_name: sectionName,
          origin: 'box',
        });
      }
      continue;
    }

    // Case 1C: Box contains non-empty fixed/prefilled text -> SKIP (labels, headers, fixed info boxes)
    if (insideTokens.length > 0) {
      // Exception: box contains only underscores/dashes
      if (!isPurePunctuationOrDashes(insideText)) {
        usedBoxRects.push(box);
        continue;
      }
    }

    // Box has NO text tokens inside. Check raster ink if available (e.g. `$` drawn as XObject image, or dense logo)
    let leftInkOffsetPt: number | null = null;
    if (raster) {
      const ink = measureInternalInkInBox(raster, box, 5);
      if (ink.darkPixels > 0) {
        // Dense non-form content (e.g., rasterized logo, scanned paragraph inside fixed box)
        if (ink.darkRatio > 0.14 || (ink.maxXPt - ink.minXPt > w * 0.45 && ink.darkRatio > 0.035)) {
          usedBoxRects.push(box);
          continue;
        }
        // Small symbol on the left edge (like `$` drawn as image inside V.1 / V.3 XObject boxes)
        if (
          ink.darkRatio > 0.0015 &&
          ink.maxXPt < box.x0 + w * 0.35 &&
          w >= 55 &&
          h >= 12 &&
          h <= 45
        ) {
          leftInkOffsetPt = ink.maxXPt + 3;
        }
      }
    }

    // Case 1D: Small/medium empty box adjacent to `Si`/`Sí`/`No` -> Checkbox (cross ✕)
    if (leftInkOffsetPt === null && w <= 95 && h <= 45) {
      const siNoMatch = findSiNoLabelNearBox(box, tokens);
      if (siNoMatch) {
        const questionContext = findNearestLabelForRect(
          { x0: 40, y0: box.y0 - 26, x1: pageWidthPt - 40, y1: box.y0 },
          lines,
          tokens,
          sectionName,
        );
        usedBoxRects.push(box);
        candidates.push({
          x0: box.x0 + 1,
          y0: box.y0 + 1,
          x1: box.x1 - 1,
          y1: box.y1 - 1,
          field_type: 'checkbox',
          checkbox_style: 'cross',
          alignment: 'center',
          cover_dashes: 0,
          font_size: clampFontSize(h),
          label: `${questionContext.slice(0, 44)} — ${siNoMatch.keyword}`,
          group_name: sectionName,
          origin: 'box',
        });
        continue;
      }
    }

    // Case 1E: Small empty square box (7..22pt) -> Checkbox (check ✓)
    if (leftInkOffsetPt === null && w >= 7 && w <= 22 && h >= 7 && h <= 22 && Math.abs(w - h) <= 6) {
      usedBoxRects.push(box);
      candidates.push({
        x0: box.x0,
        y0: box.y0,
        x1: box.x1,
        y1: box.y1,
        field_type: 'checkbox',
        checkbox_style: 'check',
        alignment: 'center',
        cover_dashes: 0,
        font_size: clampFontSize(h),
        label: findNearestLabelForRect(box, lines, tokens, 'Opción'),
        group_name: sectionName,
        origin: 'box',
      });
      continue;
    }

    // Case 1F: Standard empty fillable box / table cell
    const fx0 = leftInkOffsetPt !== null ? Math.min(box.x1 - 16, leftInkOffsetPt) : box.x0 + 2;
    const fx1 = box.x1 - 2;
    const fy0 = box.y0 + 1.5;
    const fy1 = box.y1 - 1.5;
    if (fx1 - fx0 < 10 || fy1 - fy0 < 6) continue;

    const isMultiline = fy1 - fy0 >= 38;
    usedBoxRects.push(box);
    candidates.push({
      x0: fx0,
      y0: fy0,
      x1: fx1,
      y1: fy1,
      field_type: isMultiline ? 'multiline' : 'text',
      alignment: 'left',
      cover_dashes: 0,
      font_size: clampFontSize(fy1 - fy0, isMultiline),
      label: findNearestLabelForRect(
        box,
        lines,
        tokens,
        leftInkOffsetPt !== null ? 'Monto ($)' : `Campo página ${pageNumber}`,
      ),
      group_name: sectionName,
      origin: box.source === 'xobject' ? 'box' : 'table',
    });
  }

  // 2. Merge stacked single-column wide empty rows (e.g., Word 5-8 row answer boxes like "Otras Situaciones")
  const mergedCandidates = mergeStackedFullWidthEmptyRows(candidates, allBoxes);

  // 3. Detect Unicode checkboxes (`☐`, `□`, `▢`)
  for (const tok of tokens) {
    const trimmed = tok.text.trim();
    if (!/[☐□▢]/.test(trimmed)) continue;

    // Extract square bbox around the Unicode checkbox glyph
    const glyphSize = Math.max(11, Math.min(18, Math.max(tok.y1 - tok.y0, 12)));
    const cx0 = tok.x0;
    const cy0 = tok.y0 + (tok.y1 - tok.y0 - glyphSize) / 2;
    const rect: Rect2D = {
      x0: cx0,
      y0: cy0,
      x1: cx0 + glyphSize,
      y1: cy0 + glyphSize,
    };

    // Skip if already covered by an existing checkbox candidate
    if (mergedCandidates.some((c) => rectIoU(c, rect) > 0.35)) continue;

    // Label is typically to the right on the same line
    const sameLineRight = tokens
      .filter(
        (other) =>
          other !== tok &&
          other.x0 >= tok.x1 - 2 &&
          Math.abs((other.y0 + other.y1) / 2 - (tok.y0 + tok.y1) / 2) <= 8,
      )
      .sort((a, b) => a.x0 - b.x0);

    const rightLabel = normalizePlainText(sameLineRight.map((t) => t.text).join(' '))
      .replace(/^\d+[.)]\s*/, '')
      .replace(/[:.]+$/, '')
      .trim();

    const sectionName = findSectionHeadingAbove(lines, rect.y0, `Documentos (Pág. ${pageNumber})`);
    mergedCandidates.push({
      x0: rect.x0,
      y0: rect.y0,
      x1: rect.x1,
      y1: rect.y1,
      field_type: 'checkbox',
      checkbox_style: 'check',
      alignment: 'center',
      cover_dashes: 0,
      font_size: 9,
      label: rightLabel ? rightLabel.slice(0, 68) : `Casilla pág. ${pageNumber}`,
      group_name: sectionName,
      origin: 'unicode_check',
    });
  }

  // 4. Detect mid-height dash runs (`----+`, `– – –`) -> cover_dashes: 1
  for (const line of lines) {
    const dashSpans: Array<{ x0: number; x1: number; y0: number; y1: number; tokens: PdfTextToken[] }> =
      [];

    for (const tok of line.tokens) {
      const t = tok.text.trim();
      if (!/^[-–—]{2,}$/.test(t) && !/^[-–—](\s*[-–—]){2,}$/.test(t)) continue;

      const prev = dashSpans[dashSpans.length - 1];
      if (prev && tok.x0 - prev.x1 <= 10) {
        prev.x1 = Math.max(prev.x1, tok.x1);
        prev.y0 = Math.min(prev.y0, tok.y0);
        prev.y1 = Math.max(prev.y1, tok.y1);
        prev.tokens.push(tok);
      } else {
        dashSpans.push({
          x0: tok.x0,
          x1: tok.x1,
          y0: tok.y0,
          y1: tok.y1,
          tokens: [tok],
        });
      }
    }

    for (const span of dashSpans) {
      const spanW = span.x1 - span.x0;
      const totalDashChars = span.tokens.map((t) => t.text).join('').replace(/\s+/g, '').length;
      if (spanW < 24 || totalDashChars < 4) continue;

      // Skip if inside an already classified box
      if (usedBoxRects.some((b) => rectContains(b, span, 3))) continue;

      // Check label to the left on the same line
      const leftLabelTokens = line.tokens.filter(
        (t) => t.x1 <= span.x0 + 4 && !/^[-–—]+$/.test(t.text.trim()),
      );
      let fieldX0 = span.x0 - 1;
      if (leftLabelTokens.length > 0) {
        const lastLeft = leftLabelTokens[leftLabelTokens.length - 1];
        fieldX0 = Math.max(fieldX0, lastLeft.x1 + 3);
        if (raster) {
          const rasterEnd = measureLabelEndBeforeDashesPt(
            raster,
            Math.max(0, lastLeft.x0),
            Math.min(pageWidthPt, span.x0 + 6),
            line.y0,
            line.y1,
          );
          if (rasterEnd !== null && rasterEnd > lastLeft.x0) {
            fieldX0 = Math.max(fieldX0, rasterEnd + 3);
          }
        }
      }

      const fieldX1 = Math.min(pageWidthPt - 12, span.x1 + 2);
      if (fieldX1 - fieldX0 < 20) continue;

      // Check if "Firma" appears right below the dashed line
      const belowFirma = lines.find(
        (l) =>
          l.y0 >= span.y1 - 2 &&
          l.y0 - span.y1 <= 20 &&
          l.x1 >= fieldX0 - 15 &&
          l.x0 <= fieldX1 + 15 &&
          /firma/i.test(l.text),
      );

      const midY = (span.y0 + span.y1) / 2;
      const h = belowFirma ? 16 : 13.5;
      const fy0 = belowFirma ? midY - 12 : midY - h * 0.58;
      const fy1 = fy0 + h;

      const labelText =
        belowFirma?.text.replace(/[:.]+$/, '').trim() ||
        normalizePlainText(leftLabelTokens.map((t) => t.text).join(' '))
          .replace(/^[•·\-–—*]+\s*/, '')
          .replace(/[:\-–—]+$/, '')
          .trim() ||
        findNearestLabelForRect({ x0: fieldX0, y0: fy0, x1: fieldX1, y1: fy1 }, lines, tokens, 'Campo');

      const sectionName = findSectionHeadingAbove(lines, fy0, `Página ${pageNumber}`);
      mergedCandidates.push({
        x0: fieldX0,
        y0: fy0,
        x1: fieldX1,
        y1: fy1,
        field_type: 'text',
        alignment: belowFirma ? 'center' : 'left',
        cover_dashes: 1,
        font_size: clampFontSize(h),
        label: labelText.slice(0, 68),
        group_name: sectionName,
        origin: 'dashes',
      });
    }
  }

  // 5. Detect underscore runs (`____+`) and standalone horizontal vector lines
  const lineSpans: Array<{ x0: number; x1: number; y: number }> = [];

  // 5a. Underscore text tokens
  for (const line of lines) {
    for (const tok of line.tokens) {
      if (!/_{4,}/.test(tok.text)) continue;
      if (usedBoxRects.some((b) => rectContains(b, tok, 3))) continue;
      lineSpans.push({ x0: tok.x0, x1: tok.x1, y: tok.y1 - 1 });
    }
  }

  // 5b. Standalone horizontal vector lines (not part of any detected box/table border, not header/footer divider)
  const mergedFreeHLines = mergeFreeHorizontalLines(hLines, allBoxes, pageWidthPt, pageHeightPt);
  for (const hl of mergedFreeHLines) {
    const lineW = hl.x1 - hl.x0;
    if (lineW < 36) continue;
    // Skip pure header/footer horizontal rules
    if (hl.y < 65 || hl.y > pageHeightPt - 45) continue;

    // Skip if text is sitting directly ON top of this horizontal line (it's an underline of a title, not an empty fill line!)
    const textDirectlyAbove = tokens.filter(
      (t) =>
        t.x1 > hl.x0 + 4 &&
        t.x0 < hl.x1 - 4 &&
        t.y1 >= hl.y - 13 &&
        t.y1 <= hl.y + 2 &&
        !isPurePunctuationOrDashes(t.text),
    );
    const coveredWidth = textDirectlyAbove.reduce((sum, t) => sum + (t.x1 - t.x0), 0);
    if (coveredWidth > lineW * 0.45) {
      // Check if there is still an open fillable tail to the right of the text (e.g., "Año Escolar ______")
      const rightmostTextX = Math.max(...textDirectlyAbove.map((t) => t.x1));
      if (hl.x1 - (rightmostTextX + 4) >= 34) {
        lineSpans.push({ x0: rightmostTextX + 4, x1: hl.x1, y: hl.y });
      }
      continue;
    }

    // If a short label sits at the left end of the line, start field after it
    let startX = hl.x0;
    if (textDirectlyAbove.length > 0) {
      const rightMost = Math.max(...textDirectlyAbove.map((t) => t.x1));
      if (rightMost < hl.x0 + lineW * 0.55) {
        startX = rightMost + 4;
      }
    }

    if (hl.x1 - startX >= 30) {
      lineSpans.push({ x0: startX, x1: hl.x1, y: hl.y });
    }
  }

  for (const span of lineSpans) {
    const belowFirma = lines.find(
      (l) =>
        l.y0 >= span.y - 2 &&
        l.y0 - span.y <= 18 &&
        l.x1 >= span.x0 - 15 &&
        l.x0 <= span.x1 + 15 &&
        /firma/i.test(l.text),
    );

    const h = belowFirma ? 16 : 13.5;
    const rect: Rect2D = {
      x0: span.x0,
      y0: Math.max(4, span.y - h - 0.5),
      x1: span.x1,
      y1: Math.max(10, span.y - 0.5),
    };

    // Skip if overlaps any already accepted candidate
    if (mergedCandidates.some((c) => rectIoU(c, rect) > 0.25)) continue;
    if (usedBoxRects.some((b) => rectContains(b, rect, 3))) continue;

    const sectionName = findSectionHeadingAbove(lines, rect.y0, `Página ${pageNumber}`);
    const label =
      belowFirma?.text.replace(/[:.]+$/, '').trim() ||
      findNearestLabelForRect(rect, lines, tokens, `Línea pág. ${pageNumber}`);

    mergedCandidates.push({
      x0: rect.x0,
      y0: rect.y0,
      x1: rect.x1,
      y1: rect.y1,
      field_type: 'text',
      alignment: belowFirma ? 'center' : 'left',
      cover_dashes: 0,
      font_size: clampFontSize(h),
      label: label.slice(0, 68),
      group_name: sectionName,
      origin: 'line',
    });
  }

  // 6. Final deduplication + strict Tab Order: sort by (round(y0 / 4), x0)
  const finalCandidates: CandidateField[] = [];
  const sorted = [...mergedCandidates].sort(
    (a, b) => Math.round(a.y0 / 4) - Math.round(b.y0 / 4) || a.x0 - b.x0,
  );

  for (const cand of sorted) {
    const overlapsExisting = finalCandidates.some((f) => rectIoU(f, cand) > 0.45);
    if (overlapsExisting) continue;
    finalCandidates.push(cand);
  }

  // 7. Convert to UpsertFieldInput with guaranteed unique semantic /T field names
  const nameRegistry = usedFieldNames ?? new Set<string>();
  return finalCandidates.map((cand, idx) => {
    const baseSlug = slugifyFieldName(cand.label) || `campo_${idx + 1}`;
    const prefix = cand.field_type === 'checkbox' ? `p${pageNumber}_chk_` : `p${pageNumber}_`;
    let fieldName = `${prefix}${baseSlug}`;
    let suffix = 2;
    while (nameRegistry.has(fieldName)) {
      fieldName = `${prefix}${baseSlug}_${suffix++}`;
    }
    nameRegistry.add(fieldName);

    const x = Number(Math.max(0, cand.x0).toFixed(2));
    const y = Number(Math.max(0, cand.y0).toFixed(2));
    const width = Number(Math.max(8, cand.x1 - cand.x0).toFixed(2));
    const height = Number(Math.max(8, cand.y1 - cand.y0).toFixed(2));

    return {
      document_id: documentId,
      page_number: pageNumber,
      label: cand.label,
      value: cand.field_type === 'checkbox' ? 'false' : '',
      field_type: cand.field_type,
      x,
      y,
      width,
      height,
      font_size: cand.font_size,
      group_name: cand.group_name,
      sort_order: idx,
      checkbox_style: cand.field_type === 'checkbox' ? cand.checkbox_style ?? 'check' : 'check',
      alignment: cand.alignment,
      cover_dashes: cand.cover_dashes,
      field_name: fieldName,
      tooltip: cand.label,
      source: 'auto',
    };
  });
}

function mergeStackedFullWidthEmptyRows(
  candidates: CandidateField[],
  allBoxes: VectorBox[],
): CandidateField[] {
  // Only merge wide single-column empty table rows that have no sibling cell on the same Y band
  const sorted = [...candidates].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const consumed = new Set<number>();
  const result: CandidateField[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (consumed.has(i)) continue;
    const first = sorted[i];
    const w = rectW(first);

    const isEligibleWideRow =
      first.field_type === 'text' &&
      first.origin === 'table' &&
      w >= 260 &&
      rectH(first) <= 28 &&
      !hasHorizontalSiblingBox(first, allBoxes);

    if (!isEligibleWideRow) {
      result.push(first);
      continue;
    }

    const runIndices = [i];
    let last = first;
    for (let j = i + 1; j < sorted.length; j++) {
      if (consumed.has(j)) continue;
      const next = sorted[j];
      if (
        next.field_type === 'text' &&
        next.origin === 'table' &&
        Math.abs(next.x0 - first.x0) <= 4 &&
        Math.abs(next.x1 - first.x1) <= 4 &&
        next.y0 - last.y1 >= -2 &&
        next.y0 - last.y1 <= 6 &&
        !hasHorizontalSiblingBox(next, allBoxes)
      ) {
        runIndices.push(j);
        last = next;
      }
    }

    if (runIndices.length >= 3) {
      for (const idx of runIndices) consumed.add(idx);
      result.push({
        ...first,
        y1: last.y1,
        field_type: 'multiline',
        font_size: 9.5,
      });
    } else {
      result.push(first);
    }
  }

  return result;
}

function hasHorizontalSiblingBox(target: Rect2D, allBoxes: VectorBox[]): boolean {
  const midY = (target.y0 + target.y1) / 2;
  return allBoxes.some((b) => {
    if (rectIoU(target, b) > 0.4) return false;
    const bMidY = (b.y0 + b.y1) / 2;
    if (Math.abs(bMidY - midY) > 8) return false;
    // Left or right neighbor cell on the same row
    return b.x1 <= target.x0 + 6 || b.x0 >= target.x1 - 6;
  });
}

function mergeFreeHorizontalLines(
  hLines: VectorLine[],
  allBoxes: VectorBox[],
  pageWidthPt: number,
  pageHeightPt: number,
): Array<{ x0: number; x1: number; y: number }> {
  const free = hLines.filter((l) => {
    const y = (l.y0 + l.y1) / 2;
    if (y < 40 || y > pageHeightPt - 30) return false;
    if (l.x1 - l.x0 > pageWidthPt * 0.88) return false;
    // Exclude lines that form the top or bottom edge of any detected box/table cell
    const belongsToBox = allBoxes.some(
      (b) =>
        (Math.abs(y - b.y0) <= 3.5 || Math.abs(y - b.y1) <= 3.5) &&
        l.x1 >= b.x0 - 3 &&
        l.x0 <= b.x1 + 3,
    );
    return !belongsToBox;
  });

  const sorted = [...free].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const merged: Array<{ x0: number; x1: number; y: number }> = [];
  for (const l of sorted) {
    const y = (l.y0 + l.y1) / 2;
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.y - y) <= 2.5 && l.x0 <= prev.x1 + 6) {
      prev.x1 = Math.max(prev.x1, l.x1);
    } else {
      merged.push({ x0: l.x0, x1: l.x1, y });
    }
  }
  return merged;
}
