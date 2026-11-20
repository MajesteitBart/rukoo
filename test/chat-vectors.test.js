'use strict';

// Checks test/fixtures/chat-vectors.json, the vectors both apps' chat code reads: mention offsets, invitation links
// and operation IDs. Each check here is written from the team chat contract (mentions, invitation links, UUIDv7) and
// shares no code with the apps, so a wrong vector fails here before it can make both apps agree on a mistake.

const test = require('node:test');
const assert = require('node:assert/strict');
const { serverUrl } = require('../src/main/account/client');
const vectors = require('./fixtures/chat-vectors.json');

const MEMBER_ID = /^u_[A-Za-z0-9_-]{22}$/;
const WORKSPACE_ID = /^w_[A-Za-z0-9_-]{22}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_MENTIONS = 32;
const RULES = ['split_character', 'out_of_order', 'overlap', 'past_end', 'empty', 'too_many', 'bad_actor'];

// ---- mentions ----

// Every rule a list of byte ranges breaks in text: ranges start and end between code points, come in order, don't
// overlap, end within the text and number at most 32, and each names a member.
function brokenRules(text, mentions) {
  const utf8 = Buffer.from(text, 'utf8');
  const between = (at) => at === utf8.length || (at < utf8.length && (utf8[at] & 0xc0) !== 0x80);
  const broken = new Set();
  if (mentions.length > MAX_MENTIONS) broken.add('too_many');
  let prev = null;
  for (const m of mentions) {
    if (typeof m.actor !== 'string' || !MEMBER_ID.test(m.actor)) broken.add('bad_actor');
    assert.ok(Number.isSafeInteger(m.start) && m.start >= 0 && Number.isSafeInteger(m.end) && m.end >= 0, `offsets are whole numbers: ${JSON.stringify(m)}`);
    if (m.end <= m.start) broken.add('empty');
    if (m.start > utf8.length || m.end > utf8.length) broken.add('past_end');
    if ((m.start <= utf8.length && !between(m.start)) || (m.end <= utf8.length && !between(m.end))) broken.add('split_character');
    if (prev) {
      if (m.start < prev.start) broken.add('out_of_order');
      else if (m.start < prev.end) broken.add('overlap');
    }
    prev = m;
  }
  return [...broken].sort();
}

const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff;
// A UTF-16 index between code points: not between the two halves of a surrogate pair.
const utf16Between = (text, i) => i === 0 || i === text.length || !(isHighSurrogate(text.charCodeAt(i - 1)) && isLowSurrogate(text.charCodeAt(i)));

test('every mention case pairs its UTF-16 ranges with the UTF-8 byte ranges of the same text', () => {
  for (const c of vectors.mentions) {
    assert.ok(c.text.isWellFormed(), `${c.name}: text is well formed`);
    assert.equal(c.utf16.length, c.bytes.length, c.name);
    c.utf16.forEach((m, k) => {
      assert.ok(m.start >= 0 && m.start < m.end && m.end <= c.text.length, `${c.name}: utf16 range ${k} lies in the text`);
      assert.ok(utf16Between(c.text, m.start) && utf16Between(c.text, m.end), `${c.name}: utf16 range ${k} is between code points`);
      assert.ok(c.text.slice(m.start, m.end).startsWith('@'), `${c.name}: utf16 range ${k} covers an @ chip`);
      const expected = {
        actor: m.actor,
        start: Buffer.byteLength(c.text.slice(0, m.start), 'utf8'),
        end: Buffer.byteLength(c.text.slice(0, m.end), 'utf8')
      };
      assert.deepEqual(c.bytes[k], expected, `${c.name}: bytes range ${k}`);
      // The bytes cut out the same characters the UTF-16 range does.
      assert.equal(Buffer.from(c.text, 'utf8').subarray(expected.start, expected.end).toString('utf8'), c.text.slice(m.start, m.end), `${c.name}: range ${k} text`);
    });
    assert.deepEqual(brokenRules(c.text, c.bytes), [], `${c.name}: breaks no rule`);
  }
});

