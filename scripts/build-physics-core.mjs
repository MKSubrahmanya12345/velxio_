/**
 * build-physics-core.mjs — bundle the physics scene core into the CJS module
 * the headless Node runner (backend/app/mcp/physics_sim.cjs) loads.
 *
 * Run from the repo root:
 *
 *   node scripts/build-physics-core.mjs
 *
 * The physics core (frontend/src/simulation/physics) is dependency-free TS,
 * so the bundle is a single self-contained CJS file. Rebuild it whenever the
 * core changes; the checked-in artifact keeps the backend runnable without a
 * frontend toolchain.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend', 'package.json'));

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('esbuild not found — run `npm install` in frontend/ first.');
  process.exit(1);
}

const entry = path.join(root, 'frontend', 'src', 'simulation', 'physics', 'index.ts');
const outfile = path.join(root, 'backend', 'app', 'mcp', 'physics-core.cjs');

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile,
  sourcemap: false,
  logLevel: 'warning',
});
console.log(`physics core bundled → ${path.relative(root, outfile)}`);
