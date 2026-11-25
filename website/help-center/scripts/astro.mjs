// Runs the Astro CLI with telemetry off. npm runs scripts in cmd.exe on Windows, which has no VAR=1 prefix syntax.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const bin = path.join(path.dirname(require.resolve('astro/package.json')), 'bin', 'astro.mjs');
const { status, error } = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
});
if (error) throw error;
process.exit(status ?? 1);
