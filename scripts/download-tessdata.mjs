import fs from 'fs';
import path from 'path';

const TARGET_DIR = path.resolve(process.cwd(), 'resources', 'tessdata');
const LANGUAGES = ['spa', 'eng'];
const BASE_URL = 'https://github.com/tesseract-ocr/tessdata_fast/raw/main';
const FORCE = process.argv.includes('--force');

async function downloadLanguage(lang) {
  const fileName = `${lang}.traineddata`;
  const targetPath = path.join(TARGET_DIR, fileName);

  if (!FORCE && fs.existsSync(targetPath) && fs.statSync(targetPath).size > 500_000) {
    console.log(`[setup:tessdata] ${fileName} ya existe localmente (${(fs.statSync(targetPath).size / 1024 / 1024).toFixed(2)} MB).`);
    return;
  }

  const url = `${BASE_URL}/${fileName}`;
  console.log(`[setup:tessdata] Descargando ${fileName} desde tessdata_fast...`);

  const response = await fetch(url, {
    headers: { 'User-Agent': 'LibreDoc-Studio-Setup' },
  });

  if (!response.ok) {
    throw new Error(`Error descargando ${fileName} (HTTP ${response.status}).`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength < 500_000) {
    throw new Error(`El archivo descargado ${fileName} es demasiado pequeño (${buffer.byteLength} bytes).`);
  }

  fs.writeFileSync(targetPath, buffer);
  console.log(
    `[setup:tessdata] Guardado ${fileName} (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB) en ${targetPath}`,
  );
}

async function run() {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  for (const lang of LANGUAGES) {
    await downloadLanguage(lang);
  }
  console.log('[setup:tessdata] Modelos OCR offline listos (spa + eng).');
}

run().catch((err) => {
  console.error('[setup:tessdata] Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
