'use strict';

// Node's EventEmitter, as far as the bundled code uses it: WorkspaceService extends it (src/main/workspaces/index.js)
// and the web bridge listens to it. Listeners run synchronously in the order they were added, a listener added during
// an emit doesn't run in that emit, and an 'error' with no listener throws, as in Node.
class EventEmitter {
  constructor() {
    this._events = new Map();
  }

  _list(name) {
    if (!this._events) this._events = new Map();
    return this._events.get(name) || [];
  }

  on(name, listener) {
    if (typeof listener !== 'function') throw new TypeError('The "listener" argument must be of type function');
    this._events = this._events || new Map();
    this._events.set(name, [...this._list(name), listener]);
    return this;
  }

  addListener(name, listener) {
    return this.on(name, listener);
  }

  once(name, listener) {
    if (typeof listener !== 'function') throw new TypeError('The "listener" argument must be of type function');
    const wrapped = (...args) => {
      this.removeListener(name, wrapped);
      return listener.apply(this, args);
    };
    // removeListener(name, listener) finds it through this, as Node's once() allows.
    wrapped.listener = listener;
    return this.on(name, wrapped);
  }

  // The most recently added match goes, as in Node.
  removeListener(name, listener) {
    const list = this._list(name);
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === listener || list[i].listener === listener) {
        const next = [...list.slice(0, i), ...list.slice(i + 1)];
        if (next.length) this._events.set(name, next);
        else this._events.delete(name);
        break;
      }
    }
    return this;
  }

  off(name, listener) {
    return this.removeListener(name, listener);
  }

  removeAllListeners(name) {
    if (!this._events) return this;
    if (name === undefined) this._events.clear();
    else this._events.delete(name);
    return this;
  }

  emit(name, ...args) {
    const list = this._list(name);
    if (!list.length) {
      if (name === 'error') throw args[0] instanceof Error ? args[0] : new Error(`Unhandled error. (${String(args[0])})`);
      return false;
    }
    for (const listener of list) listener.apply(this, args);
    return true;
  }

  listenerCount(name) {
    return this._list(name).length;
  }

  listeners(name) {
    return this._list(name).map((l) => l.listener || l);
  }

  eventNames() {
    return this._events ? [...this._events.keys()] : [];
  }

  // Node warns past ten listeners; nothing here does, so there is nothing to raise.
  setMaxListeners() {
    return this;
  }
}

module.exports = EventEmitter;
module.exports.EventEmitter = EventEmitter;
module.exports.default = EventEmitter;
