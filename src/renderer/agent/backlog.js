// Events that arrive before their consumer has loaded wait here; IPC does not replay an event for a listener that
// subscribed late. release() hands the waiting ones over in order and lets go of the source, because by then the
// consumer listens itself. drop() lets go without handing anything over. At max the oldest goes first.
export function holdEvents(subscribe, wanted, max = 500) {
  let waiting = [];
  const stop = subscribe((event) => {
    if (!waiting || !wanted(event)) return;
    if (waiting.length >= max) waiting.shift();
    waiting.push(event);
  });
  const end = () => {
    const events = waiting || [];
    waiting = null;
    stop();
    return events;
  };
  return {
    release(handler) {
      for (const event of end()) handler(event);
    },
    drop() {
      end();
    }
  };
}

// The agent events worth holding for the chat panel. Before it has loaded no chat is open, and everything about
// the open chat (text deltas, status, items, trims) is fetched when one opens. What would be lost: a reveal, an
// approval that waits for the user (the panel says so), and a request from main for the composer.
export function heldAgentEvent(event) {
  if (!event || event.type !== 'agent' || !event.payload) return false;
  const { kind, item } = event.payload;
  return kind === 'reveal' || kind === 'ui' || (kind === 'item' && Boolean(item) && item.type === 'approval' && item.status === 'pending');
}

// A request from main that it has stopped waiting for: acting on it now would change the composer after the tool
// already reported that it failed.
export function expired(request, now = Date.now()) {
  return Boolean(request && request.deadline) && now > request.deadline;
}
