'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine, encodeId, decodeId } = require('../src/main/engine');
const { AgentHub } = require('../src/main/agents/hub');

async function setup({ auto = false, deps = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-tools-'));
  const engine = new Engine({ dataDir: dir }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  if (auto) fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ autoMailActions: true }));
  const unsubscribed = [];
  const hub = new AgentHub({
    engine,
    dataDir: dir,
    deps: { appVersion: '1.0.0', tempDir: path.join(dir, 'agent-tmp'), unsubscribe: async (id) => (unsubscribed.push(id), { done: true }), ...deps },
    adapters: {},
    listen: false
  });
  await hub.start();
  const events = [];
  hub.on('event', (e) => events.push(e));
  // A stand-in for the renderer's side of the UI bridge.
  const ui = [];
  hub.ui = async (action, args) => {
    ui.push({ action, args });
    if (action === 'getDraft') return hub.draft || null;
    if (action === 'writeDraft') return { ok: true, draft: { to: [{ name: 'Sanne de Vries', address: 'sanne@example.com' }], subject: 'Re: Call on Thursday' } };
    return null;
  };
  const find = (subject, view = 'inbox') => engine.listMessages({ scope: acc.id, view }).find((m) => m.subject === subject);
  const done = async () => {
    await hub.dispose();
    await engine.close();
  };
  return { dir, engine, acc, hub, events, ui, find, unsubscribed, done };
}

const local = (conversationId = null) => ({ agent: 'claude', conversationId, remote: false });
const data = (res) => {
  assert.ok(!res.isError, res.content && res.content[0].text);
  return res.structuredContent;
};

