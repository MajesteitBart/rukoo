'use strict';

// A fake Rukoo Voice for the bridge tests: the WebSocket side of voice/PROTOCOL.md, written by hand (Node has a
// WebSocket client but no server, and the repo has no ws dependency). It does the upgrade, frames text, ping and
// close, keeps an event log with sequence numbers, plans the replay like Voice does and answers commands. Tests
// script it: append events, remove old ones for a gap, change the instance, keep a command unanswered, cut a
// connection halfway through a message, or leave a stale discovery file behind.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validate, replayPlan, PROTOCOL } = require('../../src/main/voice/protocol');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const b64u = (bytes) => crypto.randomBytes(bytes).toString('base64url');

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

// One client connection: reads masked frames, writes plain ones.
class Peer {
  constructor(server, socket) {
    this.server = server;
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.hello = null;
    this.closed = false;
    socket.on('data', (chunk) => this.read(chunk));
    socket.on('close', () => {
      this.closed = true;
      server.peers.delete(this);
    });
    socket.on('error', () => {});
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      let len = b1 & 0x7f;
      let at = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        at = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const need = at + (masked ? 4 : 0) + len;
      if (this.buffer.length < need) return;
      const mask = masked ? this.buffer.subarray(at, at + 4) : null;
      const payload = Buffer.from(this.buffer.subarray(at + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(need);
      this.onFrame(b0 & 0x80, b0 & 0x0f, payload);
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      if (!this.closed) this.socket.end(frame(0x8, payload.subarray(0, 2)));
      this.closed = true;
      return;
    }
    if (opcode === 0x9) return this.socket.write(frame(0xa, payload));
    if (opcode === 0xa) return;
    this.fragments.push(payload);
    if (!fin) return;
    const text = Buffer.concat(this.fragments).toString('utf8');
    this.fragments = [];
    this.server.onText(this, text);
  }

  send(message) {
    if (this.closed) return;
    this.socket.write(frame(0x1, Buffer.from(JSON.stringify(message), 'utf8')));
  }

  close(code, reason = '') {
    if (this.closed) return;
    this.closed = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.socket.end(frame(0x8, body));
  }

  // The connection dies halfway through a message: half a frame, then nothing.
  cut(message) {
    const whole = frame(0x1, Buffer.from(JSON.stringify(message), 'utf8'));
    this.closed = true;
    this.socket.write(whole.subarray(0, Math.max(3, Math.floor(whole.length / 2))), () => this.socket.destroy());
  }
}

class FakeVoice {
  // file: where the discovery file goes. instance and token: fixed values, or fresh ones.
  constructor({ file, instance = b64u(16), token = b64u(32), protocol = PROTOCOL, minProtocol = 1, helloTimeoutMs = 5000 } = {}) {
    this.file = file;
    this.instance = instance;
    this.token = token;
    this.protocol = protocol;
    this.minProtocol = minProtocol;
    this.helloTimeoutMs = helloTimeoutMs;
    this.events = [];
    this.head = 0;
    this.status = { recording: null, dictating: false };
    this.peers = new Set();
    this.hellos = [];
    this.commands = [];
    this.upgrades = [];
    // Commands left unanswered, for timeouts. handlers: replies a test sets per command.
    this.silent = new Set();
    this.handlers = {};
    this.server = null;
    this.port = null;
    this.nextMeeting = 0;
  }