test('the mention cases cover every case the contract lists', () => {
  const cases = vectors.mentions;
  assert.ok(cases.length >= 12, `at least 12 mention cases, found ${cases.length}`);
  const has = (what, pred) => assert.ok(cases.some(pred), `a mention case with ${what}`);
  has('ASCII text only', (c) => c.bytes.length > 0 && /^[\x20-\x7e]*$/.test(c.text));
  has('Zoë', (c) => c.utf16.some((m) => c.text.slice(m.start, m.end) === '@Zoë'));
  has('Joël', (c) => c.utf16.some((m) => c.text.slice(m.start, m.end) === '@Joël'));
  has('CJK', (c) => c.bytes.length > 0 && /\p{Script=Han}/u.test(c.text));
  has('an emoji with a skin tone modifier', (c) => c.bytes.length > 0 && /[\u{1F3FB}-\u{1F3FF}]/u.test(c.text));
  has('a ZWJ family emoji', (c) => c.bytes.length > 0 && /\p{Extended_Pictographic}‍\p{Extended_Pictographic}‍\p{Extended_Pictographic}/u.test(c.text));
  has('combining marks inside a mention', (c) => c.utf16.some((m) => /\p{M}/u.test(c.text.slice(m.start, m.end))));
  has('two chips separated by one space', (c) => c.utf16.some((m, k) => k > 0 && m.start === c.utf16[k - 1].end + 1 && c.text[m.start - 1] === ' '));
  has('a mention at the start', (c) => c.bytes.some((m) => m.start === 0));
  has('a mention at the end', (c) => c.bytes.some((m) => m.end === Buffer.byteLength(c.text)));
  has('a line break', (c) => c.bytes.length > 0 && /\n/.test(c.text));
  has('32 mentions', (c) => c.bytes.length === MAX_MENTIONS);
});

test('every bad mention case breaks exactly the rule it names', () => {
  for (const c of vectors.badMentions) {
    assert.ok(RULES.includes(c.rule), `${c.name}: known rule ${c.rule}`);
    assert.deepEqual(brokenRules(c.text, c.bytes), [c.rule], c.name);
  }
});

test('the bad mention cases cover every rule the contract lists', () => {
  const cases = vectors.badMentions;
  assert.ok(cases.length >= 8, `at least 8 bad mention cases, found ${cases.length}`);
  for (const rule of RULES) assert.ok(cases.some((c) => c.rule === rule), `a case for ${rule}`);
  // Which character a split lands in: the length of the UTF-8 sequence around the offset.
  const splitWidths = new Set();
  for (const c of cases.filter((x) => x.rule === 'split_character')) {
    const utf8 = Buffer.from(c.text, 'utf8');
    for (const m of c.bytes) {
      for (const at of [m.start, m.end]) {
        if (at >= utf8.length || (utf8[at] & 0xc0) !== 0x80) continue;
        let lead = at;
        while ((utf8[lead] & 0xc0) === 0x80) lead -= 1;
        splitWidths.add(utf8[lead] >= 0xf0 ? 4 : utf8[lead] >= 0xe0 ? 3 : 2);
      }
    }
  }
  assert.ok(splitWidths.has(2), 'a case splits a two-byte character');
  assert.ok(splitWidths.has(4), 'a case splits a four-byte character');
  assert.ok(cases.some((c) => c.rule === 'empty' && c.bytes.some((m) => m.start === m.end)), 'an empty range');
  assert.ok(cases.some((c) => c.rule === 'too_many' && c.bytes.length === MAX_MENTIONS + 1), '33 mentions');
});

// ---- invitation links ----

// Characters that can't end a link, and the ones that can't start a link written without its scheme.
const QUOTES = '‘’‚“”„«»‹›';
const CLOSING = new RegExp(`[.,;:!?)\\]}>'"${QUOTES}]+$`);
const OPENING = new RegExp(`^[(\\[{<'"${QUOTES}]+`);
// <host>[:<port>][/<path>]/join#<fragment>, with a host of letters, digits, dots and hyphens.
const WITHOUT_SCHEME = /^[A-Za-z0-9.-]+(:[0-9]+)?(\/\S*)?\/join#\S*$/;

// Step 1: the link in pasted text. The first http:// or https:// URL up to white space, without the characters
// that can't end a link; without one, the first word that is a link without its scheme, read as https.
function linkIn(text) {
  const trimmed = String(text).trim();
  const found = /https?:\/\/\S+/.exec(trimmed);
  if (found) return found[0].replace(CLOSING, '');
  for (const word of trimmed.split(/\s+/)) {
    const bare = word.replace(OPENING, '').replace(CLOSING, '');
    if (WITHOUT_SCHEME.test(bare)) return `https://${bare}`;
  }
  return null;
}

