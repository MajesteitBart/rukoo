// Rukoo Mail landing page. No framework: a few small behaviors, each guarded so a missing element
// on another page (the 404) does no harm.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const icon = (name, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="/assets/icons.svg#${name}"/></svg>`;
const rand = (a, b) => a + Math.random() * (b - a);

/* ---------- nav gets a backdrop once the page scrolls ---------- */

const nav = $('[data-nav]');
if (nav) {
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:12px;pointer-events:none';
  document.body.prepend(sentinel);
  new IntersectionObserver(([e]) => nav.classList.toggle('scrolled', !e.isIntersecting)).observe(sentinel);
}

/* ---------- sections fade up as they arrive ---------- */

const revealer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      revealer.unobserve(e.target);
    }
  },
  { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
);
$$('.reveal').forEach((el) => revealer.observe(el));

/* ---------- the pigeon: eyes follow the pointer, blink, and it coos when clicked ---------- */

const tpl = $('#tpl-pigeon');
if (tpl) $$('[data-pigeon], [data-pigeon-static]').forEach((el) => el.append(tpl.content.cloneNode(true)));

const birds = $$('[data-eyes], [data-pigeon] svg').map((svg) => ({
  svg,
  visible: false,
  nextIdle: 0,
  eyes: $$('.pg-eye', svg).map((g) => ({ g, iris: $('.pg-iris', g), pupil: $('.pg-pupil', g), x: 0, y: 0, tx: 0, ty: 0 })),
}));

if (birds.length && !reduce) {
  const MAX = 8.5; // SVG units the pupil may travel inside the iris
  let px = null;
  let py = null;
  let lastMove = -1e9;
  let frame = 0;

  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const bird = birds.find((b) => b.svg === e.target);
      if (bird) bird.visible = e.isIntersecting;
    }
    wake();
  });
  birds.forEach((b) => seen.observe(b.svg));

  addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') return;
      px = e.clientX;
      py = e.clientY;
      lastMove = performance.now();
      wake();
    },
    { passive: true }
  );

  function wake() {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function tick(now) {
    frame = 0;
    const tracking = px !== null && now - lastMove < 3500;
    const live = birds.filter((b) => b.visible);
    // Read every eye's position first, then write, so the browser lays out once per frame.
    if (tracking) {
      for (const b of live) {
        for (const eye of b.eyes) {
          const r = eye.iris.getBoundingClientRect();
          const dx = px - (r.left + r.width / 2);
          const dy = py - (r.top + r.height / 2);
          const d = Math.hypot(dx, dy) || 1;
          const reach = Math.min(1, d / (r.width * 3));
          eye.tx = (dx / d) * MAX * reach;
          eye.ty = (dy / d) * MAX * reach;
        }
      }
    } else {
      // Nobody around: look about like a pigeon does. Now and then the eyes disagree.
      for (const b of live) {
        if (now < b.nextIdle) continue;
        b.nextIdle = now + rand(700, 2600);
        const a = rand(0, Math.PI * 2);
        const m = rand(0.2, 1) * MAX;
        const googly = Math.random() < 0.18;
        b.eyes.forEach((eye, i) => {
          const aa = googly && i ? a + rand(1.5, 3) : a;
          eye.tx = Math.cos(aa) * m;
          eye.ty = Math.sin(aa) * m;
        });
      }
    }
    let moving = false;
    for (const b of live) {
      for (const eye of b.eyes) {
        const k = tracking ? 0.3 : 0.38;
        eye.x += (eye.tx - eye.x) * k;
        eye.y += (eye.ty - eye.y) * k;
        if (Math.abs(eye.tx - eye.x) > 0.05 || Math.abs(eye.ty - eye.y) > 0.05) moving = true;
        eye.pupil.setAttribute('transform', `translate(${eye.x.toFixed(2)} ${eye.y.toFixed(2)})`);
      }
    }
    // Keep running while eyes move, or while idling birds are on screen.
    if (moving || (!tracking && live.length)) frame = requestAnimationFrame(tick);
    else if (tracking) setTimeout(wake, 3600 - (now - lastMove));
  }
  wake();

  // Blink, every few seconds. Sometimes only one eye: a wink.
  for (const b of birds) {
    const blink = () => {
      if (b.visible) {
        const eyes = Math.random() < 0.15 ? [b.eyes[Math.floor(Math.random() * b.eyes.length)]] : b.eyes;
        eyes.forEach((e) => e.g.classList.add('blink'));
        setTimeout(() => eyes.forEach((e) => e.g.classList.remove('blink')), 130);
      }
      setTimeout(blink, rand(2400, 6500));
    };
    setTimeout(blink, rand(1200, 4000));
  }
}

