'use strict';

// Team chat Markdown (src/renderer/chat-markdown.js): every block and inline rule of the grammar, mentions in and
// around formatting, unmatched delimiters, link addresses, escapes, time in proportion to the length, and plainText.
// The DOM the chat builds from these nodes is in the Electron specs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vectors = require('./fixtures/chat-vectors.json');

// A browser module in a CommonJS package: Node takes it as ESM from a data: URL, with each renderer module it
// imports turned into a data: URL of its own.
function moduleUrl(file) {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8')
    .replace(/from '\.\/([\w-]+\.js)'/g, (_, dep) => `from '${moduleUrl(dep)}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
const loading = import(moduleUrl('chat-markdown.js'));
const loadingText = import(moduleUrl('chat-text.js'));

const ann = 'u_TSZouSPGbcL97eX33zpRL2';
const bob = 'u_1Sw3x5RkUNDzTu7h42PrUD';

const text = (t) => ({ type: 'text', text: t });
const code = (t) => ({ type: 'code', text: t });
const strong = (...children) => ({ type: 'strong', children });
const em = (...children) => ({ type: 'em', children });
const strike = (...children) => ({ type: 'strike', children });
const link = (href, ...children) => ({ type: 'link', href, children: children.length ? children : [text(href)] });
const chip = (label, actor = ann, me = false) => ({ type: 'mention', actor, text: label, me });
const paragraph = (...lines) => ({ type: 'paragraph', lines });
const item = (depth, content, ordered = false, number = null) => ({ depth, content, ordered, number });

// The byte range of the nth label in s as a mention of actor, as the wire has it.
function mention(s, label, actor = ann, nth = 0) {
  let at = -1;
  for (let n = 0; n <= nth; n++) at = s.indexOf(label, at + 1);
  assert.ok(at >= 0, `${label} is in ${s}`);
  const start = Buffer.byteLength(s.slice(0, at));
  return { actor, start, end: start + Buffer.byteLength(label) };
}

// The inline nodes of a text that is one line of one paragraph.
async function line(s, mentions = [], opts) {
  const { parse } = await loading;
  const blocks = parse(s, mentions, opts);
  assert.equal(blocks.length, 1, `${JSON.stringify(s)} is one block: ${JSON.stringify(blocks)}`);
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[0].lines.length, 1);
  return blocks[0].lines[0];
}

// ---- Blocks ----

test('paragraphs: one newline is a line break, empty lines separate paragraphs', async () => {
  const { parse } = await loading;
  assert.deepEqual(parse('one\ntwo\n\nthree', []), [paragraph([text('one')], [text('two')]), paragraph([text('three')])]);
  assert.deepEqual(parse('\n\none\n \t\n\n\ntwo\n\n', []), [paragraph([text('one')]), paragraph([text('two')])]);
  assert.deepEqual(parse('  indented stays', []), [paragraph([text('  indented stays')])]);
  assert.deepEqual(parse('', []), []);
  assert.deepEqual(parse(null, []), []);
  assert.deepEqual(parse(undefined), []);
});

test('CRLF and a lone CR break lines as LF does, and mentions after them keep their place', async () => {
  const { parse } = await loading;
  const s = 'a\r\nb\rc @Ann';
  assert.deepEqual(parse(s, [mention(s, '@Ann')]), [paragraph([text('a')], [text('b')], [text('c '), chip('@Ann')])]);
});

test('headings of one to three hashes and a space; other hashes are text', async () => {
  const { parse } = await loading;
  assert.deepEqual(parse('# One\n## Two **b**\n### Three', []), [
    { type: 'heading', level: 1, content: [text('One')] },
    { type: 'heading', level: 2, content: [text('Two '), strong(text('b'))] },
    { type: 'heading', level: 3, content: [text('Three')] },
  ]);
  assert.deepEqual(parse('#### Four\n#hashtag\n # indented\n# ', []), [
    paragraph([text('#### Four')], [text('#hashtag')], [text(' # indented')], [text('# ')]),
  ]);
  assert.deepEqual(parse('#   Spaced   ', []), [{ type: 'heading', level: 1, content: [text('Spaced')] }]);
  // A heading is a block of its own: the lines around it are paragraphs.
  assert.deepEqual(parse('before\n# Title\nafter', []).map((b) => b.type), ['paragraph', 'heading', 'paragraph']);
});

test('quotes: consecutive > lines, an optional space, inline text only', async () => {
  const { parse } = await loading;
  assert.deepEqual(parse('> one **b**\n>two\n>  three\n>\nafter', []), [
    { type: 'quote', lines: [[text('one '), strong(text('b'))], [text('two')], [text(' three')], []] },
    paragraph([text('after')]),
  ]);
  // No other blocks inside a quote.
  assert.deepEqual(parse('> - item\n> # title\n> ```', []), [
    { type: 'quote', lines: [[text('- item')], [text('# title')], [text('```')]] },
  ]);
  // An empty line ends a quote.
  assert.deepEqual(parse('> a\n\n> b', []).map((b) => b.type), ['quote', 'quote']);
});

