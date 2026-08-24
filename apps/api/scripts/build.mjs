// Bundles the API (including the workspace-internal @initiative/shared package)
// into plain ESM so the Docker image only needs `node dist/index.js`.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

// Everything from npm stays external; workspace packages get bundled in.
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@initiative/'));

await build({
  entryPoints: [resolve(root, 'src/index.ts'), resolve(root, 'src/db/migrate.ts')],
  outdir: resolve(root, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  external,
  banner: {
    // Some dependencies still reach for CJS globals at runtime.
    js: "import { createRequire as __createRequire } from 'module';\nconst require = __createRequire(import.meta.url);",
  },
});
