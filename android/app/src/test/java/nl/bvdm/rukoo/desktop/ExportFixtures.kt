package nl.bvdm.rukoo.desktop

/** An export as phonehost.js bundle() and engine.js exportAccounts() write it. */
object ExportFixtures {
    const val BUNDLE = """
{
  "version": 1,
  "exportedAt": 1761130100000,
  "desktop": { "name": "desktop-zolder", "version": "1.4.0" },
  "google": { "client_id": "client-id.apps.googleusercontent.com", "client_secret": "client-secret" },
  "accounts": [
    {
      "id": "acc-imap", "type": "imap", "provider": "other", "auth": "password",
      "email": "bart@example.nl", "name": "Bart", "label": "Werk", "color": "#4a7dff",
      "signature": null, "signatureHtml": null,
      "imap": { "host": "imap.example.nl", "port": 993, "secure": true, "user": "bart@example.nl" },
      "smtp": { "host": "smtp.example.nl", "port": 465, "secure": true, "user": "bart@example.nl" },
      "caldav": null, "aliases": [], "defaultFrom": null, "scopes": [], "createdAt": 1700000000000,
      "password": "secret-pass"
    },
    {
      "id": "acc-google", "type": "imap", "provider": "google", "auth": "oauth2",
      "email": "bart@gmail.com", "name": "Bart", "label": "bart@gmail.com", "color": "#2fd6c0",
      "signature": "Groet, Bart", "signatureHtml": null,
      "imap": { "host": "imap.gmail.com", "port": 993, "secure": true, "user": "bart@gmail.com" },
      "smtp": { "host": "smtp.gmail.com", "port": 465, "secure": true, "user": "bart@gmail.com" },
      "caldav": null, "aliases": [{ "address": "b@bvdm.ai", "name": "Bart" }], "defaultFrom": "b@bvdm.ai",
      "scopes": ["https://mail.google.com/", "openid"], "createdAt": null,
      "refreshToken": "refresh-1"
    },
    {
      "id": "acc-broken", "type": "imap", "provider": "yahoo", "auth": "password",
      "email": "old@yahoo.com", "name": "Old", "label": "old@yahoo.com", "color": "#ff8a3d",
      "signature": null, "signatureHtml": null,
      "imap": { "host": "imap.mail.yahoo.com", "port": 993, "secure": true, "user": "old@yahoo.com" },
      "smtp": { "host": "smtp.mail.yahoo.com", "port": 465, "secure": true, "user": "old@yahoo.com" },
      "aliases": [], "scopes": [], "createdAt": 1700000000001,
      "secretError": "decrypt-failed"
    }
  ],
  "settings": {
    "defaultAccountId": "acc-google", "language": "nl", "theme": "dark", "signature": "Bart van der Meeren",
    "signatureHtml": "", "vips": [], "spam": [], "syncInterval": 15, "hiddenViews": [], "darkEmails": false,
    "swipeActions": false, "notifications": true, "sort": "unread", "density": "compact"
  },
  "agents": {
    "defaultAgent": "claude", "autoMailActions": true, "shortcuts": null,
    "clark": { "enabled": true, "name": "Clark", "url": "http://100.91.52.84:8642/", "key": "hermes-key", "model": "" },
    "openclaw": { "enabled": true, "url": "http://127.0.0.1:18789", "key": "", "agent": "", "model": "" },
    "claude": { "enabled": true, "model": "opus", "access": "ask" },
    "codex": { "enabled": true, "model": "", "access": "ask" },
    "mcp": { "port": 47800 }
  }
}
"""
}