test('bulleted lists: - * and +, one item per line, nested by two spaces up to three levels', async () => {
  const { parse } = await loading;
  assert.deepEqual(parse('- a\n* b\n+ c', []), [
    { type: 'list', ordered: false, start: 1, items: [item(0, [text('a')]), item(0, [text('b')]), item(0, [text('c')])] },
  ]);
  const nested = parse('- a\n  - b\n    - c\n      - d\n  - e\n- f\n   - g\n\t- h', []);
  assert.deepEqual(
    nested[0].items.map((i) => [i.depth, i.content[0].text]),
    [[0, 'a'], [1, 'b'], [2, 'c'], [2, 'd'], [1, 'e'], [0, 'f'], [1, 'g'], [1, 'h']],
  );
  // More indentation than one level deeper is still one level deeper; one space isn't a level.
  assert.deepEqual(parse('- a\n        - b\n - c', [])[0].items.map((i) => i.depth), [0, 1, 0]);
  // An indented first item starts the list's first level.
  assert.deepEqual(parse('  - a\n  - b\n    - c', [])[0].items.map((i) => i.depth), [0, 0, 1]);
  assert.deepEqual(parse('- **bold** item', [])[0].items[0].content, [strong(text('bold')), text(' item')]);
});

test('numbered lists start at their first number, with . or ), and nested items keep their own kind', async () => {
  const { parse } = await loading;
  assert.deepEqual(parse('3. three\n4) four\n9. nine', []), [
    { type: 'list', ordered: true, start: 3, items: [item(0, [text('three')], true, 3), item(0, [text('four')], true, 4), item(0, [text('nine')], true, 9)] },
  ]);
  assert.deepEqual(parse('1. step\n   - detail\n2. next', []), [
    {
      type: 'list',
      ordered: true,
      start: 1,
      items: [item(0, [text('step')], true, 1), item(1, [text('detail')]), item(0, [text('next')], true, 2)],
    },
  ]);
  // A first-level item of the other kind starts another list; an empty line ends one.
  assert.deepEqual(parse('- a\n1. b\n\n- c', []).map((b) => [b.type, b.ordered, b.items.length]), [
    ['list', false, 1],
    ['list', true, 1],
    ['list', false, 1],
  ]);
  assert.equal(parse('0. zero', [])[0].start, 0);
});

test('lines that only look like list items are text', async () => {
  const { parse } = await loading;
  for (const s of ['-not a list', '-', '1.5 kg', '1.', '*italic*', '**bold**', '+1 from me', '1234567890. too long']) {
    assert.equal(parse(s, [])[0].type, 'paragraph', s);
  }
  // A line after a list that isn't an item is a paragraph.
  assert.deepEqual(parse('- a\nmore', []).map((b) => b.type), ['list', 'paragraph']);
  // A marker and a space with nothing after them is an empty item.
  assert.deepEqual(parse('- a\n-  \n- c', [])[0].items.map((i) => i.content), [[text('a')], [], [text('c')]]);
  assert.deepEqual(parse('* * *', []), [{ type: 'list', ordered: false, start: 1, items: [item(0, [text('* *')])] }]);
});

