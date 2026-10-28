// Booking pages at the root of BOOKING_ORIGIN, as rukoo.io serves them next to its website: every page, answer and
// link without /meet, the MCP endpoint at /mcp, the script at /booker.js, the site-level llms.txt, the account API on
// the same address, and /meet on the server's other addresses redirecting there. The other suites run without
// BOOKING_ORIGIN and cover the /meet layout.

import { describe, expect, it } from 'vitest';
import { INVITE, KDF, call, device, key, newEmail, sealed, salt, signup } from './helpers.js';
import { guest, host, hostKey, iso, meetingType, newHandle, page, publish, slotAhead } from './booking-helpers.js';
import { BOOKER_JS } from '../src/booker-script.js';

const BOOKING = 'https://booking.example';
const VARS = { BOOKING_ORIGIN: BOOKING };
const FORM = 'application/x-www-form-urlencoded';
const SAME = { origin: BOOKING, 'sec-fetch-site': 'same-origin' };

// A request to the booking address, and one to the server's own address, both with BOOKING_ORIGIN set.
const at = (method, path, options = {}) => call(method, path, { vars: VARS, origin: BOOKING, ...options });
const old = (method, path, options = {}) => call(method, path, { vars: VARS, ...options });

const slotOf = (ms) => iso(ms).replace(/:00Z$/, 'Z');

function decode(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Every link, form action and script on a page, decoded.
function pageLinks(html) {
  return [...html.matchAll(/\b(?:href|action|src)="([^"]*)"/g)].map((m) => decode(m[1]));
}

// Each link on the page is the page's own (relative or on BOOKING), the MCP endpoint, the privacy statement, the
// script or a font; none goes through /meet.
function expectRootLinks(html, handle) {
  const found = pageLinks(html);
  expect(found.length).toBeGreaterThan(3);
  for (const link of found) {
    expect(link).not.toContain('/meet');
    const path = link.startsWith(`${BOOKING}/`) ? link.slice(BOOKING.length) : link;
    expect(path, link).toMatch(new RegExp(`^/(?:${handle}(?:[/?#.]|$)|privacy(?:[?#]|$)|booker\\.js$|mcp$|assets/fonts/inter-[a-z-]+\\.woff2$)`));
  }
}

// Every absolute address in a JSON answer.
function urls(value, out = []) {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) out.push(value);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) urls(v, out);
  return out;
}

function expectRootUrls(body, handle) {
  const found = urls(body);
  expect(found.length).toBeGreaterThan(0);
  for (const u of found) expect(u, u).toMatch(new RegExp(`^${BOOKING}/(?:${handle}(?:[/?]|$)|mcp$|privacy$)`));
}

function rpc(method, params, options = {}) {
  return at('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, headers: { accept: 'application/json, text/event-stream' }, ...options });
}

describe('the account API at the booking address', () => {
  it('answers /v1/info, sign-up and sign-in, and serves / and /privacy as on any address', async () => {
    const info = await at('GET', '/v1/info');
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ protocol: 1, features: ['booking'], operator: { privacy: `${BOOKING}/privacy` } });

    const person = { email: newEmail(), kdf: KDF, salt: salt(), authKey: key(), wrappedKey: sealed(), recoveryAuth: key(), recoveryWrappedKey: sealed() };
    const made = await at('POST', '/v1/signup', { body: { ...person, invite: INVITE, device: device() } });
    expect(made.status).toBe(201);
    const login = await at('POST', '/v1/login', { body: { email: person.email, authKey: person.authKey, device: device('Phone', 'android') } });
    expect(login.status).toBe(200);
    expect((await at('GET', '/v1/account', { token: login.body.token })).status).toBe(200);

    const home = await at('GET', '/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Rukoo account server');
    const privacy = await at('GET', '/privacy');
    expect(privacy.status).toBe(200);
    expect(privacy.text).not.toContain('/meet');
  });

  it('gives the owner the page address under BOOKING_ORIGIN on either address', async () => {
    const person = await signup();
    const handle = newHandle();
    // The base comes before there is a handle, so the app can show where the page will live.
    for (const read of [at, old]) {
      const none = await read('GET', '/v1/booking', { token: person.token });
      expect(none.body).toMatchObject({ handle: null, url: null, base: BOOKING });
    }
    const res = await publish(person, page(handle, await hostKey()), { vars: VARS });
    expect(res.body.url).toBe(`${BOOKING}/${handle}`);
    const there = await at('GET', '/v1/booking', { token: person.token });
    expect(there.body).toMatchObject({ url: `${BOOKING}/${handle}`, base: BOOKING });
  });
});

