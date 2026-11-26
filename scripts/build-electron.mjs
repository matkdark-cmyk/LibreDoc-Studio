import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

const outDir = path.resolve(process.cwd(), 'dist-electron');
fs.mkdirSync(outDir, { recursive: true });

const sharedConfig = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: [
    'electron',
    'better-sqlite3',
    'pdfjs-dist',
    'pdfjs-dist/legacy/build/pdf.mjs',
    'tesseract.js',
    'pdf-lib',
    'electron-updater',
  ],
  logLevel: 'info',
};

async function run() {
  await Promise.all([
    build({
      ...sharedConfig,
      entryPoints: [path.resolve(process.cwd(), 'electron/main.ts')],
      outfile: path.join(outDir, 'main.cjs'),
    }),
    build({
      ...sharedConfig,
      entryPoints: [path.resolve(process.cwd(), 'electron/preload.ts')],
      outfile: path.join(outDir, 'preload.cjs'),
    }),
  ]);
}

run().catch((err) => {
  console.error('[build-electron] Error compiling Electron entrypoints:', err);
  process.exit(1);
});
