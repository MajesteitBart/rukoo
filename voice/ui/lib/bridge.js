// The pages talk to the Rust app through Tauri's global API (withGlobalTauri). Outside Tauri, or with ?mock in the
// URL, a mock from mock/ answers instead, so every state renders in a browser for design work and screenshots.
// voice/ui/API.md lists every command and event.

export const params = new URLSearchParams(location.search);
export const mocked = params.has('mock') || !window.__TAURI__;

let impl = null;

export async function connect(page) {
  if (!mocked) {
    const { core, event } = window.__TAURI__;
    impl = {
      invoke: (command, args) => core.invoke(command, args),
      listen: (name, handler) => event.listen(name, (e) => handler(e.payload))
    };
    return;
  }
  document.documentElement.classList.add('mock');
  const module = page === 'pill' ? await import('../mock/pill.js') : await import('../mock/settings.js');
  impl = module.createMock(params);
}

export function invoke(command, args = {}) {
  return impl.invoke(command, args);
}

export function listen(name, handler) {
  return impl.listen(name, handler);
}
