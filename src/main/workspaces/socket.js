'use strict';

// The wake socket of one workspace (team chat contract 3.11). It carries no messages: a {"t":"wake"} frame says the
// feed has something new, and the service runs a sync. The ticket comes from POST /socket-ticket and goes in the
// Authorization header ("Ticket <ticket>"), never in the address, with the subprotocol rukoo.workspace.v1 offered.
// Node's global WebSocket takes headers in its init, so the main process needs no WebSocket package.
//
// Every close schedules another attempt unless the socket is parked: stopped by the service (not wanted, signed out,
// removed, quarantined) or by an answer that says trying again won't help. WebSocket, timers, now and random are
// injected, so tests can drive it with a fake socket and a fake clock.

const PROTOCOL = 'rukoo.workspace.v1';
// Frames over this, and binary ones, are ignored.
const MAX_FRAME = 1024;

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
};

class WakeSocket {
  // url: the socket's address (ws: or wss:). ticket(): a promise of a fresh ticket, which throws the call's ChatError.
  // onOpen, onWake, onLease (close 4001), onRemoved (close 4003), onChange (state): the service's reactions.
  constructor({
    url,
    ticket,
    WebSocket,
    timing,
    random = Math.random,
    now = Date.now,
    timers = defaultTimers,
    onOpen = () => {},
    onWake = () => {},
    onLease = () => {},
    onRemoved = () => {},
    onChange = () => {}
  }) {
    this.url = url;
    this.ticket = ticket;
    this.WebSocket = WebSocket;
    this.timing = timing;
    this.random = random;
    this.now = now;
    this.timers = timers;
    // The service's reactions run inside socket and timer callbacks, where a throw would be uncaught.
    const safe = (fn) => (...args) => {
      try {
        fn(...args);
      } catch (_) {
        // The service records its own failures; the socket goes on.
      }
    };
    this.on = { open: safe(onOpen), wake: safe(onWake), lease: safe(onLease), removed: safe(onRemoved), change: safe(onChange) };
    // 'off' (parked or not started), 'connecting', 'open', 'down' (waiting to try again).
    this.state = 'off';
    this.wanted = false;
    // Failed attempts in a row, for the backoff; an open socket resets it.
    this.attempt = 0;
    // Each connect gets a number; what an older socket or ticket answers is ignored.
    this.token = 0;
    this.socket = null;
    this.retry = null;
    this.retryAt = null;
    this.pingTimer = null;
    this.pongTimer = null;
    // The last reconnect at once after a 4001, so a server that keeps sending 4001 meets the backoff.
    this.quickAt = -Infinity;
    // The delay of the last scheduled attempt, for tests and debugState.
    this.lastDelay = null;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.on.change(state);
  }

  // The service wants this socket open.
  start() {
    if (this.wanted && this.state !== 'off') return;
    this.wanted = true;
    this.connect();
  }

  // Parked: closed with code, and no further attempts until start().
  stop(code = 1000) {
    this.wanted = false;
    this.token += 1;
    this.clearTimers();
    this.closeSocket(code);
    this.setState('off');
  }

  // Focus or resume: a socket that waits to try again tries now, from the first step of the backoff, and an open one
  // sends a ping at once, which finds a connection that died while the computer slept.
  nudge() {
    if (!this.wanted) return;
    if (this.state === 'down') {
      this.attempt = 0;
      this.connect();
    } else if (this.state === 'open') {
      this.ping();
    }
  }

  clearTimers() {
    if (this.retry) this.timers.clearTimeout(this.retry);
    if (this.pingTimer) this.timers.clearTimeout(this.pingTimer);
    if (this.pongTimer) this.timers.clearTimeout(this.pongTimer);
    this.retry = this.pingTimer = this.pongTimer = null;
    this.retryAt = null;
  }