describe('booking pages at the root of BOOKING_ORIGIN', () => {
  it('serves the landing page with every link on the root layout', async () => {
    const { handle } = await host(signup, { profile: { types: [meetingType(), meetingType({ slug: '60min', title: 'An hour', duration: 60 })] } });
    const res = await at('GET', `/${handle}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('link')).toBe(`<${BOOKING}/${handle}/llms.txt>; rel="alternate"; type="text/markdown"`);
    expect(res.text).toContain('<script src="/booker.js"></script>');
    expect(res.text).toContain(`href="/${handle}/60min"`);
    expectRootLinks(res.text, handle);

    const markdown = await at('GET', `/${handle}`, { headers: { accept: 'text/markdown' } });
    expect(markdown.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(markdown.text).not.toContain('/meet');
  });

  it('serves the booker, the filled-in form, the form’s booking and the manage page with root links', async () => {
    const { handle } = await host(signup);
    const booker = await at('GET', `/${handle}/30min`);
    expect(booker.status).toBe(200);
    expectRootLinks(booker.text, handle);

    const start = slotAhead(5);
    const form = await at('GET', `/${handle}/30min?slot=${slotOf(start)}&name=Jane%20Doe`);
    expect(form.status).toBe(200);
    expect(form.text).toContain(`method="post" action="/${handle}/30min"`);
    expectRootLinks(form.text, handle);
    const idem = decode(form.text.match(/name="idem" value="([^"]*)"/)[1]);

    const fields = { start: slotOf(start), tz: 'Europe/Amsterdam', idem, name: 'Jane Doe', email: 'jane-form@example.com', notes: '' };
    const posted = await at('POST', `/${handle}/30min`, { body: new URLSearchParams(fields).toString(), contentType: FORM, headers: SAME });
    expect(posted.status).toBe(303);
    const location = posted.headers.get('location');
    expect(location).toMatch(new RegExp(`^/${handle}/booking/[A-Za-z0-9_-]{22}\\?k=`));

    const manage = await at('GET', location);
    expect(manage.status).toBe(200);
    expect(manage.text).toContain(`action="/${handle}/booking/`);
    expect(manage.text).toMatch(new RegExp(`href="/${handle}/booking/[A-Za-z0-9_-]{22}\\.ics\\?k=`));
    expect(manage.text).toMatch(new RegExp(`href="/${handle}/30min\\?[^"]*reschedule=`));
    expectRootLinks(manage.text, handle);

    // A browser on another website can't post there.
    const elsewhere = await at('POST', `/${handle}/30min`, { body: new URLSearchParams(fields).toString(), contentType: FORM, headers: { origin: 'https://accounts.example' } });
    expect(elsewhere.status).toBe(403);
  });

  it('answers the JSON API with root addresses, and books with the booking address as the UID host', async () => {
    const { handle } = await host(signup);
    const index = await at('GET', `/${handle}/api`);
    expect(index.status).toBe(200);
    expect(index.body.links).toEqual({
      page: `${BOOKING}/${handle}`,
      llms_txt: `${BOOKING}/${handle}/llms.txt`,
      bookings: `${BOOKING}/${handle}/api/bookings`,
      mcp: `${BOOKING}/mcp`,
      privacy: `${BOOKING}/privacy`
    });
    expectRootUrls(index.body, handle);

    const slots = await at('GET', `/${handle}/api/slots`);
    expect(slots.status).toBe(200);
    expect(slots.body.slots[0].book_url).toMatch(new RegExp(`^${BOOKING}/${handle}/30min\\?slot=`));
    expectRootUrls(slots.body, handle);

    const start = slotAhead(4);
    const booked = await at('POST', `/${handle}/api/bookings`, { body: { type: '30min', start: iso(start), ...guest() }, headers: { origin: BOOKING } });
    expect(booked.status).toBe(201);
    expect(booked.body.manage_url).toMatch(new RegExp(`^${BOOKING}/${handle}/booking/${booked.body.booking.id}\\?k=`));
    expect(booked.body.message).toContain(`Change or cancel: ${BOOKING}/${handle}/booking/`);
    expectRootUrls(booked.body, handle);

    const { id } = booked.body.booking;
    const auth = { authorization: `Bearer ${booked.body.key}` };
    const read = await at('GET', `/${handle}/api/bookings/${id}`, { headers: auth });
    expectRootUrls(read.body, handle);

    const ics = await at('GET', `/${handle}/booking/${id}.ics?k=${encodeURIComponent(booked.body.key)}`);
    expect(ics.status).toBe(200);
    const unfolded = ics.text.replace(/\r\n /g, '');
    expect(unfolded).toContain(`UID:${id}@booking.example`);
    expect(unfolded).toContain(`Change or cancel: ${BOOKING}/${handle}/booking/${id}?k=`);

    const evil = await at('POST', `/${handle}/api/bookings`, { body: { type: '30min', start: iso(slotAhead(6)), ...guest() }, headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(evil.body.error).toBe('cross_site');
  });

  it('serves each page’s llms.txt and the site-level one', async () => {
    const { handle } = await host(signup);
    const guide = await at('GET', `/${handle}/llms.txt`);
    expect(guide.status).toBe(200);
    expect(guide.text).toContain(`POST ${BOOKING}/${handle}/api/bookings`);
    expect(guide.text).toContain(`[MCP endpoint](${BOOKING}/mcp)`);
    expect(guide.text).toContain(`pass ${BOOKING}/${handle} as link`);
    expect(guide.text).not.toContain('/meet');

    const site = await at('GET', '/llms.txt');
    expect(site.status).toBe(200);
    expect(site.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(site.headers.get('access-control-allow-origin')).toBe('*');
    expect(site.text).toMatch(/^# Rukoo booking pages\n\n> /);
    expect(site.text).toContain(`${BOOKING}/<handle>/llms.txt`);
    expect(site.text).toContain(`${BOOKING}/mcp`);
    expect(site.text).toContain(`GET ${BOOKING}/<handle>/api/slots?type=<type>`);
    expect(site.text).toContain(`POST ${BOOKING}/<handle>/api/bookings`);
    expect(site.text).toContain(`[Privacy statement](${BOOKING}/privacy)`);
    expect(site.text).not.toContain('/meet');
    expect((await at('HEAD', '/llms.txt')).text).toBe('');
    // Only at the root of BOOKING_ORIGIN.
    expect((await old('GET', '/llms.txt')).status).toBe(404);
    expect((await call('GET', '/meet/llms.txt')).status).toBe(404);
  });

  it('serves the script at /booker.js', async () => {
    const res = await at('GET', '/booker.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.text).toBe(BOOKER_JS);
  });

  it('serves the fonts at /assets/fonts/, where the website has the same files', async () => {
    const res = await at('GET', '/assets/fonts/inter-latin-opsz-normal.woff2');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('font/woff2');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await at('HEAD', '/assets/fonts/inter-latin-ext-opsz-normal.woff2')).status).toBe(200);
    for (const path of ['/assets/fonts/nothing.woff2', '/assets/fonts/', '/assets/fonts/constructor', '/assets/fonts/inter-latin-opsz-normal.woff2/x']) {
      expect((await at('GET', path)).status, path).toBe(404);
    }
    expect((await at('POST', '/assets/fonts/inter-latin-opsz-normal.woff2', { body: {} })).status).not.toBe(200);
    const page = await at('GET', '/nobody-has-this');
    expect(page.text).toContain('<link rel="preload" href="/assets/fonts/inter-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>');
    expect(page.text).toContain("src:url('/assets/fonts/inter-latin-ext-opsz-normal.woff2') format('woff2')");
    expect(page.headers.get('content-security-policy')).toContain("font-src 'self'");
  });

  it('answers MCP at /mcp, with links on the root layout', async () => {
    const { handle } = await host(signup);
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.status).toBe(200);
    expect(init.body.result.instructions).toContain(`(${BOOKING}/<handle>, or a meeting type’s address)`);

    const types = await rpc('tools/call', { name: 'get_meeting_types', arguments: { link: `${BOOKING}/${handle}` } });
    expect(types.body.result.isError).toBe(false);
    expect(types.body.result.structuredContent.links.page).toBe(`${BOOKING}/${handle}`);
    expect(types.body.result.structuredContent.links.mcp).toBe(`${BOOKING}/mcp`);

    // A type's address picks the type; an older /meet link still names the page.
    for (const link of [`${BOOKING}/${handle}/30min`, `${BOOKING}/meet/${handle}`, `booking.example/${handle}`, handle]) {
      const times = await rpc('tools/call', { name: 'find_available_times', arguments: { link } });
      expect(times.body.result.isError, link).toBe(false);
      expect(times.body.result.structuredContent.type).toBe('30min');
    }
    const elsewhere = await rpc('tools/call', { name: 'get_meeting_types', arguments: { link: `https://accounts.example/meet/${handle}` } });
    expect(elsewhere.body.result.isError).toBe(true);
    expect(elsewhere.body.result.structuredContent.message).toContain(`such as ${BOOKING}/<handle>`);

    const booked = await rpc('tools/call', {
      name: 'book_meeting',
      arguments: { link: `${BOOKING}/${handle}`, start: iso(slotAhead(3)), name: 'Jane Doe', email: 'jane-mcp@example.com' }
    });
    expect(booked.body.result.isError).toBe(false);
    expectRootUrls(booked.body.result.structuredContent, handle);
    expect(booked.body.result.content[0].text).toContain(`Manage link for your user: ${BOOKING}/${handle}/booking/`);

    const get = await at('GET', '/mcp');
    expect(get.status).toBe(405);
    expect(get.text).toContain(`${BOOKING}/<handle>/llms.txt`);
  });

  it('takes /meet links on an address in BOOKING_ALIASES as the same page', async () => {
    const { handle } = await host(signup);
    const vars = { ...VARS, BOOKING_ALIASES: ' https://old.example/ , not an address, https://older.example:8443' };
    const tool = (name, args) => rpc('tools/call', { name, arguments: args }, { vars });
    for (const link of [`https://old.example/meet/${handle}`, `old.example/meet/${handle}/30min`, `https://older.example:8443/meet/${handle}`]) {
      const times = await tool('find_available_times', { link });
      expect(times.body.result.isError, link).toBe(false);
      expect(times.body.result.structuredContent.type).toBe('30min');
    }
    const types = await tool('get_meeting_types', { link: `https://old.example/meet/${handle}` });
    expect(types.body.result.structuredContent.links.page).toBe(`${BOOKING}/${handle}`);
    // Only /meet links: the root of a former address was never a booking page, and other addresses stay refused.
    for (const link of [`https://old.example/${handle}`, `https://older.example/meet/${handle}`, `http://old.example/meet/${handle}`, `https://elsewhere.example/meet/${handle}`]) {
      const res = await tool('get_meeting_types', { link });
      expect(res.body.result.isError, link).toBe(true);
      expect(res.body.result.structuredContent).toMatchObject({ error: 'invalid', field: 'link' });
      expect(res.body.result.structuredContent.message).toContain(`such as ${BOOKING}/<handle>`);
    }
    // Without the setting, the former address is another server.
    const without = await rpc('tools/call', { name: 'get_meeting_types', arguments: { link: `https://old.example/meet/${handle}` } });
    expect(without.body.result.isError).toBe(true);
  });

  it('redirects a renamed page to the new handle at the root', async () => {
    const { person, key, handle } = await host(signup);
    const next = newHandle('renamed');
    expect((await publish(person, page(next, key))).status).toBe(200);
    const landing = await at('GET', `/${handle}?lang=nl`);
    expect(landing.status).toBe(301);
    expect(landing.headers.get('location')).toBe(`${BOOKING}/${next}?lang=nl`);
    const index = await at('GET', `/${handle}/api`);
    expect(index.status).toBe(301);
    expect(index.headers.get('location')).toBe(`${BOOKING}/${next}/api`);
    expect(index.body.moved_to).toBe(`${BOOKING}/${next}`);
    const write = await at('POST', `/${handle}/api/bookings`, { body: { type: '30min', start: iso(slotAhead(3)), ...guest() } });
    expect(write.status).toBe(308);
    expect(write.headers.get('location')).toBe(`${BOOKING}/${next}/api/bookings`);
  });

  it('answers any other root path with the neutral 404 page', async () => {
    const bodies = new Set();
    for (const path of ['/nobody-has-this', '/download', '/github', '/Bart', '/robots.txt', '/favicon.ico', '/nobody-has-this/30min', '/meeting']) {
      const res = await at('GET', path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
      expect(res.headers.get('link'), path).toBe(null);
      expect(res.text).toContain('<script src="/booker.js"></script>');
      if (path.split('/').length === 2) bodies.add(res.text.replace(/<footer[\s\S]*<\/footer>/, ''));
    }
    expect(bodies.size).toBe(1);
    // JSON routes keep answering JSON.
    const api = await at('GET', '/nobody-has-this/api');
    expect(api.status).toBe(404);
    expect(api.body.error).toBe('not_found');
    const nothing = await at('DELETE', '/nobody-has-this');
    expect(nothing.status).toBe(404);
    expect(nothing.body.error).toBe('not_found');
    // The server's other addresses have no root layout.
    for (const path of ['/nobody-has-this', '/booker.js', '/mcp']) expect((await old('GET', path)).body.error, path).toBe('not_found');
  });

  it('keeps the website’s paths and likely future ones from being claimed', async () => {
    const person = await signup();
    const key = await hostKey();
    for (const handle of ['assets', 'img', 'media', 'download', 'downloads', 'github', 'releases', 'styles', 'app', 'docs', 'blog', 'pricing', 'contact', 'android', 'robots', 'sitemap', 'favicon', 'index', 'booker', 'llms', 'mcp', 'privacy', '404', '500']) {
      const res = await publish(person, page(handle, key), { vars: VARS });
      expect(res.status, handle).toBe(409);
      expect(res.body.error, handle).toBe('handle_reserved');
      const check = await call('GET', `/v1/booking/handles/${handle}`, { token: person.token, vars: VARS });
      expect(check.body, handle).toEqual({ handle, available: false, reason: 'reserved' });
    }
  });
});

describe('a former root of the pages, in BOOKING_FORMER_ROOTS', () => {
  // As rukoo.io, where the pages lived before meet.rukoo.io.
  const WAS = 'https://was.example';
  const MOVED = { BOOKING_ORIGIN: BOOKING, BOOKING_FORMER_ROOTS: ` ${WAS}/ , not an address, ${BOOKING}` };
  const was = (method, path, options = {}) => call(method, path, { vars: MOVED, origin: WAS, ...options });
  const now = (method, path, options = {}) => call(method, path, { vars: MOVED, origin: BOOKING, ...options });

  it('redirects reads to the same path under BOOKING_ORIGIN', async () => {
    const handle = 'bart-example';
    const cases = [
      ['GET', `/${handle}?lang=nl&tz=Europe/Amsterdam`, `${BOOKING}/${handle}?lang=nl&tz=Europe/Amsterdam`],
      ['HEAD', `/${handle}/30min?slot=2026-11-03T09:00Z`, `${BOOKING}/${handle}/30min?slot=2026-11-03T09:00Z`],
      ['GET', `/${handle}/llms.txt?type=30min`, `${BOOKING}/${handle}/llms.txt?type=30min`],
      ['GET', `/${handle}/api/slots?type=30min`, `${BOOKING}/${handle}/api/slots?type=30min`],
      ['GET', '/mcp', `${BOOKING}/mcp`],
      ['GET', '/llms.txt', `${BOOKING}/llms.txt`],
      ['GET', `/meet/${handle}`, `${BOOKING}/${handle}`],
      ['GET', '/meet/assets/booker.js', `${BOOKING}/booker.js`]
    ];
    for (const [method, path, location] of cases) {
      const res = await was(method, path);
      expect(res.status, `${method} ${path}`).toBe(301);
      expect(res.headers.get('location'), `${method} ${path}`).toBe(location);
      expect(res.headers.get('access-control-allow-origin'), `${method} ${path}`).toBe('*');
    }
    // The pages' script and fonts stay, for a manage page answered there.
    expect((await was('GET', '/booker.js')).text).toBe(BOOKER_JS);
    expect((await was('GET', '/assets/fonts/inter-latin-opsz-normal.woff2')).headers.get('content-type')).toBe('font/woff2');
    // The account API, / and /privacy stay, as on any address.
    expect((await was('GET', '/v1/info')).body.features).toEqual(['booking']);
    expect((await was('GET', '/')).status).toBe(200);
    expect((await was('GET', '/privacy')).status).toBe(200);
    expect((await was('POST', '/v1/login', { body: {} })).status).not.toBe(301);
    // Without the setting the old address is just another address of the server.
    expect((await call('GET', `/${handle}`, { vars: VARS, origin: WAS })).status).toBe(404);
  });

  it('still answers posts, MCP and keyed reads there, with the new addresses in the answers', async () => {
    const { handle } = await host(signup);
    // A form on a page opened before the move posts to its own address: a browser won't carry it to another origin.
    const form = await now('GET', `/${handle}/30min?slot=${slotOf(slotAhead(4))}`);
    const idem = decode(form.text.match(/name="idem" value="([^"]*)"/)[1]);
    const fields = { start: slotOf(slotAhead(4)), tz: 'Europe/Amsterdam', idem, name: 'Jane Doe', email: 'jane-moved@example.com' };
    const body = new URLSearchParams(fields).toString();
    const posted = await was('POST', `/${handle}/30min`, { body, contentType: FORM, headers: { origin: WAS, 'sec-fetch-site': 'same-origin' } });
    expect(posted.status).toBe(303);
    const location = posted.headers.get('location');
    expect(location).toMatch(new RegExp(`^/${handle}/booking/[A-Za-z0-9_-]{22}\\?k=`));
    // The browser goes on to the manage page under the form's form-action 'self', so it is answered there too.
    const manage = await was('GET', location);
    expect(manage.status).toBe(200);
    expect(manage.text).toContain('<p class="pill ok">Booked</p>');
    expect(manage.headers.get('link')).toBe(`<${BOOKING}/${handle}/llms.txt>; rel="alternate"; type="text/markdown"`);
    const cancelFields = Object.fromEntries([...manage.text.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], decode(m[2])]));
    expect(cancelFields.action).toBe('cancel');
    const gone = await was('POST', location.split('?')[0], { body: new URLSearchParams(cancelFields).toString(), contentType: FORM, headers: { origin: WAS, 'sec-fetch-site': 'same-origin' } });
    expect(gone.status).toBe(303);
    expect((await was('GET', gone.headers.get('location'))).text).toContain('<p class="pill gone">Cancelled</p>');
    expect((await now('GET', location)).status).toBe(200);
    // The new address takes posts from its own pages only; a page at the old one posts there.
    const across = await now('POST', `/${handle}/30min`, { body, contentType: FORM, headers: { origin: WAS, 'sec-fetch-site': 'same-site' } });
    expect(across.status).toBe(403);

    // A client with a manage key keeps its Authorization header, which a redirect to another origin would drop.
    const made = await now('POST', `/${handle}/api/bookings`, { body: { type: '30min', start: iso(slotAhead(6)), ...guest() } });
    expect(made.status).toBe(201);
    const id = made.body.booking.id;
    const read = await was('GET', `/${handle}/api/bookings/${id}`, { token: made.body.key });
    expect(read.status).toBe(200);
    expect(read.body.manage_url.startsWith(`${BOOKING}/${handle}/booking/${id}?k=`)).toBe(true);
    expect((await was('GET', `/${handle}/api/bookings/${id}`)).status).toBe(301);
    const cancelled = await was('POST', `/${handle}/api/bookings/${id}/cancel`, { token: made.body.key, body: {} });
    expect(cancelled.status).toBe(200);

    // MCP there, and links to the old address anywhere, name the same pages, which now live at the new one.
    const rpc = (at, link, name = 'find_available_times') =>
      at('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { link } } } });
    for (const link of [`${WAS}/${handle}/30min`, `${WAS}/${handle}`, `${WAS}/meet/${handle}`]) {
      const times = await rpc(now, link);
      expect(times.body.result.isError, link).toBe(false);
      expect(times.body.result.structuredContent.type).toBe('30min');
    }
    const types = await rpc(was, `${WAS}/${handle}`, 'get_meeting_types');
    expect(types.status).toBe(200);
    expect(types.body.result.structuredContent.links.page).toBe(`${BOOKING}/${handle}`);
  });
});

describe('/meet with BOOKING_ORIGIN set', () => {
  it('redirects to the root of BOOKING_ORIGIN: 301 for reads, 308 for the rest, with the query', async () => {
    const handle = 'bart-example';
    const cases = [
      ['GET', `/meet/${handle}?lang=nl&tz=Europe/Amsterdam`, 301, `${BOOKING}/${handle}?lang=nl&tz=Europe/Amsterdam`],
      ['HEAD', `/meet/${handle}/30min`, 301, `${BOOKING}/${handle}/30min`],
      ['GET', `/meet/${handle}/api/slots?type=30min`, 301, `${BOOKING}/${handle}/api/slots?type=30min`],
      ['POST', `/meet/${handle}/api/bookings`, 308, `${BOOKING}/${handle}/api/bookings`],
      ['POST', `/meet/${handle}/booking/Rf63vMqqWdS0MICDAHKmrw`, 308, `${BOOKING}/${handle}/booking/Rf63vMqqWdS0MICDAHKmrw`],
      ['OPTIONS', `/meet/${handle}/api`, 308, `${BOOKING}/${handle}/api`],
      ['POST', '/meet/mcp', 308, `${BOOKING}/mcp`],
      ['GET', '/meet/mcp', 301, `${BOOKING}/mcp`],
      ['GET', '/meet/assets/booker.js', 301, `${BOOKING}/booker.js`],
      ['GET', '/meet/assets/fonts/inter-latin-opsz-normal.woff2', 301, `${BOOKING}/assets/fonts/inter-latin-opsz-normal.woff2`],
      ['GET', '/meet', 301, `${BOOKING}/`],
      ['GET', '/meet/', 301, `${BOOKING}/`]
    ];
    for (const [method, path, status, location] of cases) {
      const res = await old(method, path, method === 'POST' ? { body: {} } : {});
      expect(res.status, `${method} ${path}`).toBe(status);
      expect(res.headers.get('location'), `${method} ${path}`).toBe(location);
      expect(res.headers.get('access-control-allow-origin'), `${method} ${path}`).toBe(status === 301 ? '*' : null);
    }
    // Old-style addresses on the booking address itself go to the root too.
    const own = await at('GET', `/meet/${handle}`);
    expect(own.status).toBe(301);
    expect(own.headers.get('location')).toBe(`${BOOKING}/${handle}`);
  });

  it('keeps the /meet layout when BOOKING_ORIGIN is empty or broken', async () => {
    const { handle } = await host(signup);
    // A former root means nothing without a BOOKING_ORIGIN to move to, so a rollback that empties it keeps /meet working.
    const was = { BOOKING_FORMER_ROOTS: 'https://accounts.example' };
    for (const vars of [{ BOOKING_ORIGIN: '', ...was }, { BOOKING_ORIGIN: 'not an address', ...was }, { BOOKING_ORIGIN: 'ftp://booking.example' }]) {
      const res = await call('GET', `/meet/${handle}`, { vars });
      expect(res.status, vars.BOOKING_ORIGIN).toBe(200);
      expect(res.text).toContain('<script src="/meet/assets/booker.js"></script>');
      expect(res.text).toContain("src:url('/meet/assets/fonts/inter-latin-opsz-normal.woff2')");
      expect(res.headers.get('link')).toBe(`<https://accounts.example/meet/${handle}/llms.txt>; rel="alternate"; type="text/markdown"`);
      expect((await call('GET', '/meet/assets/booker.js', { vars })).status).toBe(200);
      expect((await call('OPTIONS', `/meet/${handle}/api`, { vars })).status).toBe(204);
      expect((await call('GET', `/${handle}`, { vars })).status).toBe(404);
    }
  });
});
