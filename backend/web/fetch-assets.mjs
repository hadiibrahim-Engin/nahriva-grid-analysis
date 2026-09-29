// Copies the handful of files app/main.py needs to serve /docs and /redoc
// without depending on a CDN at runtime. Run after `npm install` here:
//   npm install && npm run fetch
// Output goes to ./docs-assets, which main.py mounts at /docs-assets when
// present (falling back to the CDN otherwise, e.g. on a fresh clone that
// hasn't run this step).
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'docs-assets');
mkdirSync(outDir, { recursive: true });

const files = [
  ['swagger-ui-dist/swagger-ui-bundle.js', 'swagger-ui-bundle.js'],
  ['swagger-ui-dist/swagger-ui.css', 'swagger-ui.css'],
  ['redoc/bundles/redoc.standalone.js', 'redoc.standalone.js'],
];

for (const [src, destName] of files) {
  const srcPath = join(here, 'node_modules', src);
  const destPath = join(outDir, destName);
  copyFileSync(srcPath, destPath);
  console.log(`copied ${src} -> docs-assets/${destName}`);
}
