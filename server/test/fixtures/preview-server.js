// Vitest's global setup: the web pages link card tests fetch (preview-pages.cjs), running in Node for the whole test
// run. Tests read its address with inject('previewOrigin') and inject('previewHost').

import pages from './preview-pages.cjs';

let server = null;

export async function setup(project) {
  server = await pages.startPreviewServer();
  project.provide('previewOrigin', server.origin);
  project.provide('previewHost', server.host);
}

export async function teardown() {
  await server?.close();
}