// The coo itself: an ElevenLabs sound effect, loaded on the first click only.
let coo;
const playCoo = () => {
  coo ||= Object.assign(new Audio('/assets/coo.mp3'), { volume: 0.55 });
  coo.currentTime = 0;
  coo.play().catch(() => {});
};

for (const bird of $$('button.pigeon')) {
  let clicks = 0;
  const bubble = document.createElement('span');
  bubble.className = 'coo';
  bubble.setAttribute('aria-live', 'polite');
  bird.append(bubble);
  let hide;
  bird.addEventListener('click', () => {
    clicks++;
    bird.classList.remove('bob');
    void bird.offsetWidth;
    bird.classList.add('bob');
    // Every fourth coo comes out in Dutch, where pigeons say "roekoe".
    bubble.textContent = clicks % 4 === 0 ? 'roekoe.' : 'rukoo.';
    bubble.classList.add('show');
    playCoo();
    clearTimeout(hide);
    hide = setTimeout(() => bubble.classList.remove('show'), 1400);
  });
  bird.addEventListener('animationend', () => bird.classList.remove('bob'));
}

/* ---------- hero: switch the screenshot between the app's dark and light themes ---------- */

const themeBtns = $$('[data-theme-btn]');
for (const btn of themeBtns) {
  btn.addEventListener('click', () => {
    const theme = btn.dataset.themeBtn;
    themeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    $$('[data-theme-img]').forEach((p) => p.classList.toggle('is-hidden', p.dataset.themeImg !== theme));
  });
}

/* ---------- inbox: fold and unfold the sender stack ---------- */

const stack = $('[data-stack]');
const stackBtn = $('[data-stack-btn]');
if (stack && stackBtn) {
  const hot = $('[data-stack-hot]');
  const set = (open) => {
    stack.dataset.open = String(open);
    stackBtn.setAttribute('aria-pressed', String(open));
    $('span', stackBtn).textContent = open ? 'Fold the stack' : 'Unfold the stack';
    $('use', stackBtn).setAttribute('href', `/assets/icons.svg#caret-${open ? 'up' : 'down'}`);
  };
  const toggle = () => set(stack.dataset.open !== 'true');
  stackBtn.addEventListener('click', toggle);
  hot.addEventListener('click', toggle);
}

/* ---------- platform: your own download comes first, and Macs see ⌘ for Ctrl ---------- */

const os = (() => {
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return null;
  if (/Mac/i.test(platform)) return navigator.maxTouchPoints > 1 ? null : 'mac'; // an iPad asks for the desktop site
  if (/Win/i.test(platform)) return 'windows';
  if (/Linux|X11|CrOS/i.test(platform + ua)) return 'linux';
  return null;
})();
if (os) {
  $(`[data-dl] [data-os="${os}"]`)?.classList.add('is-yours');
  const cta = $('[data-dl-cta] span');
  if (cta) cta.textContent = `Download for ${{ windows: 'Windows', mac: 'Mac', linux: 'Linux', android: 'Android' }[os]}`;
  if (os === 'mac') $$('kbd').forEach((k) => k.textContent === 'Ctrl' && (k.textContent = '⌘'));
}

