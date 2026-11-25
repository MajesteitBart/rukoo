'use strict';

// Key presses that differ between platforms, for Playwright's keyboard.press(). For a shortcut whose modifier is
// Command on a Mac and Control elsewhere, use Playwright's own ControlOrMeta instead, as in ControlOrMeta+a. Control
// alone is right for Rukoo's own shortcuts, which take Control on a Mac too (keymap.js), but not for what Chromium
// does in a text field: on a Mac, Control+A, Control+B and Control+V move the caret or scroll instead of selecting
// everything, making text bold or pasting.

// The end of the line and of an editor's text. On a Mac, End only scrolls and leaves the caret and a selection where
// they are, and Chromium binds Control+End only outside macOS (third_party/blink/renderer/core/editing/
// editing_behavior.cc). Command+Right and Command+Down are macOS's own keys for the end of the line and of the text.
const END_OF_LINE = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';
const END_OF_TEXT = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

module.exports = { END_OF_LINE, END_OF_TEXT };
