'use strict';

// Jev, TypeSafe's decision model: one choice question per email, with the person's categories as the options and
// their descriptions as what each option means. https://docs.typesafe.ai
const https = require('https');

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// A fixed version, so the sorting doesn't change when TypeSafe moves jev-latest.
const MODEL = 'jev-1.13.0';
const TIMEOUT = 20000;
// How much of an email's text goes along.
const TEXT_CHARS = 1000;
// The most of an answer that is read; one takes a few hundred bytes.
const MAX_ANSWER = 1024 * 1024;

class JevError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// An option name for each category: its name in lowercase words, which the model reads, made unique.
function optionNames(categories) {
  const names = new Map();
  const taken = new Set();
  for (const c of categories) {
    const base =
      String(c.name || c.id)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'category';
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
    taken.add(name);
    names.set(c.id, name);
  }
  return names;
}

// What Jev reads about one email. Nothing else of the mail leaves this computer.
function emailState(m, { toMe }) {
  const s = m.signals || {};
  return {
    from: { name: (m.from && m.from.name) || '', address: (m.from && m.from.address) || '' },
    addressed_to_me: Boolean(toMe),
    subject: m.subject || '',
    text: String(m.preview || '').slice(0, TEXT_CHARS),
    has_attachments: Boolean(m.hasAttachments),
    mailing_list: Boolean(s.list),
    sent_in_bulk: Boolean(s.bulk),
    sent_automatically: Boolean(s.auto),
    marketing_software: Boolean(s.campaign),
    ...(m.gmailTab ? { gmail_tab: m.gmailTab } : {})
  };
}

function post(key, body, request = https.request) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = request(
      ENDPOINT,
      {
        method: 'POST',
        timeout: TIMEOUT,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': payload.length }
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_ANSWER) {
            reject(new JevError('server', res.statusCode));
            req.destroy();
          } else chunks.push(c);
        });
        // An answer cut off halfway ends without 'end'; without these the request would wait forever, and every
        // later sort behind it.
        res.on('error', () => reject(new JevError('network')));
        res.on('close', () => {
          if (!res.complete) reject(new JevError('network'));
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (_) {
            json = null;
          }
          if (res.statusCode >= 200 && res.statusCode < 300 && json) return resolve(json);
          const code = res.statusCode === 401 || res.statusCode === 403 ? 'key' : res.statusCode === 429 || res.statusCode === 529 ? 'busy' : 'server';
          reject(new JevError(code, res.statusCode));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new JevError('network')));
    req.write(payload);
    req.end();
  });
}

// { category, confidence, model } for one email, or a JevError. categories: [{ id, name, description }] in order.
async function classify(key, m, categories, { toMe = false, request } = {}) {
  const names = optionNames(categories);
  const criteria = {};
  for (const c of categories) criteria[names.get(c.id)] = c.description || c.name;
  const res = await post(
    key,
    {
      model: MODEL,
      state: emailState(m, { toMe }),
      questions: {
        category: {
          type: 'choice',
          instructions:
            'Which of these inbox categories does this email belong in? Read each category\'s description. When more than one fits, choose the one listed first.',
          criteria
        }
      }
    },
    request
  );
  const answer = res && res.answers && res.answers.category;
  const chosen = answer && [...names.entries()].find(([, name]) => name === answer.choice);
  if (!chosen) throw new JevError('answer');
  return { category: chosen[0], confidence: Number(answer.confidence) || 0, model: String(res.model || MODEL) };
}

module.exports = { MODEL, TEXT_CHARS, MAX_ANSWER, JevError, classify, optionNames, emailState };