test('search_mail matches every word anywhere (subject, preview, people) and filters', async () => {
  const t = await setup();
  try {
    const hits = data(await t.hub.callTool(local(), 'search_mail', { query: 'call thursday' }));
    const subjects = hits.results.map((r) => r.subject);
    assert.ok(subjects.includes('Call on Thursday'), 'the engine substring search misses this; tokens do not');
    assert.ok(subjects.includes('Re: Call on Thursday'), 'sent mail is searched too');
    const first = hits.results.find((r) => r.subject === 'Call on Thursday');
    assert.equal(first.messageId, '<demo-13@example.com>');
    assert.equal(first.account, 'demo@example.com');
    assert.equal(first.role, 'inbox');
    assert.match(first.date, /^\d{4}-\d\d-\d\dT/);
    assert.equal(first.has_attachments, true);
    assert.deepEqual(Object.keys(first).sort(), ['account', 'cc', 'date', 'folder', 'from', 'has_attachments', 'id', 'messageId', 'preview', 'role', 'starred', 'subject', 'to', 'unread'].sort());
    // Joris is only in cc of Sanne's mail.
    const joris = data(await t.hub.callTool(local(), 'search_mail', { query: 'joris thursday' }));
    assert.ok(joris.results.some((r) => r.subject === 'Call on Thursday'));
    const from = data(await t.hub.callTool(local(), 'search_mail', { from: 'vandebron', unread: true, limit: 1 }));
    assert.equal(from.results.length, 1);
    assert.ok(from.total >= 2);
    assert.ok(from.results.every((r) => r.unread && /vandebron/i.test(r.from.address)));
    // User folders only reach the cache after they were opened; search opens them.
    const invoices = data(await t.hub.callTool(local(), 'search_mail', { folder: 'Invoices', account: 'demo@example.com' }));
    assert.equal(invoices.results[0].subject, 'Your invoice for October');
    const sent = data(await t.hub.callTool(local(), 'search_mail', { folder: 'sent' }));
    assert.ok(sent.results.length && sent.results.every((r) => r.role === 'sent'));
    const bad = await t.hub.callTool(local(), 'search_mail', { folder: 'Nope' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Invoices/);
    const badAccount = await t.hub.callTool(local(), 'search_mail', { account: 'x@y.z' });
    assert.match(badAccount.content[0].text, /demo@example.com/);
  } finally {
    await t.done();
  }
});

test('read_message returns headers, text and attachments without marking it read', async () => {
  const t = await setup();
  try {
    const call = t.find('Call on Thursday');
    assert.equal(call.unread, true);
    const m = data(await t.hub.callTool(local(), 'read_message', { message_id: call.id }));
    assert.equal(m.id, call.id);
    assert.equal(m.message_id_header, '<demo-13@example.com>');
    assert.equal(m.from.address, 'sanne@example.com');
    assert.equal(m.cc[0].address, 'joris@example.com');
    assert.match(m.text, /Thursday at 10:00/);
    assert.equal(m.truncated, false);
    assert.deepEqual(m.attachments, [{ index: 0, filename: 'Proposal-v3.pdf', content_type: 'application/pdf', size: 192 }]);
    assert.equal(m.unsubscribe, false);
    assert.equal('html' in m, false, 'agents never get html');
    assert.equal(t.find('Call on Thursday').unread, true);
    // The Message-ID header works as an id too, and max_chars cuts the text.
    const byHeader = data(await t.hub.callTool(local(), 'read_message', { message_id: '<demo-13@example.com>', max_chars: 200 }));
    assert.equal(byHeader.id, call.id);
    const anwb = t.find('Traffic fines in 2027: what you will pay');
    const short = data(await t.hub.callTool(local(), 'read_message', { message_id: anwb.id, max_chars: 200 }));
    // 200 characters of body, inside its <unsafe_content> tag.
    const body = short.text.match(/^<unsafe_content source="email" message_id="[^"]*">\n([\s\S]*)\n<\/unsafe_content>$/);
    assert.ok(body, 'the body is tagged as unsafe content');
    assert.equal(body[1].length, 200);
    assert.equal(short.truncated, true);
    assert.equal(short.unsubscribe, true);
    const missing = await t.hub.callTool(local(), 'read_message', { message_id: 'nope:INBOX:1' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /search_mail/);
  } finally {
    await t.done();
  }
});

test('read_attachment hands a PDF out as a resource, with a local file only for local agents', async () => {
  const t = await setup();
  try {
    const call = t.find('Call on Thursday');
    const res = await t.hub.callTool(local(), 'read_attachment', { message_id: call.id, index: 0 });
    assert.ok(!res.isError, res.content[0].text);
    const [note, resource] = res.content;
    assert.equal(note.type, 'text');
    assert.equal(resource.type, 'resource');
    assert.equal(resource.resource.mimeType, 'application/pdf');
    assert.equal(resource.resource.uri, `rukoo://attachment/${encodeURIComponent(call.id)}/0`);
    assert.match(Buffer.from(resource.resource.blob, 'base64').toString('latin1'), /^%PDF-1\.4/);
    const info = JSON.parse(note.text);
    // The long form of the temp folder (os.tmpdir() can be an 8.3 path), the same one Claude gets as --add-dir.
    const base = fs.realpathSync.native(path.join(t.dir, 'agent-tmp'));
    assert.ok(info.local_path.startsWith(base + path.sep), info.local_path);
    assert.equal(t.hub.tempBase(), base);
    assert.equal(path.basename(info.local_path), 'Proposal-v3.pdf');
    assert.equal(fs.readFileSync(info.local_path).length, 192);
    const remote = await t.hub.callTool({ agent: 'clark', conversationId: null, remote: true }, 'read_attachment', { message_id: call.id, index: 0 });
    assert.equal(JSON.parse(remote.content[0].text).local_path, undefined, 'Clark runs on another machine');
    const none = await t.hub.callTool(local(), 'read_attachment', { message_id: call.id, index: 3 });
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /0: Proposal-v3\.pdf/);
    await t.done();
    assert.equal(fs.existsSync(info.local_path), false, 'the copy is removed on quit');
  } catch (err) {
    await t.done();
    throw err;
  }
});

test('get_context shows the open email, its thread, the selection and the composer draft', async () => {
  const t = await setup();
  try {
    const call = t.find('Call on Thursday');
    const dinner = t.find('Re: Dinner on Saturday');
    const c = t.hub.create({ agent: 'claude', message: { id: call.id } });
    t.hub.view({ openMessageId: call.id, checkedIds: [dinner.id, 'gone:INBOX:99'], scope: 'all', view: 'inbox', folder: null, composer: { mode: 'reply', replyToId: call.id } });
    t.hub.draft = { mode: 'reply', to: [{ name: 'Sanne', address: 'sanne@example.com' }], subject: 'Re: Call on Thursday', text: 'Hi Sanne,', html: '<div>Hi</div>', dirty: true, agent: { name: 'Claude' } };
    const ctx = data(await t.hub.callTool(local(c.id), 'get_context', {}));
    assert.equal(ctx.conversation_id, c.id);
    assert.equal(ctx.agent, 'claude');
    assert.match(ctx.today, /^\d{4}-\d\d-\d\d$/);
    assert.equal(ctx.user.accounts[0].email, 'demo@example.com');
    assert.ok(ctx.user.accounts[0].folders.some((f) => f.path === 'Archive' && f.role === 'archive'));
    assert.equal(ctx.open_message.id, call.id);
    assert.match(ctx.open_message.text, /discuss the proposal/);
    assert.equal(ctx.chat_message, null, 'the chat email is the open one');
    assert.deepEqual(ctx.thread.map((m) => m.subject), ['Re: Call on Thursday'], 'the demo has no threading headers; the subject rule finds the reply');
    assert.deepEqual(ctx.selection.map((m) => m.id), [dinner.id]);
    assert.equal(ctx.composer.text, 'Hi Sanne,');
    assert.equal(ctx.composer.agent, 'Claude');
    assert.equal('html' in ctx.composer, false);
    assert.deepEqual(t.ui.map((u) => u.action), ['getDraft']);
    // Looking at another email: the chat email comes along as chat_message.
    t.hub.view({ openMessageId: dinner.id });
    const other = data(await t.hub.callTool(local(c.id), 'get_context', {}));
    assert.equal(other.open_message.id, dinner.id);
    assert.equal(other.chat_message.id, call.id);
    assert.equal(other.composer, null, 'no composer open, no bridge call');
    assert.equal(t.ui.length, 1);
  } finally {
    await t.done();
  }
});

test('write_draft asks the renderer to fill the composer and records a draft item', async () => {
  const t = await setup();
  try {
    const call = t.find('Call on Thursday');
    const c = t.hub.create({ agent: 'claude', message: { id: call.id } });
    const res = data(
      await t.hub.callTool(local(c.id), 'write_draft', { body: 'Hi Sanne,\n\n**Thursday** works.', mode: 'reply_all', cc: ['Joris <joris@example.com>'] })
    );
    const { action, args } = t.ui[0];
    assert.equal(action, 'writeDraft');
    assert.equal(args.messageId, call.id);
    assert.equal(args.mode, 'replyAll', 'composer mode names');
    assert.equal(args.html, '<div>Hi Sanne,</div><div><br></div><div><b>Thursday</b> works.</div>');
    assert.deepEqual(args.cc, [{ name: 'Joris', address: 'joris@example.com' }]);
    assert.equal('to' in args, false, 'recipients the agent did not set stay as the composer has them');
    assert.equal(args.agentName, 'Claude');
    assert.equal(args.conversationId, c.id);
    assert.equal(res.ok, true);
    assert.match(res.note, /cannot send/);
    assert.equal(res.draft.body_text, 'Hi Sanne,\n\nThursday works.');
    const item = c.items.find((i) => i.type === 'draft');
    assert.equal(item.mode, 'reply_all');
    assert.equal(item.subject, 'Re: Call on Thursday');
    assert.equal(item.to[0].address, 'sanne@example.com');
    assert.equal(item.summary, 'Hi Sanne, Thursday works.');
    assert.equal(item.messageRef, call.id);
    assert.equal(item.undone, false);
    // New mail needs no email; reply without one is refused.
    const loose = t.hub.create({ agent: 'claude', message: null });
    data(await t.hub.callTool(local(loose.id), 'write_draft', { body: 'Hello', mode: 'new', to: ['a@b.nl'], subject: 'Hi' }));
    assert.equal(t.ui[1].args.messageId, null);
    assert.equal(t.ui[1].args.mode, 'new');
    const reply = await t.hub.callTool(local(loose.id), 'write_draft', { body: 'x', mode: 'reply' });
    assert.equal(reply.isError, true);
    const badTo = await t.hub.callTool(local(loose.id), 'write_draft', { body: 'x', mode: 'new', to: ['not an address'] });
    assert.equal(badTo.isError, true);
    // With the window closed the tool fails in words the model can pass on.
    t.hub.ui = async () => {
      throw Object.assign(new Error('window'), { code: 'window' });
    };
    const closed = await t.hub.callTool(local(c.id), 'write_draft', { body: 'x' });
    assert.equal(closed.isError, true);
    assert.match(closed.content[0].text, /window is closed/);
  } finally {
    await t.done();
  }
});

test('write_draft refuses a draft the composer cannot hold whole, and reports what the composer shows', async () => {
  const t = await setup();
  try {
    const call = t.find('Call on Thursday');
    const c = t.hub.create({ agent: 'claude', message: { id: call.id } });
    // Within the 100,000 characters the schema allows, but every short line becomes a <div> of its own.
    const long = await t.hub.callTool(local(c.id), 'write_draft', { body: 'a\n'.repeat(40000) });
    assert.equal(long.isError, true);
    assert.match(long.content[0].text, /too long for the composer/);
    assert.equal(t.ui.length, 0, 'nothing reached the composer');
    assert.equal(c.items.some((i) => i.type === 'draft'), false);
    // From outside a chat: refused before a chat is made for it.
    const chats = t.hub.conversations.size;
    const outside = await t.hub.callTool(clarkRemote, 'write_draft', { body: 'a\n'.repeat(40000), mode: 'new' });
    assert.equal(outside.isError, true);
    assert.equal(t.hub.conversations.size, chats, 'no empty chat left behind');
    // body_text is the composer's text as the renderer read it back (here with the signature it added).
    t.hub.ui = async () => ({ ok: true, draft: { to: [], subject: 'Re: Call on Thursday', text: 'Thursday works.\n\n-- \nBart' } });
    const res = data(await t.hub.callTool(local(c.id), 'write_draft', { body: 'Thursday works.' }));
    assert.equal(res.draft.body_text, 'Thursday works.\n\n-- \nBart');
  } finally {
    await t.done();
  }
});

test('show_plan upserts by plan id or task ids; show_sources keeps only safe links', async () => {
  const t = await setup();
  try {
    const c = t.hub.create({ agent: 'codex', message: null });
    const me = { agent: 'codex', conversationId: null, remote: false };
    t.hub.mapThread('thread-1', c.id);
    const meta = { threadId: 'thread-1' };
    const first = data(await t.hub.callTool(me, 'show_plan', { title: 'Follow-ups', tasks: [{ title: 'A' }, { title: 'B', status: 'done', url: 'javascript:alert(1)' }] }, meta));
    assert.equal(first.plan_id, 'p1');
    assert.deepEqual(first.tasks, [
      { id: 't1', title: 'A', status: 'todo' },
      { id: 't2', title: 'B', status: 'done' }
    ]);
    const plan = c.items.find((i) => i.type === 'plan');
    assert.equal(plan.tasks[1].url, null);
    // Same task ids without plan_id: the latest plan updates in place.
    const second = data(await t.hub.callTool(me, 'show_plan', { tasks: [{ id: 't1', status: 'running', url: 'https://todoist.com/x' }] }, meta));
    assert.equal(second.plan_id, 'p1');
    assert.equal(c.items.filter((i) => i.type === 'plan').length, 1);
    assert.equal(plan.tasks[0].status, 'running');
    assert.equal(plan.tasks[0].title, 'A', 'fields that were not sent stay');
    assert.equal(plan.tasks[0].url, 'https://todoist.com/x');
    // By plan_id, new tasks are appended with the next free id.
    const third = data(await t.hub.callTool(me, 'show_plan', { plan_id: 'p1', tasks: [{ title: 'C' }] }, meta));
    assert.deepEqual(third.tasks.map((x) => x.id), ['t1', 't2', 't3']);
    const unknown = data(await t.hub.callTool(me, 'show_plan', { tasks: [{ id: 'zz', title: 'Other' }] }, meta));
    assert.equal(unknown.plan_id, 'p2');
    const bad = await t.hub.callTool(me, 'show_plan', { plan_id: 'p1', tasks: [{ id: 'new-without-title' }] }, meta);
    assert.equal(bad.isError, true);
    assert.equal(plan.tasks.length, 3, 'a refused call changes nothing');
    const empty = await t.hub.callTool(me, 'show_plan', { tasks: [] }, meta);
    assert.equal(empty.isError, true);

    const call = t.find('Call on Thursday');
    data(
      await t.hub.callTool(
        me,
        'show_sources',
        {
          sources: [
            { title: 'Earlier mail', message_id: call.id },
            { title: 'Note', url: 'obsidian://open?vault=x', source: 'Obsidian' },
            { title: 'Evil', url: 'file:///C:/Windows' }
          ]
        },
        meta
      )
    );
    const sources = c.items.find((i) => i.type === 'sources').sources;
    assert.equal(sources[0].messageId, call.id);
    assert.equal(sources[0].source, 'Email');
    assert.equal(sources[1].url, 'obsidian://open?vault=x');
    assert.equal(sources[2].url, null);
  } finally {
    await t.done();
  }
});

test('mail_action asks first; approving archives, notes it and can be undone', async () => {
  const t = await setup();
  try {
    const target = t.find('Sign in to Bencompare');
    const c = t.hub.create({ agent: 'claude', message: null });
    const res = data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'archive', message_ids: [target.id] }));
    assert.equal(res.status, 'waiting_for_user');
    const card = c.items.find((i) => i.id === res.proposal_id);
    assert.equal(card.type, 'approval');
    assert.equal(card.kind, 'mail');
    assert.equal(card.status, 'pending');
    assert.equal(card.title, 'Archive 1 email');
    assert.deepEqual(card.fields, [{ label: 'Bencompare', value: 'Sign in to Bencompare' }]);
    assert.ok(t.find('Sign in to Bencompare'), 'nothing happens before the user decides');
    t.hub.decide(c.id, card.id, 'approve');
    for (let i = 0; i < 50 && !c.items.some((x) => x.type === 'notice'); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(card.status, 'approved');
    assert.equal(t.find('Sign in to Bencompare'), undefined);
    const notice = c.items.find((i) => i.type === 'notice');
    assert.equal(notice.text, 'Archived 1 email');
    assert.equal(notice.tone, 'success');
    assert.deepEqual(notice.undo, { kind: 'move', ids: [target.id] });
    assert.match(c.notes[0], /^The user approved: <unsafe_content source="mail action">Archive 1 email<\/unsafe_content>\. Rukoo: <unsafe_content source="mail result">Archived 1 email/);
    const undone = await t.hub.undo(c.id, notice.id);
    assert.deepEqual(undone, { restored: 1, failed: 0 });
    assert.ok(t.find('Sign in to Bencompare'), 'back in the inbox');
    assert.equal(notice.undo, null);
    await assert.rejects(() => t.hub.undo(c.id, notice.id), /invalid/);
    // Declining only leaves a note.
    const again = data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'trash', message_ids: [t.find('Sign in to Bencompare').id] }));
    t.hub.decide(c.id, again.proposal_id, 'decline');
    assert.equal(c.items.find((i) => i.id === again.proposal_id).status, 'denied');
    assert.ok(t.find('Sign in to Bencompare'));
    assert.match(c.notes.at(-1), /declined: <unsafe_content source="mail action">Delete 1 email<\/unsafe_content>/);
    // Bad input is refused before any card appears.
    const cards = c.items.length;
    assert.equal((await t.hub.callTool(local(c.id), 'mail_action', { action: 'move', message_ids: [target.id] })).isError, true);
    assert.equal((await t.hub.callTool(local(c.id), 'mail_action', { action: 'move', message_ids: [t.find('Sign in to Bencompare').id], folder: 'Nope' })).isError, true);
    assert.equal((await t.hub.callTool(local(c.id), 'mail_action', { action: 'archive', message_ids: ['gone:INBOX:1'] })).isError, true);
    assert.equal(c.items.length, cards);
  } finally {
    await t.done();
  }
});

