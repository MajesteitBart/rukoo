import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { s3Vars } from './test/fixtures/fake-s3.js';
import { stripeVars } from './test/fixtures/fake-stripe.js';

// Tests run against the real Worker and Durable Object in the local Workers runtime, with wrangler.jsonc's settings.
// The secrets and the operator settings are set here so a developer's own .dev.vars doesn't change the results. The
// local runtime can't place objects in a jurisdiction, so JURISDICTION is empty; test/info.test.js checks the routing
// to one separately.
//
// The files bucket is commented out in wrangler.jsonc, so a fork that deploys it unchanged runs without files; the
// tests bind a local one. test/fixtures/preview-server.js serves the pages link cards are made of, on 127.0.0.1, and
// the link card tests let the Worker reach it with WORKSPACE_PREVIEW_HOSTS.
//
// Four projects: r2 runs every test with that local bucket, and s3 runs test/s3-*.test.js with no bucket and an
// S3-compatible store instead, whose endpoint test/fixtures/fake-s3.js answers inside the runtime. billing runs
// test/billing-*.test.js with team chat and billing on, against the stand-in for Stripe in test/fixtures/fake-stripe.js,
// and winddown runs test/billing-winddown.test.js with BILLING off but Stripe's settings still there. Billing is off in
// r2 and s3, as in wrangler.jsonc. The S3 and Stripe settings are stand-ins, not credentials.
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
  WORKSPACE_FILES_S3_PLACE: '',
  BILLING: 'off',
  STRIPE_API: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',
  STRIPE_PRICE_ID: '',
  STRIPE_TAX: ''
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
          exclude: ['test/s3-*.test.js', 'test/billing-*.test.js'],
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
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // The workspace's object reads billing's settings from its own environment, which per-request vars don't
            // reach, so team chat is on here for every request.
            miniflare: { r2Buckets: ['WORKSPACE_FILES'], bindings: { ...BINDINGS, WORKSPACE_MODE: 'on', ...stripeVars() } }
          })
        ],
        test: {
          name: 'billing',
          include: ['test/billing-*.test.js'],
          exclude: ['test/billing-winddown.test.js'],
          // Each test signs several people up and runs the workspace's alarm until Stripe has the seats.
          testTimeout: 30000,
          globalSetup: ['test/fixtures/preview-server.js']
        }
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // BILLING off with Stripe's settings still there, in the workspace's object too: what an operator who
            // winds billing down runs (README.md, Billing).
            miniflare: { r2Buckets: ['WORKSPACE_FILES'], bindings: { ...BINDINGS, WORKSPACE_MODE: 'on', ...stripeVars(), BILLING: 'off' } }
          })
        ],
        test: {
          name: 'winddown',
          include: ['test/billing-winddown.test.js'],
          testTimeout: 30000,
          globalSetup: ['test/fixtures/preview-server.js']
        }
      }
    ]
  }
});
