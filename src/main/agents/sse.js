'use strict';

// Server-sent events, as Hermes writes them: `id:`/`event:`/`data:` lines, a blank line ends a frame,
// lines starting with ':' are comments (keepalives). Chunks can split anywhere, also inside a UTF-8
// character or between \r and \n, so the parser buffers until it has whole lines.

class SseParser {
  // onEvent({ event, data, id }) for every complete frame; `data` is the joined data lines as text.
  constructor(onEvent, { onComment } = {}) {
    this.onEvent = onEvent;
    this.onComment = onComment || null;
    this.buffer = '';
    this.event = '';
    this.data = [];
    this.id = null;
    this.lastEventId = null;
    this.decoder = new TextDecoder('utf-8');
  }

  // Accepts text or bytes.
  push(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      // A trailing \r may be the first half of \r\n: wait for the next chunk before deciding.
      if (ch === '\r' && i === this.buffer.length - 1) break;
      this.line(this.buffer.slice(start, i));
      if (ch === '\r' && this.buffer[i + 1] === '\n') i++;
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
  }

  // The stream ended: a frame without its closing blank line is incomplete and dropped, as browsers do.
  end() {
    this.buffer += this.decoder.decode();
    this.buffer = '';
    this.reset();
  }

  reset() {
    this.event = '';
    this.data = [];
    this.id = null;
  }

  line(text) {
    if (text === '') return this.dispatch();
    if (text[0] === ':') {
      if (this.onComment) this.onComment(text.slice(1).trim());
      return;
    }
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id' && !value.includes('\0')) this.id = value;
  }

  dispatch() {
    if (this.id !== null) this.lastEventId = this.id;
    if (this.data.length) this.onEvent({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
    this.reset();
  }
}

// Reads a fetch() response body through a parser until the server closes it. Resolves 'end', or
// 'idle' when nothing (not even a keepalive comment) arrived for idleMs, or 'aborted' when the
// signal fired. Network errors reject.
async function readSse(body, parser, { idleMs = 0, signal } = {}) {
  const reader = body.getReader();
  let timer = null;
  let outcome = null;
  const stop = (why) => {
    if (outcome) return;
    outcome = why;
    reader.cancel().catch(() => {});
  };
  const arm = () => {
    if (!idleMs) return;
    clearTimeout(timer);
    timer = setTimeout(() => stop('idle'), idleMs);
  };
  const onAbort = () => stop('aborted');
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  arm();
  try {
    while (!outcome) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      parser.push(value);
    }
    parser.end();
    return outcome || 'end';
  } catch (err) {
    if (outcome) return outcome;
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { SseParser, readSse };