test('fenced code blocks: a language word, literal contents, and the end of the text closes one', async () => {
  const { parse } = await loading;
  assert.deepEqual(parse('```js\nconst a = `x`;\n**not bold** [x](https://a.example) \\*\n\n  indented\n```\nafter', []), [
    { type: 'code', lang: 'js', text: 'const a = `x`;\n**not bold** [x](https://a.example) \\*\n\n  indented' },
    paragraph([text('after')]),
  ]);
  assert.deepEqual(parse('before\n```\nno end\n# not a heading', []), [
    paragraph([text('before')]),
    { type: 'code', lang: null, text: 'no end\n# not a heading' },
  ]);
  assert.deepEqual(parse('```c++  \n```   ', []), [{ type: 'code', lang: 'c++', text: '' }]);
  assert.deepEqual(parse('```', []), [{ type: 'code', lang: null, text: '' }]);
  // Not fences: a second word, four backticks, indentation. Three backticks around text on one line are inline code.
  for (const s of ['```js extra', '````', ' ```']) assert.equal(parse(s, [])[0].type, 'paragraph', s);
  assert.deepEqual(await line('```const a = 1```'), [code('const a = 1')]);
  // A closing fence needs a line of its own.
  assert.deepEqual(parse('```\na ```\n```', []), [{ type: 'code', lang: null, text: 'a ```' }]);
});

test('a mention in a code block is its text', async () => {
  const { parse } = await loading;
  const s = '```\nask @Ann\n```\n@Ann';
  assert.deepEqual(parse(s, [mention(s, '@Ann'), mention(s, '@Ann', ann, 1)]), [
    { type: 'code', lang: null, text: 'ask @Ann' },
    paragraph([chip('@Ann')]),
  ]);
});

// ---- Inline ----

test('code spans are literal, match a run of as many backticks, and lose one space at both ends', async () => {
  assert.deepEqual(await line('a `*b* [c](https://x.example) \\*` d'), [text('a '), code('*b* [c](https://x.example) \\*'), text(' d')]);
  assert.deepEqual(await line('``a ` b``'), [code('a ` b')]);
  assert.deepEqual(await line('`` `tick` ``'), [code('`tick`')]);
  assert.deepEqual(await line('`  `'), [code('  ')]);
  assert.deepEqual(await line('` a `'), [code('a')]);
  // Unmatched runs are text, and a run of another length doesn't close.
  assert.deepEqual(await line('`a'), [text('`a')]);
  assert.deepEqual(await line('``a`'), [text('``a`')]);
  assert.deepEqual(await line('`a`` b`'), [code('a`` b')]);
  // A backslash in code is code; an escaped backtick outside opens nothing.
  assert.deepEqual(await line('`a\\`'), [code('a\\')]);
  assert.deepEqual(await line('\\`a`'), [text('`a`')]);
  // Code holds no address.
  assert.deepEqual(await line('`https://a.example`'), [code('https://a.example')]);
});

test('bold, italic and strikethrough with * _ and ~', async () => {
  assert.deepEqual(await line('**b** __b__ *i* _i_ ~~s~~'), [
    strong(text('b')),
    text(' '),
    strong(text('b')),
    text(' '),
    em(text('i')),
    text(' '),
    em(text('i')),
    text(' '),
    strike(text('s')),
  ]);
  assert.deepEqual(await line('**bold _and italic_ and ~~gone~~**'), [
    strong(text('bold '), em(text('and italic')), text(' and '), strike(text('gone'))),
  ]);
  assert.deepEqual(await line('***both***'), [em(strong(text('both')))]);
  assert.deepEqual(await line('**a *b* c**'), [strong(text('a '), em(text('b')), text(' c'))]);
  assert.deepEqual(await line('*a **b** c*'), [em(text('a '), strong(text('b')), text(' c'))]);
  // A star works inside a word; ~ only in pairs.
  assert.deepEqual(await line('un*frigging*believable'), [text('un'), em(text('frigging')), text('believable')]);
  assert.deepEqual(await line('~a~ ~~~b~~~'), [text('~a~ ~~~b~~~')]);
});

test('an opening delimiter is not followed by white space and a closing one not preceded by it', async () => {
  assert.deepEqual(await line('a * b * c'), [text('a * b * c')]);
  assert.deepEqual(await line('** a** and **a **'), [text('** a** and **a **')]);
  assert.deepEqual(await line('_ a_ ~~ a~~'), [text('_ a_ ~~ a~~')]);
  assert.deepEqual(await line('*a *b*'), [text('*a '), em(text('b'))]);
  assert.deepEqual(await line('2 * 3 = 6 and 4*5'), [text('2 * 3 = 6 and 4*5')]);
});

