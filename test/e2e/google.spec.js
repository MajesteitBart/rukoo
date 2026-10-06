// "Aanmelden met Google" in the real app, with the system browser replaced by a stub.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('Google tile starts browser sign-in and reports a denied consent', async () => {
  const env = {
    ...process.env,
    SEM_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sem-e2e-g-')),
    SEM_HIDDEN: '1',
    SEM_GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    SEM_GOOGLE_CLIENT_SECRET: 'test-secret'
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  try {
    const win = await app.firstWindow();
    // Stand-in for the browser: record the URL and send the user back as if they clicked "Annuleren" at Google.
    await app.evaluate(({ shell }) => {
      global.__opened = [];
      shell.openExternal = async (url) => {
        global.__opened.push(url);
        const u = new URL(url);
        const back = new URL(u.searchParams.get('redirect_uri'));
        back.searchParams.set('state', u.searchParams.get('state'));
        back.searchParams.set('error', 'access_denied');
        setTimeout(() => fetch(back).catch(() => {}), 300);
      };
    });
    await win.click('[data-provider="google"]');
    await expect(win.locator('.login-head h2')).toHaveText('Aanmelden bij Google');
    await win.click('[data-s="google"]');
    await expect(win.locator('[data-error]')).toHaveText('Je hebt geen toegang gegeven.', { timeout: 10000 });
    const opened = await app.evaluate(() => global.__opened);
    const u = new URL(opened[0]);
    expect(u.origin).toBe('https://accounts.google.com');
    expect(u.searchParams.get('scope')).toContain('https://mail.google.com/');
    expect(u.searchParams.get('client_id')).toBe('test-client.apps.googleusercontent.com');

    await win.click('[data-s="password-mode"]');
    await expect(win.locator('[name=password]')).toBeVisible();
  } finally {
    await app.close();
  }
});