test('auto mail actions run at once (archive stays undoable); unsubscribe still asks', async () => {
  const t = await setup({ auto: true });
  try {
    const c = t.hub.create({ agent: 'claude', message: null });
    const target = t.find('Your travel summary for September');
    const res = data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'archive', message_ids: [target.id] }));
    assert.equal(res.status, 'done');
    assert.equal(res.done, 1);
    assert.equal(res.undoable, true);
    assert.equal(t.find('Your travel summary for September'), undefined);
    assert.ok(t.engine.canUndo(target.id));
    assert.ok(!c.items.some((i) => i.type === 'approval'));
    const star = data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'star', message_ids: [t.find('Call on Thursday').id] }));
    assert.equal(star.done, 1);
    assert.equal(t.find('Call on Thursday').starred, true);

    const news = t.find('Traffic fines in 2027: what you will pay');
    const unsub = data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'unsubscribe', message_ids: [news.id] }));
    assert.equal(unsub.status, 'waiting_for_user');
    const card = c.items.find((i) => i.id === unsub.proposal_id);
    assert.equal(card.title, 'Unsubscribe from ANWB Newsletter');
    t.hub.decide(c.id, card.id, 'approve');
    for (let i = 0; i < 50 && !t.unsubscribed.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(t.unsubscribed, [news.id]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(c.items.at(-1).text, 'Unsubscribed from ANWB Newsletter');
  } finally {
    await t.done();
  }
});

