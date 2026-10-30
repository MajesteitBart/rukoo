'use strict';

// The chat's permission level: when Rukoo shows an approval card before it acts for an agent, and when it goes ahead
// on its own. One level drives every card Rukoo itself decides on: mail_action, create_event and propose_action.
// Settings has the default; a chat can have its own (hub.permissionOf).
//
// - ask: every action that changes something waits for the user. The default, and what an unknown level means.
// - auto: Rukoo goes ahead with what only the user sees and what is easy to undo: archiving, moving between
//   folders, marking read or unread, starring, and an event without guests on a calendar the user owns. It asks
//   before anything other people see or that is hard to undo: deleting (also a move into Trash), unsubscribing, an
//   event with guests or on someone else's calendar, and every proposal for another system.
// - full: no cards at all. That includes deleting, unsubscribing, invitations to guests and what the agent proposes
//   to do elsewhere, such as sending a message.
//
// The agent programs' own permission requests (Claude Code running a command, Codex leaving its sandbox, Hermes'
// dangerous commands) are not Rukoo's to decide: they follow the agent's own setting (Settings > Access for Claude
// Code and Codex) at every level.

const PERMISSIONS = ['ask', 'auto', 'full'];

// Mail actions Auto does without asking. A move only when it does not land in Trash (intoTrash).
const AUTO_MAIL = new Set(['archive', 'move', 'mark_read', 'mark_unread', 'star', 'unstar']);

const permissionLevel = (value) => (PERMISSIONS.includes(value) ? value : null);

// request: {kind: 'mail', action, intoTrash} | {kind: 'calendar', guests (count), owned (the user owns the
// calendar)} | {kind: 'proposal'}. Anything not listed asks, at every level but full.
function needsApproval(level, request = {}) {
  if (level === 'full') return false;
  if (level !== 'auto') return true;
  switch (request.kind) {
    case 'mail':
      return !(AUTO_MAIL.has(request.action) && request.intoTrash !== true);
    case 'calendar':
      return !(request.owned === true && !(Number(request.guests) > 0));
    default:
      return true;
  }
}

module.exports = { PERMISSIONS, AUTO_MAIL, permissionLevel, needsApproval };