test('an underscore needs a non-word character or the edge outside it, so snake_case stays text', async () => {
  assert.deepEqual(await line('snake_case_name'), [text('snake_case_name')]);
  assert.deepEqual(await line('call my_func_ now'), [text('call my_func_ now')]);
  assert.deepEqual(await line('__init__.py'), [strong(text('init')), text('.py')]);
  assert.deepEqual(await line('x__init__'), [text('x__init__')]);
  assert.deepEqual(await line('_a_b_'), [em(text('a_b'))]);
  assert.deepEqual(await line('(_quiet_)'), [text('('), em(text('quiet')), text(')')]);
  assert.deepEqual(await line('_über_'), [em(text('über'))]);
  assert.deepEqual(await line('école_lieu_dit'), [text('école_lieu_dit')]);
});

test('unmatched delimiters stay text, and pairs never cross', async () => {
  assert.deepEqual(await line('**unclosed and *this'), [text('**unclosed and *this')]);
  assert.deepEqual(await line('closed** only*'), [text('closed** only*')]);
  assert.deepEqual(await line('**a*'), [text('*'), em(text('a'))]);
  assert.deepEqual(await line('*a**'), [em(text('a')), text('*')]);
  assert.deepEqual(await line('*a _b* c_'), [em(text('a _b')), text(' c_')]);
  assert.deepEqual(await line('**a ~~b** c~~'), [strong(text('a ~~b')), text(' c~~')]);
  assert.deepEqual(await line('so * * *'), [text('so * * *')]);
});

test('formatting does not cross a line break', async () => {
  const { parse } = await loading;
  assert.deepEqual(parse('**one\ntwo**', []), [paragraph([text('**one')], [text('two**')])]);
  assert.deepEqual(parse('`a\nb`', []), [paragraph([text('`a')], [text('b`')])]);
});

test('formatting nested past twenty levels shows its markers', async () => {
  const { parse, plainText } = await loading;
  // Thirty italics inside each other: each opener only opens, each closer only closes.
  const s = `${'*a '.repeat(30)}x${' a*'.repeat(30)}`;
  let deepest = 0;
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (n.type === 'em') deepest = Math.max(deepest, depth + 1);
      if (n.children) walk(n.children, depth + 1);
    }
  };
  walk(parse(s, [])[0].lines[0], 0);
  assert.equal(deepest, 20);
  assert.equal(plainText(s), `${'a '.repeat(20)}${'*a '.repeat(10)}x${' a*'.repeat(10)}${' a'.repeat(20)}`);
  assert.equal(plainText(`${'*a '.repeat(20)}x${' a*'.repeat(20)}`), `${'a '.repeat(20)}x${' a'.repeat(20)}`);
});

test('links: [label](address) with http, https or mailto, a label of inline text', async () => {
  assert.deepEqual(await line('see [the docs](https://docs.example/a_(b)) now'), [
    text('see '),
    link('https://docs.example/a_(b)', text('the docs')),
    text(' now'),
  ]);
  assert.deepEqual(await line('[**bold** and `code`](http://a.example)'), [link('http://a.example', strong(text('bold')), text(' and '), code('code'))]);
  assert.deepEqual(await line('**[x](https://a.example)**'), [strong(link('https://a.example', text('x')))]);
  assert.deepEqual(await line('[mail me](mailto:ann@example.com)'), [link('mailto:ann@example.com', text('mail me'))]);
  assert.deepEqual(await line('[x](HTTPS://A.EXAMPLE)'), [link('HTTPS://A.EXAMPLE', text('x'))]);
  // Escapes in the address are read; brackets in the label balance.
  assert.deepEqual(await line('[x](https://a.example/\\)y)'), [link('https://a.example/)y', text('x'))]);
  assert.deepEqual(await line('[a [b] c](https://a.example)'), [link('https://a.example', text('a [b] c'))]);
  // An address in a label isn't a second link.
  assert.deepEqual(await line('[https://a.example](https://b.example)'), [link('https://b.example', text('https://a.example'))]);
});