test('display tools without a conversation open an external one and ask the renderer to reveal it', async () => {
  const t = await setup();
  try {
    const call = t.find('Call on Thursday');
    t.hub.view({ openMessageId: call.id });
    const clark = { agent: 'clark', conversationId: null, remote: true };
    const res = data(await t.hub.callTool(clark, 'propose_action', { title: 'Add 2 tasks to Todoist', confirm_label: 'Add' }));
    const reveal = t.events.find((e) => e.kind === 'reveal');
    assert.ok(reveal);
    const c = t.hub.get(reveal.conversationId);
    assert.equal(c.origin, 'external');
    assert.equal(c.agent, 'clark');
    assert.equal(c.message.id, call.id);
    assert.equal(c.message.messageId, '<demo-13@example.com>');
    const card = c.items.find((i) => i.id === res.proposal_id);
    assert.deepEqual(card.choices, [
      { id: 'approve', label: 'Add', kind: 'primary' },
      { id: 'decline', label: 'Decline', kind: 'default' }
    ]);
    assert.equal(card.kind, 'proposal');
    assert.equal(card.source, 'clark');
    // Read-only tools do not create anything.
    const before = t.hub.list().length;
    data(await t.hub.callTool(clark, 'search_mail', { query: 'thursday' }));
    assert.equal(t.hub.list().length, before);
    // Passing conversation_id targets that conversation, but only for its own agent.
    data(await t.hub.callTool(clark, 'show_sources', { conversation_id: c.id, sources: [{ title: 'x' }] }));
    assert.equal(t.hub.list().length, before);
    const mine = t.hub.create({ agent: 'claude', message: null });
    data(await t.hub.callTool(clark, 'show_sources', { conversation_id: mine.id, sources: [{ title: 'y' }] }));
    assert.equal(mine.items.length, 0, 'Clark cannot write into a Claude conversation');
  } finally {
    await t.done();
  }
});

