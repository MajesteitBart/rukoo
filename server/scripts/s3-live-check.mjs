// Checks the S3 file store (src/filestore.js) against a real bucket, by hand and never in CI. It needs the five
// settings in the environment:
//
//   WORKSPACE_FILES_S3_ENDPOINT, WORKSPACE_FILES_S3_REGION, WORKSPACE_FILES_S3_BUCKET,
//   WORKSPACE_FILES_S3_ACCESS_KEY_ID, WORKSPACE_FILES_S3_SECRET_ACCESS_KEY
//
//   node scripts/s3-live-check.mjs
//
// The store needs the Workers runtime, so this starts scripts/s3-live-check-worker.js with wrangler on 127.0.0.1,
// hands it the settings as secret bindings (they are never written to disk), asks it to run the steps and stops it.
// The Worker writes a few small objects under live-check/<random>/ and deletes them again. Each step prints pass or
// fail and nothing else; the exit code is 0 when every step passed.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = [
  'WORKSPACE_FILES_S3_ENDPOINT',
  'WORKSPACE_FILES_S3_REGION',
  'WORKSPACE_FILES_S3_BUCKET',
  'WORKSPACE_FILES_S3_ACCESS_KEY_ID',
  'WORKSPACE_FILES_S3_SECRET_ACCESS_KEY'
];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.dirname(HERE);

const missing = SETTINGS.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`Set ${missing.join(', ')} in the environment first.`);
  process.exit(2);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Miniflare otherwise fetches https://workers.cloudflare.com/cf.json; its built-in request.cf is enough here.
process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';
const { unstable_startWorker } = createRequire(path.join(SERVER, 'package.json'))('wrangler');

// wrangler bundles into the config's folder, so the config goes to a temporary folder and the repository stays as it
// is. It holds no setting: those go in as bindings.
const dir = mkdtempSync(path.join(tmpdir(), 'rukoo-s3-live-check-'));
const configPath = path.join(dir, 'wrangler.json');
writeFileSync(configPath, JSON.stringify({ name: 'rukoo-s3-live-check', main: path.join(HERE, 's3-live-check-worker.js'), compatibility_date: '2026-10-20' }));

let worker = null;
let code = 1;
try {
  const port = await freePort();
  worker = await unstable_startWorker({
    config: configPath,
    bindings: Object.fromEntries(SETTINGS.map((name) => [name, { type: 'secret_text', value: process.env[name].trim() }])),
    envFiles: [],
    dev: {
      server: { hostname: '127.0.0.1', port },
      inspector: false,
      watch: false,
      liveReload: false,
      persist: path.join(dir, 'state'),
      logLevel: 'none'
    }
  });
  await worker.ready;
  const url = (await worker.url).href.replace(/\/$/, '');
  const res = await fetch(`${url}/run`, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  const results = res.ok ? await res.json() : [{ step: 'the check Worker answered', ok: false }];
  for (const { step, ok } of results) console.log(`${ok ? 'pass' : 'fail'}  ${step}`);
  code = results.length > 1 && results.every((r) => r.ok) ? 0 : 1;
} catch {
  console.log('fail  the check Worker started and answered');
} finally {
  await worker?.dispose().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