test('a link with any other address, or without a label, stays text', async () => {
  for (const s of [
    '[x](javascript:alert(1))',
    '[x](JavaScript:alert(1))',
    '[x](data:text/html,hi)',
    '[x](vbscript:msgbox)',
    '[x](file:///C:/Windows)',
    '[x](ftp://files.example)',
    '[x](/relative/path)',
    '[x](//host.example)',
    '[x](https:host.example)',
    '[x](http://)',
    '[x](mailto:)',
    '[x](https://a.example "title")',
    '[x]( https://a.example)',
    '[](https://a.example)',
    '[x] (https://a.example)',
    '[x](https://a.example',
  ]) {
    const nodes = await line(s);
    // At most a bare address inside it is a link, as its own text.
    const links = nodes.filter((n) => n.type !== 'text');
    assert.ok(
      links.every((n) => n.type === 'link' && /^https?:\/\//.test(n.href) && n.children.length === 1 && n.children[0].text === n.href),
      `${s}: ${JSON.stringify(nodes)}`,
    );
  }
  assert.deepEqual(await line('[x](javascript:alert(1))'), [text('[x](javascript:alert(1))')]);
  assert.deepEqual(await line('[x](ftp://files.example)'), [text('[x](ftp://files.example)')]);
  // Formatting in the label of a construct that isn't a link still applies; its brackets show.
  assert.deepEqual(await line('[**x**](javascript:y)'), [text('['), strong(text('x')), text('](javascript:y)')]);
});

test('no link inside a link: the innermost brackets make it', async () => {
  // The rest is text, where a bare address is a link of its own.
  assert.deepEqual(await line('[a [b](https://b.example) c](https://c.example)'), [
    text('[a '),
    link('https://b.example', text('b')),
    text(' c]('),
    link('https://c.example'),
    text(')'),
  ]);
  assert.deepEqual(await line('[a](https://a.example)[b](https://b.example)'), [link('https://a.example', text('a')), link('https://b.example', text('b'))]);
});

test('bare addresses become links as linkify.js finds them, also with markers in them or around them', async () => {
  assert.deepEqual(await line('go to https://example.com/a_b_c.'), [text('go to '), link('https://example.com/a_b_c'), text('.')]);
  assert.deepEqual(await line('see https://example.com/_x_/*y*'), [text('see '), link('https://example.com/_x_/*y*')]);
  assert.deepEqual(await line('(www.example.com)'), [text('('), link('https://www.example.com', text('www.example.com')), text(')')]);
  assert.deepEqual(await line('**https://example.com**'), [strong(link('https://example.com'))]);
  // linkify.js reads an address right after _ as part of a word, as it does in the composer.
  assert.deepEqual(await line('_https://example.com_'), [em(text('https://example.com'))]);
  // An address that ends in the _ closing an italic it is in ends before it; on its own the _ is part of it.
  assert.deepEqual(await line('_see https://example.com_'), [em(text('see '), link('https://example.com'))]);
  assert.deepEqual(await line('__see www.example.com__!'), [strong(text('see '), link('https://www.example.com', text('www.example.com'))), text('!')]);
  assert.deepEqual(await line('see https://example.com/a_'), [text('see '), link('https://example.com/a_')]);
  assert.deepEqual(await line('my_var https://example.com/a_'), [text('my_var '), link('https://example.com/a_')]);
  assert.deepEqual(await line('~~https://example.com~~'), [strike(link('https://example.com'))]);
  assert.deepEqual(await line('ftp://files.example mailto:a@example.com'), [text('ftp://files.example mailto:a@example.com')]);
});

test('a backslash makes every marker character literal, and other backslashes stay', async () => {
  assert.deepEqual(await line('\\\\ \\` \\* \\_ \\~ \\[ \\] \\( \\) \\# \\> \\- \\+ \\. \\!'), [text('\\ ` * _ ~ [ ] ( ) # > - + . !')]);
  assert.deepEqual(await line('\\*not italic\\*'), [text('*not italic*')]);
  assert.deepEqual(await line('\\**italic*'), [text('*'), em(text('italic'))]);
  assert.deepEqual(await line('\\[x](https://a.example)'), [text('[x]('), link('https://a.example'), text(')')]);
  assert.deepEqual(await line('C:\\Users\\a and \\n and a\\'), [text('C:\\Users\\a and \\n and a\\')]);
  assert.deepEqual(await line('\\~~not struck~~'), [text('~~not struck~~')]);
});

test('an escaped block marker leaves the line a paragraph', async () => {
  const { parse } = await loading;
  assert.deepEqual(parse('\\# not a heading\n\\> not a quote\n\\- not an item\n1\\. not numbered\n\\+ plus\n\\```', []), [
    paragraph([text('# not a heading')], [text('> not a quote')], [text('- not an item')], [text('1. not numbered')], [text('+ plus')], [text('```')]),
  ]);
});

// ---- Mentions ----

test('a mention is one token that formatting may wrap', async () => {
  const s = '**@Ann** _@Ann_ ~~@Ann~~ [@Ann](https://a.example) hi @Ann';
  const mentions = [0, 1, 2, 3, 4].map((n) => mention(s, '@Ann', ann, n));
  assert.deepEqual(await line(s, mentions), [
    strong(chip('@Ann')),
    text(' '),
    em(chip('@Ann')),
    text(' '),
    strike(chip('@Ann')),
    text(' '),
    link('https://a.example', chip('@Ann')),
    text(' hi '),
    chip('@Ann'),
  ]);
});

test('a mention says me for your member ID, and a blocked author has none', async () => {
  const s = '@Ann and **@Bob**';
  const mentions = [mention(s, '@Ann'), mention(s, '@Bob', bob)];
  assert.deepEqual(await line(s, mentions, { me: bob }), [chip('@Ann'), text(' and '), strong(chip('@Bob', bob, true))]);
  assert.deepEqual(await line(s, mentions, { me: bob, blocked: true }), [text('@Ann and '), strong(text('@Bob'))]);
  assert.deepEqual(await line(s, mentions, {}), [chip('@Ann'), text(' and '), strong(chip('@Bob', bob))]);
});

test('nothing splits a mention: markers, backticks and brackets inside one are its text', async () => {
  const stars = '@Ann *the* best*';
  assert.deepEqual(await line(stars, [mention(stars, '@Ann *the*')]), [chip('@Ann *the*'), text(' best*')]);
  const under = '_hi @Jan_de_Vries_';
  assert.deepEqual(await line(under, [mention(under, '@Jan_de_Vries')]), [em(text('hi '), chip('@Jan_de_Vries'))]);
  const ticks = '`a @B`c d`';
  assert.deepEqual(await line(ticks, [mention(ticks, '@B`c')]), [code('a @B`c d')]);
  const open = '`x @B`c d';
  assert.deepEqual(await line(open, [mention(open, '@B`c')]), [text('`x '), chip('@B`c'), text(' d')]);
  const bracket = '[see @Ann](https://a.example) [x](https://a.example/@Bob)';
  assert.deepEqual(await line(bracket, [mention(bracket, '@Ann'), mention(bracket, '@Bob', bob)]), [
    link('https://a.example', text('see '), chip('@Ann')),
    text(' [x]('),
    link('https://a.example/'),
    chip('@Bob', bob),
    text(')'),
  ]);
  // A delimiter right after a mention reads the mention's last character as its neighbour.
  const after = '@Ann_x_ and _@Ann_';
  assert.deepEqual(await line(after, [mention(after, '@Ann'), mention(after, '@Ann', ann, 1)]), [
    chip('@Ann'),
    text('_x_ and '),
    em(chip('@Ann')),
  ]);
});

test('a mention in code shows as its text, and no address is searched inside one', async () => {
  const s = 'run `ping @Ann` or ask @www.example.com';
  assert.deepEqual(await line(s, [mention(s, '@Ann'), mention(s, '@www.example.com', bob)]), [
    text('run '),
    code('ping @Ann'),
    text(' or ask '),
    chip('@www.example.com', bob),
  ]);
  const url = 'https://example.com/@Ann/page';
  assert.deepEqual(await line(url, [mention(url, '@Ann')]), [link('https://example.com/'), chip('@Ann'), text('/page')]);
});

test('mentions in headings, quotes and list items; one under a block marker or over a line break is text', async () => {
  const { parse } = await loading;
  const s = '# @Ann\n> @Ann\n- @Ann';
  assert.deepEqual(parse(s, [0, 1, 2].map((n) => mention(s, '@Ann', ann, n))), [
    { type: 'heading', level: 1, content: [chip('@Ann')] },
    { type: 'quote', lines: [[chip('@Ann')]] },
    { type: 'list', ordered: false, start: 1, items: [item(0, [chip('@Ann')])] },
  ]);
  // A label that starts with a marker keeps its line a paragraph.
  const marker = '# Ann team';
  assert.deepEqual(parse(marker, [mention(marker, '# Ann')]), [paragraph([chip('# Ann'), text(' team')])]);
  const broken = 'hi @Ann\nSmith';
  assert.deepEqual(parse(broken, [mention(broken, '@Ann\nSmith')]), [paragraph([text('hi @Ann')], [text('Smith')])]);
  // Ranges that don't hold (validMentions) are text.
  assert.deepEqual(parse('hi @Ann', [{ actor: ann, start: 3, end: 99 }, { actor: 'nobody', start: 0, end: 2 }]), [paragraph([text('hi @Ann')])]);
});

test('every mention vector reads as the same chips that segments() shows', async () => {
  const { parse } = await loading;
  const { segments } = await loadingText;
  const chips = (nodes, out = []) => {
    for (const n of nodes) {
      if (n.type === 'mention') out.push({ text: n.text, mention: n.actor });
      else if (n.children) chips(n.children, out);
    }
    return out;
  };
  for (const c of vectors.mentions) {
    const blocks = parse(c.text, c.bytes, { me: ann });
    const found = blocks.flatMap((b) => (b.lines || []).flatMap((l) => chips(l)));
    const expected = segments(c.text, c.bytes, { me: ann }).filter((x) => x.mention).map(({ text, mention }) => ({ text, mention }));
    assert.deepEqual(found, expected, c.name);
  }
});

// ---- Time ----

test('time grows with the length, also for long runs that never close', async () => {
  const { parse, plainText } = await loading;
  // Four times the longest message, so a step that compares every marker with every other can't stay under the bound.
  const n = 65536;
  const fill = (unit) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const cases = {
    stars: fill('*'),
    underscores: fill('_'),
    backticks: fill('`'),
    brackets: fill('['),
    closers: fill(']'),
    'star words': fill('*a'),
    'underscore words': fill('_a '),
    'backtick words': fill('`a'),
    'open links': fill('[a]('),
    'unclosed addresses': fill('[a](https://x.example/('),
    'mixed markers': fill('*_~~`[](\\'),
    'bold openers': fill('**a '),
    'growing backtick runs': Array.from({ length: 360 }, (_, k) => `${'`'.repeat(k + 1)}x`).join(''),
    nesting: `${fill('*_').slice(0, n / 2)}x${fill('_*').slice(0, n / 2)}`,
    'list lines': fill('- a\n'),
    'quote lines': fill('> *a\n'),
    'fence lines': fill('```\n'),
    addresses: fill('https://a.example/_x_ '),
    'escapes': fill('\\*'),
    'one long word': fill('a'),
  };
  for (const [name, s] of Object.entries(cases)) {
    parse(s, []);
    const started = process.hrtime.bigint();
    parse(s, []);
    plainText(s);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 500, `${name}: ${Math.round(ms)} ms for ${s.length} characters`);
  }
  // The runs that never close are text, all of them.
  assert.equal(plainText(fill('*')), fill('*'));
  assert.equal(plainText(fill('`')), fill('`'));
  assert.equal(plainText(fill('[')), fill('['));
});

test('random marker soup never throws and only loses markers', async () => {
  const { parse, plainText } = await loading;
  const alphabet = ['*', '**', '_', '__', '~~', '~', '`', '``', '[', ']', '(', ')', '\\', ' ', 'a', 'b', '\n', '> ', '- ', '# ', '1. ', 'https://x.example/', '@'];
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 500; round++) {
    let s = '';
    const length = 1 + Math.floor(random() * 40);
    for (let k = 0; k < length; k++) s += alphabet[Math.floor(random() * alphabet.length)];
    const blocks = parse(s, []);
    assert.ok(Array.isArray(blocks));
    const plain = plainText(s);
    const letters = (x) => (x.match(/[ab]/g) || []).length;
    assert.equal(letters(plain), letters(s), `${JSON.stringify(s)} keeps its letters: ${JSON.stringify(plain)}`);
  }
});

// ---- plainText ----

test('plainText leaves out the markers, a line per line, heading, quote line and list item', async () => {
  const { plainText } = await loading;
  assert.equal(plainText('**Hi** _there_, see [the docs](https://a.example) and `npm test`'), 'Hi there, see the docs and npm test');
  assert.equal(plainText('# Plan\n> said **this**\n- one\n  2. two\n\nlast ~~line~~'), 'Plan\nsaid this\none\ntwo\nlast line');
  assert.equal(plainText('```js\nconst a = **1**;\n```'), 'const a = **1**;');
  assert.equal(plainText('snake_case and \\*stars\\* and https://a.example/_b_'), 'snake_case and *stars* and https://a.example/_b_');
  assert.equal(plainText(''), '');
  assert.equal(plainText(undefined), '');
  // With the mentions, a mention's text is never read as markers.
  const s = 'hi @Ann *x*';
  assert.equal(plainText(s, [mention(s, '@Ann *x*')]), 'hi @Ann *x*');
  assert.equal(plainText(s), 'hi @Ann x');
});
