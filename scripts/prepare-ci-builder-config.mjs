import fs from 'fs';
import yaml from 'js-yaml';

const owner = process.env.GH_OWNER?.trim();
const repo = process.env.GH_REPO?.trim();

if (!owner || !repo) {
  console.error('[ci-config] Faltan variables de entorno GH_OWNER o GH_REPO.');
  process.exit(1);
}

const baseConfig = yaml.load(fs.readFileSync('electron-builder.yml', 'utf8'));
if (!baseConfig || typeof baseConfig !== 'object') {
  console.error('[ci-config] No se pudo leer electron-builder.yml.');
  process.exit(1);
}

const ciConfig = {
  ...baseConfig,
  publish: {
    provider: 'github',
    owner,
    repo,
    releaseType: 'release',
  },
};

fs.writeFileSync('electron-builder.ci.yml', yaml.dump(ciConfig), 'utf8');
console.log(`[ci-config] electron-builder.ci.yml generado para ${owner}/${repo}`);
