import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

const TARGET_DIR = path.resolve(process.cwd(), 'resources', 'bin', 'win', 'qpdf');
const GITHUB_RELEASE_API = 'https://api.github.com/repos/qpdf/qpdf/releases/latest';

async function downloadQpdfWindows() {
  console.log('[setup:qpdf] Consultando la última versión estable de qpdf en GitHub Releases...');

  const headers = {
    'User-Agent': 'LibreDoc-Studio-Setup',
    Accept: 'application/vnd.github+json',
  };
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (ghToken) {
    headers.Authorization = `Bearer ${ghToken}`;
  }

  const releaseRes = await fetch(GITHUB_RELEASE_API, { headers });

  if (!releaseRes.ok) {
    throw new Error(`No se pudo consultar GitHub Releases (HTTP ${releaseRes.status}).`);
  }

  const release = await releaseRes.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];

  // Prefer MSVC x64 zip (minimal DLL footprint on Windows), fallback to MinGW x64 zip
  const selectedAsset =
    assets.find((a) => /qpdf-.*-msvc64\.zip$/i.test(a.name)) ||
    assets.find((a) => /qpdf-.*-mingw64\.zip$/i.test(a.name)) ||
    assets.find((a) => /qpdf-.*win64.*\.zip$/i.test(a.name));

  if (!selectedAsset) {
    throw new Error(
      'No se encontró un paquete Windows x64 (.zip) en la última release de qpdf. Descárgalo manualmente desde https://github.com/qpdf/qpdf/releases',
    );
  }

  console.log(`[setup:qpdf] Descargando ${selectedAsset.name} (${release.tag_name})...`);
  const zipRes = await fetch(selectedAsset.browser_download_url, {
    headers: { 'User-Agent': 'LibreDoc-Studio-Setup' },
  });

  if (!zipRes.ok) {
    throw new Error(`Error descargando ${selectedAsset.name} (HTTP ${zipRes.status}).`);
  }

  const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
  const zip = await JSZip.loadAsync(zipBuffer);

  fs.mkdirSync(TARGET_DIR, { recursive: true });

  // Clean previous binaries before extracting fresh ones
  for (const existing of fs.readdirSync(TARGET_DIR)) {
    if (existing.toLowerCase().endsWith('.exe') || existing.toLowerCase().endsWith('.dll')) {
      fs.rmSync(path.join(TARGET_DIR, existing), { force: true });
    }
  }

  let extractedCount = 0;
  const entries = Object.values(zip.files);

  for (const entry of entries) {
    if (entry.dir) continue;
    const normalized = entry.name.replace(/\\/g, '/');
    const lower = normalized.toLowerCase();

    // Extract qpdf.exe and all DLLs located inside the bin/ directory of the archive
    const isInBin = lower.includes('/bin/');
    const baseName = path.posix.basename(normalized);
    const isTargetBinary =
      baseName.toLowerCase() === 'qpdf.exe' || baseName.toLowerCase().endsWith('.dll');

    if (isInBin && isTargetBinary) {
      const content = await entry.async('nodebuffer');
      fs.writeFileSync(path.join(TARGET_DIR, baseName), content);
      extractedCount += 1;
    }
  }

  const qpdfExePath = path.join(TARGET_DIR, 'qpdf.exe');
  if (!fs.existsSync(qpdfExePath)) {
    throw new Error('La extracción finalizó sin encontrar qpdf.exe dentro de bin/.');
  }

  console.log(
    `[setup:qpdf] Listo: se extrajeron ${extractedCount} archivos (qpdf.exe y DLLs) en ${TARGET_DIR}`,
  );
}

downloadQpdfWindows().catch((err) => {
  console.error('[setup:qpdf] Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
