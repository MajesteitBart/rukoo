// The page at / tells anyone who opens the server's address what it is, who runs it and what it can see. It is plain
// HTML with no scripts and nothing loaded from elsewhere.

const PROTOCOL_URL = 'https://github.com/MajesteitBart/rukoo/blob/main/server/PROTOCOL.md';

const PLACES = {
  eu: 'in the European Union',
  us: 'in the United States',
  fedramp: 'in FedRAMP-Moderate data centers in the United States'
};

function escape(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Only web addresses become links; the values come from the operator's settings, but a javascript: link is never right.
function link(url, label) {
  return /^https?:\/\//i.test(url || '') ? `<a href="${escape(url)}">${escape(label)}</a>` : escape(label);
}

function contact(value) {
  if (!value) return '';
  const isAddress = /^[^\s@]+@[^\s@]+$/.test(value);
  const target = isAddress ? `<a href="mailto:${escape(value)}">${escape(value)}</a>` : link(value, value);
  return ` You can reach them at ${target}.`;
}

export function page({ operator, jurisdiction, signups }) {
  const runBy = operator.name
    ? `<p>This server is run by ${link(operator.url, operator.name)}.${contact(operator.contact)}</p>`
    : `<p>Whoever runs this server hasn't filled in their name.${contact(operator.contact)}</p>`;
  const place = PLACES[jurisdiction]
    ? `Each account is stored and handled ${PLACES[jurisdiction]} (Cloudflare's "${jurisdiction}" jurisdiction).`
    : 'Each account is stored in one Cloudflare location, usually near the first device that used it.';
  const newAccounts = {
    open: 'Anyone can make an account here.',
    invite: 'New accounts need an invite code.',
    closed: 'This server takes no new accounts.'
  }[signups];
  const links = [
    operator.privacy && link(operator.privacy, 'Privacy statement'),
    link(PROTOCOL_URL, 'The Rukoo account protocol')
  ]
    .filter(Boolean)
    .join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rukoo account server</title>
<style>
body { font: 16px/1.55 system-ui, sans-serif; max-width: 38rem; margin: 2.5rem auto; padding: 0 1.25rem; color: #1f2328; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; } a { color: #0b62c4; }
@media (prefers-color-scheme: dark) { body { background: #16181c; color: #e6e8eb; } a { color: #6cb0ff; } }
</style>
</head>
<body>
<h1>Rukoo account server</h1>
<p>This is a server for Rukoo accounts. Rukoo is an open-source mail app. A Rukoo account keeps a person's inbox categories, the category each email got and their corrections in step between their devices. No mail and no mail passwords pass through this server. ${escape(newAccounts)}</p>

<h2>Who runs it</h2>
${runBy}

<h2>Where the data is</h2>
<p>The server runs on Cloudflare, a service of Cloudflare, Inc., a company in the United States. ${escape(place)}</p>

<h2>What the server can see</h2>
<p>Records are encrypted on the person's devices, end to end, with a key this server never has. What it can see:</p>
<ul>
<li>The account's email address, when it was made and the <code>kdf</code> parameters.</li>
<li>Device names and platforms, and when each device last connected.</li>
<li>How many records there are, their sizes and when they change.</li>
<li>IP addresses, in Cloudflare's request logs and in the rate limiter.</li>
</ul>
<p>It can't see what a record holds: no category names, no senders, no Message-IDs and nothing about the mail.</p>

<p>${links}</p>
</body>
</html>
`;
}