/* ---------- the walkthrough: opened from the hero in a player, streamed from Mux, with sound ---------- */

const film = $('[data-film]');
if (film) {
  const video = $('[data-film-video]', film);
  const frameEl = $('[data-film-frame]', film);
  const d = video.dataset;
  let loaded = false;
  // HLS goes first; browsers that can't play it fall through to the MP4.
  // Nothing downloads before the first click.
  const load = () => {
    if (loaded) return;
    loaded = true;
    // A 4:5 cut for phones when the page has one; otherwise every screen gets the 16:9 file.
    const tall = Boolean(d.tallMp4) && matchMedia('(max-width: 640px)').matches;
    const pick = (k) => d[(tall ? 'tall' : 'wide') + k];
    video.poster = pick('Poster');
    for (const [src, type] of [[pick('Hls'), 'application/x-mpegURL'], [pick('Mp4'), 'video/mp4']]) {
      if (src) video.append(Object.assign(document.createElement('source'), { src, type }));
    }
    // Captions are available from the player controls; most spoken lines are already on screen as type.
    video.append(Object.assign(document.createElement('track'), { kind: 'captions', src: d.captions, srclang: 'en', label: 'English' }));
    film.classList.toggle('tall', tall);
    frameEl.classList.toggle('tall', tall);
  };
  const open = () => {
    load();
    film.showModal();
    // The click is the user's gesture, so the film may start with sound.
    video.play().catch(() => {});
  };
  $$('[data-film-open]').forEach((b) => b.addEventListener('click', open));
  $('[data-film-close]', film).addEventListener('click', () => film.close());
  // A click on the dimmed backdrop (the dialog itself, outside the frame) closes it too.
  film.addEventListener('click', (e) => e.target === film && film.close());
  film.addEventListener('close', () => video.pause());
}

/* ---------- contribute: copy the fork commands ---------- */

const termCopy = $('[data-term-copy]');
if (termCopy && navigator.clipboard) {
  termCopy.addEventListener('click', async () => {
    const text = $$('[data-term] [data-cmd]').map((el) => el.textContent).join('\n');
    const label = $('span', termCopy);
    try {
      await navigator.clipboard.writeText(text);
      label.textContent = 'Copied';
    } catch {
      label.textContent = 'Select and copy';
    }
    setTimeout(() => (label.textContent = 'Copy'), 1800);
  });
} else if (termCopy) termCopy.hidden = true;

/* ---------- the agent demo ----------
   A replica of Rukoo's chat panel. Every string comes from the app: the scripted demo agent
   (src/main/agents/fake.js) and the English catalog. Clark drafts a reply to Sanne, then plans
   the follow-ups and waits for you to approve. Nothing here sends anything anywhere.
   One change from the scripted agent: "Confirm the call" is an open task (a numbered circle, no
   pill, as the app draws "todo") instead of "Done", because the reply is only drafted and sending
   it is still yours. */

