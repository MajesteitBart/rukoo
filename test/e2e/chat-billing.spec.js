// Billing in Workspace settings (server/WORKSPACES.md, Billing): the real app on a throwaway profile against the real
// account server with billing on, and a stand-in for Stripe (test/fixtures/stripe-server.js) behind STRIPE_API. An
// owner sees what setting up billing costs, opens Checkout in the browser, sees the subscription once Stripe's event
// arrived, and opens the portal; an admin reads the same without buttons. Captures of each state, in both themes and
// both languages, go to the test's output folder. The stand-in doesn't prove Stripe's real Checkout or webhooks.
const { test, expect } = require('@playwright/test');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { PASSWORD, skipWithoutServer, startServer, launch, signIn, openChat, dialogBox, workspaceMenu } = require('./chat-helpers');
const { startStripe } = require('../fixtures/stripe-server');

skipWithoutServer();

let stripe;
let server;
let app;
let win;
let dataDir;

test.beforeAll(async () => {
  stripe = await startStripe();
  server = await startServer({ vars: stripe.vars });
});

test.afterAll(async () => {
  await server?.close();
  await stripe?.close();
});

test.beforeEach(() => {
  dataDir = tempDir('rukoo-chat-billing-e2e-');
});

test.afterEach(async () => {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
});

const switcherName = () => win.locator('.sidebar .ch-ws-switch .name');
const section = () => dialogBox(win).locator('[data-part="billing"]');
const row = (label) => section().locator('.ch-set-row', { has: win.locator('.ch-set-label', { hasText: label }) });

async function ready(person) {
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, person);
  await openChat(win);
  // Stripe's pages open in the browser; here they are only recorded.
  await app.evaluate(({ shell }) => {
    global.__opened = [];
    shell.openExternal = async (url) => void global.__opened.push(url);
  });
}

const opened = () => app.evaluate(() => global.__opened);

async function settings(look = {}) {
  if (Object.keys(look).length) await win.evaluate((patch) => window.mail.call('updateSettings', patch), look);
  await workspaceMenu(win, look.language === 'nl' ? 'Instellingen van de werkruimte' : 'Workspace settings');
  await expect(section()).toBeVisible({ timeout: 15000 });
}