test('unknown tools and bad arguments come back as tool errors the model can read', async () => {
  const t = await setup();
  try {
    const unknown = await t.hub.callTool(local(), 'send_mail', {});
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /get_context, search_mail/);
    const prefixed = await t.hub.callTool(local(), 'mcp__rukoo__search_mail', { query: 'thursday', limit: '2' });
    assert.equal(prefixed.isError, undefined, 'prefixed names and numeric strings are accepted');
    assert.equal(prefixed.structuredContent.results.length, 2);
    const limit = await t.hub.callTool(local(), 'search_mail', { limit: 500 });
    assert.match(limit.content[0].text, /at most 50/);
    const enumBad = await t.hub.callTool(local(), 'mail_action', { action: 'explode', message_ids: ['x'] });
    assert.match(enumBad.content[0].text, /one of: archive/);
    const missing = await t.hub.callTool(local(), 'read_message', {});
    assert.match(missing.content[0].text, /message_id is required/);
  } finally {
    await t.done();
  }
});

// ---------- round 1 fixes ----------

const clarkRemote = { agent: 'clark', conversationId: null, remote: true };

test('an external agent stays in one conversation per open email, and learns its id from every display tool', async () => {
  const t = await setup();
  try {
    const call = t.find('Call on Thursday');
    t.hub.view({ openMessageId: call.id });
    const plan = data(await t.hub.callTool(clarkRemote, 'show_plan', { tasks: [{ id: 't1', title: 'Do it' }] }));
    const proposal = data(await t.hub.callTool(clarkRemote, 'propose_action', { title: 'Add a task' }));
    const update = data(await t.hub.callTool(clarkRemote, 'show_plan', { plan_id: plan.plan_id, tasks: [{ id: 't1', status: 'done' }] }));
    const sources = data(await t.hub.callTool(clarkRemote, 'show_sources', { sources: [{ title: 'x' }] }));
    const external = t.hub.list().filter((c) => c.origin === 'external');
    assert.equal(external.length, 1);
    const id = external[0].id;
    assert.deepEqual([plan.conversation_id, proposal.conversation_id, update.conversation_id, sources.conversation_id], [id, id, id, id]);
    assert.deepEqual(update.tasks, [{ id: 't1', title: 'Do it', status: 'done' }]);
    assert.equal(t.events.filter((e) => e.kind === 'reveal').length, 1, 'only the new conversation is revealed');
    // Another email: another conversation. A bad call with nothing to update leaves nothing behind.
    t.hub.view({ openMessageId: t.find('Your parcel is on its way').id });
    const bad = await t.hub.callTool(clarkRemote, 'show_plan', { tasks: [{ id: 't9', status: 'done' }] });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /needs a title/);
    assert.equal(t.hub.list().filter((c) => c.origin === 'external').length, 1);
    const other = data(await t.hub.callTool(clarkRemote, 'show_sources', { sources: [{ title: 'y' }] }));
    assert.notEqual(other.conversation_id, id);
    // Stale ones are not reused.
    t.hub.get(other.conversation_id).updatedAt -= 5 * 60 * 60 * 1000;
    const fresh = data(await t.hub.callTool(clarkRemote, 'show_sources', { sources: [{ title: 'z' }] }));
    assert.notEqual(fresh.conversation_id, other.conversation_id);
  } finally {
    await t.done();
  }
});

