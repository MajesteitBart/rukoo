// Renders a mail body in a sandboxed iframe. Shared by the reader and the quote in the compose window.

// options: { light, darkEmails, forQuote }
export function frameDoc(m, { light = false, darkEmails = true, forQuote = false } = {}) {
  const invert = !light && darkEmails && m.isHtml;
  const textColor = light || invert ? '#15171c' : '#e6e8ee';
  const link = invert ? '#1a5fd0' : light ? '#2f63c8' : '#8ab0ff';
  // Inverting #e2e3e8 and turning the hue back lands on the reader's dark panel colour.
  const invertCss = invert
    ? `html{filter:invert(1) hue-rotate(180deg);background:#e2e3e8}
       img,picture,video,svg,[style*="background-image"],[background]{filter:invert(1) hue-rotate(180deg)}`
    : '';
  // The frame's colour scheme must match the app's: Chromium paints a white backdrop behind a
  // light-scheme frame inside a dark page. Inverted mail is drawn light and filtered dark.
  const scheme = light || invert ? 'light' : 'dark';
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<style>
html{color-scheme:${scheme};color:${textColor};background:transparent}
body{margin:0;padding:0 2px 8px;font:14.5px/1.6 'Segoe UI',system-ui,sans-serif;overflow-wrap:anywhere;${forQuote ? '' : 'overflow:hidden;'}}
a{color:${link}}
img{max-width:100%;height:auto}
pre{white-space:pre-wrap}
blockquote{border-left:3px solid rgba(128,128,128,.45);margin:0 0 0 2px;padding-left:12px}
${invertCss}
</style></head><body>${m.html || ''}</body></html>`;
}

// Newsletters sit on a grey canvas as wide as the window. In the reader that reads as a broken
// frame, so a light, neutral canvas around the content becomes transparent. Content colours stay.
function clearCanvas(doc) {
  const neutral = (el) => {
    const c = (getComputedStyle(el).backgroundColor.match(/[\d.]+/g) || []).map(Number);
    if (c.length < 3 || c[3] === 0) return false;
    return Math.min(c[0], c[1], c[2]) >= 225 && Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) <= 14;
  };
  const width = doc.body.clientWidth;
  const chain = [doc.body];
  let el = doc.body;
  for (let depth = 0; depth < 5; depth++) {
    const kids = [...el.children].filter((k) => !/^(STYLE|SCRIPT|META|LINK|TITLE)$/.test(k.tagName));
    if (kids.length !== 1 || kids[0].getBoundingClientRect().width < width * 0.95) break;
    el = kids[0];
    chain.push(el);
  }
  for (const node of chain) {
    if (!neutral(node)) continue;
    node.style.setProperty('background-color', 'transparent', 'important');
    node.removeAttribute('bgcolor');
  }
}

// options: frameDoc's options plus { fitContent }
export function fillFrame(frame, m, opts = {}) {
  (frame.observers || []).forEach((o) => o.disconnect());
  frame.srcdoc = frameDoc(m, opts);
  frame.addEventListener(
    'load',
    () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const fit = () => {
        const body = doc.body;
        if (!body || !frame.isConnected) return;
        if (opts.fitContent !== false) {
          body.style.zoom = '';
          const avail = frame.clientWidth;
          const needed = doc.documentElement.scrollWidth;
          if (needed > avail + 4) body.style.zoom = String(Math.max(0.3, avail / needed));
        }
        // A document's scroll height never drops below the frame's own height, so measured in place
        // the frame can only grow, and every resize grows it again. Measure with the frame collapsed,
        // and keep the surrounding scroll position, which the collapse would otherwise reset.
        const scroller = frame.closest('.reader-scroll, .compose-body');
        const top = scroller ? scroller.scrollTop : 0;
        body.style.overflowY = '';
        frame.style.height = '0px';
        const height = Math.ceil(doc.documentElement.scrollHeight);
        frame.style.height = `${height}px`;
        // Content sized to the window (100vh and the like) grows along with the frame and has no
        // fitting height; let such mail scroll inside the frame instead of cutting off its end.
        if (doc.documentElement.scrollHeight > height + 1) body.style.overflowY = 'auto';
        if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
      };
      if (m.isHtml && doc.body) clearCanvas(doc);
      fit();
      frame.observers = [new ResizeObserver(fit), new ResizeObserver(fit)];
      frame.observers[0].observe(doc.body);
      frame.observers[1].observe(frame);
      doc.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('href');
        if (href && !href.startsWith('#')) window.mail.call('openExternal', a.href);
      });
    },
    { once: true }
  );
}
