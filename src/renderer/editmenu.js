// The right-click menu in the composer's text: spelling suggestions for a misspelled word, then cut, copy and paste.
// Only main knows the spelling, from the window's context-menu event, so the editor lets its own contextmenu event
// through and draws the menu once main sends what it found ('edit-menu', forwardEditMenu in main.js). The context
// menu key and Shift+F10 raise the same event at the caret. The quoted email in a reply has its own menu (mailframe.js),
// which stops the event before main sees it.
import { t } from './i18n.js';
import { api, toast, showMenu } from './ui.js';

const run = (work) => work.catch((err) => toast(err.message, 5000));

// editor: the contenteditable element. onOpen: called as the menu opens. Returns a function that removes the menu's
// listeners, for when the editor closes.
export function editMenu(editor, { onOpen } = {}) {
  // Where the last right-click in this window was, while main's answer to it is on its way; null when it wasn't in
  // the editor, so an answer for another field in the window opens nothing.
  let pending = null;
  const onContext = (e) => {
    pending = editor.contains(e.target) ? { x: e.clientX, y: e.clientY } : null;
  };
  document.addEventListener('contextmenu', onContext, true);
  const off = window.mail.on(({ type, payload }) => {
    if (type !== 'edit-menu' || !pending || !editor.isConnected) return;
    const at = pending;
    pending = null;
    open(editor, payload || {}, at);
    if (onOpen) onOpen();
  });
  return () => {
    document.removeEventListener('contextmenu', onContext, true);
    off();
  };
}

// info: { word, suggestions, canPaste, canPastePlain } from main. The items follow Chromium's own menu: the
// suggestions and Add to dictionary, then the clipboard, then Select all.
function open(editor, info, at) {
  const sel = window.getSelection();
  const range = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  const selected = Boolean(range && !range.collapsed);
  // The menu took the focus. The editor gets it back, with the selection the menu was opened on, before main acts on
  // it: a right-click on a misspelled word selects that word, which is what a suggestion replaces.
  const back = () => {
    editor.focus();
    if (!range) return;
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  };
  const act = (method, ...args) => () => {
    back();
    run(api(method, ...args));
  };
  const items = [];
  if (info.word) {
    const suggestions = Array.isArray(info.suggestions) ? info.suggestions.filter((w) => typeof w === 'string' && w) : [];
    for (const word of suggestions) items.push({ label: word, action: act('replaceMisspelling', word) });
    if (!suggestions.length) items.push({ label: t('composer.spelling.none'), disabled: true });
    items.push({ icon: 'dictionary', label: t('composer.spelling.add'), action: act('addToDictionary') }, { separator: true });
  }
  items.push(
    { icon: 'cut', label: t('composer.edit.cut'), shortcut: 'Ctrl+X', disabled: !selected, action: act('nativeEdit', 'cut') },
    { icon: 'copy', label: t('composer.edit.copy'), shortcut: 'Ctrl+C', disabled: !selected, action: act('nativeEdit', 'copy') },
    { icon: 'paste', label: t('composer.edit.paste'), shortcut: 'Ctrl+V', disabled: !info.canPaste, action: act('nativeEdit', 'paste') },
    // A rich-text editor: text from a web page or a document brings its fonts and colours along with Ctrl+V.
    {
      icon: 'pastePlain',
      label: t('composer.edit.pastePlain'),
      shortcut: 'Ctrl+Shift+V',
      disabled: !info.canPastePlain,
      action: act('nativeEdit', 'pasteAndMatchStyle')
    },
    { separator: true },
    { icon: 'selectAll', label: t('composer.edit.selectAll'), shortcut: 'Ctrl+A', action: act('nativeEdit', 'selectAll') }
  );
  showMenu(editor, items, { at });
}
