// Dev helper: launches the app with a temp profile and saves screenshots of the main screens, once in
// light and once in dark, to <dir>/light and <dir>/dark. UI and sample mail are in English.
// Usage: node scripts/screenshots.js <dir>   (THEME=dark|light for one theme only)
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function capture(theme, out) {
  fs.mkdirSync(out, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-shot-'));
  fs.mkdirSync(path.join(dataDir, 'data'));
  // A settings file makes this an existing profile, so the calendar would show its one-time notice about reminders.
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ language: 'en', theme, calendar: { notifiedUpgrade: true } }));
  // The chat screenshots use the scripted test agents, under the name of a Hermes agent.
  fs.writeFileSync(path.join(dataDir, 'data', 'agents.json'), JSON.stringify({ version: 1, clark: { name: 'Clark' } }));
  const env = (({ ELECTRON_RUN_AS_NODE, ...rest }) => ({ ...rest, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', SEM_LOGOS: '1', SEM_AGENT_FAKE: '1' }))(process.env);
  // At 150%, whatever the display's scaling, so the images stay sharp and the same size from any PC.
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1.5'], cwd: path.join(__dirname, '..'), env });
  try {
    const win = await app.firstWindow();
    const logs = [];
    const watch = (page) => {
      page.on('console', (m) => m.type() !== 'log' && logs.push(`${m.type()}: ${m.text()}`));
      page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
    };
    watch(win);
    const resize = (height) => app.evaluate(({ BrowserWindow }, h) => BrowserWindow.getAllWindows()[0].setSize(1600, h), height);
    // Keep the pointer off the list, so no row shows its hover state.
    const shot = async (name, wait = 800) => {
      await expect(win.locator('html')).toHaveAttribute('lang', 'en');
      await win.evaluate(() => document.fonts.ready);
      await win.mouse.move(1595, 995);
      await win.waitForTimeout(wait);
      await win.screenshot({ path: path.join(out, name) });
    };
    const item = (subject) => win.locator('.item', { hasText: subject }).first();

    await resize(1000);
    await win.waitForSelector('.provider-grid', { timeout: 15000 });
    await expect(win.locator('.setup h1')).toHaveText('Set up email');
    await shot('01-setup.png', 400);
    await win.click('[data-s="demo"]');
    await win.waitForSelector('.item', { timeout: 15000 });
    await expect(win.locator('.list-title h1')).toHaveText('Inbox');

    // The newest message opens by itself. Wait for the logos and for the "account added" notice to fade.
    await win.waitForSelector('.mail-frame', { timeout: 15000 });
    await shot('02-inbox.png', 3500);

    // Scrolled down, the subject moves into the toolbar. The newsletter fits a full-height window, so shorten it.
    await resize(640);
    await win.waitForTimeout(500);
    await win.locator('.reader-scroll').evaluate((el) => el.scrollTo(0, 400));
    await shot('03-reader-scrolled.png');
    await resize(1000);
    await win.waitForTimeout(500);

    await item('Call on Thursday').click();
    await win.waitForSelector('.reader-subject:text-is("Call on Thursday")');
    await shot('04-reader.png');
    await win.click('[data-reader="details"]');
    await shot('05-reader-details.png');

    await win.click('.stack-btn');
    await shot('06-stack-open.png');
    await win.click('.stack-btn.open');

    // Replies open in the reading pane.
    await item('Call on Thursday').click();
    await win.click('[data-reader="reply"]');
    await win.waitForSelector('.composer .editor', { timeout: 15000 });
    await win.keyboard.type('Hi Sanne, Thursday at 10:00 works for me. I will call you then.');
    await shot('07-reply.png');
    // Select the last words, so the formatting bar shows above them.
    await win.keyboard.down('Shift');
    for (let i = 0; i < 12; i++) await win.keyboard.press('ArrowLeft');
    await win.keyboard.up('Shift');
    await shot('08-reply-format.png', 300);
    await win.keyboard.press('End');
    await win.click('.composer [data-c="quote"]');
    await shot('09-reply-quote.png');
    await win.click('.composer [data-c="close"]');
    if (await win.$('.scrim')) await win.getByRole('button', { name: "Don't save", exact: true }).click();
    await win.waitForTimeout(300);

    // The chat panel: Clark drafts the reply to Sanne, then plans the follow-ups and asks before adding tasks.
    const chip = (label) => win.locator('.agentpane .bui-sugg__chip', { hasText: label });
    await item('Call on Thursday').click();
    await win.waitForSelector('.reader-subject:text-is("Call on Thursday")');
    await win.keyboard.press('Control+j');
    await chip('Draft a reply').click();
    await expect(win.locator('.agentpane .ap-transcript')).toContainText('Done. The draft is in the composer.', { timeout: 20000 });
    await shot('11-agent-reply.png', 1200);
    await win.click('.composer [data-c="close"]');
    if (await win.$('.scrim')) await win.getByRole('button', { name: "Don't save", exact: true }).click();
    await win.click('.agentpane [data-ap="new"]');
    await chip('Plan follow-ups').click();
    await expect(win.locator('.agentpane .bui-approval')).toContainText('Waiting for you', { timeout: 20000 });
    await shot('12-agent-plan.png', 1200);
    await win.click('.agentpane [data-ap="close"]');
    await win.waitForTimeout(300);

    // The calendar: the demo account's week beside the small month, then the card of the invitation that waits for
    // an answer.
    const calEvent = (title) => win.locator('.calendar [data-ev]', { hasText: title }).first();
    const invitation = calEvent('Quarterly planning');
    await win.click('[data-mode="calendar"]');
    await expect(invitation).toBeVisible({ timeout: 10000 });
    await expect(win.locator('.sidebar .cal-mini [data-mini-day]').first()).toBeVisible();
    await shot('13-calendar.png');
    await invitation.click();
    await win.waitForSelector('.cal-pop');
    await shot('14-calendar-event.png', 400);
    await win.keyboard.press('Escape');
    await expect(win.locator('.cal-pop')).toHaveCount(0);

    await win.click('[data-cal-view="month"]');
    await expect(win.locator('[data-cal-view="month"]')).toHaveAttribute('aria-selected', 'true');
    await expect(calEvent('Roadmap review')).toBeVisible();
    await shot('15-calendar-month.png');
    await win.click('[data-cal-view="week"]');
    await expect(invitation).toBeVisible();

    // A click on the grid: 15:00 on Wednesday, the day of the lunch with Sanne, which the demo week leaves open there.
    const day = await calEvent('Lunch with Sanne').evaluate((el) => el.closest('[data-cal-col]').dataset.calCol);
    const column = await win.locator(`.cal-col[data-cal-col="${day}"]`).boundingBox();
    await win.mouse.click(column.x + column.width / 2, column.y + 15.2 * 56);
    await expect(win.locator('.cal-quick:not(.measuring)')).toBeVisible();
    await win.keyboard.type('Coffee with Joris');
    await shot('16-calendar-quick.png', 400);
    await win.keyboard.press('Escape');
    await expect(win.locator('.cal-quick')).toHaveCount(0);

    // The full dialog of the weekly piano lesson, with More open on its repeat and reminder.
    await calEvent('Piano lesson').click();
    await win.click('.cal-pop [data-pop="edit"]');
    await win.waitForSelector('.dialog .cal-form');
    await win.click('.cal-form [data-extras]');
    await expect(win.locator('.cal-form .cal-extras-body')).not.toHaveAttribute('inert', '');
    await shot('17-calendar-dialog.png');
    await win.keyboard.press('Escape');
    await expect(win.locator('.dialog')).toHaveCount(0);

    // The open time over the next 14 days, so a run late in the week still finds working hours ahead.
    const panel = win.locator('.calendar .cal-panel');
    await win.click('[data-cal-panel="free"]');
    await expect(panel.locator('h2')).toHaveText('Availability');
    await panel.locator('[data-free="range"]').selectOption('days14');
    await expect(panel.locator('.free-slot').first()).toBeVisible({ timeout: 10000 });
    await expect(panel.locator('.free-days')).not.toHaveClass(/busy/);
    await shot('18-calendar-availability.png');
    await win.click('[data-cal-panel="free"]');
    await win.click('[data-mode="mail"]');
    await win.waitForTimeout(300);

    const settings = win.locator('.page.settings');
    await win.click('[data-action="settings"]');
    await win.waitForSelector('.settings .card');
    await expect(win.locator('.settings h1')).toHaveText('Email settings');
    await shot('10-settings.png', 400);
    await settings.locator('[data-a="calset-open"]').click();
    await expect(settings.locator('h1')).toHaveText('Calendar');
    await expect(settings.locator('.calset-cal')).toHaveCount(3);
    await shot('19-settings-calendar.png', 400);
    await settings.locator('[data-a="back"]').click();
    // Signed out: this profile has no Rukoo account.
    await settings.locator('[data-a="booking-open"]').click();
    await expect(settings.locator('h1')).toHaveText('Booking page');
    await expect(settings.locator('.settings-text').first()).toContainText('It runs on your Rukoo account');
    await shot('20-settings-booking.png', 400);
    console.log(`${theme}: ${logs.join('\n') || 'no console output'}`);
    if (logs.some((message) => message.startsWith('pageerror:'))) throw new Error(logs.join('\n'));
  } finally {
    // Tear down temporary capture windows even if an assertion or screenshot fails.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.destroy())).catch(() => {});
    await app.close();
    const resolvedProfile = path.resolve(dataDir);
    if (path.dirname(resolvedProfile) === path.resolve(os.tmpdir()) && path.basename(resolvedProfile).startsWith('sem-shot-')) {
      fs.rmSync(resolvedProfile, { recursive: true, force: true });
    }
  }
}

(async () => {
  const out = path.resolve(process.argv[2] || 'shots');
  const themes = process.env.THEME ? [process.env.THEME] : ['light', 'dark'];
  for (const theme of themes) await capture(theme, path.join(out, theme));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