test('a flood of external display calls cannot push out the chats of the user', async () => {
  const t = await setup();
  try {
    const mine = [];
    for (let i = 0; i < 5; i++) mine.push(t.hub.create({ agent: 'claude', message: null }).id);
    const views = t.engine.listMessages({ scope: t.acc.id, view: 'inbox' });
    for (let i = 0; i < 150; i++) {
      t.hub.view({ openMessageId: views[i % views.length].id });
      data(await t.hub.callTool(clarkRemote, 'show_plan', { tasks: [{ title: `x${i}` }] }));
    }
    const list = t.hub.list();
    assert.ok(list.filter((c) => c.origin === 'external').length <= 20);
    for (const id of mine) assert.ok(t.hub.get(id), 'panel chats survive');
  } finally {
    await t.done();
  }
});

test('an agent that is turned off gets no tool access', async () => {
  const t = await setup();
  try {
    const c = t.hub.create({ agent: 'claude', message: null });
    await t.hub.updateConfig({ clark: { enabled: false }, claude: { enabled: false } });
    const remote = await t.hub.callTool(clarkRemote, 'search_mail', { query: 'thursday' });
    assert.equal(remote.isError, true);
    assert.match(remote.content[0].text, /turned off in Rukoo/);
    const draft = await t.hub.callTool(local(c.id), 'write_draft', { body: 'hi', mode: 'new' });
    assert.equal(draft.isError, true);
    assert.equal(t.ui.length, 0, 'nothing reached the composer');
    const codex = data(await t.hub.callTool({ agent: 'codex', conversationId: null, remote: false }, 'search_mail', { query: 'thursday' }));
    assert.ok(codex.results.length > 0, 'agents that are on keep working');
  } finally {
    await t.done();
  }
});

test('search_mail and read_message call the All Mail role of Gmail "archive", like get_context', async () => {
  const t = await setup();
  try {
    await t.engine.archive(t.find('Sign in to Bencompare').id);
    t.engine.caches.get(t.acc.id).folders.find((f) => f.path === 'Archive').role = 'all';
    const hit = data(await t.hub.callTool(local(), 'search_mail', { query: 'bencompare' })).results.find((r) => r.folder === 'Archive');
    assert.equal(hit.role, 'archive');
    const byRole = data(await t.hub.callTool(local(), 'search_mail', { folder: 'archive' }));
    assert.ok(byRole.results.length && byRole.results.every((r) => r.role === 'archive'));
    assert.equal(data(await t.hub.callTool(local(), 'read_message', { message_id: hit.id })).role, 'archive');
  } finally {
    await t.done();
  }
});

test('write_draft for a chat whose email is gone fails instead of replying to the open email', async () => {
  const t = await setup();
  try {
    const call = t.find('Call on Thursday');
    const c = t.hub.create({ agent: 'claude', message: { id: call.id } });
    await t.engine.move(call.id, 'Invoices');
    t.hub.view({ openMessageId: t.find('Your parcel is on its way').id });
    const res = await t.hub.callTool(local(c.id), 'write_draft', { body: 'Hi Sanne' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Pass message_id/);
    assert.equal(t.ui.length, 0);
    const ctx = data(await t.hub.callTool(local(c.id), 'get_context', {}));
    assert.equal(ctx.chat_message, null);
    assert.equal(ctx.chat_message_missing, true);
    assert.equal(ctx.chat_message_subject, 'Call on Thursday');
    // A chat about no email still drafts a reply to the open one.
    const loose = t.hub.create({ agent: 'claude', message: null });
    data(await t.hub.callTool(local(loose.id), 'write_draft', { body: 'Hi' }));
    assert.equal(t.ui[0].args.mode, 'reply');
  } finally {
    await t.done();
  }
});

test('write_draft: the draft item records its composer; explicit empty recipients pass through; a busy composer is explained', async () => {
  const t = await setup();
  try {
    const call = t.find('Call on Thursday');
    const c = t.hub.create({ agent: 'claude', message: { id: call.id } });
    t.hub.ui = async (action, args) => {
      t.ui.push({ action, args });
      return { ok: true, draft: { key: 'composer-1', mode: 'reply', to: [], cc: [], subject: 'Re: Call on Thursday' } };
    };
    const res = data(await t.hub.callTool(local(c.id), 'write_draft', { body: 'Hi', cc: [] }));
    assert.equal(res.conversation_id, c.id);
    assert.deepEqual(t.ui[0].args.cc, [], 'an explicit empty list clears the field');
    assert.equal('to' in t.ui[0].args, false);
    assert.equal('bcc' in t.ui[0].args, false);
    assert.equal(c.items.find((i) => i.type === 'draft').composerKey, 'composer-1');
    t.hub.ui = async () => {
      throw Object.assign(new Error('busy'), { code: 'busy', detail: 'The user is writing another email in the composer.' });
    };
    const busy = await t.hub.callTool(local(c.id), 'write_draft', { body: 'Hi' });
    assert.equal(busy.isError, true);
    assert.match(busy.content[0].text, /ask the user to finish or close that email/);
    t.hub.ui = async () => {
      throw Object.assign(new Error('busy'), { code: 'busy', detail: 'The composer is busy sending, saving or closing.' });
    };
    assert.match((await t.hub.callTool(local(c.id), 'write_draft', { body: 'Hi' })).content[0].text, /Wait a moment and try again/);
  } finally {
    await t.done();
  }
});

test('auto mail actions still ask before deleting', async () => {
  const t = await setup({ auto: true });
  try {
    const c = t.hub.create({ agent: 'claude', message: null });
    const res = data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'trash', message_ids: [t.find('Sign in to Bencompare').id] }));
    assert.equal(res.status, 'waiting_for_user');
    assert.equal(res.conversation_id, c.id);
    assert.ok(t.find('Sign in to Bencompare'));
    const auto = data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'mark_read', message_ids: [t.find('Sign in to Bencompare').id] }));
    assert.deepEqual([auto.status, auto.conversation_id], ['done', c.id]);
  } finally {
    await t.done();
  }
});

