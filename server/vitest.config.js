import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { s3Vars } from './test/fixtures/fake-s3.js';

// Tests run against the real Worker and Durable Object in the local Workers runtime, with wrangler.jsonc's settings.
// The secrets and the operator settings are set here so a developer's own .dev.vars doesn't change the results. The
// local runtime can't place objects in a jurisdiction, so JURISDICTION is empty; test/info.test.js checks the routing
// to one separately.
//
// The files bucket is commented out in wrangler.jsonc, so a fork that deploys it unchanged runs without files; the
// tests bind a local one. test/fixtures/preview-server.js serves the pages link cards are made of, on 127.0.0.1, and
// the link card tests let the Worker reach it with WORKSPACE_PREVIEW_HOSTS.
//
// Two projects: r2 runs every test with that local bucket, and s3 runs test/s3-*.test.js with no bucket and an
// S3-compatible store instead, whose endpoint test/fixtures/fake-s3.js answers inside the runtime. The S3 settings are
// stand-ins, not credentials.
const BINDINGS = {
  PEPPER: 'test-pepper-not-secret-0123456789',
  INVITE_CODES: 'first-code, second-code',
  // Most tests sign up many times with one code; the invite tests set their own number of uses.
  INVITE_USES: '0',
  JURISDICTION: '',
  OPERATOR_NAME: '',
  OPERATOR_URL: '',
  OPERATOR_CONTACT: '',
  PRIVACY_URL: '',
  // No mail: the code tests set a key and a sender per request and answer Resend themselves (test/fixtures/fake-resend.js).
  RESEND_API_KEY: '',
  MAIL_FROM: '',
  BOOKING_ORIGIN: '',
  BOOKING_ALIASES: '',
  BOOKING_FORMER_ROOTS: '',
  BLOCKED_HANDLES: '',
  // Team chat is off, as in wrangler.jsonc; the workspace tests turn it on per request.
  WORKSPACE_MODE: 'off',
  WORKSPACE_ORIGIN: '',
  WORKSPACE_FILES_ORIGIN: '',
  WORKSPACE_PREVIEWS: 'on',
  WORKSPACE_PREVIEW_HOSTS: '',
  WORKSPACE_FILES_S3_ENDPOINT: '',
  WORKSPACE_FILES_S3_REGION: '',
  WORKSPACE_FILES_S3_BUCKET: '',
  WORKSPACE_FILES_S3_ACCESS_KEY_ID: '',
  WORKSPACE_FILES_S3_SECRET_ACCESS_KEY: '',
  WORKSPACE_FILES_S3_PROVIDER: '',
  WORKSPACE_FILES_S3_PLACE: ''
};

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { r2Buckets: ['WORKSPACE_FILES'], bindings: BINDINGS }
          })
        ],
        test: {
          name: 'r2',
          include: ['test/**/*.test.js'],
          exclude: ['test/s3-*.test.js'],
          globalSetup: ['test/fixtures/preview-server.js']
        }
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { bindings: { ...BINDINGS, ...s3Vars() } }
          })
        ],
        test: {
          name: 's3',
          include: ['test/s3-*.test.js'],
          globalSetup: ['test/fixtures/preview-server.js']
        }
      }
    ]
  }
});