const demo = $('[data-demo]');
if (demo) {
  const log = $('[data-log]', demo);
  const sugg = $('[data-sugg]', demo);
  const panes = { read: $('[data-pane="read"]', demo), compose: $('[data-pane="compose"]', demo) };
  const typed = $('[data-typed]', demo);
  const drafted = $('[data-drafted]', demo);
  const DRAFT = "Hi Sanne,\n\nThursday at 10:00 works for me. I'll call you then.\n\nBest,\nDemo";
  let gen = 0;
  let started = false;
  let nudgeTimer;
  let inView = false;

  const stale = new Error('stale');
  const wait = (ms, g) => new Promise((res, rej) => setTimeout(() => (g === gen ? res() : rej(stale)), reduce ? 0 : ms));
  const scroll = () => log.scrollTo({ top: log.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  const add = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    const el = t.content.firstElementChild;
    log.append(el);
    scroll();
    return el;
  };
  const say = async (text, g) => {
    const p = add('<p class="ap-say"></p>');
    if (reduce) return void ((p.textContent = text), scroll());
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      p.textContent = words.slice(0, i + 1).join(' ');
      scroll();
      await wait(34, g);
    }
  };
  // While the agent works the quick actions step aside, as they do in the app.
  const busy = (on) => sugg.classList.toggle('busy', on);
  const tool = (row, name, label) => {
    const t = document.createElement('span');
    t.className = 'ap-tool';
    t.innerHTML = `${icon(name)}${label}<i class="spin"></i>`;
    row.append(t);
    return t;
  };
  const toolDone = (t) => t.querySelector('.spin').replaceWith(Object.assign(document.createElement('span'), { innerHTML: icon('check', 'ic ok') }));
  const setPane = (name) => {
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== name;
  };
  const press = (act) => {
    const b = $(`[data-act="${act}"]`, sugg);
    if (!b) return;
    b.classList.remove('nudge');
    b.classList.add('pressed');
    setTimeout(() => b.classList.remove('pressed'), 160);
  };
  const reset = () => {
    gen++;
    clearTimeout(nudgeTimer);
    log.replaceChildren();
    typed.textContent = '';
    drafted.classList.remove('on');
    setPane('read');
    $$('button', sugg).forEach((b) => b.classList.remove('nudge'));
  };

  async function reply(g) {
    press('reply');
    busy(true);
    add('<div class="ap-user">Draft a reply</div>');
    const think = add(`<div class="ap-think live">${icon('sparkle')}<span>Thinking</span></div>`);
    await wait(1100, g);
    think.classList.remove('live');
    think.innerHTML = `${icon('sparkle')}<span>Thought for 1s</span>${icon('caret-down')}`;
    const row = add('<div class="ap-tools"></div>');
    const t1 = tool(row, 'envelope-simple', 'Looked at your screen');
    await wait(650, g);
    toolDone(t1);
    const t2 = tool(row, 'magnifying-glass', 'Searched your mail');
    await wait(900, g);
    toolDone(t2);
    await wait(200, g);
    await say('I checked your earlier mail with Sanne and kept the reply short.', g);
    await wait(350, g);
    // write_draft puts the whole reply in the composer at once.
    setPane('compose');
    await wait(420, g);
    typed.textContent = DRAFT;
    drafted.classList.add('on');
    add(`<div class="ap-card">
      <div class="ap-card-head"><span class="pen">${icon('pencil-simple')}</span><b>Wrote a reply</b>
        <span class="acts"><span class="mini-btn outline">Show</span><span class="mini-btn">Undo</span></span></div>
      <div class="meta">Sanne de Vries · Re: Call on Thursday</div>
      <div class="prev">Hi Sanne, Thursday at 10:00 works for me. I'll call you then. Best, Demo</div>
    </div>`);
    await wait(600, g);
    await say('Done. The draft is in the composer.', g);
    busy(false);
    scroll();
    const next = $('[data-act="tasks"]', sugg);
    next.classList.add('nudge');
    nudgeTimer = setTimeout(() => {
      if (g === gen && inView) start('tasks', true);
    }, 6500);
  }

  async function tasks(g) {
    press('tasks');
    busy(true);
    log.replaceChildren(); // a new chat, like the app's "+" button
    add('<div class="ap-user">Plan follow-ups</div>');
    await wait(800, g);
    add('<div class="plan-title">Follow-ups <span class="count">3</span></div>');
    const plan = add(`<div class="plan">
      <div class="plan-row"><span class="num">1</span><span class="t">Confirm the call on Thursday at 10:00</span><span class="sys">Email</span><span></span></div>
      <div class="plan-row" data-t="2"><span class="num">2</span><span class="t">Review Proposal-v3.pdf</span><span class="sys">Todoist</span><span class="status">Proposed</span></div>
      <div class="plan-row" data-t="3"><span class="num">3</span><span class="t">Send notes to Joris after the call</span><span class="sys">Todoist</span><span class="status">Proposed</span></div>
    </div>`);
    await wait(700, g);
    await say('Two of these belong in Todoist.', g);
    await wait(300, g);
    const card = add(`<div class="ap-card approve">
      <b>Add 2 tasks to Todoist</b>
      <p>Review Proposal-v3.pdf (due Wednesday) and send notes to Joris after the call (due Friday).</p>
      <dl><dt>Task</dt><dd>Review Proposal-v3.pdf, due Wednesday</dd><dt>Task</dt><dd>Send notes to Joris after the call, due Friday</dd></dl>
      <div class="approve-foot"><span class="wait">Waiting for <em>you</em></span>
        <button type="button" class="no">Decline</button><button type="button" class="yes">Add tasks</button></div>
    </div>`);
    await wait(400, g);
    await say("I'll add them once you approve.", g);
    scroll();
    const yes = $('.yes', card);
    const no = $('.no', card);
    yes.classList.add('nudge');
    const decide = async (ok) => {
      if (g !== gen || card.classList.contains('resolved')) return;
      card.classList.add('resolved');
      $('.wait', card).textContent = ok ? 'Approved' : 'Declined';
      add(`<div class="ap-user"><small>${ok ? 'You approved' : 'You declined'}</small>Add 2 tasks to Todoist</div>`);
      if (!ok) return void busy(false);
      // Bring the plan back into view, so you see the tasks flip to Done.
      await wait(700, g);
      log.scrollTo({ top: Math.max(0, plan.offsetTop - 34), behavior: reduce ? 'auto' : 'smooth' });
      await wait(650, g);
      for (const n of ['2', '3']) {
        const r = $(`[data-t="${n}"]`, plan);
        r.classList.add('done');
        $('.num', r).innerHTML = icon('check');
        $('.status', r).textContent = 'Done';
        await wait(260, g);
      }
      await wait(500, g);
      await say('Done. I added 2 tasks and linked them in the plan.', g);
      busy(false);
      scroll();
    };
    yes.addEventListener('click', () => decide(true).catch(() => {}));
    no.addEventListener('click', () => decide(false).catch(() => {}));
  }

  function start(act, keepComposer = false) {
    const keep = keepComposer && !panes.compose.hidden;
    reset();
    if (keep) {
      setPane('compose');
      typed.textContent = DRAFT;
      drafted.classList.add('on');
    }
    started = true;
    const g = gen;
    (act === 'tasks' ? tasks : reply)(g).catch((e) => {
      if (e !== stale) throw e;
    });
  }

  for (const b of $$('button', sugg)) b.addEventListener('click', () => start(b.dataset.act, b.dataset.act === 'tasks'));
  $('[data-replay]', demo).addEventListener('click', () => start('reply'));

  new IntersectionObserver(
    ([e]) => {
      inView = e.isIntersecting;
      if (inView && !started) setTimeout(() => !started && start('reply'), reduce ? 0 : 500);
    },
    { threshold: 0.45 }
  ).observe(demo);
}

/* ---------- early access: the form posts to the site's Worker, which emails Bart ---------- */

const early = $('[data-early]');
if (early) {
  const status = $('[data-early-status]', early);
  const button = $('button[type="submit"]', early);
  const say = (text, kind = '') => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  const problem = {
    400: 'Check your email address and try again.',
    429: 'Too many tries. Wait a minute and try again.',
  };
  early.addEventListener('submit', async (e) => {
    e.preventDefault();
    button.disabled = true;
    say('Sending…');
    try {
      const res = await fetch(early.action, { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams(new FormData(early)) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        early.reset();
        early.classList.add('sent');
        say("Thanks. I'll be in touch.", 'ok');
        return;
      }
      say(problem[res.status] || "That didn't go through. Try again in a moment.", 'error');
    } catch {
      say("That didn't go through. Check your connection and try again.", 'error');
    }
    button.disabled = false;
  });
}
