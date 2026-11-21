'use strict';

// The WebSocket the WorkspaceService gets in the browser. socket.js opens a wake socket the way Node's undici takes
// it: new WebSocket(url, { protocols: ['rukoo.workspace.v1'], headers: { authorization: 'Ticket <ticket>' } }). A
// browser can't send headers on an upgrade and turns that object into a protocol string, so this adapter moves the
// ticket into the offered subprotocols as 'rukoo.ticket.<ticket>', next to the protocol's own name. The server takes
// it from there (server/src/workspaces.js, socket()) and answers with rukoo.workspace.v1 only, so the ticket isn't
// echoed back, and it never goes in the address.
const TICKET_PREFIX = 'rukoo.ticket.';
const TICKET_HEADER = /^Ticket (\S+)$/i;

// The protocols to offer for socket.js's init: a string or an array passes as it is; the undici-style object becomes
// its protocols plus the ticket. Any other header can't be sent from a browser, so it is refused rather than dropped.
function protocolsFor(init) {
  if (init === undefined || init === null) return [];
  if (typeof init === 'string' || Array.isArray(init)) return init;
  if (typeof init !== 'object') throw new TypeError('WebSocket protocols must be a string, an array or an init object');
  const out = init.protocols === undefined ? [] : [].concat(init.protocols).map(String);
  for (const [name, value] of Object.entries(init.headers || {})) {
    if (name.toLowerCase() !== 'authorization') throw new TypeError(`A browser WebSocket can't send the ${name} header`);
    const ticket = TICKET_HEADER.exec(String(value));
    if (!ticket) throw new TypeError('A browser WebSocket can send only a socket ticket, as a subprotocol entry');
    out.push(TICKET_PREFIX + ticket[1]);
  }
  return out;
}

// A constructor for the WorkspaceService over Native (the browser's WebSocket by default), or null when there is
// none: the service then keeps sockets off (index.js updateSockets) and catches up on its timers. new on it returns a
// native socket, so addEventListener, send and close are the browser's own.
function webSocketAdapter(Native = globalThis.WebSocket) {
  if (typeof Native !== 'function') return null;
  class WebSocketAdapter {
    constructor(url, init) {
      return new Native(url, protocolsFor(init));
    }
  }
  for (const name of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) WebSocketAdapter[name] = Native[name];
  return WebSocketAdapter;
}

module.exports = { webSocketAdapter, protocolsFor, TICKET_PREFIX };
