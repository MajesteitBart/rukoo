import { t } from '../i18n.js';

// Rukoo's quick actions in the chat panel. The bubble shows the short label; the agent gets the prompt.
// Prompts stay in English on purpose: they are instructions for the model, not interface text.
export const ACTIONS = [
  {
    key: 'reply',
    icon: 'mail',
    needsEmail: true,
    prompt:
      'Draft a reply to this email in my voice, in the language of the email. First gather what you need: earlier mail with this person (search_mail), your memory, my notes and any other system you can reach. Then put the reply in the composer with write_draft. Keep it short. Afterwards tell me in one or two sentences what you assumed or left open.'
  },
  {
    key: 'brief',
    icon: 'search',
    needsEmail: true,
    prompt:
      'Before I reply: who is this, what is our history and what do I need to know or decide? Search my other mail, your memory, my notes and the other systems you can reach. Show the most useful sources with show_sources, then give me a short brief. Do not change anything.'
  },
  {
    key: 'tasks',
    icon: 'list',
    needsEmail: true,
    prompt:
      'Extract the follow-up actions from this email, with owner and due date where you can tell. Show them with show_plan. Then propose adding them to my task system with propose_action. Do not create anything until I approve.'
  },
  {
    key: 'team',
    icon: 'arrow-right',
    needsEmail: true,
    prompt:
      'Who on my team should know about this? Instead of forwarding the email, write a short message for the right channel (Slack, Mattermost, WhatsApp, Telegram or whatever you use for them) with the key points and the Message-ID so they can find it. Propose it with propose_action and only send it after I approve.'
  },
  {
    key: 'update',
    icon: 'layers',
    needsEmail: true,
    prompt:
      'Record this email where it belongs: CRM contact or deal, my notes, Linear, Todoist or anything else you manage for me. Show the planned updates with show_plan and propose each one with propose_action. After I approve, do it and update the plan with links.'
  },
  {
    key: 'unsubscribe',
    icon: 'x',
    needsEmail: true,
    needsUnsubscribe: true,
    prompt: 'Unsubscribe me from this sender with mail_action (action "unsubscribe"), and propose archiving their other mail in my inbox with mail_action.'
  },
  {
    key: 'summary',
    icon: 'sparkle',
    needsEmail: true,
    prompt: 'Summarize this email and its thread in at most three bullets, then tell me whether it needs a reply from me and by when.'
  },
  {
    key: 'triage',
    icon: 'clock',
    needsEmail: false,
    prompt:
      'Look at my inbox across all accounts with search_mail and tell me what needs my attention today, most urgent first, with one line per email. Show the emails as sources with show_sources (use the message ids).'
  }
];

for (const a of ACTIONS) {
  Object.defineProperty(a, 'label', { get: () => t(`agent.actions.${a.key}.label`), enumerable: true });
  Object.defineProperty(a, 'description', { get: () => t(`agent.actions.${a.key}.description`), enumerable: true });
}

// The quick actions of a chat about a Rukoo Voice meeting. A list of their own, outside the shortcuts: those are kept
// in agents.json and exported to the phone, which has no meetings. The transcript reaches the agent only through
// read_meeting_transcript, as untrusted text, so every prompt asks for it there.
export const MEETING_ACTIONS = [
  {
    key: 'catchup',
    icon: 'clock',
    prompt:
      'Catch me up on this meeting. Read what was said since you last read it with read_meeting_transcript, then tell me in a few short bullets what was discussed, what was decided and what is still open. Keep it brief: I am in the meeting.'
  },
  {
    key: 'asked',
    icon: 'person',
    prompt:
      'What did the others in this meeting ask me or expect from me? Read the transcript with read_meeting_transcript (since "start") and list each question or request: who asked it, what they asked, and whether I already answered it.'
  },
  {
    key: 'notes',
    icon: 'pen',
    prompt:
      'Write the notes of this meeting with your own meeting-notes skill, and store them where I keep notes. Read the whole transcript with read_meeting_transcript (since "start") and my own notes with read_meeting_notes. Tell me where you stored them.'
  },
  {
    key: 'followup',
    icon: 'mail',
    prompt:
      'Draft the follow-up email for this meeting to the people who were in it: thanks, what we decided, and who does what by when. Read the transcript with read_meeting_transcript (since "start") and my notes with read_meeting_notes, find the attendees in the calendar with list_events, then put the draft in the composer with write_draft (mode "new"). Do not send anything.'
  }
];

for (const a of MEETING_ACTIONS) {
  a.action = `meeting-${a.key}`;
  Object.defineProperty(a, 'label', { get: () => t(`agent.meetingActions.${a.key}.label`), enumerable: true });
  Object.defineProperty(a, 'description', { get: () => t(`agent.meetingActions.${a.key}.description`), enumerable: true });
}

