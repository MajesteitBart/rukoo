// AWS Signature Version 4 for requests to an S3-compatible store (filestore.js), with Web Crypto only. The steps are
// AWS's: a canonical request, a string to sign that holds its SHA-256, and an HMAC of that under a key derived from
// the secret, the day, the region and the service. What a request sends and what it signs are built from the same
// parts here, so they can't drift apart.
//
// Nothing here logs, and nothing it throws holds the secret, the derived key or a signature.

import { utf8 } from './bytes.js';

export const ALGORITHM = 'AWS4-HMAC-SHA256';
// The SHA-256 of no bytes: the payload hash of a request without a body.
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// A string as RFC 3986 encodes it, which S3 expects in a path segment and a query: everything but the unreserved
// characters A-Z a-z 0-9 - _ . ~ as %XX in upper case. encodeURIComponent leaves ! ' ( ) * as they are.
export function encodeRfc3986(text) {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// The canonical query string: each name and value encoded, sorted by name and then value, joined with &. The same
// string is the query the request is sent with.
export function canonicalQuery(query = []) {
  return query
    .map(([name, value]) => [encodeRfc3986(String(name)), encodeRfc3986(String(value ?? ''))])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

// 20130524T000000Z for a moment.
export function amzDate(time) {
  return new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmacBytes(key, text) {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, utf8(text)));
}

// The derived key changes once a day; it is kept for the secret, day, region and service it was made for.
let derived = { id: null, key: null };

async function signingKey(secret, day, region, service) {
  const id = `${day}\n${region}\n${service}\n${secret}`;
  if (derived.id !== id) {
    let key = await hmacBytes(utf8(`AWS4${secret}`), day);
    key = await hmacBytes(key, region);
    key = await hmacBytes(key, service);
    key = await hmacBytes(key, 'aws4_request');
    derived = { id, key: await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) };
  }
  return derived.key;
}

// Signs a request. path is the encoded path exactly as it is sent; query a list of [name, value] pairs; headers the
// headers to send and sign besides host, x-amz-date and x-amz-content-sha256, which are added here. payloadHash is the
// hex SHA-256 of the body the service checks, EMPTY_SHA256 without one. time is a moment in milliseconds.
//
// Returns the headers to send, Authorization included, and the query string, with the canonical request, the string
// to sign and the signature for tests.
export async function sign({ method, host, path, query = [], headers = {}, payloadHash = EMPTY_SHA256, region, service = 's3', accessKeyId, secretAccessKey, time = Date.now() }) {
  const date = amzDate(time);
  const day = date.slice(0, 8);
  const all = new Map();
  for (const [name, value] of Object.entries(headers)) all.set(name.toLowerCase(), String(value));
  all.set('host', host);
  all.set('x-amz-date', date);
  all.set('x-amz-content-sha256', payloadHash);
  const names = [...all.keys()].sort();
  const canonicalHeaders = names.map((name) => `${name}:${all.get(name).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const queryString = canonicalQuery(query);
  const canonicalRequest = [method, path, queryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, date, scope, hex(await crypto.subtle.digest('SHA-256', utf8(canonicalRequest)))].join('\n');
  const key = await signingKey(secretAccessKey, day, region, service);
  const signature = hex(await crypto.subtle.sign('HMAC', key, utf8(stringToSign)));
  const out = Object.fromEntries([...all].filter(([name]) => name !== 'host'));
  out.authorization = `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: out, query: queryString, canonicalRequest, stringToSign, signature };
}