// The contract's parsing steps for an invitation link, in order. devHosts are the extra local hosts Android allows
// for http in debug builds.
function parseInviteLink(text, configured, devHosts = []) {
  const bad = { result: null, error: 'bad_link' };
  // 1. Trim, then the link in the text.
  const found = linkIn(text);
  if (!found) return bad;
  let url;
  try {
    url = new URL(found);
  } catch (_) {
    return bad;
  }
  // 2. http only for local hosts.
  const local = ['localhost', '127.0.0.1', '[::1]', ...devHosts].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return bad;
  // 3. No user info, the path ends with /join, the fragment is w and i in any order and nothing else.
  if (url.username || url.password) return bad;
  if (!url.pathname.endsWith('/join')) return bad;
  const pairs = url.hash.replace(/^#/, '').split('&').map((p) => {
    const eq = p.indexOf('=');
    return eq < 0 ? [p, null] : [p.slice(0, eq), p.slice(eq + 1)];
  });
  if (pairs.length !== 2) return bad;
  const fragment = Object.fromEntries(pairs);
  if (Object.keys(fragment).sort().join() !== 'i,w') return bad;
  // 4. The shapes of w and i.
  if (!WORKSPACE_ID.test(fragment.w) || !SECRET.test(fragment.i)) return bad;
  // 5. The server: origin plus the path without /join and without a trailing slash.
  const server = url.origin + url.pathname.slice(0, -'/join'.length).replace(/\/+$/, '');
  // 6. Another server than the configured one.
  if (server !== configured) return { result: null, error: 'other_server' };
  return { result: { server, workspace: fragment.w, secret: fragment.i }, error: null };
}

test('every invitation link case parses as the contract says, on desktop and on Android', () => {
  for (const c of vectors.inviteLinks) {
    // Desktop can't be configured for http on 10.0.2.2, the emulator's address of the computer, so that server is
    // written as Android would keep it.
    const normalized = c.android ? new URL(c.server).origin : serverUrl(c.server);
    assert.equal(normalized, c.server, `${c.name}: server is written as the account service normalizes it`);
    assert.ok((c.expect === null) !== (c.error === null), `${c.name}: either expect or error`);
    assert.deepEqual(parseInviteLink(c.text, c.server), { result: c.expect, error: c.error }, `${c.name} on desktop`);
    if (c.expect) {
      assert.match(c.expect.workspace, WORKSPACE_ID, c.name);
      assert.match(c.expect.secret, SECRET, c.name);
    }
    // Android's debug builds add 10.0.2.2; a case with an android entry says what that changes.
    const android = c.android || { expect: c.expect, error: c.error };
    if (c.android) assert.equal(c.android.build, 'debug', `${c.name}: android override names its build`);
    assert.deepEqual(parseInviteLink(c.text, c.server, ['10.0.2.2']), { result: android.expect, error: android.error }, `${c.name} on Android debug`);
  }
});