test('an approved mail action refuses a message that is no longer the one on the card', async () => {
  const t = await setup();
  try {
    const removed = [];
    t.engine.remove = async (id) => removed.push(id);
    const c = t.hub.create({ agent: 'claude', message: null });
    const box = t.engine.caches.get(t.acc.id).boxes.INBOX;
    const waitNotice = async (n) => {
      for (let i = 0; i < 50 && c.items.filter((x) => x.type === 'notice').length < n; i++) await new Promise((r) => setTimeout(r, 10));
    };
    // The mailbox was rebuilt: same folder, new UIDVALIDITY.
    const first = data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'trash', message_ids: [t.find('Sign in to Bencompare').id] }));
    box.uidValidity = 'rebuilt';
    t.hub.decide(c.id, first.proposal_id, 'approve');
    await waitNotice(1);
    assert.deepEqual(removed, []);
    assert.match(c.items.filter((x) => x.type === 'notice').at(-1).text, /^Could not delete 1 email\. 1 failed: The email is no longer there/);
    // Another message took over the uid.
    const target = t.find('Sign in to Bencompare');
    const second = data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'trash', message_ids: [target.id] }));
    const a = box.messages.find((m) => m.subject === 'Sign in to Bencompare');
    const b = box.messages.find((m) => m.subject === 'Call on Thursday');
    [a.uid, b.uid] = [b.uid, a.uid];
    t.hub.decide(c.id, second.proposal_id, 'approve');
    await waitNotice(2);
    assert.deepEqual(removed, [], 'Call on Thursday was not deleted in its place');
    const notices = c.items.filter((x) => x.type === 'notice');
    assert.equal(notices.length, 2);
    assert.equal(notices[1].tone, 'error');
    assert.match(notices[1].text, /no longer there/);
  } finally {
    await t.done();
  }
});

test('unsubscribing from a sender that only takes email opens a filled-in email to send', async () => {
  const opened = [];
  const t = await setup({ deps: { unsubscribe: async () => ({ mailto: 'mailto:leave@news.example?subject=unsubscribe' }), openMailto: async (url) => opened.push(url) } });
  try {
    const c = t.hub.create({ agent: 'claude', message: null });
    const news = t.find('Traffic fines in 2027: what you will pay');
    const res = data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'unsubscribe', message_ids: [news.id] }));
    t.hub.decide(c.id, res.proposal_id, 'approve');
    for (let i = 0; i < 50 && !c.items.some((x) => x.type === 'notice'); i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(opened, ['mailto:leave@news.example?subject=unsubscribe']);
    const notice = c.items.find((x) => x.type === 'notice');
    assert.equal(notice.text, 'Opened an unsubscribe email to leave@news.example. Send it to finish');
    assert.equal(notice.tone, 'success');
    assert.equal(notice.mail.action, 'unsubscribe_email');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(c.notes.at(-1), 'The user approved: <unsafe_content source="mail action">Unsubscribe from ANWB Newsletter</unsafe_content>. Rukoo: <unsafe_content source="mail result">Opened an unsubscribe email to leave@news.example. Send it to finish</unsafe_content>.');
  } finally {
    await t.done();
  }
});

test('auto mail actions also ask before a move into Trash, by name or by role', async () => {
  const t = await setup({ auto: true });
  try {
    const c = t.hub.create({ agent: 'claude', message: null });
    for (const folder of ['Trash', 'trash']) {
      const res = data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'move', folder, message_ids: [t.find('Sign in to Bencompare').id] }));
      assert.equal(res.status, 'waiting_for_user', `move to ${folder} waits for the user`);
      assert.ok(t.find('Sign in to Bencompare'), 'nothing moved yet');
    }
    // A move elsewhere still runs at once.
    const moved = data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'move', folder: 'Archive', message_ids: [t.find('Sign in to Bencompare').id] }));
    assert.equal(moved.status, 'done');
  } finally {
    await t.done();
  }
});

test('an external agent gets a separate conversation for the same email in another account', async () => {
  const t = await setup();
  try {
    // A second account that received the same mail: a copy of the first one's cache under another id.
    const second = { ...t.engine.accounts[0], id: 'acc-two', email: 'other@example.com' };
    t.engine.accounts.push(second);
    t.engine.caches.set(second.id, structuredClone(t.engine.caches.get(t.acc.id)));
    const a = t.find('Call on Thursday');
    const { folder, uid } = decodeId(a.id);
    const b = encodeId(second.id, folder, uid);

    t.hub.view({ openMessageId: a.id });
    const first = data(await t.hub.callTool(clarkRemote, 'show_sources', { sources: [{ title: 'x' }] }));
    t.hub.view({ openMessageId: b });
    const other = data(await t.hub.callTool(clarkRemote, 'show_sources', { sources: [{ title: 'y' }] }));
    assert.notEqual(other.conversation_id, first.conversation_id, "the other account's copy gets its own chat");
    assert.equal(t.hub.get(other.conversation_id).message.id, b);
    // Back on the first copy: its own chat again.
    t.hub.view({ openMessageId: a.id });
    const again = data(await t.hub.callTool(clarkRemote, 'show_sources', { sources: [{ title: 'z' }] }));
    assert.equal(again.conversation_id, first.conversation_id);
  } finally {
    await t.done();
  }
});

