import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, escHtml } from './build-changelog.mjs';

// Marked renders an apostrophe in alt text as &#39;. The builder captures
// that already-escaped value from the HTML, so it must decode before it
// escapes for its own markup, or screen readers hear "What&#39;s".
test('alt text from rendered HTML is escaped exactly once', () => {
  assert.equal(escHtml(decodeEntities('What&#39;s new guide')), 'What&#39;s new guide');
  assert.equal(
    escHtml(decodeEntities('Chat shortcuts on the phone&#39;s small screen')),
    'Chat shortcuts on the phone&#39;s small screen',
  );
  assert.equal(escHtml(decodeEntities('Fish &amp; chips &lt;3')), 'Fish &amp; chips &lt;3');
  assert.equal(escHtml('Plain "quotes" & angle <brackets>'), 'Plain &quot;quotes&quot; &amp; angle &lt;brackets&gt;');
});