export const meetingActionByKey = (key) => MEETING_ACTIONS.find((a) => a.key === String(key || '').replace(/^\//, '')) || null;

// ---------- shortcuts ----------

// The user arranges the quick actions in Settings → Agents → Shortcuts: hides Rukoo's, gives them their own label or
// prompt, puts them in another order, and adds their own. Main keeps that list (agents.json, config.js) as entries
// with only what changed; shortcutList() turns it into the shortcuts the panel offers, with every agent.
// The same rules as main's: the icons a shortcut of the user's can have, and the names neither can take.
export const SHORTCUT_ICONS = ['sparkle', 'mail', 'search', 'list', 'arrow-right', 'layers', 'clock', 'file', 'pen', 'calendar', 'person', 'globe', 'chart', 'link', 'check', 'shield', 'info', 'x'];
export const SHORTCUT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SHORTCUT_RESERVED = new Set(['approved', 'declined', 'skill', 'shortcut']);
export const SHORTCUTS_MAX = 40;
export const SHORTCUT_LABEL_MAX = 60;
export const SHORTCUT_PROMPT_MAX = 4000;

const builtinOf = (key) => ACTIONS.find((a) => a.key === key) || null;

// One shortcut as the panel and Settings use it. Rukoo's keep their translated label, unless the user wrote their
// own. action: what the message tells main it came from; a shortcut of the user's is just 'shortcut'.
function makeShortcut(entry, base) {
  const e = entry || {};
  if (!base) {
    const when = e.when === 'always' ? 'always' : 'email';
    return { key: e.key, custom: true, hidden: Boolean(e.hidden), icon: SHORTCUT_ICONS.includes(e.icon) ? e.icon : 'sparkle', when, needsEmail: when === 'email', label: e.label, description: e.label, prompt: e.prompt, action: 'shortcut' };
  }
  const edited = { label: e.label || '', prompt: e.prompt || '' };
  const s = { key: base.key, custom: false, hidden: Boolean(e.hidden), icon: base.icon, needsEmail: base.needsEmail, needsUnsubscribe: Boolean(base.needsUnsubscribe), edited, defaultPrompt: base.prompt, action: base.key };
  Object.defineProperty(s, 'defaultLabel', { get: () => base.label, enumerable: true });
  Object.defineProperty(s, 'label', { get: () => s.edited.label || base.label, enumerable: true });
  Object.defineProperty(s, 'description', { get: () => (s.edited.label ? base.label : base.description), enumerable: true });
  Object.defineProperty(s, 'prompt', { get: () => s.edited.prompt || base.prompt, enumerable: true });
  return s;
}

// The stored list (null: Rukoo's own) as shortcuts, in the user's order. A shortcut of Rukoo's that the list doesn't
// have, such as one newer than the list, goes after the one before it in Rukoo's own order.
export function shortcutList(stored) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(stored) ? stored : []) {
    if (!e || typeof e.key !== 'string' || seen.has(e.key)) continue;
    const base = builtinOf(e.key);
    if (!base && !(e.custom && e.label && e.prompt)) continue;
    seen.add(e.key);
    out.push(makeShortcut(e, base));
  }
  ACTIONS.forEach((a, i) => {
    if (seen.has(a.key)) return;
    const before = ACTIONS.slice(0, i).reverse().find((p) => seen.has(p.key));
    out.splice(before ? out.findIndex((s) => s.key === before.key) + 1 : 0, 0, makeShortcut(null, a));
    seen.add(a.key);
  });
  return out;
}

// What main stores for these shortcuts: null when they are Rukoo's own, as they come.
export function storedShortcuts(list) {
  const entries = list.map((s) => {
    const hidden = s.hidden ? { hidden: true } : {};
    if (s.custom) return { key: s.key, custom: true, label: s.label, prompt: s.prompt, icon: s.icon, when: s.when, ...hidden };
    return { key: s.key, ...hidden, ...(s.edited.label ? { label: s.edited.label } : {}), ...(s.edited.prompt ? { prompt: s.edited.prompt } : {}) };
  });
  const plain = entries.length === ACTIONS.length && entries.every((e, i) => Object.keys(e).length === 1 && e.key === ACTIONS[i].key);
  return plain ? null : entries;
}

export const shortcutByKey = (list, key) => list.find((s) => s.key === String(key || '').replace(/^\//, '')) || null;

// Whether a shortcut makes sense for this email (or for no email at all). Rukoo's are for an email, except the inbox
// overview, which is for no email; the user's are for an email or for always.
export function applies(s, message) {
  if (s.custom) return s.when === 'always' || Boolean(message);
  if (!message) return !s.needsEmail;
  if (s.needsUnsubscribe && !message.unsubscribe) return false;
  return s.needsEmail;
}

// The chips in the empty state: the shortcuts for the email, or for no email, that the user didn't hide.
export const actionsFor = (message, list) => list.filter((s) => !s.hidden && applies(s, message));

// Slash commands (/reply, /brief, ...): the same shortcuts, hidden ones too; the inbox overview and the user's
// shortcuts for always are always there.
export const commandsFor = (message, list) =>
  list
    .filter((s) => s.key === 'triage' || (s.custom && s.when === 'always') || applies(s, message))
    .map((s) => ({ name: s.key, label: s.label, description: s.description, icon: s.icon }));

// Skills as slash commands, after the shortcuts. A shortcut keeps its command: a skill with the same name is not
// offered here, though the agent can still read it with read_skill (docs/agents.md, "Skills").
export const skillCommands = (skills, list) =>
  (Array.isArray(skills) ? skills : [])
    .filter((s) => s && typeof s.name === 'string' && !shortcutByKey(list, s.name))
    .map((s) => ({ name: s.name, label: s.description, description: s.description, icon: 'file', skill: true }));