  closeSocket(code) {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close(code);
    } catch (_) {
      // Closed already.
    }
  }

  // Tries again after delay ms.
  later(delay) {
    this.clearTimers();
    this.lastDelay = delay;
    this.retryAt = this.now() + delay;
    this.setState('down');
    this.retry = this.timers.setTimeout(() => {
      this.retry = null;
      this.retryAt = null;
      if (this.wanted) this.connect();
    }, delay);
  }

  // The next attempt after a failure: 1, 2, 4, 8, 16, 32, then 60 s, each times a random factor from 0.5 to 1.0, so
  // a server that comes back doesn't get every device in the same second.
  backoff() {
    const table = this.timing.socketBackoff;
    const base = table[Math.min(this.attempt, table.length - 1)];
    this.attempt += 1;
    this.later(Math.round(base * (0.5 + 0.5 * this.random())));
  }

  async connect() {
    if (!this.wanted) return;
    const token = ++this.token;
    this.clearTimers();
    this.closeSocket(1000);
    this.setState('connecting');
    let ticket;
    try {
      ticket = await this.ticket();
    } catch (err) {
      if (token !== this.token || !this.wanted) return;
      const code = err && err.code;
      // The session ended or this service's epoch moved on, the workspace is gone (the call ran the removal path),
      // or the server needs a newer Rukoo: trying again won't help.
      if ((err && err.stale) || ['signed_out', 'not_found', 'forbidden', 'upgrade_required'].includes(code)) {
        this.stop();
        return;
      }
      if (code === 'rate_limited') {
        this.later((Number.isSafeInteger(err.retryAfter) ? err.retryAfter : 60) * 1000);
        return;
      }
      this.backoff();
      return;
    }
    if (token !== this.token || !this.wanted) return;
    let socket;
    try {
      socket = new this.WebSocket(this.url, { protocols: [PROTOCOL], headers: { authorization: `Ticket ${ticket}` } });
    } catch (_) {
      this.backoff();
      return;
    }
    this.socket = socket;
    const mine = () => token === this.token && this.socket === socket;
    socket.addEventListener('open', () => {
      if (!mine()) return;
      this.attempt = 0;
      this.setState('open');
      this.schedulePing();
      this.on.open();
    });
    socket.addEventListener('message', (event) => {
      if (!mine()) return;
      // Any frame says the connection lives.
      if (this.pongTimer) {
        this.timers.clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      const data = event && event.data;
      if (typeof data !== 'string' || data.length > MAX_FRAME || data === 'pong') return;
      let frame;
      try {
        frame = JSON.parse(data);
      } catch (_) {
        return;
      }
      if (frame && typeof frame === 'object' && frame.t === 'wake') this.on.wake();
    });
    // An error is followed by a close, which decides what happens next.
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', (event) => {
      if (!mine()) return;
      this.socket = null;
      this.clearTimers();
      if (!this.wanted) {
        this.setState('off');
        return;
      }
      const code = event && event.code;
      if (code === 4001) {
        // The lease ran out, and the server sent this close instead of a wake: something may be new.
        this.on.lease();
        const now = this.now();
        if (now - this.quickAt >= this.timing.reconnectGap) {
          this.quickAt = now;
          this.connect();
        } else {
          this.backoff();
        }
        return;
      }
      if (code === 4003) {
        // Removed from the workspace, or it was deleted. The service asks GET /, whose 404 runs the removal path.
        this.wanted = false;
        this.setState('off');
        this.on.removed();
        return;
      }
      this.backoff();
    });
  }

  schedulePing() {
    if (this.pingTimer) this.timers.clearTimeout(this.pingTimer);
    this.pingTimer = this.timers.setTimeout(() => {
      this.pingTimer = null;
      this.ping();
    }, this.timing.pingEvery);
  }

  // A ping that no frame answers within the pong timeout closes the socket and connects again.
  ping() {
    if (this.state !== 'open' || !this.socket) return;
    try {
      this.socket.send('ping');
    } catch (_) {
      // The close that follows decides.
    }
    if (!this.pongTimer) {
      this.pongTimer = this.timers.setTimeout(() => {
        this.pongTimer = null;
        this.dead();
      }, this.timing.pongTimeout);
    }
    this.schedulePing();
  }

  dead() {
    if (this.state !== 'open') return;
    this.token += 1;
    this.closeSocket(1000);
    this.backoff();
  }
}

module.exports = { WakeSocket, PROTOCOL, MAX_FRAME };
