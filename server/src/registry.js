// How many accounts this server holds, so an operator can cap them (MAX_ACCOUNTS), and how often each invite code
// was used (INVITE_USES). With open sign-ups, the cap is what bounds the storage strangers can take: each account is
// limited on its own, but nothing else limits how many accounts there are. With invite codes, the uses keep one code
// from filling the cap. One object for the whole server, holding counts and hashes of invite codes, nothing about
// anyone.

import { DurableObject } from 'cloudflare:workers';

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS counts (id INTEGER PRIMARY KEY CHECK (id = 1), accounts INTEGER NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO counts (id, accounts) VALUES (1, 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, used INTEGER NOT NULL)');
  }

  used(code) {
    const row = this.sql.exec('SELECT used FROM invites WHERE code = ?', code).toArray()[0];
    return row ? row.used : 0;
  }

  count() {
    return this.sql.exec('SELECT accounts FROM counts WHERE id = 1').one().accounts;
  }

  // Takes a place for a new account, and a use of its invite code (a hash) when it has one: 'ok', 'full' or 'used'.
  // max 0 means no cap; uses 0 means a code works any number of times.
  async reserve(max, code = null, uses = 0) {
    if (max > 0 && this.count() >= max) return 'full';
    if (code && uses > 0 && this.used(code) >= uses) return 'used';
    this.sql.exec('UPDATE counts SET accounts = accounts + 1 WHERE id = 1');
    if (code) this.sql.exec('INSERT INTO invites (code, used) VALUES (?, 1) ON CONFLICT (code) DO UPDATE SET used = used + 1', code);
    return 'ok';
  }

  // Gives a place back. With the code, the sign-up didn't happen after all, so its use comes back too; a deleted
  // account gives back only its place, or a code could be used again and again.
  async release(code = null) {
    this.sql.exec('UPDATE counts SET accounts = MAX(0, accounts - 1) WHERE id = 1');
    if (code) this.sql.exec('UPDATE invites SET used = MAX(0, used - 1) WHERE code = ?', code);
  }

  async accounts() {
    return this.count();
  }
}
