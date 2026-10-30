'use strict';

// The chat's permission level: when Rukoo shows an approval card before it acts for an agent, and when it goes ahead
// on its own. One level drives every card Rukoo itself decides on: mail_action, create_event and propose_action.
// Settings has the default; a chat can have its own (hub.permissionOf), which a tool call gets only when it is tied
// to that chat (hub.permissionFor).
//
// - ask: every action that changes something waits for the user. The default, and what an unknown level means.
// - auto: Rukoo goes ahead with what only the user sees and what is easy to undo: archiving, moving between
//   folders, marking read or unread, starring, and an event without guests on the user's own calendar. It asks
//   before anything other people see or that is hard to undo: deleting (also a move into Trash), a move into Spam,
//   unsubscribing, an event with guests or on someone else's calendar, and every proposal for another system.
// - full: no cards at all. That includes deleting, unsubscribing, invitations to guests and what the agent proposes
//   to do elsewhere, such as sending a message.
//
// The agent programs' own permission requests (Claude Code running a command, Codex leaving its sandbox, Hermes'
// dangerous commands) are not Rukoo's to decide: they follow the agent's own setting (Settings > Access for Claude
// Code and Codex) at every level.

// From the strictest level to the loosest.
const PERMISSIONS = ['ask', 'auto', 'full'];

// Mail actions Auto does without asking. A move only when it lands in neither Trash nor Spam (intoTrash, intoSpam):
// Spam empties itself after a while, as Gmail's does after 30 days, and a move there teaches the spam filter.
const AUTO_MAIL = new Set(['archive', 'move', 'mark_read', 'mark_unread', 'star', 'unstar']);

const permissionLevel = (value) => (PERMISSIONS.includes(value) ? value : null);

// The strictest of some levels; one Rukoo does not know counts as Ask, and so does none.
function strictest(levels) {
  const known = (levels || []).map((l) => permissionLevel(l) || 'ask');
  return PERMISSIONS.find((p) => known.includes(p)) || 'ask';
}

// request: {kind: 'mail', action, intoTrash, intoSpam} | {kind: 'calendar', guests (count), mine (the calendar is
// the user's own, calendar index.js mineOf)} | {kind: 'proposal'}. Anything not listed asks, at every level but full.
function needsApproval(level, request = {}) {
  if (level === 'full') return false;
  if (level !== 'auto') return true;
  switch (request.kind) {
    case 'mail':
      return !(AUTO_MAIL.has(request.action) && request.intoTrash !== true && request.intoSpam !== true);
    case 'calendar':
      return !(request.mine === true && !(Number(request.guests) > 0));
    default:
      return true;
  }
}

module.exports = { PERMISSIONS, AUTO_MAIL, permissionLevel, strictest, needsApproval };