test('the invitation link cases cover every case the contract lists', () => {
  const cases = vectors.inviteLinks;
  assert.ok(cases.length >= 14, `at least 14 invitation link cases, found ${cases.length}`);
  const has = (what, pred) => assert.ok(cases.some(pred), `an invitation link case: ${what}`);
  const accepted = (c) => c.error === null;
  const refused = (c) => c.error === 'bad_link';
  has('plain', (c) => accepted(c) && c.text.startsWith('https://') && !/\s/.test(c.text));
  has('inside longer text', (c) => accepted(c) && /\S\s+https?:\/\/\S+\s+\S/.test(c.text));
  has('surrounded by white space', (c) => accepted(c) && c.text !== c.text.trim());
  has('keys in reverse order', (c) => accepted(c) && /#i=.*&w=/.test(c.text));
  has('local http on 127.0.0.1', (c) => accepted(c) && c.text.includes('http://127.0.0.1'));
  has('http on a public host', (c) => refused(c) && /http:\/\/(?!127\.|localhost|\[::1\]|10\.0\.2\.2)/.test(c.text));
  has('10.0.2.2 for Android debug only', (c) => refused(c) && c.text.includes('http://10.0.2.2') && c.android && c.android.error === null);
  has('missing w', (c) => refused(c) && !/[#&]w=/.test(c.text) && c.text.includes('/join#'));
  has('malformed w', (c) => refused(c) && /[#&]w=(?!w_[A-Za-z0-9_-]{22}(&|$|\s))/.test(c.text));
  has('short secret', (c) => refused(c) && /[#&]i=[A-Za-z0-9_-]{1,42}(&|$|\s)/.test(c.text));
  has('an extra fragment key', (c) => refused(c) && /[#&](?![wi]=)[^&=\s]+=/.test(c.text));
  has('a path other than /join', (c) => refused(c) && /:\/\/[^/\s]+\/(?!join)[^\s#]*#w=/.test(c.text));
  has('user info', (c) => refused(c) && /:\/\/[^/\s@]+@/.test(c.text));
  has('another server', (c) => c.error === 'other_server');
  has('a server with a base path', (c) => accepted(c) && new URL(c.expect.server).pathname !== '/');
  // What people paste from sentences and mails: punctuation after the link, and a link without its scheme.
  // An accepted link whose last value, the secret or the workspace ID, is followed by one of chars in the text.
  const follows = (c, chars) => accepted(c) && [c.expect.secret, c.expect.workspace].some((v) => [...chars].some((ch) => c.text.includes(v + ch)));
  has('a full stop after the link', (c) => follows(c, '.'));
  has('a closing bracket after the link', (c) => follows(c, ')'));
  has('a quote after the link', (c) => follows(c, '"”'));
  has('a comma after the link', (c) => follows(c, ','));
  has('a link without a scheme', (c) => accepted(c) && !/https?:\/\//.test(c.text));
  has('a link that stays bad without its punctuation', (c) => refused(c) && /https?:\/\/\S+[.,;:!?)\]}>'"‘’‚“”„«»‹›]$/.test(c.text.trim()));
});

// ---- UUIDv7 ----

// The contract's layout: bytes 0 to 5 the milliseconds big-endian, byte 6 0x70 | (r[0] & 0x0f), byte 7 r[1],
// byte 8 0x80 | (r[2] & 0x3f), bytes 9 to 15 r[3..9]; lowercase hex in 8-4-4-4-12 groups.
function uuidv7(ms, r) {
  const b = new Array(16);
  let rest = BigInt(ms);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  assert.equal(rest, 0n, `${ms} fits in 48 bits`);
  b[6] = 0x70 | (r[0] & 0x0f);
  b[7] = r[1];
  b[8] = 0x80 | (r[2] & 0x3f);
  for (let i = 3; i <= 9; i++) b[i + 6] = r[i];
  const hex = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

test('every UUIDv7 case rebuilds from its milliseconds and random bytes', () => {
  assert.ok(vectors.uuidv7.length >= 3, `at least 3 UUIDv7 cases, found ${vectors.uuidv7.length}`);
  for (const c of vectors.uuidv7) {
    assert.match(c.random, /^[0-9a-f]{20}$/, `${c.name}: 10 random bytes as hex`);
    assert.ok(Number.isSafeInteger(c.ms) && c.ms >= 0, `${c.name}: ms`);
    const r = Array.from({ length: 10 }, (_, i) => parseInt(c.random.slice(i * 2, i * 2 + 2), 16));
    assert.equal(uuidv7(c.ms, r), c.id, c.name);
    // The server's check, and the time it reads back from the first 48 bits.
    assert.match(c.id, UUID_V7, c.name);
    assert.equal(parseInt(c.id.replace(/-/g, '').slice(0, 12), 16), c.ms, `${c.name}: time`);
  }
});

// ---- the whole file ----

test('the file keeps its shape and holds only made-up IDs and secrets', () => {
  assert.deepEqual(Object.keys(vectors), ['about', 'mentions', 'badMentions', 'inviteLinks', 'uuidv7']);
  assert.equal(typeof vectors.about, 'string');
  const names = new Set();
  for (const section of ['mentions', 'badMentions', 'inviteLinks', 'uuidv7']) {
    for (const c of vectors[section]) {
      assert.equal(typeof c.name, 'string', section);
      assert.ok(!names.has(`${section}/${c.name}`), `${section}: unique name ${c.name}`);
      names.add(`${section}/${c.name}`);
    }
  }
  for (const c of vectors.mentions) for (const m of [...c.utf16, ...c.bytes]) assert.match(m.actor, MEMBER_ID, c.name);
  // Hosts are the product's own, documentation domains or local addresses.
  for (const c of vectors.inviteLinks) {
    for (const u of [c.server, ...(c.text.match(/https?:\/\/\S+/g) || []), linkIn(c.text)].filter(Boolean)) {
      assert.match(new URL(u).hostname.toLowerCase(), /^(rukoo\.io|(chat\.)?example\.(com|net)|localhost|127\.0\.0\.1|\[::1\]|10\.0\.2\.2)$/, `${c.name}: ${u}`);
    }
  }
});
