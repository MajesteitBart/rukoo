// How many accounts this server holds, so an operator can cap them (MAX_ACCOUNTS), and how often each invite code
// was used (INVITE_USES). With open sign-ups, the cap is what bounds the storage strangers can take: each account is
// limited on its own, but nothing else limits how many accounts there are. With invite codes, the uses keep one code
// from filling the cap. One object for the whole server, holding counts and hashes of invite codes, nothing about
// anyone. It also keeps a place per workspace, for MAX_WORKSPACES, and holds the installation id that tells this
// server apart from another one answering at the same address later (WORKSPACES.md, Conventions).

import { DurableObject } from 'cloudflare:workers';
import { randomBytes, toBase64url } from './bytes.js';
import { workspaceObject } from './config.js';

// A place taken for a workspace that was never confirmed made or called off is settled after this long, by asking
// the workspace.
const SETTLE_AFTER = 5 * 60 * 1000;
// When the server is full, how many made workspaces one new workspace asks whether they still exist, and how long a
// workspace that answered yes isn't asked again.
const RECHECK_BATCH = 25;
const RECHECK_AFTER = 60 * 60 * 1000;

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS counts (id INTEGER PRIMARY KEY CHECK (id = 1), accounts INTEGER NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO counts (id, accounts) VALUES (1, 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, used INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS host (id INTEGER PRIMARY KEY CHECK (id = 1), installation TEXT NOT NULL)');
    // One row per workspace: its place under MAX_WORKSPACES. made is 0 from the moment the place is taken until the
    // workspace is known to exist. checked is when a made workspace was last asked whether it still exists.
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, at INTEGER NOT NULL, made INTEGER NOT NULL DEFAULT 0, checked INTEGER NOT NULL DEFAULT 0)'
    );
    if (!this.sql.exec('PRAGMA table_info(workspace)').toArray().some((c) => c.name === 'checked')) {
      this.sql.exec('ALTER TABLE workspace ADD COLUMN checked INTEGER NOT NULL DEFAULT 0');
    }
  }

  // Made the first time workspaces are used, and never changed.
  async installation() {
    this.sql.exec('INSERT OR IGNORE INTO host (id, installation) VALUES (1, ?)', toBase64url(randomBytes(16)));
    return this.sql.exec('SELECT installation FROM host WHERE id = 1').one().installation;
  }

  // Takes a place for a workspace that is about to be made: 'ok' or 'full'. The place is kept by the workspace's id,
  // so taking, confirming and giving it back can each be repeated without counting twice.
  async reserveWorkspace(id, max) {
    await this.#settle();
    const full = () => max > 0 && this.sql.exec('SELECT COUNT(*) AS n FROM workspace').one().n >= max;
    if (full()) {
      await this.#recheck();
      if (full()) return 'full';
    }
    this.sql.exec('INSERT OR IGNORE INTO workspace (id, at, made) VALUES (?, ?, 0)', id, Date.now());
    return 'ok';
  }

  // The workspace was made.
  async confirmWorkspace(id) {
    this.sql.exec('UPDATE workspace SET made = 1 WHERE id = ?', id);
  }

  // The workspace was not made. A place that was confirmed stays.
  async releaseWorkspace(id) {
    this.sql.exec('DELETE FROM workspace WHERE id = ? AND made = 0', id);
  }

  // The workspace was deleted: its place is free again, confirmed or not. When this call doesn't arrive, #recheck
  // finds the place once the server is full.
  async forgetWorkspace(id) {
    this.sql.exec('DELETE FROM workspace WHERE id = ?', id);
  }

  // The server is full: made workspaces not asked in the past hour, those asked longest ago first, are asked whether
  // they still exist, RECHECK_BATCH at a time, and the place of one deleted without telling the registry is free
  // again. A server that really is full asks each workspace at most once an hour.
  async #recheck() {
    const now = Date.now();
    const asked = this.sql
      .exec('SELECT id FROM workspace WHERE made = 1 AND checked < ? ORDER BY checked, at LIMIT ?', now - RECHECK_AFTER, RECHECK_BATCH)
      .toArray();
    await Promise.all(
      asked.map(async ({ id }) => {
        try {
          if (await workspaceObject(this.env, id).exists()) this.sql.exec('UPDATE workspace SET checked = ? WHERE id = ?', now, id);
          else this.sql.exec('DELETE FROM workspace WHERE id = ? AND made = 1', id);
        } catch {
          // Asked again the next time the server is full.
        }
      })
    );
  }

  // When the answer to making a workspace got lost, nobody confirmed or gave back its place. The workspace itself
  // knows whether it exists, so it is asked, a few at a time, before the next place is handed out.
  async #settle() {
    const waiting = this.sql.exec('SELECT id FROM workspace WHERE made = 0 AND at < ? LIMIT 5', Date.now() - SETTLE_AFTER).toArray();
    for (const { id } of waiting) {
      try {
        if (await workspaceObject(this.env, id).exists()) this.sql.exec('UPDATE workspace SET made = 1 WHERE id = ?', id);
        else this.sql.exec('DELETE FROM workspace WHERE id = ? AND made = 0', id);
      } catch {
        // Asked again the next time a place is taken.
      }
    }
  }

  used(code) {
    const row = this.sql.exec('SELECT used FROM invites WHERE code = ?', code).toArray()[0];
    return row ? row.used : 0;
  }

  count() {
    return this.sql.exec('SELECT accounts FROM counts WHERE id = 1').one().accounts;
  }

  // Takes a place for a new account, and a use of its invite code (a hash) when it has one: 'ok', 'full' or 'used'.
  // max 0 means no cap; uses 0 means a code works any number of times. usedFirst: a used code says so even when the
  // server is full, as a workspace invitation that made its account must (WORKSPACES.md, Signing up with an invitation).
  async reserve(max, code = null, uses = 0, usedFirst = false) {
    const used = () => code && uses > 0 && this.used(code) >= uses;
    if (usedFirst && used()) return 'used';
    if (max > 0 && this.count() >= max) return 'full';
    if (used()) return 'used';
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