  async listen(port = 0) {
    this.server = http.createServer((req, res) => res.writeHead(404).end());
    this.server.on('upgrade', (req, socket) => this.upgrade(req, socket));
    await new Promise((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this;
  }

  upgrade(req, socket) {
    this.upgrades.push({ url: req.url, headers: req.headers });
    const origin = req.headers.origin;
    if (origin && /^https?:/i.test(origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (req.url !== '/bridge' || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const peer = new Peer(this, socket);
    if (this.peers.size >= 4) {
      peer.send({ type: 'error', code: 'too_many_clients', message: 'Four clients are already connected.' });
      peer.close(4004);
      return;
    }
    this.peers.add(peer);
    peer.timer = setTimeout(() => {
      if (peer.hello) return;
      peer.send({ type: 'error', code: 'hello_timeout', message: 'No hello.' });
      peer.close(4003);
    }, this.helloTimeoutMs);
  }

  onText(peer, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (!peer.hello) {
      clearTimeout(peer.timer);
      const res = validate('rukoo', message);
      if (!res.ok || message.type !== 'hello') {
        peer.send({ type: 'error', code: 'hello_timeout', message: 'hello comes first.' });
        return peer.close(4003);
      }
      this.hellos.push(message);
      if (message.token !== this.token) {
        peer.send({ type: 'error', code: 'bad_token', message: "The token doesn't match." });
        return peer.close(4001);
      }
      if (message.protocol < this.minProtocol || message.protocol > this.protocol) {
        peer.send({ type: 'error', code: 'unsupported_protocol', message: 'No.' });
        return peer.close(4002);
      }
      peer.hello = message;
      const oldest = this.oldest();
      const plan = replayPlan(message.instance, message.after, this.instance, this.head, oldest);
      peer.send({ type: 'welcome', protocol: message.protocol, voiceVersion: '0.1.0', instance: this.instance, head: this.head, oldest, replay: plan.replay, status: this.status });
      for (const e of this.events) if (e.seq >= plan.from) peer.send(e);
      return;
    }
    if (message.type !== 'command') return;
    const res = validate('rukoo', message);
    if (!res.ok) {
      if (typeof message.id === 'string') peer.send({ type: 'reply', id: message.id, ok: false, error: { code: 'bad_request', message: res.reason } });
      return;
    }
    this.commands.push(res.message);
    if (this.silent.has(res.message.command)) return;
    const handler = this.handlers[res.message.command] || DEFAULTS[res.message.command];
    let out;
    try {
      out = handler ? handler.call(this, res.message.args, peer) : { error: { code: 'unknown_command', message: res.message.command } };
    } catch (err) {
      out = { error: { code: err.code || 'failed', message: err.message, ...(err.meeting ? { meeting: err.meeting } : {}) } };
    }
    if (out && out.error) peer.send({ type: 'reply', id: res.message.id, ok: false, error: out.error });
    else peer.send({ type: 'reply', id: res.message.id, ok: true, result: out || {} });
  }

  oldest() {
    return this.events.length ? this.events[0].seq : this.head + 1;
  }

  // Stores an event and pushes it to every client that said hello.
  append(event, meeting, data, { push = true } = {}) {
    const e = { type: 'event', seq: ++this.head, event, ...(meeting ? { meeting } : {}), createdAt: Date.now(), data };
    this.events.push(e);
    if (event === 'status') this.status = data;
    if (push) for (const p of this.peers) if (p.hello) p.send(e);
    return e;
  }

  // Drops stored events up to seq, as Voice does when it deletes a meeting: the next hello behind them is a gap.
  forget(upTo) {
    this.events = this.events.filter((e) => e.seq > upTo);
  }

  // A new data folder: a new instance and sequence numbers from 1.
  reset() {
    this.instance = b64u(16);
    this.events = [];
    this.head = 0;
  }

  meetingId() {
    const d = new Date(Date.UTC(2026, 9, 30, 9, 0, this.nextMeeting++));
    const stamp = d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    return `m-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
  }

  // A snapshot of a meeting from the stored events, as meeting.get answers.
  snapshot(id) {
    const own = this.events.filter((e) => e.meeting === id);
    const started = own.find((e) => e.event === 'meeting.started');
    if (!started) return null;
    let state = { state: 'recording', at: 0 };
    const speakers = new Map();
    const passages = new Map();
    const marks = new Map();
    for (const e of own) {
      if (e.event === 'meeting.state') state = e.data;
      if (e.event === 'speaker') speakers.set(e.data.id, e.data);
      if (e.event === 'passage') passages.set(e.data.id, e.data);
      if (e.event === 'passage.removed') passages.delete(e.data.id);
      if (e.event === 'mark') marks.set(e.data.id, e.data);
    }
    return {
      meeting: { ...started.data, id, state: state.state, endedAt: state.endedAt || null },
      speakers: [...speakers.values()],
      passages: [...passages.values()],
      marks: [...marks.values()],
      head: this.head
    };
  }

  discovery(overrides = {}) {
    return { protocol: this.protocol, minProtocol: this.minProtocol, port: this.port, token: this.token, pid: process.pid, instance: this.instance, voiceVersion: '0.1.0', startedAt: Date.now(), ...overrides };
  }

  // Written to a temporary name and renamed into place, as Voice does.
  writeDiscovery(overrides = {}) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.discovery(overrides)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  removeDiscovery() {
    fs.rmSync(this.file, { force: true });
  }

  // Every connection dies; with message set, halfway through sending it.
  drop(message = null) {
    for (const p of [...this.peers]) {
      if (message) p.cut(message);
      else p.socket.destroy();
    }
    this.peers.clear();
  }

  // Voice quits: close code 1001 and the server stops.
  async close() {
    for (const p of [...this.peers]) p.close(1001);
    this.peers.clear();
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }
}

const DEFAULTS = {
  'status.get'() {
    return this.status;
  },
  'meeting.get'(args) {
    const snap = this.snapshot(args.meeting);
    if (!snap) return { error: { code: 'not_found', message: 'No such meeting.' } };
    return snap;
  },
  'meeting.list'(args) {
    const ids = [...new Set(this.events.filter((e) => e.event === 'meeting.started').map((e) => e.meeting))].reverse();
    return { meetings: ids.slice(0, args.limit || 50).map((id) => this.snapshot(id).meeting) };
  },
  'meeting.start'(args) {
    if (this.status.recording) return { error: { code: 'busy', message: 'A meeting is already recording.', meeting: this.status.recording } };
    const id = this.meetingId();
    const startedAt = Date.now();
    this.append('meeting.started', id, { title: args.title || '', startedAt, tracks: args.tracks || ['mic', 'call'], screen: args.screen || 'off', startedBy: 'rukoo', context: args.context || null });
    this.append('meeting.state', id, { state: 'recording', at: 0 });
    this.append('status', null, { recording: id, dictating: false });
    return { meeting: id };
  },
  'meeting.stop'(args) {
    if (this.status.recording !== args.meeting) return { error: { code: 'not_recording', message: 'Not recording.' } };
    this.append('meeting.state', args.meeting, { state: 'processing', at: 1000, endedAt: Date.now(), reason: 'rukoo' });
    this.append('status', null, { recording: null, dictating: false });
    return {};
  },
  'meeting.mark'(args) {
    if (this.status.recording !== args.meeting) return { error: { code: 'not_recording', message: 'Not recording.' } };
    const n = this.events.filter((e) => e.event === 'mark').length + 1;
    this.append('mark', args.meeting, { id: `k-${n}`, kind: 'user', at: 1000, until: null, track: null, detail: null, label: args.label || null });
    return { mark: `k-${n}`, at: 1000 };
  },
  'frame.get'() {
    return { error: { code: 'not_available', message: 'Voice 0.1 does not record the screen.' } };
  }
};

async function startVoiceServer(options) {
  return new FakeVoice(options).listen();
}

module.exports = { FakeVoice, startVoiceServer };
