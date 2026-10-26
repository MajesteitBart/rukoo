import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run against the real Worker and Durable Object in the local Workers runtime, with wrangler.jsonc's settings.
// The secrets are set here so a developer's own .dev.vars doesn't change the results. The local runtime can't place
// objects in a jurisdiction, so JURISDICTION is empty; test/info.test.js checks the routing to one separately.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          PEPPER: 'test-pepper-not-secret-0123456789',
          INVITE_CODES: 'first-code, second-code',
          JURISDICTION: ''
        }
      }
    })
  ],
  test: {
    include: ['test/**/*.test.js']
  }
});
