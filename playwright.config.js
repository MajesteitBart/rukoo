// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  workers: 1,
  reporter: 'list'
});
