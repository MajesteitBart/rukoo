import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run against the real Worker and Durable Object in the local Workers runtime, with wrangler.jsonc's settings.
// The secrets and the operator settings are set here so a developer's own .dev.vars doesn't change the results. The
// local runtime can't place objects in a jurisdiction, so JURISDICTION is empty; test/info.test.js checks the routing
// to one separately.
//
// The files bucket is commented out in wrangler.jsonc, so a fork that deploys it unchanged runs without files; the
// tests bind a local one. test/fixtures/preview-server.js serves the pages link cards are made of, on 127.0.0.1, and
// the link card tests let the Worker reach it with WORKSPACE_PREVIEW_HOSTS.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        r2Buckets: ['WORKSPACE_FILES'],
        bindings: {
          PEPPER: 'test-pepper-not-secret-0123456789',
          INVITE_CODES: 'first-code, second-code',
          // Most tests sign up many times with one code; the invite tests set their own number of uses.
          INVITE_USES: '0',
          JURISDICTION: '',
          OPERATOR_NAME: '',
          OPERATOR_URL: '',
          OPERATOR_CONTACT: '',
          PRIVACY_URL: '',
          BOOKING_ORIGIN: '',
          BOOKING_ALIASES: '',
          BOOKING_FORMER_ROOTS: '',
          BLOCKED_HANDLES: '',
          // Team chat is off, as in wrangler.jsonc; the workspace tests turn it on per request.
          WORKSPACE_MODE: 'off',
          WORKSPACE_ORIGIN: '',
          WORKSPACE_FILES_ORIGIN: '',
          WORKSPACE_PREVIEWS: 'on',
          WORKSPACE_PREVIEW_HOSTS: ''
        }
      }
    })
  ],
  test: {
    include: ['test/**/*.test.js'],
    globalSetup: ['test/fixtures/preview-server.js']
  }
});
