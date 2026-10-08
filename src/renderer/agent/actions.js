import { t } from '../i18n.js';

// Quick actions in the chat panel. The bubble shows the short label; the agent gets the prompt.
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

export const actionByKey = (key) => ACTIONS.find((a) => a.key === String(key || '').replace(/^\//, '')) || null;

// Whether an action makes sense for this email (or for no email at all).
export function applies(action, message) {
  if (!message) return !action.needsEmail;
  if (action.needsUnsubscribe && !message.unsubscribe) return false;
  return action.needsEmail;
}

// The chips in the empty state: the email actions, or the inbox overview when no email is open.
export const actionsFor = (message) => ACTIONS.filter((a) => applies(a, message));

// Slash commands (/reply, /brief, ...): the same actions; the inbox overview is always available.
export const commandsFor = (message) =>
  ACTIONS.filter((a) => a.key === 'triage' || applies(a, message)).map((a) => ({ name: a.key, label: a.label, description: a.description, icon: a.icon }));

// Skills as slash commands, after the quick actions. A quick action keeps its command: a skill with the same name
// is not offered here, though the agent can still read it with read_skill (docs/agents.md, "Skills").
export const skillCommands = (skills) =>
  (Array.isArray(skills) ? skills : [])
    .filter((s) => s && typeof s.name === 'string' && !actionByKey(s.name))
    .map((s) => ({ name: s.name, label: s.description, description: s.description, icon: 'file', skill: true }));