// A toast from an earlier step would cover the dialog's buttons in the picture; it goes after a few seconds.
async function capture(name, testInfo) {
  await expect(win.locator('#toast.show')).toHaveCount(0, { timeout: 10000 });
  await win.waitForTimeout(150);
  await dialogBox(win).screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function closeDialog() {
  await dialogBox(win).locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
}

// The server's billing for person, as the app would read it.
async function serverBilling(person, wsId) {
  const res = await server.call('GET', `/v1/workspaces/${wsId}/billing`, { token: person.token });
  if (res.status !== 200) throw new Error(`billing: ${res.status} ${res.text}`);
  return res.body.billing;
}

test('an owner sees the cost, sets billing up in Stripe, sees the subscription and manages it', async ({}, testInfo) => {
  const bart = await server.seedAccount({ password: PASSWORD });
  const olga = await server.seedAccount();
  const ws = await server.seedWorkspace(bart, { name: 'Acme', displayName: 'Bart' });
  const olgaMe = await server.seedMember(ws, olga, 'Olga');
  await server.createInvite(bart, ws.id, { role: 'member' });
  await ready(bart);
  await expect(switcherName()).toHaveText('Acme', { timeout: 15000 });

  // Before: two members are two seats, the open invitation none, at the price Stripe has.
  await settings({ theme: 'dark', language: 'en' });
  await expect(row('Status').locator('.ch-bill-status')).toHaveText('Not set up');
  await expect(row('Paid seats once set up').locator('.ch-bill-value')).toHaveText('2');
  await expect(row('Monthly total once set up').locator('.ch-bill-value')).toHaveText('€39.00 a month, VAT included');
  await expect(row('Monthly total once set up').locator('.ch-bill-help')).toHaveText('€19.50 per member a month, VAT included');
  await expect(section()).toContainText("1 open invitation isn't billed until someone joins with it.");
  await capture('owner-before-dark-en', testInfo);

  // Set up billing opens Stripe Checkout for two seats.
  await section().getByRole('button', { name: 'Set up billing' }).click();
  await expect.poll(opened).toHaveLength(1);
  const session = stripe.fake.lastSession();
  expect((await opened())[0]).toBe(session.url);
  expect(session.params.line_items[0]).toMatchObject({ price: stripe.vars.STRIPE_PRICE_ID, quantity: '2' });
  expect(session.params.locale).toBe('en');
  await expect(win.locator('#toast')).toContainText('Stripe opened in your browser.');

  // The owner pays; Stripe tells the server, which reads the subscription.
  const done = stripe.fake.completeCheckout(session.id);
  await stripe.deliver(server, stripe.fake.event('checkout.session.completed', done.session));
  await expect.poll(async () => (await serverBilling(bart, ws.id)).status, { timeout: 30000 }).toBe('active');

  // Back in the window, the section shows it.
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(row('Status').locator('.ch-bill-status')).toHaveText('Active');
  await expect(row('Status').locator('.ch-bill-status')).toHaveAttribute('data-tone', 'ok');
  await expect(row('Paid seats').locator('.ch-bill-value')).toHaveText('2');
  await expect(row('Monthly total').locator('.ch-bill-value')).toHaveText('€39.00 a month, VAT included');
  await expect(row('Renews on')).toBeVisible();
  await expect(section().getByRole('button', { name: 'Set up billing' })).toHaveCount(0);
  await capture('owner-active-dark-en', testInfo);

  // Manage billing opens the portal.
  await section().getByRole('button', { name: 'Manage billing' }).click();
  await expect.poll(opened).toHaveLength(2);
  expect((await opened())[1]).toBe(stripe.fake.portals.at(-1).url);
  await closeDialog();

  // The same in Dutch and light.
  await settings({ theme: 'light', language: 'nl' });
  await expect(row('Status').locator('.ch-bill-status')).toHaveText('Actief');
  await expect(row('Per maand').locator('.ch-bill-value')).toHaveText(/€\s?39,00 per maand, inclusief btw/);
  await expect(section().getByRole('button', { name: 'Betalen beheren' })).toBeVisible();
  await capture('owner-active-light-nl', testInfo);
  await closeDialog();

  // Alone again, Bart still can't delete the workspace while Stripe can charge its subscription.
  expect((await server.call('DELETE', `/v1/workspaces/${ws.id}/members/${olgaMe.id}`, { token: bart.token })).status).toBe(204);
  const refused = await server.call('DELETE', `/v1/workspaces/${ws.id}`, { token: bart.token });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe('billing_active');
});

test('an admin reads billing without buttons, in both languages and themes', async ({}, testInfo) => {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(olga, { name: 'Studio', displayName: 'Olga' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const promoted = await server.call('PATCH', `/v1/workspaces/${ws.id}/members/${bartMe.id}`, { token: olga.token, body: { role: 'admin' } });
  expect(promoted.status).toBe(200);
  await ready(bart);
  await expect(switcherName()).toHaveText('Studio', { timeout: 15000 });

  await settings({ theme: 'light', language: 'en' });
  await expect(row('Status').locator('.ch-bill-status')).toHaveText('Not set up');
  await expect(section()).toContainText('Only owners can change billing.');
  await expect(section().getByRole('button')).toHaveCount(0);
  await capture('admin-before-light-en', testInfo);
  await closeDialog();

  await settings({ theme: 'dark', language: 'nl' });
  await expect(section()).toContainText('Alleen eigenaren kunnen het betalen wijzigen.');
  await expect(row('Betaalde plekken na instellen').locator('.ch-bill-value')).toHaveText('2');
  await capture('admin-before-dark-nl', testInfo);
});

test('a member sees no billing at all', async () => {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(olga, { name: 'Crew', displayName: 'Olga' });
  await server.seedMember(ws, bart, 'Bart');
  await ready(bart);
  await expect(switcherName()).toHaveText('Crew', { timeout: 15000 });
  await workspaceMenu(win, 'Workspace settings');
  await expect(dialogBox(win).locator('[data-part="you"]')).toBeVisible();
  await expect(section()).toHaveCount(0);
});
