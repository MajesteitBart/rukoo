// How many accounts this server holds, so an operator can cap them (MAX_ACCOUNTS). With open sign-ups, the cap is
// what bounds the storage strangers can take: each account is limited on its own, but nothing else limits how many
// accounts there are. One object for the whole server, holding a single number and nothing about anyone.

import { DurableObject } from 'cloudflare:workers';

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS counts (id INTEGER PRIMARY KEY CHECK (id = 1), accounts INTEGER NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO counts (id, accounts) VALUES (1, 0)');
  }

  count() {
    return this.sql.exec('SELECT accounts FROM counts WHERE id = 1').one().accounts;
  }

  // Takes a place for a new account; false when the server is full. max 0 means no cap.
  async reserve(max) {
    if (max > 0 && this.count() >= max) return false;
    this.sql.exec('UPDATE counts SET accounts = accounts + 1 WHERE id = 1');
    return true;
  }

  // Gives a place back: the sign-up didn't happen after all, or the account was deleted.
  async release() {
    this.sql.exec('UPDATE counts SET accounts = MAX(0, accounts - 1) WHERE id = 1');
  }

  async accounts() {
    return this.count();
  }
}