test('a source card finds its email again after the email moved', async () => {
  const t = await setup();
  try {
    const c = t.hub.create({ agent: 'claude', message: null });
    const call = t.find('Call on Thursday');
    data(await t.hub.callTool(local(c.id), 'show_sources', { sources: [{ title: 'Sanne', message_id: call.id }] }));
    const source = c.items.find((i) => i.type === 'sources').sources[0];
    assert.equal(source.messageId, call.id);
    assert.equal(source.messageHeader, '<demo-13@example.com>');
    assert.equal(source.accountId, t.acc.id);
    assert.equal(await t.hub.locate({ id: source.messageId, messageHeader: source.messageHeader, accountId: source.accountId }), call.id);
    // Archived: the stored id is stale, the Message-ID finds it in Archive.
    await t.engine.archive(call.id);
    const now = await t.hub.locate({ id: source.messageId, messageHeader: source.messageHeader, accountId: source.accountId });
    assert.ok(now && now !== call.id);
    assert.equal(decodeId(now).folder, 'Archive');
    // Without the header nothing can be found.
    assert.equal(await t.hub.locate({ id: source.messageId }), null);
  } finally {
    await t.done();
  }
});

test('a source card finds its email in a folder that was never opened, after Rukoo moved it there', async () => {
  const t = await setup();
  try {
    const call = t.find('Call on Thursday');
    const ref = { id: call.id, messageHeader: '<demo-13@example.com>', accountId: t.acc.id };
    const cache = t.engine.caches.get(t.acc.id);
    assert.equal(cache.boxes.Travel, undefined, 'Travel was never opened, so Rukoo does not sync it');
    await t.engine.move(call.id, 'Travel');
    assert.equal(cache.boxes.Travel, undefined, 'the move does not sync a folder that is not in the cache');
    const now = await t.hub.locate(ref);
    assert.ok(now, 'found, not reported as gone');
    assert.equal(decodeId(now).folder, 'Travel');
    assert.equal(t.engine.locate(now).msg.subject, 'Call on Thursday');
    // Moved on from there: the newest destination counts, and an undone move counts too.
    await t.engine.move(now, 'Invoices');
    const later = await t.hub.locate(ref);
    assert.equal(decodeId(later).folder, 'Invoices');
    const back = await t.engine.undoMove(now);
    assert.equal(decodeId(back).folder, 'Travel');
    assert.deepEqual(cache.moves.filter((m) => m.id === 'demo-13@example.com'), [{ id: 'demo-13@example.com', folder: 'Travel' }]);
    assert.equal(await t.hub.locate(ref), back);
    // Another account never finds this account's move.
    assert.equal(await t.hub.locate({ ...ref, accountId: 'acc-other' }), null);
  } finally {
    await t.done();
  }
});

test('the folder a message was moved to is kept with the account cache, for the newest moves only', async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 505; i++) t.engine.noteMove(t.acc.id, `<m${i}@example.com>`, 'Travel');
    t.engine.noteMove(t.acc.id, '<M3@Example.com>', 'Invoices');
    const { moves } = t.engine.caches.get(t.acc.id);
    assert.equal(moves.length, 500);
    assert.equal(moves[0].id, 'm6@example.com', 'the oldest go first');
    assert.deepEqual(moves[moves.length - 1], { id: 'm3@example.com', folder: 'Invoices' }, 'one entry per Message-ID, the latest move');
    // Without a Message-ID there is nothing to find it by.
    t.engine.noteMove(t.acc.id, '', 'Travel');
    assert.equal(t.engine.caches.get(t.acc.id).moves.length, 500);
    // Saved to disk with the rest of the cache.
    t.engine.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'cache', `${t.acc.id}.json`), 'utf8'));
    assert.equal(saved.moves.length, 500);
  } finally {
    await t.done();
  }
});

test('read_attachment decodes text attachments in the charset they declare', async () => {
  const t = await setup();
  try {
    const iconv = require('iconv-lite');
    const call = t.find('Call on Thursday');
    const realGet = t.engine.getMessage.bind(t.engine);
    t.engine.getMessage = async (id) => ({ ...(await realGet(id)), attachments: [{ index: 0, filename: 'notes.txt', contentType: 'text/plain', size: 30 }] });
    t.engine.attachment = async () => ({ filename: 'notes.txt', content: iconv.encode('Café crème, €12', 'windows-1252'), contentType: 'text/plain', charset: 'windows-1252' });
    const res = data(await t.hub.callTool({ agent: 'clark', conversationId: null, remote: true }, 'read_attachment', { message_id: call.id, index: 0 }));
    assert.match(res.text, /Café crème, €12/);
    // No declared charset: UTF-8, without a byte order mark.
    t.engine.attachment = async () => ({ filename: 'notes.txt', content: Buffer.from('﻿Hallo wereld', 'utf8'), contentType: 'text/plain', charset: null });
    const plain = data(await t.hub.callTool({ agent: 'clark', conversationId: null, remote: true }, 'read_attachment', { message_id: call.id, index: 0 }));
    assert.match(plain.text, /\nHallo wereld\n/);
  } finally {
    await t.done();
  }
});
