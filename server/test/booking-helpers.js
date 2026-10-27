// Shared by the booking page tests: a host's key pair, a profile and open hours to publish, and calls on the public
// routes. Times are real UTC instants; the tests set the clock with vi.setSystemTime.

import { env } from 'cloudflare:workers';
import { toBase64url } from '../src/bytes.js';
import { keyId } from '../src/seal.js';
import { addDays, zonedInstant, zonedParts } from '../src/zone.js';
import { call, random, randomIp } from './helpers.js';

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const ORIGIN = 'https://accounts.example';

let counter = 0;
export function newHandle(prefix = 'host') {
  counter += 1;
  const tail = Array.from(random(4), (b) => (b % 36).toString(36)).join('');
  return `${prefix}-${counter}-${tail}`;
}

export async function hostKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privatePkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { publicRaw, privatePkcs8, publicKey: toBase64url(publicRaw), keyId: toBase64url(await keyId(publicRaw)) };
}

export function meetingType(overrides = {}) {
  return {
    slug: '30min',
    title: '30 minute meeting',
    duration: 30,
    description: '',
    location: { kind: 'googleMeet', label: 'Google Meet' },
    bufferBefore: 0,
    bufferAfter: 0,
    minNotice: 240,
    horizon: 30,
    slotInterval: 30,
    dailyLimit: null,
    confirm: false,
    hidden: false,
    schedule: 'default',
    ...overrides
  };
}

export function profile(key, overrides = {}) {
  return {
    name: 'Bart van der Meeren',
    intro: 'Happy to talk about agents in your team.',
    timeZone: 'Europe/Amsterdam',
    locale: 'en',
    keyId: key.keyId,
    publicKey: key.publicKey,
    contact: 'No time that works? Reply to my last email.',
    dailyCap: 20,
    types: [meetingType()],
    ...overrides
  };
}

// Open hours on every day from today to days ahead, as [start, end] pairs in the zone.
export function hours({ zone = 'Europe/Amsterdam', from = '09:00', to = '17:00', days = 30, weekdays = [0, 1, 2, 3, 4, 5, 6], now = Date.now() } = {}) {
  const out = [];
  let date = zonedParts(now, zone).date;
  for (let i = 0; i <= days; i++, date = addDays(date, 1)) {
    const s = zonedInstant(date, from, zone);
    if (!weekdays.includes(zonedParts(s, zone).weekday)) continue;
    out.push([s, zonedInstant(date, to, zone)]);
  }
  return out;
}

export function page(handle, key, overrides = {}) {
  return {
    handle,
    enabled: true,
    profile: profile(key, overrides.profile),
    windows: overrides.windows ?? { default: hours() },
    busy: overrides.busy ?? [],
    ...(overrides.takeover === undefined ? {} : { takeover: overrides.takeover }),
    ...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled })
  };
}

export function publish(person, body, options = {}) {
  return call('PUT', '/v1/booking', { token: person.token, body, ...options });
}

// A host with a published page: { person, key, handle, body }.
export async function host(signup, overrides = {}) {
  const person = await signup();
  const key = await hostKey();
  const handle = overrides.handle ?? newHandle();
  const body = page(handle, key, overrides);
  const res = await publish(person, body);
  if (res.status !== 200) throw new Error(`Publish failed: ${res.status} ${res.text}`);
  return { person, key, handle, body, view: res.body };
}

export function bookingStub(handle) {
  return env.BOOKINGS.get(env.BOOKINGS.idFromName(`booking\n${handle}`));
}

// A guest's booking through the JSON API.
export function book(handle, body, { ip = randomIp(), headers = {}, vars } = {}) {
  return call('POST', `/meet/${handle}/api/bookings`, { body, ip, headers, vars });
}

export function guest(overrides = {}) {
  return { name: 'Jane Doe', email: `jane-${random(3).join('')}@example.com`, notes: 'Kickoff', time_zone: 'Europe/Amsterdam', ...overrides };
}

export function iso(ms) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

// A start a week ahead at 10:00 Amsterdam time, on a weekday, safely inside default hours.
export function slotAhead(days = 7, time = '10:00', zone = 'Europe/Amsterdam', now = Date.now()) {
  return zonedInstant(addDays(zonedParts(now, zone).date, days), time, zone);
}
