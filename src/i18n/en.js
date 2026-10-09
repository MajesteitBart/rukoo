// English source catalog with translator context.
(function (root) {
  const messages = {
  "mailbox.sidebar.accountCount": {
    "message": { "one": "{count} account", "other": "{count} accounts" },
    "description": "Sidebar account switcher: number of accounts below the All accounts label."
  },
  "mailbox.sidebar.draftCount": {
    "message": { "one": "{count} draft", "other": "{count} drafts" },
    "description": "Sidebar Drafts count: accessible name for the count badge."
  },
  "mailbox.sidebar.unreadCount": {
    "message": "{count} unread",
    "description": "Sidebar folder count: accessible name for the unread count badge."
  },
  "reader.unsubscribe.unknownSender": {
    "message": "this sender",
    "description": "Unsubscribe confirmation: fallback when no sender name or address is available."
  },
  "composer.quote.excludedPill": {
    "message": "··· excluded",
    "description": "Composer: collapsed previous-message pill when the quoted email is excluded from sending."
  },
  "agent.actions.brief.description": {
    "message": "Who this is and what you should know",
    "description": "Chat panel slash command menu: one-line description of the brief quick action."
  },
  "agent.actions.brief.label": {
    "message": "Brief me",
    "description": "Chat panel quick action chip: the agent explains who the sender is and what to know before replying."
  },
  "agent.actions.reply.description": {
    "message": "Write a reply in the composer",
    "description": "Chat panel slash command menu: one-line description of the reply quick action."
  },
  "agent.actions.reply.label": {
    "message": "Draft a reply",
    "description": "Chat panel quick action chip and slash command label: the agent writes a reply into the composer."
  },
  "agent.actions.summary.description": {
    "message": "The email and its thread in three bullets",
    "description": "Chat panel slash command menu: one-line description of the summary quick action."
  },
  "agent.actions.summary.label": {
    "message": "Summarize",
    "description": "Chat panel quick action chip: the agent summarizes the email and its thread."
  },
  "agent.actions.tasks.description": {
    "message": "Turn the email into tasks",
    "description": "Chat panel slash command menu: one-line description of the follow-ups quick action."
  },
  "agent.actions.tasks.label": {
    "message": "Plan follow-ups",
    "description": "Chat panel quick action chip: the agent turns the email into follow-up tasks."
  },
  "agent.actions.team.description": {
    "message": "Share the key points with your team",
    "description": "Chat panel slash command menu: one-line description of the tell-the-team quick action."
  },
  "agent.actions.team.label": {
    "message": "Tell the team",
    "description": "Chat panel quick action chip: the agent writes a short message for the team instead of forwarding."
  },
  "agent.actions.triage.description": {
    "message": "Go through the inbox, most urgent first",
    "description": "Chat panel slash command menu: one-line description of the inbox overview quick action."
  },
  "agent.actions.triage.label": {
    "message": "What needs me today?",
    "description": "Chat panel quick action chip when no email is open: the agent goes through the inbox."
  },
  "agent.actions.unsubscribe.description": {
    "message": "Stop mail from this sender",
    "description": "Chat panel slash command menu: one-line description of the unsubscribe quick action."
  },
  "agent.actions.unsubscribe.label": {
    "message": "Unsubscribe",
    "description": "Chat panel quick action chip, shown for newsletters: the agent unsubscribes after approval."
  },
  "agent.actions.update.description": {
    "message": "Record it in your CRM, notes or tasks",
    "description": "Chat panel slash command menu: one-line description of the update-systems quick action."
  },
  "agent.actions.update.label": {
    "message": "Update systems",
    "description": "Chat panel quick action chip: the agent records the email in CRM, notes or task systems."
  },
  "agent.approval.changeFiles": {
    "message": "{name} wants to change files",
    "description": "Chat transcript approval card title: the agent asks to write or edit files. name: agent name."
  },
  "agent.approval.command": {
    "message": "{name} wants to run a command",
    "description": "Chat transcript approval card title: the agent asks to run a shell command. name: agent name."
  },
  "agent.approval.permissions": {
    "message": "{name} wants more permissions",
    "description": "Chat transcript approval card title: the agent asks for extra sandbox permissions (network, writing files). name: agent name."
  },
  "agent.approval.readFile": {
    "message": "{name} wants to read a file",
    "description": "Chat transcript approval card title: the agent asks to read a file on this computer. name: agent name."
  },
  "agent.approval.tool": {
    "message": "{name} wants to use {tool}",
    "description": "Chat transcript approval card title for any other tool. name: agent name; tool: the tool, for example \"todoist · add_task\"."
  },
  "agent.approval.web": {
    "message": "{name} wants to open a web page",
    "description": "Chat transcript approval card title: the agent asks to fetch a web page. name: agent name."
  },
  "agent.approval.field.after": {
    "message": "New text",
    "description": "Chat transcript approval card field label: the text an edit puts in."
  },
  "agent.approval.field.before": {
    "message": "Old text",
    "description": "Chat transcript approval card field label: the text an edit replaces."
  },
  "agent.approval.field.command": {
    "message": "Command",
    "description": "Chat transcript approval card field label: the shell command to run."
  },
  "agent.approval.field.content": {
    "message": "Content",
    "description": "Chat transcript approval card field label: what the agent writes into a file."
  },
  "agent.approval.field.diff": {
    "message": "Changes",
    "description": "Chat transcript approval card field label: the diff of a file change."
  },
  "agent.approval.field.file": {
    "message": "File",
    "description": "Chat transcript approval card field label: the file the agent wants to read or change."
  },
  "agent.approval.field.folder": {
    "message": "Folder",
    "description": "Chat transcript approval card field label: the folder a command runs in."
  },
  "agent.approval.field.path": {
    "message": "Path",
    "description": "Chat transcript approval card field label: a file or folder path."
  },
  "agent.approval.field.pattern": {
    "message": "Pattern",
    "description": "Chat transcript approval card field label: the search pattern of a file search."
  },
  "agent.approval.field.query": {
    "message": "Search",
    "description": "Chat transcript approval card field label: what the agent wants to search for."
  },
  "agent.approval.field.reason": {
    "message": "Reason",
    "description": "Chat transcript approval card field label: why the agent asks."
  },
  "agent.approval.field.url": {
    "message": "Web address",
    "description": "Chat transcript approval card field label: the web page the agent wants to open."
  },
  "agent.approval.showAll": {
    "message": "Show all",
    "description": "Chat transcript approval card: unfolds a long command or file content."
  },
  "agent.approval.showLess": {
    "message": "Show less",
    "description": "Chat transcript approval card: folds a long value again."
  },
  "agent.approval.truncated": {
    "message": { "one": "{shown} more character not shown", "other": "{shown} more characters not shown" },
    "description": "Chat transcript approval card, under a value Rukoo had to shorten (over 20,000 characters). shown: the number, formatted."
  },
  "agent.choices.accept": {
    "message": "Allow",
    "description": "Chat transcript approval button: allow this command or change."
  },
  "agent.choices.acceptForSession": {
    "message": "Allow for this chat",
    "description": "Chat transcript approval button: allow similar requests for the rest of this chat."
  },
  "agent.choices.allow": {
    "message": "Allow",
    "description": "Chat transcript approval button: let the agent do it."
  },
  "agent.choices.always": {
    "message": "Always allow",
    "description": "Chat transcript approval button: allow this from now on."
  },
  "agent.choices.approve": {
    "message": "Approve",
    "description": "Chat transcript approval button for a proposed action."
  },
  "agent.choices.cancel": {
    "message": "Cancel",
    "description": "Chat transcript approval button: cancel the request."
  },
  "agent.choices.decline": {
    "message": "Decline",
    "description": "Chat transcript approval button that turns down a proposed action."
  },
  "agent.choices.deny": {
    "message": "Deny",
    "description": "Chat transcript approval button: do not let the agent do it."
  },
  "agent.choices.once": {
    "message": "Allow once",
    "description": "Chat transcript approval button: allow this one time."
  },
  "agent.choices.session": {
    "message": "Allow for this turn",
    "description": "Chat transcript approval button: allow until the agent finishes this answer."
  },
  "agent.draft.forward": {
    "message": "Wrote a forward",
    "description": "Chat transcript draft card title: the agent wrote a forwarded email."
  },
  "agent.draft.gone": {
    "message": "That draft is no longer open.",
    "description": "Toast when you use Show or Undo on a draft card but the composer was closed."
  },
  "agent.draft.cannotUndo": {
    "message": "Can't undo this draft anymore",
    "description": "Tooltip on the disabled Undo button of a draft card: its composer closed or the agent wrote again after your edits."
  },
  "agent.draft.new": {
    "message": "Wrote a new email",
    "description": "Chat transcript draft card title: the agent wrote a new email."
  },
  "agent.draft.reply": {
    "message": "Wrote a reply",
    "description": "Chat transcript draft card title: the agent wrote a reply in the composer."
  },
  "agent.draft.replyAll": {
    "message": "Wrote a reply to all",
    "description": "Chat transcript draft card title: the agent wrote a reply to all."
  },
  "agent.draft.show": {
    "message": "Show",
    "description": "Chat transcript draft card button that shows the draft in the composer."
  },
  "agent.draft.undone": {
    "message": "Undone",
    "description": "Chat transcript draft card: state after you undid the draft."
  },
  "agent.empty.body": {
    "message": "Looks things up and writes the draft. Sending stays with you.",
    "description": "Chat panel empty state line under the heading while an email is open."
  },
  "agent.empty.bodyLeftOut": {
    "message": "Add the email to work on it, or start with what needs you today.",
    "description": "Chat panel empty state line after you left the open email out of the new chat; Add this email is the chip above the input (renderEmpty in agent/panel.js)."
  },
  "agent.empty.bodyNoEmail": {
    "message": "Open an email to work on it, or start with what needs you today.",
    "description": "Chat panel empty state line under the heading without an open email."
  },
  "agent.empty.setupBody": {
    "message": "Rukoo needs a few details before it can reach {name}.",
    "description": "Chat panel empty state line when the agent is not set up; the setup link is below."
  },
  "agent.empty.setupTitle": {
    "message": "Set up {name} to start",
    "description": "Chat panel empty state heading when the agent is not set up or installed."
  },
  "agent.empty.title": {
    "message": "What should {name} do with this email?",
    "description": "Chat panel empty state heading while an email is open; name is the agent."
  },
  "agent.empty.titleNoEmail": {
    "message": "Ask {name} about your mail",
    "description": "Chat panel empty state heading without an open email; name is the agent."
  },
  "agent.errors.busy": {
    "message": "{name} is still working on the last message.",
    "description": "Chat panel error: a message was sent while the agent was still busy."
  },
  "agent.errors.disabled": {
    "message": "{name} is turned off in Settings.",
    "description": "Chat panel error: the agent is switched off."
  },
  "agent.errors.not-configured": {
    "message": "{name} isn't set up yet.",
    "description": "Chat panel error: the agent has no address or key."
  },
  "agent.errors.not-installed": {
    "message": "{name} isn't installed on this computer.",
    "description": "Chat panel error: the agent program was not found."
  },
  "agent.errors.offline": {
    "message": "Can't reach {name}.",
    "description": "Chat panel error: the agent server or program did not answer; name is the agent."
  },
  "agent.errors.protocol": {
    "message": "{name} sent something Rukoo didn't understand.",
    "description": "Chat panel error: unexpected response from the agent."
  },
  "agent.errors.rate-limited": {
    "message": "{name} is getting too many requests. Try again in a moment.",
    "description": "Chat panel error: the agent answered with a rate limit."
  },
  "agent.errors.spawn-failed": {
    "message": "{name} didn't start.",
    "description": "Chat panel error: the agent program could not be started or stopped unexpectedly."
  },
  "agent.errors.stopped": {
    "message": "Stopped.",
    "description": "Chat panel: shown when the turn was stopped."
  },
  "agent.errors.timeout": {
    "message": "{name} took too long to answer.",
    "description": "Chat panel error: the agent did not answer in time."
  },
  "agent.errors.unauthorized": {
    "message": "{name} didn't accept the key or token.",
    "description": "Chat panel error: authentication with the agent failed."
  },
  "agent.errors.unknown": {
    "message": "Something went wrong.",
    "description": "Chat panel error: fallback when the cause is not known."
  },
  "agent.notices.approval-too-long": {
    "message": "Declined without asking: {title}. Part of it is too long to show here, so you could not check it.",
    "description": "Chat transcript info line: Rukoo declined an approval request itself because a value was too long to show in full; title is the request."
  },
  "agent.notices.kept-approval": {
    "message": "Not done yet: {title}. {name} hears about your approval with your next message.",
    "description": "Chat transcript info line: you approved a proposal, but the follow-up turn could not start (for example the app quit). title is the proposal, name the agent."
  },
  "agent.notices.new-session": {
    "message": "{name} started a new session",
    "description": "Chat panel info line (agent/panel.js localizeNotice): Claude Code or Hermes no longer had this chat's session, so it started a new one (claude.js ClaudeAdapter.turn, hermes.js HermesAdapter.session). Rukoo sends that session the email and a recap of the chat. name is the agent name."
  },
  "agent.notices.new-thread": {
    "message": "{name} started a new thread",
    "description": "Chat panel info line (agent/panel.js localizeNotice): Codex could not reopen this chat's thread, so it started a new one (codex.js CodexAdapter.ensureThread). Rukoo sends that thread the email and a recap of the chat. name is the agent name."
  },
  "agent.errors.window": {
    "message": "Rukoo's main window is closed.",
    "description": "Chat panel error: an agent needed the main window, which was closed."
  },
  "agent.items.approved": {
    "message": "Approved",
    "description": "Chat transcript approval card: state after you approved."
  },
  "agent.items.denied": {
    "message": "Declined",
    "description": "Chat transcript approval card: state after you declined or denied."
  },
  "agent.items.emailSource": {
    "message": "Email",
    "description": "Chat transcript: label on a source card that points to an email in Rukoo."
  },
  "agent.items.plan": {
    "message": "Plan",
    "description": "Chat transcript: heading of a plan card when the agent gave it no title."
  },
  "agent.items.sources": {
    "message": "Sources",
    "description": "Chat transcript: heading of the sources card when the agent gave it no title."
  },
  "agent.items.expired": {
    "message": "Expired",
    "description": "Chat transcript approval card: the request ended before you answered."
  },
  "agent.items.thinking": {
    "message": "Thinking",
    "description": "Chat transcript: shimmering label while the agent reasons."
  },
  "agent.items.thoughtFor": {
    "message": "Thought for {count}s",
    "description": "Chat transcript: label after the agent reasoned; count is seconds."
  },
  "agent.items.waiting": {
    "message": "Waiting for you",
    "description": "Chat transcript approval card: state while the agent waits for your answer."
  },
  "agent.items.working": {
    "message": "{name} is working on it...",
    "description": "Chat transcript: shown after you send a message, before the agent responds."
  },
  "agent.items.youApproved": {
    "message": "You approved",
    "description": "Chat transcript: compact line before the title of something you approved."
  },
  "agent.items.youDeclined": {
    "message": "You declined",
    "description": "Chat transcript: compact line before the title of something you declined."
  },
  "agent.mail.unsubscribeEmailMany": {
    "message": "Opened {count} unsubscribe emails. Send them to finish.",
    "description": "Chat transcript notice: senders only offer unsubscribing by email, so Rukoo opened that many prepared emails for you to send."
  },
  "agent.mail.unsubscribeEmailOne": {
    "message": "Opened an unsubscribe email to {address}. Send it to finish.",
    "description": "Chat transcript notice: the sender only offers unsubscribing by email; Rukoo opened a prepared email to address for you to send."
  },
  "agent.mail.unsubscribePageMany": {
    "message": "Opened {count} unsubscribe pages in your browser. Finish there; Rukoo Mail can't tell whether they worked.",
    "description": "Chat transcript notice: the senders' unsubscribe links are web pages, so Rukoo opened that many in the browser; the user may still have to confirm on each."
  },
  "agent.mail.unsubscribePageOne": {
    "message": "Opened the unsubscribe page for {name} in your browser. Finish there; Rukoo Mail can't tell whether it worked.",
    "description": "Chat transcript notice: the sender's unsubscribe link is a web page, so Rukoo opened it in the browser; the user may still have to confirm there. name is the sender's name or address."
  },
  "agent.mail.archive": {
    "message": { "one": "Archived {count} email", "other": "Archived {count} emails" },
    "description": "Chat transcript notice after Rukoo archived mail for an agent; count is the number of emails."
  },
  "agent.mail.mark_read": {
    "message": { "one": "Marked {count} email as read", "other": "Marked {count} emails as read" },
    "description": "Chat transcript notice after Rukoo marked mail as read for an agent."
  },
  "agent.mail.mark_unread": {
    "message": { "one": "Marked {count} email as unread", "other": "Marked {count} emails as unread" },
    "description": "Chat transcript notice after Rukoo marked mail as unread for an agent."
  },
  "agent.mail.move": {
    "message": { "one": "Moved {count} email to {folder}", "other": "Moved {count} emails to {folder}" },
    "description": "Chat transcript notice after Rukoo moved mail for an agent; folder is the folder path."
  },
  "agent.mail.star": {
    "message": { "one": "Starred {count} email", "other": "Starred {count} emails" },
    "description": "Chat transcript notice after Rukoo added a star to mail for an agent."
  },
  "agent.mail.trash": {
    "message": { "one": "Moved {count} email to Trash", "other": "Moved {count} emails to Trash" },
    "description": "Chat transcript notice after Rukoo deleted mail for an agent (moved to the trash)."
  },
  "agent.mail.undo": {
    "message": { "one": "Put {count} email back", "other": "Put {count} emails back" },
    "description": "Chat transcript notice after you undid a mail action from the chat."
  },
  "agent.mail.unstar": {
    "message": { "one": "Removed the star from {count} email", "other": "Removed the star from {count} emails" },
    "description": "Chat transcript notice after Rukoo removed stars for an agent."
  },
  "agent.panel.addContext": {
    "message": "Add this email",
    "description": "Chat panel input: dashed chip in the email chip's place after you left the email out of a new chat; clicking it puts the email back (contextChip and attach in agent/panel.js)."
  },
  "agent.panel.close": {
    "message": "Close chat",
    "description": "Chat panel header: tooltip of the button that closes the panel."
  },
  "agent.panel.continueChat": {
    "message": "Continue the chat about the earlier message",
    "description": "Chat panel empty state: quiet row under the quick actions when the open email has no chat but an earlier email in its thread has one; the agent and the chat's date are under it (renderEmpty and continueChat in agent/panel.js)."
  },
  "agent.panel.history": {
    "message": "Recent chats",
    "description": "Chat panel header: tooltip of the clock button that lists earlier conversations."
  },
  "agent.panel.jump": {
    "message": "Go to the latest message",
    "description": "Chat panel: tooltip of the arrow that scrolls back down after you scrolled up."
  },
  "agent.panel.label": {
    "message": "Agent chat",
    "description": "Chat panel: accessible name of the side panel where you chat with an agent."
  },
  "agent.panel.needsEmail": {
    "message": "Open an email first.",
    "description": "Chat panel toast: an email quick action was picked while no email is attached."
  },
  "agent.panel.skillMissing": {
    "message": "Rukoo can't find the skill /{name} anymore.",
    "description": "Chat panel toast (panel.js send): you picked a skill from the slash command menu, but its folder is gone or no longer valid. name is the skill name."
  },
  "agent.panel.needsYou": {
    "message": "An agent is waiting for your approval",
    "description": "Toast when an agent asks for approval in a chat that is not on screen."
  },
  "agent.panel.draftBlocked": {
    "message": "{name} has a draft for you. Finish or close the email you're writing first.",
    "description": "Toast when a chat that is not on screen wants to write a draft while you are writing another email. name: agent name."
  },
  "agent.panel.new": {
    "message": "New chat",
    "description": "Chat panel header: tooltip of the plus button that starts a new conversation."
  },
  "agent.panel.newChat": {
    "message": "New chat",
    "description": "Chat panel header: title line for a conversation without a title yet, and history fallback."
  },
  "agent.panel.newerMessage": {
    "message": "Newer message",
    "description": "Chat panel input: grey text in the second email chip, next to the subject of the newer email you continued an earlier chat from, while that email is open (contextChip in agent/panel.js)."
  },
  "agent.panel.newerPending": {
    "message": "You continued this chat from this newer message. It goes to {name} with your next message.",
    "description": "Chat panel input: tooltip of Newer message in the second email chip, before the agent has had that email; name is the agent (contextChip in agent/panel.js)."
  },
  "agent.panel.newerSent": {
    "message": "You continued this chat from this newer message. {name} has it.",
    "description": "Chat panel input: tooltip of Newer message in the second email chip, once a message took that email to the agent; name is the agent (contextChip in agent/panel.js)."
  },
  "agent.panel.noHistory": {
    "message": "No chats yet",
    "description": "Chat panel history menu: shown when there are no earlier conversations."
  },
  "agent.panel.noMatches": {
    "message": "No matching commands",
    "description": "Chat panel slash command menu: shown when no command matches what you typed."
  },
  "agent.panel.pickAgent": {
    "message": "Choose agent",
    "description": "Chat panel input: label of the agent picker (Hermes, Claude Code, Codex)."
  },
  "agent.panel.placeholder": {
    "message": "Ask {name}...",
    "description": "Chat panel input placeholder without an email; name is the agent name."
  },
  "agent.panel.placeholderEmail": {
    "message": "Ask {name} about this email...",
    "description": "Chat panel input placeholder while an email is attached; name is the agent name."
  },
  "agent.panel.removeContext": {
    "message": "Leave this email out",
    "description": "Chat panel input: tooltip of the x on the email chip of a chat that has not started yet; the chat then starts without the email (contextChip and detach in agent/panel.js)."
  },
  "agent.panel.send": {
    "message": "Send",
    "description": "Chat panel input: label of the button that sends your chat message (not an email)."
  },
  "agent.panel.setUp": {
    "message": "Set up {name}",
    "description": "Chat panel: link-style button that opens Settings, Agents; name is the agent name."
  },
  "agent.panel.show": {
    "message": "Show",
    "description": "Toast action that opens the chat with the waiting approval."
  },
  "agent.panel.sourceGone": {
    "message": "That email is no longer in Rukoo. It may have been deleted, or moved to a folder Rukoo has not downloaded.",
    "description": "Chat panel toast: you clicked a source card for an email that Rukoo can no longer find."
  },
  "agent.panel.stop": {
    "message": "Stop",
    "description": "Chat panel input: label of the button that stops the agent while it works."
  },
  "agent.panel.toggle": {
    "message": "Chat with an agent (Ctrl+J)",
    "description": "Title bar button tooltip that opens or closes the chat panel."
  },
  "agent.panel.transcript": {
    "message": "Conversation",
    "description": "Chat panel: accessible name of the list of messages in the conversation."
  },
  "agent.panel.width": {
    "message": "Chat panel width",
    "description": "Chat panel: accessible name of the divider that resizes the panel."
  },
  "agent.plan.done": {
    "message": "Done",
    "description": "Chat transcript plan rows: status of a finished step."
  },
  "agent.plan.failed": {
    "message": "Failed",
    "description": "Chat transcript plan rows: status of a step that did not work."
  },
  "agent.plan.proposed": {
    "message": "Proposed",
    "description": "Chat transcript plan rows: status of a proposed step."
  },
  "agent.plan.running": {
    "message": "In progress",
    "description": "Chat transcript plan rows: status of a step the agent is working on."
  },
  "agent.plan.skipped": {
    "message": "Skipped",
    "description": "Chat transcript plan rows: status of a step the agent skipped."
  },
  "agent.plan.todo": {
    "message": "To do",
    "description": "Chat transcript plan rows: status of a step that is planned."
  },
  "agent.setup.disabled": {
    "message": "{name} is turned off.",
    "description": "Chat panel, above the disabled input: the agent is switched off in Settings."
  },
  "agent.setup.missing": {
    "message": "{name} isn't installed on this computer.",
    "description": "Chat panel, above the disabled input: the agent program was not found."
  },
  "agent.setup.unauthorized": {
    "message": "{name} didn't accept the API key.",
    "description": "Chat panel, above the disabled input: the agent rejected the key."
  },
  "agent.setup.unconfigured": {
    "message": "{name} isn't set up yet.",
    "description": "Chat panel, above the disabled input: the agent needs an address or key; name is the agent."
  },
  "agent.status.disabled": {
    "message": "Turned off",
    "description": "Chat panel and Settings: agent status when it is switched off in Settings."
  },
  "agent.status.missing": {
    "message": "Not installed",
    "description": "Chat panel and Settings: agent status when its program is not found on this computer."
  },
  "agent.status.offline": {
    "message": "Can't be reached",
    "description": "Chat panel and Settings: agent status when its server or program does not answer."
  },
  "agent.status.ready": {
    "message": "Ready",
    "description": "Chat panel and Settings: agent status when it can take a message."
  },
  "agent.status.starting": {
    "message": "Starting...",
    "description": "Chat panel and Settings: agent status while Rukoo connects to the agents."
  },
  "agent.status.unauthorized": {
    "message": "Key not accepted",
    "description": "Chat panel and Settings: agent status when the agent rejects the API key or token."
  },
  "agent.status.unavailable": {
    "message": "Agents aren't available",
    "description": "Chat panel header and input: shown when this build has no agent support."
  },
  "agent.status.unconfigured": {
    "message": "Not set up",
    "description": "Chat panel and Settings: agent status when the address or key is missing."
  },
  "agent.status.unknown": {
    "message": "Status unknown",
    "description": "Chat panel and Settings: agent status when Rukoo cannot tell."
  },
  "agent.tools.generic.command": {
    "message": "Ran a command",
    "description": "Chat transcript tool chip: the agent ran a shell or terminal command."
  },
  "agent.tools.generic.code": {
    "message": "Ran code",
    "description": "Chat transcript tool chip: the agent ran a piece of code."
  },
  "agent.tools.generic.webSearch": {
    "message": "Searched the web",
    "description": "Chat transcript tool chip: the agent ran a web search."
  },
  "agent.tools.generic.webPage": {
    "message": "Opened a web page",
    "description": "Chat transcript tool chip: the agent fetched or read a web page."
  },
  "agent.tools.generic.browser": {
    "message": "Used the browser",
    "description": "Chat transcript tool chip: the agent clicked or navigated in a browser."
  },
  "agent.tools.generic.readFile": {
    "message": "Read a file",
    "description": "Chat transcript tool chip: the agent read a file on its own machine."
  },
  "agent.tools.generic.changeFiles": {
    "message": "Changed files",
    "description": "Chat transcript tool chip: the agent wrote or edited files."
  },
  "agent.tools.generic.subagent": {
    "message": "Ran a subagent",
    "description": "Chat transcript tool chip: the agent handed part of the work to a helper agent."
  },
  "agent.tools.generic.findFiles": {
    "message": "Looked through files",
    "description": "Chat transcript tool chip: the agent searched or listed files."
  },
  "agent.tools.generic.todo": {
    "message": "Updated its to-do list",
    "description": "Chat transcript tool chip: the agent updated its own internal to-do list."
  },
  "agent.tools.generic.lookupTools": {
    "message": "Looked up its tools",
    "description": "Chat transcript tool chip: the agent looked up which tools it has."
  },
  "agent.tools.generic.memory": {
    "message": "Checked its memory",
    "description": "Chat transcript tool chip: the agent read or searched its long-term memory."
  },
  "agent.tools.generic.skill": {
    "message": "Read a skill",
    "description": "Chat transcript tool chip: the agent read one of its skills (instructions it keeps)."
  },
  "agent.tools.generic.pastChats": {
    "message": "Searched past chats",
    "description": "Chat transcript tool chip: the agent searched its earlier conversations."
  },
  "agent.tools.generic.schedule": {
    "message": "Scheduled a job",
    "description": "Chat transcript tool chip: the agent created or changed a scheduled job."
  },
  "agent.tools.generic.sendMessage": {
    "message": "Sent a message",
    "description": "Chat transcript tool chip: the agent sent a message on another channel such as WhatsApp or Slack."
  },
  "agent.tools.generic.image": {
    "message": "Made an image",
    "description": "Chat transcript tool chip: the agent generated an image."
  },
  "agent.tools.generic.vision": {
    "message": "Looked at an image",
    "description": "Chat transcript tool chip: the agent analysed an image."
  },
  "agent.tools.get_context": {
    "message": "Looked at your screen",
    "description": "Chat transcript tool chip: the agent read what Rukoo shows (open email, selection, draft)."
  },
  "agent.tools.get_draft": {
    "message": "Checked the draft",
    "description": "Chat transcript tool chip: the agent read the composer."
  },
  "agent.tools.mail_action": {
    "message": "Proposed a mail action",
    "description": "Chat transcript tool chip: the agent asked Rukoo to archive, move or mark mail."
  },
  "agent.tools.propose_action": {
    "message": "Asked for approval",
    "description": "Chat transcript tool chip: the agent proposed an action and waits for you."
  },
  "agent.tools.read_attachment": {
    "message": "Read an attachment",
    "description": "Chat transcript tool chip: the agent opened an attachment."
  },
  "agent.tools.read_skill": {
    "message": "Read a skill",
    "description": "Chat transcript tool chip (panel.js toolProps): the agent read one of Rukoo's skills with read_skill."
  },
  "agent.tools.read_message": {
    "message": "Read an email",
    "description": "Chat transcript tool chip: the agent read a full email."
  },
  "agent.tools.search_mail": {
    "message": "Searched your mail",
    "description": "Chat transcript tool chip: the agent searched your mailboxes."
  },
  "agent.tools.show_plan": {
    "message": "Made a plan",
    "description": "Chat transcript tool chip: the agent showed a plan of steps."
  },
  "agent.tools.show_sources": {
    "message": "Gathered sources",
    "description": "Chat transcript tool chip: the agent showed the sources it used."
  },
  "agent.tools.unknown": {
    "message": "Used a tool",
    "description": "Chat transcript tool chip: fallback when the tool has no name."
  },
  "agent.tools.write_draft": {
    "message": "Wrote the draft",
    "description": "Chat transcript tool chip: the agent wrote into the composer."
  },
  "agent.tools.running.get_context": {
    "message": "Looking at your screen...",
    "description": "Chat transcript tool chip while it runs: the agent reads what is on screen. Present tense; the done form is agent.tools.get_context."
  },
  "agent.tools.running.get_draft": {
    "message": "Checking the draft...",
    "description": "Chat transcript tool chip while it runs: the agent reads the composer. Present tense; the done form is agent.tools.get_draft."
  },
  "agent.tools.running.mail_action": {
    "message": "Proposing a mail action...",
    "description": "Chat transcript tool chip while it runs: the agent asks to archive, move or mark mail. Present tense; the done form is agent.tools.mail_action."
  },
  "agent.tools.running.propose_action": {
    "message": "Asking for approval...",
    "description": "Chat transcript tool chip while it runs: the agent proposes an action. Present tense; the done form is agent.tools.propose_action."
  },
  "agent.tools.running.read_attachment": {
    "message": "Reading an attachment...",
    "description": "Chat transcript tool chip while it runs: the agent reads an attachment. Present tense; the done form is agent.tools.read_attachment."
  },
  "agent.tools.running.read_skill": {
    "message": "Reading a skill...",
    "description": "Chat transcript tool chip while it runs (panel.js toolProps): the agent reads one of Rukoo's skills. Present tense; the done form is agent.tools.read_skill."
  },
  "agent.tools.running.read_message": {
    "message": "Reading an email...",
    "description": "Chat transcript tool chip while it runs: the agent reads an email. Present tense; the done form is agent.tools.read_message."
  },
  "agent.tools.running.search_mail": {
    "message": "Searching your mail...",
    "description": "Chat transcript tool chip while it runs: the agent searches your mail. Present tense; the done form is agent.tools.search_mail."
  },
  "agent.tools.running.show_plan": {
    "message": "Making a plan...",
    "description": "Chat transcript tool chip while it runs: the agent shows a plan. Present tense; the done form is agent.tools.show_plan."
  },
  "agent.tools.running.show_sources": {
    "message": "Gathering sources...",
    "description": "Chat transcript tool chip while it runs: the agent shows its sources. Present tense; the done form is agent.tools.show_sources."
  },
  "agent.tools.running.unknown": {
    "message": "Using a tool...",
    "description": "Chat transcript tool chip while it runs: a tool without a name. Present tense; the done form is agent.tools.unknown."
  },
  "agent.tools.running.write_draft": {
    "message": "Writing the draft...",
    "description": "Chat transcript tool chip while it runs: the agent writes into the composer. Present tense; the done form is agent.tools.write_draft."
  },
  "agent.tools.running.generic.command": {
    "message": "Running a command...",
    "description": "Chat transcript tool chip while the agent's own tool runs: a shell command. Present tense; the done form is agent.tools.generic.command."
  },
  "agent.tools.running.generic.code": {
    "message": "Running code...",
    "description": "Chat transcript tool chip while the agent's own tool runs: code execution. Present tense; the done form is agent.tools.generic.code."
  },
  "agent.tools.running.generic.webSearch": {
    "message": "Searching the web...",
    "description": "Chat transcript tool chip while the agent's own tool runs: a web search. Present tense; the done form is agent.tools.generic.webSearch."
  },
  "agent.tools.running.generic.webPage": {
    "message": "Opening a web page...",
    "description": "Chat transcript tool chip while the agent's own tool runs: fetching a web page. Present tense; the done form is agent.tools.generic.webPage."
  },
  "agent.tools.running.generic.browser": {
    "message": "Using the browser...",
    "description": "Chat transcript tool chip while the agent's own tool runs: browser automation. Present tense; the done form is agent.tools.generic.browser."
  },
  "agent.tools.running.generic.readFile": {
    "message": "Reading a file...",
    "description": "Chat transcript tool chip while the agent's own tool runs: reading a file. Present tense; the done form is agent.tools.generic.readFile."
  },
  "agent.tools.running.generic.changeFiles": {
    "message": "Changing files...",
    "description": "Chat transcript tool chip while the agent's own tool runs: writing or editing files. Present tense; the done form is agent.tools.generic.changeFiles."
  },
  "agent.tools.running.generic.subagent": {
    "message": "Running a subagent...",
    "description": "Chat transcript tool chip while the agent's own tool runs: a subagent. Present tense; the done form is agent.tools.generic.subagent."
  },
  "agent.tools.running.generic.findFiles": {
    "message": "Looking through files...",
    "description": "Chat transcript tool chip while the agent's own tool runs: a file search. Present tense; the done form is agent.tools.generic.findFiles."
  },
  "agent.tools.running.generic.todo": {
    "message": "Updating its to-do list...",
    "description": "Chat transcript tool chip while the agent's own tool runs: the agent's own to-do list. Present tense; the done form is agent.tools.generic.todo."
  },
  "agent.tools.running.generic.lookupTools": {
    "message": "Looking up its tools...",
    "description": "Chat transcript tool chip while the agent's own tool runs: the agent looks up which tools it has. Present tense; the done form is agent.tools.generic.lookupTools."
  },
  "agent.tools.running.generic.memory": {
    "message": "Checking its memory...",
    "description": "Chat transcript tool chip while the agent's own tool runs: the agent's memory. Present tense; the done form is agent.tools.generic.memory."
  },
  "agent.tools.running.generic.skill": {
    "message": "Reading a skill...",
    "description": "Chat transcript tool chip while the agent's own tool runs: the agent reads one of its skills. Present tense; the done form is agent.tools.generic.skill."
  },
  "agent.tools.running.generic.pastChats": {
    "message": "Searching past chats...",
    "description": "Chat transcript tool chip while the agent's own tool runs: the agent searches its past conversations. Present tense; the done form is agent.tools.generic.pastChats."
  },
  "agent.tools.running.generic.schedule": {
    "message": "Scheduling a job...",
    "description": "Chat transcript tool chip while the agent's own tool runs: a scheduled job. Present tense; the done form is agent.tools.generic.schedule."
  },
  "agent.tools.running.generic.sendMessage": {
    "message": "Sending a message...",
    "description": "Chat transcript tool chip while the agent's own tool runs: a message to another channel. Present tense; the done form is agent.tools.generic.sendMessage."
  },
  "agent.tools.running.generic.image": {
    "message": "Making an image...",
    "description": "Chat transcript tool chip while the agent's own tool runs: image generation. Present tense; the done form is agent.tools.generic.image."
  },
  "agent.tools.running.generic.vision": {
    "message": "Looking at an image...",
    "description": "Chat transcript tool chip while the agent's own tool runs: image analysis. Present tense; the done form is agent.tools.generic.vision."
  },
  "common.actions.add": {
    "message": "Add",
    "description": "common > actions. src/renderer/app.js (messageMenu); src/renderer/settings.js (render)"
  },
  "common.actions.archive": {
    "message": "Archive",
    "description": "common > actions. src/renderer/app.js (renderListTools); src/renderer/app.js (bulkMenu); src/renderer/app.js (messageMenu); src/renderer/app.js (readerBar); src/renderer/app.js (renderReader)"
  },
  "common.actions.back": {
    "message": "Back",
    "description": "common > actions. src/renderer/settings.js (render); src/renderer/setup.js (showGrid); src/renderer/setup.js (showGoogle); src/renderer/setup.js (showLogin)"
  },
  "common.actions.cancel": {
    "message": "Cancel",
    "description": "common > actions. src/renderer/settings.js (promptDialog); src/renderer/settings.js (openSettings); src/renderer/setup.js (showGoogle); src/renderer/composer.js (insertLink); src/renderer/composer.js (close); src/renderer/ui.js (confirmDialog); src/renderer/ui.js (choiceDialog); src/main/main.js"
  },
  "common.actions.clear": {
    "message": "Clear",
    "description": "common > actions. src/renderer/app.js (renderListHead); src/renderer/app.js (itemHtml)"
  },
  "common.actions.close": {
    "message": "Close",
    "description": "common > actions. src/renderer/compose.js (init)"
  },
  "common.actions.delete": {
    "message": "Delete",
    "description": "common > actions. src/renderer/app.js (removeMessages); src/renderer/app.js (messageMenu); src/renderer/app.js (renderReader); src/renderer/settings.js (openSettings); src/renderer/composer.js (recipientsHtml); src/renderer/composer.js (mountComposer); src/renderer/composer.js (discard)"
  },
  "common.actions.moreOptions": {
    "message": "More options",
    "description": "common > actions. src/renderer/app.js (renderListHead); src/renderer/composer.js (template)"
  },
  "common.actions.move": {
    "message": "Move",
    "description": "common > actions. src/renderer/app.js (renderReader)"
  },
  "common.actions.ok": {
    "message": "OK",
    "description": "common > actions. src/renderer/ui.js (dialog); src/renderer/ui.js (confirmDialog)"
  },
  "common.actions.save": {
    "message": "Save",
    "description": "common > actions. src/renderer/app.js (attachmentsHtml); src/renderer/settings.js (promptDialog); src/renderer/settings.js (render); src/renderer/settings.js (openSettings); src/renderer/composer.js (close)"
  },
  "common.actions.undo": {
    "message": "Undo",
    "description": "common > actions. src/renderer/app.js (offerUndo)"
  },
  "common.dates.today": {
    "message": "Today",
    "description": "common > dates. src/renderer/ui.js (groupLabel)"
  },
  "common.dates.yesterday": {
    "message": "Yesterday",
    "description": "common > dates. src/renderer/ui.js (groupLabel)"
  },
  "common.errors.invalidEmail": {
    "message": "Invalid email address",
    "description": "common > errors. src/renderer/settings.js (openSettings)"
  },
  "common.errors.invalidEmailValue": {
    "message": "Invalid email address: {address}",
    "description": "common > errors. src/renderer/composer.js (send); src/main/engine.js"
  },
  "common.status.saving": {
    "message": "Saving...",
    "description": "Progress status while a draft save is running, shown by src/renderer/composer.js (describeSaved). Separate from the Save action in native file dialogs."
  },
  "common.values.none": {
    "message": "None",
    "description": "common > values. src/renderer/settings.js; src/renderer/settings.js (render)"
  },
  "common.values.noneLower": {
    "message": "none",
    "description": "common > values. Account signature value when no general signature is configured."
  },
  "composer.actions.addBcc": {
    "message": "Add Bcc",
    "description": "composer > actions. src/renderer/composer.js (mountComposer)"
  },
  "composer.actions.addCc": {
    "message": "Add Cc",
    "description": "composer > actions. src/renderer/composer.js (mountComposer)"
  },
  "composer.actions.closeShortcut": {
    "message": "Close (Esc)",
    "description": "composer > actions. src/renderer/composer.js (template)"
  },
  "composer.actions.discard": {
    "message": "Delete draft",
    "description": "composer > actions. src/renderer/composer.js (template); src/renderer/composer.js (mountComposer); src/renderer/composer.js (close)"
  },
  "composer.actions.editDraft": {
    "message": "Edit draft",
    "description": "composer > actions. src/renderer/app.js (messageMenu)"
  },
  "composer.actions.popout": {
    "message": "Open in a separate window",
    "description": "composer > actions. src/renderer/composer.js (template); src/renderer/composer.js (mountComposer)"
  },
  "composer.actions.saveDraft": {
    "message": "Save to Drafts",
    "description": "composer > actions. src/renderer/composer.js (mountComposer)"
  },
  "composer.actions.send": {
    "message": "Send",
    "description": "composer > actions. src/renderer/composer.js (template); src/renderer/composer.js (send)"
  },
  "composer.actions.sendShortcut": {
    "message": "Send (Ctrl+Enter)",
    "description": "composer > actions. src/renderer/composer.js (template)"
  },
  "composer.agent.drafted": {
    "message": "Drafted by {name}",
    "description": "Composer bar mark after an agent wrote the draft; name is the agent."
  },
  "composer.agent.draftedEdited": {
    "message": "Drafted by {name} · edited",
    "description": "Composer bar mark after an agent wrote the draft and you changed it."
  },
  "composer.agent.someone": {
    "message": "an agent",
    "description": "Composer bar mark: fallback when the agent has no name (\"Drafted by an agent\")."
  },
  "composer.agent.undo": {
    "message": "Undo",
    "description": "Composer bar link that restores what was there before the agent's draft."
  },
  "composer.agent.undoHelp": {
    "message": "Your own changes since then are undone too.",
    "description": "Composer confirmation text when undoing an agent draft you already edited."
  },
  "composer.agent.undoTitle": {
    "message": "Undo {name}'s draft?",
    "description": "Composer confirmation title when undoing an agent draft you already edited."
  },
  "composer.attachments.image": {
    "message": "Insert image",
    "description": "composer > attachments. src/renderer/composer.js (template); src/main/main.js"
  },
  "composer.attachments.pick": {
    "message": "Attach files",
    "description": "composer > attachments. src/renderer/composer.js (template); src/main/main.js"
  },
  "composer.body.label": {
    "message": "Message body",
    "description": "composer > body. src/renderer/composer.js (template)"
  },
  "composer.body.placeholder": {
    "message": "Write your message",
    "description": "composer > body. src/renderer/composer.js (template)"
  },
  "composer.close.discard": {
    "message": "Don't save",
    "description": "composer > close. src/renderer/composer.js (close)"
  },
  "composer.close.help": {
    "message": "Save this message to Drafts to continue writing later.",
    "description": "composer > close. src/renderer/composer.js (close)"
  },
  "composer.close.title": {
    "message": "Save draft?",
    "description": "composer > close. src/renderer/composer.js (close)"
  },
  "composer.discard.savedHelp": {
    "message": "This draft will also be removed from Drafts.",
    "description": "composer > discard. src/renderer/composer.js (discard)"
  },
  "composer.discard.title": {
    "message": "Delete draft?",
    "description": "composer > discard. src/renderer/composer.js (discard)"
  },
  "composer.discard.unsavedHelp": {
    "message": "What you have written will be lost.",
    "description": "composer > discard. src/renderer/composer.js (discard)"
  },
  "composer.errors.autosave": {
    "message": "Autosave failed",
    "description": "composer > errors. src/renderer/composer.js (saveDraft)"
  },
  "composer.errors.missingAttachments": {
    "message": "The draft is in Drafts, but its attachments could not be found. Close this window and reopen the draft.",
    "description": "composer > errors. src/renderer/composer.js (settleAttachments)"
  },
  "composer.errors.noRecipients": {
    "message": "Add at least one recipient",
    "description": "composer > errors. src/renderer/composer.js (send)"
  },
  "composer.errors.send": {
    "message": "Sending failed",
    "description": "composer > errors. src/renderer/composer.js (send)"
  },
  "composer.format.bold": {
    "message": "Bold (Ctrl+B)",
    "description": "composer > format. src/renderer/composer.js"
  },
  "composer.format.bullets": {
    "message": "Bulleted list",
    "description": "composer > format. src/renderer/composer.js"
  },
  "composer.format.clear": {
    "message": "Clear formatting",
    "description": "composer > format. src/renderer/composer.js (template)"
  },
  "composer.format.highlight": {
    "message": "Highlight",
    "description": "composer > format. src/renderer/composer.js (template)"
  },
  "composer.format.indent": {
    "message": "Increase indent",
    "description": "composer > format. src/renderer/composer.js (template)"
  },
  "composer.format.italic": {
    "message": "Italic (Ctrl+I)",
    "description": "composer > format. src/renderer/composer.js"
  },
  "composer.format.label": {
    "message": "Formatting",
    "description": "composer > format. src/renderer/composer.js (template)"
  },
  "composer.format.link": {
    "message": "Link (Ctrl+K)",
    "description": "composer > format. src/renderer/composer.js"
  },
  "composer.format.numbered": {
    "message": "Numbered list",
    "description": "composer > format. src/renderer/composer.js"
  },
  "composer.format.outdent": {
    "message": "Decrease indent",
    "description": "composer > format. src/renderer/composer.js (template)"
  },
  "composer.format.textColor": {
    "message": "Text color",
    "description": "composer > format. src/renderer/composer.js (template)"
  },
  "composer.format.underline": {
    "message": "Underline (Ctrl+U)",
    "description": "composer > format. src/renderer/composer.js"
  },
  "composer.link.address": {
    "message": "Address",
    "description": "composer > link. src/renderer/composer.js (insertLink)"
  },
  "composer.link.insert": {
    "message": "Insert",
    "description": "composer > link. src/renderer/composer.js (insertLink)"
  },
  "composer.link.title": {
    "message": "Insert link",
    "description": "composer > link. src/renderer/composer.js (insertLink)"
  },
  "composer.quote.date": {
    "message": "Date: {date}",
    "description": "composer > quote. src/renderer/composer.js (quoteHeader)"
  },
  "composer.quote.exclude": {
    "message": "Exclude from message",
    "description": "composer > quote. src/renderer/composer.js (template); src/renderer/composer.js (mountComposer)"
  },
  "composer.quote.from": {
    "message": "From: {sender}",
    "description": "composer > quote. src/renderer/composer.js (quoteHeader)"
  },
  "composer.quote.hide": {
    "message": "Hide previous messages",
    "description": "composer > quote. src/renderer/composer.js (mountComposer)"
  },
  "composer.quote.include": {
    "message": "Include in message",
    "description": "composer > quote. src/renderer/composer.js (mountComposer)"
  },
  "composer.quote.marker": {
    "message": "-------- Original message --------",
    "description": "composer > quote. Header inserted above quoted email when replying or forwarding."
  },
  "composer.quote.show": {
    "message": "Show previous messages",
    "description": "composer > quote. src/renderer/composer.js (template); src/renderer/composer.js (mountComposer)"
  },
  "composer.quote.subject": {
    "message": "Subject: {subject}",
    "description": "composer > quote. src/renderer/composer.js (quoteHeader)"
  },
  "composer.quote.title": {
    "message": "Previous message",
    "description": "composer > quote. src/renderer/composer.js (template)"
  },
  "composer.quote.to": {
    "message": "To: {recipients}",
    "description": "composer > quote. src/renderer/composer.js (quoteHeader)"
  },
  "composer.send.noSubjectHelp": {
    "message": "Send this email without a subject?",
    "description": "composer > send. src/renderer/composer.js (send)"
  },
  "composer.send.noSubjectTitle": {
    "message": "No subject",
    "description": "composer > send. src/renderer/composer.js (send)"
  },
  "composer.status.deleted": {
    "message": "Draft deleted",
    "description": "composer > status. src/renderer/composer.js (discard); src/renderer/composer.js (close)"
  },
  "composer.status.kept": {
    "message": "Draft kept in Drafts",
    "description": "composer > status. src/renderer/composer.js (close); src/renderer/composer.js (leave); src/renderer/composer.js (mountComposer)"
  },
  "composer.status.saved": {
    "message": "Draft saved",
    "description": "composer > status. src/renderer/composer.js (mountComposer)"
  },
  "composer.status.savedAt": {
    "message": "Saved at {time}",
    "description": "composer > status. src/renderer/composer.js (mountComposer)"
  },
  "composer.status.savedClosed": {
    "message": "Draft saved to Drafts",
    "description": "composer > status. src/renderer/composer.js (leave)"
  },
  "composer.status.savedToDrafts": {
    "message": "Saved to Drafts",
    "description": "composer > status. src/renderer/composer.js (saveDraft); src/renderer/composer.js (close)"
  },
  "composer.status.sending": {
    "message": "Sending...",
    "description": "composer > status. src/renderer/composer.js (send)"
  },
  "composer.status.sent": {
    "message": "Email sent",
    "description": "composer > status. src/renderer/composer.js (send); src/main/main.js"
  },
  "composer.titles.draft": {
    "message": "Draft",
    "description": "composer > titles. src/renderer/app.js (itemHtml); src/renderer/app.js (renderReader); src/renderer/composer.js"
  },
  "composer.titles.forward": {
    "message": "Forward",
    "description": "composer > titles. src/renderer/app.js (messageMenu); src/renderer/composer.js"
  },
  "composer.titles.new": {
    "message": "New message",
    "description": "composer > titles. src/renderer/app.js (renderSidebar); src/renderer/app.js (personMenu); src/renderer/composer.js; src/renderer/composer.js (template); src/renderer/composer.js (mountComposer); src/main/main.js (openComposeWindow)"
  },
  "composer.titles.newShortcut": {
    "message": "New message (Ctrl+N)",
    "description": "composer > titles. src/renderer/app.js (renderSidebar)"
  },
  "composer.titles.reply": {
    "message": "Reply",
    "description": "composer > titles. src/renderer/app.js (messageMenu); src/renderer/app.js (readerBar); src/renderer/composer.js"
  },
  "composer.titles.replyAll": {
    "message": "Reply all",
    "description": "composer > titles. src/renderer/app.js (messageMenu); src/renderer/composer.js"
  },
  "errors.account.duplicate": {
    "message": "This account has already been added.",
    "description": "errors > account. src/main/engine.js"
  },
  "errors.account.identity": {
    "message": "This address does not belong to this account.",
    "description": "errors > account. src/main/engine.js"
  },
  "errors.account.invalidEmail": {
    "message": "Enter a valid email address.",
    "description": "errors > account. src/main/engine.js"
  },
  "errors.account.missing": {
    "message": "Account not found.",
    "description": "errors > account. src/main/engine.js"
  },
  "errors.account.password": {
    "message": "Enter your password.",
    "description": "errors > account. src/main/engine.js"
  },
  "errors.attachment.missing": {
    "message": "Attachment not found.",
    "description": "errors > attachment. src/main/engine.js"
  },
  "errors.connection.auth": {
    "message": "Sign-in failed. Check your email address and password or app password.",
    "description": "errors > connection. src/main/imap.js (friendlyError)"
  },
  "errors.connection.certificate": {
    "message": "The server certificate is not trusted.",
    "description": "errors > connection. src/main/imap.js (friendlyError)"
  },
  "errors.connection.host": {
    "message": "Server not found. Check the server name.",
    "description": "errors > connection. src/main/imap.js (friendlyError)"
  },
  "errors.connection.refused": {
    "message": "Connection refused. Check the server and port.",
    "description": "errors > connection. src/main/imap.js (friendlyError)"
  },
  "errors.connection.timeout": {
    "message": "The connection to the server timed out.",
    "description": "errors > connection. src/main/imap.js (friendlyError)"
  },
  "errors.folder.duplicate": {
    "message": "A folder with that name already exists.",
    "description": "errors > folder. src/main/engine.js"
  },
  "errors.folder.invalidName": {
    "message": "A folder name cannot contain / \\ % or *.",
    "description": "errors > folder. src/main/engine.js"
  },
  "errors.folder.nameRequired": {
    "message": "Enter a folder name.",
    "description": "errors > folder. src/main/engine.js"
  },
  "errors.folder.noArchive": {
    "message": "This account has no archive folder.",
    "description": "errors > folder. src/main/engine.js"
  },
  "errors.folder.noDrafts": {
    "message": "This account has no Drafts folder.",
    "description": "errors > folder. src/main/engine.js"
  },
  "errors.folder.rebuilt": {
    "message": "The folder was rebuilt on the server.",
    "description": "errors > folder. src/main/imap.js"
  },
  "errors.google.aliases": {
    "message": "Gmail did not return aliases ({status}).",
    "description": "errors > google. src/main/engine.js"
  },
  "errors.google.aliasesAuth": {
    "message": "Only available for accounts using Google sign-in.",
    "description": "errors > google. src/main/engine.js"
  },
  "errors.google.cancelled": {
    "message": "Sign-in cancelled.",
    "description": "errors > google. src/main/google.js"
  },
  "errors.google.connection": {
    "message": "Cannot reach Google. Check your internet connection.",
    "description": "errors > google. src/main/google.js"
  },
  "errors.google.denied": {
    "message": "You did not grant access.",
    "description": "errors > google. src/main/google.js"
  },
  "errors.google.expired": {
    "message": "Your Google access has expired or been revoked. Sign in again through Settings.",
    "description": "errors > google. src/main/google.js"
  },
  "errors.google.invalidClient": {
    "message": "This file does not contain a Google OAuth client.",
    "description": "errors > google. src/main/google.js"
  },
  "errors.google.noEmail": {
    "message": "Google did not return an email address.",
    "description": "errors > google. src/main/google.js"
  },
  "errors.google.noRefreshToken": {
    "message": "Google did not return a refresh token. Try again.",
    "description": "errors > google. src/main/google.js"
  },
  "errors.google.notConfigured": {
    "message": "Google sign-in is not configured on this PC.",
    "description": "errors > google. src/main/google.js"
  },
  "errors.google.request": {
    "message": "Google rejected the request ({reason}).",
    "description": "errors > google. src/main/google.js"
  },
  "errors.google.scope": {
    "message": "Allow Rukoo Mail to access Gmail (select all permissions) and try again.",
    "description": "errors > google. src/main/google.js"
  },
  "errors.google.timeout": {
    "message": "Sign-in took too long. Try again.",
    "description": "errors > google. src/main/google.js"
  },
  "errors.google.unavailable": {
    "message": "Google sign-in is unavailable.",
    "description": "errors > google. src/main/engine.js"
  },
  "errors.google.unreachable": {
    "message": "Cannot reach Gmail.",
    "description": "errors > google. src/main/engine.js"
  },
  "errors.google.wrongAccount": {
    "message": "You signed in as {signedInEmail}, but this account is {accountEmail}.",
    "description": "errors > google. src/main/engine.js"
  },
  "errors.message.missing": {
    "message": "Message not found.",
    "description": "errors > message. src/main/engine.js"
  },
  "errors.message.savedMissing": {
    "message": "Saved email not found.",
    "description": "errors > message. src/main/engine.js"
  },
  "errors.message.serverMissing": {
    "message": "Message not found on the server.",
    "description": "errors > message. src/main/imap.js"
  },
  "errors.network.privateHost": {
    "message": "{hostname} is not a public address",
    "description": "errors > network. src/main/net.js (publicLookup)"
  },
  "errors.send.identity": {
    "message": "You cannot send as {address} from this account.",
    "description": "errors > send. src/main/engine.js"
  },
  "errors.send.noRecipients": {
    "message": "Add at least one recipient.",
    "description": "errors > send. src/main/engine.js"
  },
  "errors.undo.expired": {
    "message": "This action can no longer be undone.",
    "description": "errors > undo. src/main/engine.js"
  },
  "errors.undo.rebuilt": {
    "message": "This action can no longer be undone: the folder was rebuilt on the server.",
    "description": "errors > undo. src/main/engine.js"
  },
  "errors.unsubscribe.missing": {
    "message": "This email has no unsubscribe link.",
    "description": "errors > unsubscribe. src/main/main.js"
  },
  "mailbox.actions.addStar": {
    "message": "Add star",
    "description": "mailbox > actions. src/renderer/app.js (itemHtml); src/renderer/app.js (bulkMenu); src/renderer/app.js (messageMenu); src/renderer/app.js (renderReader)"
  },
  "mailbox.actions.alreadyRead": {
    "message": "All emails are already read",
    "description": "mailbox > actions. src/renderer/app.js (markAllRead)"
  },
  "mailbox.actions.compact": {
    "message": "Compact view",
    "description": "mailbox > actions. src/renderer/app.js (listAction)"
  },
  "mailbox.actions.deleteShortcut": {
    "message": "Delete (Delete)",
    "description": "mailbox > actions. src/renderer/app.js (renderListTools); src/renderer/app.js (readerBar)"
  },
  "mailbox.actions.markedUnread": {
    "message": "Marked as unread",
    "description": "mailbox > actions. src/renderer/app.js (bindReader)"
  },
  "mailbox.actions.moveMenu": {
    "message": "Move...",
    "description": "mailbox > actions. src/renderer/app.js (bulkMenu); src/renderer/app.js (messageMenu)"
  },
  "mailbox.actions.moveShortcut": {
    "message": "Move (Ctrl+Shift+V)",
    "description": "mailbox > actions. src/renderer/app.js (renderListTools); src/renderer/app.js (readerBar)"
  },
  "mailbox.actions.print": {
    "message": "Print",
    "description": "mailbox > actions. src/renderer/app.js (messageMenu)"
  },
  "mailbox.actions.read": {
    "message": "Mark as read",
    "description": "mailbox > actions. src/renderer/app.js (bulkMenu); src/renderer/app.js (messageMenu)"
  },
  "mailbox.actions.readAll": {
    "message": "Mark all as read",
    "description": "mailbox > actions. src/renderer/app.js (listAction)"
  },
  "mailbox.actions.readCount": {
    "message": {
      "one": "Marked {count} email as read",
      "other": "Marked {count} emails as read"
    },
    "description": "mailbox > actions. src/renderer/app.js (markAllRead)"
  },
  "mailbox.actions.readShortcut": {
    "message": "Mark as read (Ctrl+Q)",
    "description": "mailbox > actions. src/renderer/app.js (renderListTools)"
  },
  "mailbox.actions.star": {
    "message": "Star",
    "description": "mailbox > actions. src/renderer/app.js (renderListTools)"
  },
  "mailbox.actions.sync": {
    "message": "Sync",
    "description": "mailbox > actions. src/renderer/app.js (listAction)"
  },
  "mailbox.actions.unread": {
    "message": "Mark as unread",
    "description": "mailbox > actions. src/renderer/app.js (bulkMenu); src/renderer/app.js (messageMenu)"
  },
  "mailbox.actions.unreadShortcut": {
    "message": "Mark as unread (Ctrl+U)",
    "description": "mailbox > actions. src/renderer/app.js (renderListTools); src/renderer/app.js (readerBar)"
  },
  "mailbox.actions.unstar": {
    "message": "Remove star",
    "description": "mailbox > actions. src/renderer/app.js (itemHtml); src/renderer/app.js (bulkMenu); src/renderer/app.js (messageMenu); src/renderer/app.js (renderReader)"
  },
  "mailbox.delete.countAction": {
    "message": {
      "one": "Delete {count} email",
      "other": "Delete {count} emails"
    },
    "description": "mailbox > delete. src/renderer/app.js (bulkMenu)"
  },
  "mailbox.delete.deletedCount": {
    "message": {
      "one": "{count} email deleted",
      "other": "{count} emails deleted"
    },
    "description": "mailbox > delete. src/renderer/app.js (emptyCurrent); src/renderer/app.js (removeMessages)"
  },
  "mailbox.delete.deletedOne": {
    "message": "Deleted",
    "description": "mailbox > delete. src/renderer/app.js (removeMessages)"
  },
  "mailbox.delete.movedCount": {
    "message": {
      "one": "{count} email moved to Trash",
      "other": "{count} emails moved to Trash"
    },
    "description": "mailbox > delete. src/renderer/app.js (removeMessages)"
  },
  "mailbox.delete.movedOne": {
    "message": "Moved to Trash",
    "description": "mailbox > delete. src/renderer/app.js (removeMessages)"
  },
  "mailbox.delete.noTrash": {
    "message": "This account has no Trash folder. The email will be permanently deleted from the server.",
    "description": "mailbox > delete. src/renderer/app.js (removeMessages)"
  },
  "mailbox.delete.noTrashCount": {
    "message": {
      "one": "This account has no Trash folder. {count} email will be permanently deleted from the server.",
      "other": "This account has no Trash folder. {count} emails will be permanently deleted from the server."
    },
    "description": "mailbox > delete. src/renderer/app.js (removeMessages)"
  },
  "mailbox.delete.one": {
    "message": "This email will be permanently deleted.",
    "description": "mailbox > delete. src/renderer/app.js (removeMessages)"
  },
  "mailbox.delete.permanentCount": {
    "message": {
      "one": "{count} email will be permanently deleted.",
      "other": "{count} emails will be permanently deleted."
    },
    "description": "mailbox > delete. src/renderer/app.js (removeMessages)"
  },
  "mailbox.delete.title": {
    "message": "Permanently delete?",
    "description": "mailbox > delete. src/renderer/app.js (removeMessages)"
  },
  "mailbox.drag.messages": {
    "message": {
      "one": "{count} message",
      "other": "{count} messages"
    },
    "description": "mailbox > drag. src/renderer/app.js (bindList)"
  },
  "mailbox.drag.one": {
    "message": "1 message",
    "description": "mailbox > drag. Drag preview fallback for a single message without a subject."
  },
  "mailbox.empty.filter": {
    "message": "No emails match this filter",
    "description": "mailbox > empty. src/renderer/app.js (listHtml)"
  },
  "mailbox.empty.folder": {
    "message": "No emails",
    "description": "mailbox > empty. src/renderer/app.js (listHtml)"
  },
  "mailbox.empty.search": {
    "message": "No results",
    "description": "mailbox > empty. src/renderer/app.js (listHtml)"
  },
  "mailbox.empty.searchAll": {
    "message": "Try searching all folders.",
    "description": "mailbox > empty. src/renderer/app.js (listHtml)"
  },
  "mailbox.empty.searchAllAction": {
    "message": "Search all folders",
    "description": "mailbox > empty. src/renderer/app.js (listHtml)"
  },
  "mailbox.empty.searchOther": {
    "message": "Try another search term.",
    "description": "mailbox > empty. src/renderer/app.js (listHtml)"
  },
  "mailbox.empty.showAll": {
    "message": "Show all",
    "description": "mailbox > empty. src/renderer/app.js (listHtml)"
  },
  "mailbox.empty.syncing": {
    "message": "Syncing...",
    "description": "mailbox > empty. src/renderer/app.js (listHtml)"
  },
  "mailbox.emptyFolder.action": {
    "message": "Empty {folder}",
    "description": "mailbox > emptyFolder. src/renderer/app.js (listAction)"
  },
  "mailbox.emptyFolder.confirm": {
    "message": "Empty",
    "description": "mailbox > emptyFolder. src/renderer/app.js (emptyCurrent)"
  },
  "mailbox.emptyFolder.permanent": {
    "message": "All emails in this folder will be permanently deleted.",
    "description": "mailbox > emptyFolder. src/renderer/app.js (emptyCurrent)"
  },
  "mailbox.emptyFolder.title": {
    "message": "Empty {folder}?",
    "description": "mailbox > emptyFolder. src/renderer/app.js (emptyCurrent)"
  },
  "mailbox.emptyFolder.trash": {
    "message": "All emails in this folder will be moved to Trash.",
    "description": "mailbox > emptyFolder. src/renderer/app.js (emptyCurrent)"
  },
  "mailbox.export.action": {
    "message": "Export as .eml",
    "description": "mailbox > export. src/renderer/app.js (messageMenu)"
  },
  "mailbox.export.done": {
    "message": "Exported",
    "description": "mailbox > export. src/renderer/app.js (messageMenu)"
  },
  "mailbox.filters.all": {
    "message": "All",
    "description": "mailbox > filters. src/renderer/app.js"
  },
  "mailbox.filters.attachments": {
    "message": "Attachments",
    "description": "mailbox > filters. src/renderer/app.js; src/renderer/app.js (attachmentsHtml); src/renderer/composer.js (template)"
  },
  "mailbox.filters.label": {
    "message": "Filter",
    "description": "mailbox > filters. src/renderer/app.js (renderListTools)"
  },
  "mailbox.filters.starred": {
    "message": "Starred",
    "description": "mailbox > filters. src/renderer/app.js"
  },
  "mailbox.filters.unread": {
    "message": "Unread",
    "description": "mailbox > filters. src/renderer/app.js; src/renderer/app.js (itemHtml); src/renderer/app.js (renderReader)"
  },
  "mailbox.folders.archive": {
    "message": "Archive",
    "description": "mailbox > folders. src/renderer/app.js; src/renderer/app.js (archiveMessages); src/renderer/settings.js"
  },
  "mailbox.folders.created": {
    "message": "Folder {name} created",
    "description": "mailbox > folders. src/renderer/app.js (newFolder)"
  },
  "mailbox.folders.drafts": {
    "message": "Drafts",
    "description": "mailbox > folders. src/renderer/app.js; src/renderer/settings.js"
  },
  "mailbox.folders.inbox": {
    "message": "Inbox",
    "description": "mailbox > folders. src/renderer/app.js; src/renderer/app.js (viewLabel)"
  },
  "mailbox.folders.junk": {
    "message": "Spam",
    "description": "mailbox > folders. src/renderer/app.js; src/renderer/settings.js"
  },
  "mailbox.folders.name": {
    "message": "Folder name",
    "description": "mailbox > folders. src/renderer/app.js (newFolder)"
  },
  "mailbox.folders.new": {
    "message": "New folder",
    "description": "mailbox > folders. src/renderer/app.js (renderSidebar); src/renderer/app.js (newFolder)"
  },
  "mailbox.folders.saved": {
    "message": "Saved emails",
    "description": "mailbox > folders. src/renderer/app.js; src/renderer/settings.js"
  },
  "mailbox.folders.sent": {
    "message": "Sent",
    "description": "mailbox > folders. src/renderer/app.js; src/renderer/settings.js"
  },
  "mailbox.folders.starred": {
    "message": "Starred",
    "description": "mailbox > folders. src/renderer/app.js; src/renderer/settings.js"
  },
  "mailbox.folders.trash": {
    "message": "Trash",
    "description": "mailbox > folders. src/renderer/app.js; src/renderer/settings.js"
  },
  "mailbox.folders.vip": {
    "message": "VIPs",
    "description": "mailbox > folders. src/renderer/app.js; src/renderer/settings.js; src/renderer/settings.js (render)"
  },
  "mailbox.layout.folders": {
    "message": "Folders",
    "description": "mailbox > layout. src/renderer/app.js (renderShell); src/renderer/app.js (renderSidebar)"
  },
  "mailbox.layout.listWidth": {
    "message": "Message list width",
    "description": "mailbox > layout. src/renderer/app.js (renderShell)"
  },
  "mailbox.layout.message": {
    "message": "Message",
    "description": "mailbox > layout. src/renderer/app.js (renderShell)"
  },
  "mailbox.layout.messages": {
    "message": "Messages",
    "description": "mailbox > layout. src/renderer/app.js (renderShell)"
  },
  "mailbox.list.sentTo": {
    "message": "To: {recipients}",
    "description": "mailbox > list. src/renderer/app.js (senderLine)"
  },
  "mailbox.list.unreadSummary": {
    "message": "{count} unread · {scope}",
    "description": "mailbox > list. src/renderer/app.js (listTitle)"
  },
  "mailbox.message.attachment": {
    "message": "Attachment",
    "description": "mailbox > message. src/renderer/app.js (itemHtml)"
  },
  "mailbox.message.collapse": {
    "message": "Collapse",
    "description": "mailbox > message. src/renderer/app.js (itemHtml)"
  },
  "mailbox.message.noRecipient": {
    "message": "(No recipient)",
    "description": "Message list: sent email with no recipient."
  },
  "mailbox.message.noSubject": {
    "message": "(no subject)",
    "description": "mailbox > message. Message list and reader: fallback when the email has no subject."
  },
  "mailbox.message.unknownSender": {
    "message": "(Unknown sender)",
    "description": "Fallback when an email has neither a sender name nor address. Shared by the message list and reader header in src/renderer/app.js (senderLine, renderReader)."
  },
  "mailbox.message.read": {
    "message": "Read",
    "description": "mailbox > message. src/renderer/app.js (itemHtml); src/renderer/app.js (renderReader)"
  },
  "mailbox.message.replied": {
    "message": "Replied",
    "description": "mailbox > message. src/renderer/app.js (itemHtml)"
  },
  "mailbox.message.select": {
    "message": "Select",
    "description": "mailbox > message. src/renderer/app.js (itemHtml)"
  },
  "mailbox.message.stack": {
    "message": {
      "one": "{count} more email from {sender}",
      "other": "{count} more emails from {sender}"
    },
    "description": "mailbox > message. Message list: tooltip on the collapsed sender stack button."
  },
  "mailbox.message.vip": {
    "message": "VIP",
    "description": "mailbox > message. src/renderer/app.js (itemHtml); src/renderer/app.js (renderReader)"
  },
  "mailbox.move.alreadyThere": {
    "message": "These emails are already there",
    "description": "mailbox > move. src/renderer/app.js (moveMessages)"
  },
  "mailbox.move.count": {
    "message": {
      "one": "{count} email moved to {folder}",
      "other": "{count} emails moved to {folder}"
    },
    "description": "mailbox > move. src/renderer/app.js (moveMessages)"
  },
  "mailbox.move.countTitle": {
    "message": {
      "one": "Move {count} email to",
      "other": "Move {count} emails to"
    },
    "description": "mailbox > move. src/renderer/app.js (pickFolder)"
  },
  "mailbox.move.noArchive": {
    "message": "No archive folder is available",
    "description": "mailbox > move. src/renderer/app.js (moveMessages)"
  },
  "mailbox.move.one": {
    "message": "Moved to {folder}",
    "description": "mailbox > move. src/renderer/app.js (moveMessages)"
  },
  "mailbox.move.title": {
    "message": "Move to",
    "description": "mailbox > move. src/renderer/app.js (pickFolder)"
  },
  "mailbox.saved.save": {
    "message": "Save to Saved emails",
    "description": "mailbox > saved. src/renderer/app.js (messageMenu)"
  },
  "mailbox.saved.saved": {
    "message": "Saved to Saved emails",
    "description": "mailbox > saved. src/renderer/app.js (messageMenu)"
  },
  "mailbox.search.account": {
    "message": "This account",
    "description": "mailbox > search. src/renderer/app.js (searchScopeLabel)"
  },
  "mailbox.search.allAccounts": {
    "message": "All accounts",
    "description": "mailbox > search. src/renderer/app.js (searchScopeLabel); src/renderer/app.js (renderSidebar); src/renderer/app.js (accountMenu); src/renderer/app.js (listTitle)"
  },
  "mailbox.search.allFolders": {
    "message": "All folders",
    "description": "mailbox > search. src/renderer/app.js (searchScopeLabel)"
  },
  "mailbox.search.clearShortcut": {
    "message": "Clear search (Esc)",
    "description": "mailbox > search. src/renderer/app.js (renderListHead)"
  },
  "mailbox.search.folder": {
    "message": "This folder",
    "description": "mailbox > search. src/renderer/app.js (searchScopeLabel)"
  },
  "mailbox.search.folderNamed": {
    "message": "This folder ({folder})",
    "description": "mailbox > search. src/renderer/app.js (renderSearch)"
  },
  "mailbox.search.in": {
    "message": "Search in",
    "description": "mailbox > search. src/renderer/app.js (renderSearch)"
  },
  "mailbox.search.label": {
    "message": "Search",
    "description": "mailbox > search. src/renderer/app.js (renderSearch)"
  },
  "mailbox.search.placeholder": {
    "message": "Search in {scope}",
    "description": "mailbox > search. src/renderer/app.js (renderSearch)"
  },
  "mailbox.search.results": {
    "message": "Search results",
    "description": "mailbox > search. src/renderer/app.js (listTitle)"
  },
  "mailbox.search.scope": {
    "message": "Search scope",
    "description": "mailbox > search. src/renderer/app.js (renderSearch)"
  },
  "mailbox.search.summary": {
    "message": {
      "one": "{count} result for \"{query}\" in {scope}",
      "other": "{count} results for \"{query}\" in {scope}"
    },
    "description": "mailbox > search. src/renderer/app.js (listTitle)"
  },
  "mailbox.selection.allShortcut": {
    "message": "Select all (Ctrl+A)",
    "description": "mailbox > selection. src/renderer/app.js (renderListTools)"
  },
  "mailbox.selection.clear": {
    "message": "Clear selection",
    "description": "mailbox > selection. src/renderer/app.js (renderReader)"
  },
  "mailbox.selection.clearShortcut": {
    "message": "Clear selection (Esc)",
    "description": "mailbox > selection. src/renderer/app.js (renderListTools)"
  },
  "mailbox.selection.count": {
    "message": "{count} selected",
    "description": "mailbox > selection. Message list selection toolbar: number of selected messages."
  },
  "mailbox.selection.none": {
    "message": "Deselect all",
    "description": "mailbox > selection. src/renderer/app.js (renderListTools)"
  },
  "mailbox.selection.summary": {
    "message": {
      "one": "{count} email selected",
      "other": "{count} emails selected"
    },
    "description": "mailbox > selection. Reading pane: heading shown when selecting multiple emails."
  },
  "mailbox.sidebar.collapse": {
    "message": "Collapse sidebar",
    "description": "mailbox > sidebar. src/renderer/app.js (renderSidebar)"
  },
  "mailbox.sidebar.expand": {
    "message": "Expand sidebar",
    "description": "mailbox > sidebar. src/renderer/app.js (renderSidebar)"
  },
  "mailbox.sort.menu": {
    "message": "Sort by...",
    "description": "mailbox > sort. src/renderer/app.js (listAction)"
  },
  "mailbox.sort.newest": {
    "message": "Date (newest first)",
    "description": "mailbox > sort. src/renderer/app.js (chooseSort)"
  },
  "mailbox.sort.oldest": {
    "message": "Date (oldest first)",
    "description": "mailbox > sort. src/renderer/app.js (chooseSort)"
  },
  "mailbox.sort.sender": {
    "message": "Sender",
    "description": "mailbox > sort. src/renderer/app.js (chooseSort)"
  },
  "mailbox.sort.title": {
    "message": "Sort by",
    "description": "mailbox > sort. src/renderer/app.js (chooseSort)"
  },
  "mailbox.sort.unread": {
    "message": "Unread first",
    "description": "mailbox > sort. src/renderer/app.js (chooseSort)"
  },
  "mailbox.spam.add": {
    "message": "Add to spam addresses",
    "description": "mailbox > spam. src/renderer/app.js (messageMenu)"
  },
  "mailbox.spam.added": {
    "message": "Added to spam addresses",
    "description": "mailbox > spam. src/renderer/app.js (messageMenu)"
  },
  "mailbox.spam.confirm": {
    "message": "Add to spam addresses?",
    "description": "mailbox > spam. src/renderer/app.js (messageMenu)"
  },
  "mailbox.spam.confirmHelp": {
    "message": "Emails from {address} will no longer appear in your Inbox.",
    "description": "mailbox > spam. src/renderer/app.js (messageMenu)"
  },
  "mailbox.sync.date": {
    "message": "Updated on {date}",
    "description": "mailbox > sync. src/renderer/app.js (syncStatus)"
  },
  "mailbox.sync.done": {
    "message": "Synced",
    "description": "mailbox > sync. src/renderer/app.js (syncNow); src/renderer/settings.js (openSettings)"
  },
  "mailbox.sync.failed": {
    "message": "Sync failed",
    "description": "mailbox > sync. src/renderer/app.js (syncStatus)"
  },
  "mailbox.sync.justNow": {
    "message": "Updated just now",
    "description": "mailbox > sync. src/renderer/app.js (syncStatus)"
  },
  "mailbox.sync.minutesAgo": {
    "message": {
      "one": "Updated {count} minute ago",
      "other": "Updated {count} minutes ago"
    },
    "description": "mailbox > sync. src/renderer/app.js (syncStatus)"
  },
  "mailbox.sync.never": {
    "message": "Not synced yet",
    "description": "mailbox > sync. src/renderer/app.js (syncStatus); src/renderer/settings.js (render)"
  },
  "mailbox.sync.shortcut": {
    "message": "Sync (F5)",
    "description": "mailbox > sync. src/renderer/app.js (renderListHead)"
  },
  "mailbox.sync.syncing": {
    "message": "Syncing...",
    "description": "mailbox > sync. src/renderer/app.js (syncStatus); src/renderer/app.js (syncNow); src/renderer/settings.js (render); src/renderer/settings.js (openSettings)"
  },
  "mailbox.sync.time": {
    "message": "Updated at {time}",
    "description": "mailbox > sync. src/renderer/app.js (syncStatus)"
  },
  "mailbox.sync.tooltip": {
    "message": "Updated on {date} at {time}. Click to sync (F5).",
    "description": "mailbox > sync. src/renderer/app.js (syncStatus)"
  },
  "mailbox.undo.restored": {
    "message": "Restored",
    "description": "mailbox > undo. src/renderer/app.js (undoMoves)"
  },
  "mailbox.undo.restoredCount": {
    "message": {
      "one": "{count} email restored",
      "other": "{count} emails restored"
    },
    "description": "mailbox > undo. src/renderer/app.js (undoMoves)"
  },
  "mailbox.vip.add": {
    "message": "Add to VIPs",
    "description": "mailbox > vip. src/renderer/app.js (messageMenu); src/renderer/app.js (personMenu)"
  },
  "mailbox.vip.added": {
    "message": "Added to VIPs",
    "description": "mailbox > vip. src/renderer/app.js (personMenu)"
  },
  "mailbox.vip.addedSender": {
    "message": "{sender} added to VIPs",
    "description": "mailbox > vip. src/renderer/app.js (messageMenu)"
  },
  "mailbox.vip.remove": {
    "message": "Remove from VIPs",
    "description": "mailbox > vip. src/renderer/app.js (messageMenu); src/renderer/app.js (personMenu)"
  },
  "mailbox.vip.removed": {
    "message": "Removed from VIPs",
    "description": "mailbox > vip. src/renderer/app.js (personMenu)"
  },
  "mailbox.vip.removedSender": {
    "message": "{sender} removed from VIPs",
    "description": "mailbox > vip. src/renderer/app.js (messageMenu)"
  },
  "native.attachments.defaultName": {
    "message": "attachment",
    "description": "Default filename for an attachment without a filename."
  },
  "native.attachments.defaultNumbered": {
    "message": "attachment-{number}",
    "description": "Default attachment filename with its one-based index."
  },
  "native.attachments.directory": {
    "message": "Save attachments to",
    "description": "native > attachments. src/main/main.js (saveAllAttachments)"
  },
  "native.attachments.images": {
    "message": "Images",
    "description": "native > attachments. src/main/main.js"
  },
  "native.attachments.open": {
    "message": "Open attachment",
    "description": "native > attachments. src/main/main.js"
  },
  "native.attachments.riskyHelp": {
    "message": "This file type cannot be opened from email. Save it and only open it if you trust the sender.",
    "description": "native > attachments. src/main/main.js"
  },
  "native.attachments.riskyTitle": {
    "message": "{filename} can launch a program.",
    "description": "native > attachments. src/main/main.js"
  },
  "native.attachments.save": {
    "message": "Save...",
    "description": "Save action in native attachment file dialogs in src/main/main.js. This action is separate from the composer draft-saving progress status."
  },
  "native.export.defaultName": {
    "message": "message",
    "description": "Default filename stem for exporting an email without a subject."
  },
  "native.notifications.newCount": {
    "message": {
      "one": "{count} new email",
      "other": "{count} new emails"
    },
    "description": "native > notifications. src/main/main.js (notify); src/main/main.js"
  },
  "native.notifications.newOne": {
    "message": "1 new email",
    "description": "native > notifications. Windows taskbar badge: singular unread/new email description."
  },
  "reader.actions.edit": {
    "message": "Edit",
    "description": "reader > actions. src/renderer/app.js (readerBar)"
  },
  "reader.actions.editDraftShortcut": {
    "message": "Edit draft (Enter)",
    "description": "reader > actions. src/renderer/app.js (readerBar)"
  },
  "reader.actions.forwardShortcut": {
    "message": "Forward (Ctrl+F)",
    "description": "reader > actions. src/renderer/app.js (readerBar)"
  },
  "reader.actions.label": {
    "message": "Actions",
    "description": "reader > actions. src/renderer/app.js (readerBar)"
  },
  "reader.actions.more": {
    "message": "More actions",
    "description": "reader > actions. src/renderer/app.js (readerBar)"
  },
  "reader.actions.replyAllShortcut": {
    "message": "Reply all (Ctrl+Shift+R)",
    "description": "reader > actions. src/renderer/app.js (readerBar)"
  },
  "reader.actions.replyShortcut": {
    "message": "Reply (Ctrl+R)",
    "description": "reader > actions. src/renderer/app.js (readerBar)"
  },
  "reader.address.copied": {
    "message": "Copied",
    "description": "reader > address. src/renderer/app.js (personMenu)"
  },
  "reader.address.copy": {
    "message": "Copy email address",
    "description": "reader > address. src/renderer/app.js (personMenu)"
  },
  "reader.attachments.count": {
    "message": {
      "one": "{count} attachment",
      "other": "{count} attachments"
    },
    "description": "Reading pane attachment section toggle in src/renderer/app.js (attachmentsHtml). count is the number of attached files; includes plural forms."
  },
  "reader.attachments.open": {
    "message": "Open: {filename}",
    "description": "Tooltip on image and file attachment open buttons in src/renderer/app.js (attachmentsHtml). filename is the attachment's original filename."
  },
  "reader.attachments.saveAll": {
    "message": "Save all",
    "description": "reader > attachments. src/renderer/app.js (attachmentsHtml)"
  },
  "reader.attachments.savedCount": {
    "message": {
      "one": "{count} attachment saved",
      "other": "{count} attachments saved"
    },
    "description": "reader > attachments. src/renderer/app.js (bindReader)"
  },
  "reader.attachments.savedOne": {
    "message": "Attachment saved",
    "description": "reader > attachments. src/renderer/app.js (bindReader)"
  },
  "reader.content.label": {
    "message": "Email content",
    "description": "reader > content. src/renderer/app.js (renderReader)"
  },
  "reader.details.hide": {
    "message": "Hide all details",
    "description": "Reading pane recipient summary tooltip when full headers are open."
  },
  "reader.details.show": {
    "message": "Show all details",
    "description": "Reading pane recipient summary tooltip when full headers are closed."
  },
  "reader.empty.browse": {
    "message": "Browse",
    "description": "reader > empty. Shared interface label."
  },
  "reader.empty.title": {
    "message": "No email selected",
    "description": "reader > empty. src/renderer/app.js (renderReader)"
  },
  "reader.headers.bcc": {
    "message": "Bcc",
    "description": "reader > headers. src/renderer/app.js (detailsHtml); src/renderer/composer.js (template); src/renderer/composer.js (mountComposer)"
  },
  "reader.headers.cc": {
    "message": "Cc",
    "description": "reader > headers. src/renderer/app.js (detailsHtml); src/renderer/composer.js (template); src/renderer/composer.js (mountComposer)"
  },
  "reader.headers.date": {
    "message": "Date",
    "description": "reader > headers. src/renderer/app.js (detailsHtml)"
  },
  "reader.headers.from": {
    "message": "From",
    "description": "reader > headers. src/renderer/app.js (detailsHtml); src/renderer/composer.js (template)"
  },
  "reader.headers.replyTo": {
    "message": "Reply to",
    "description": "reader > headers. src/renderer/app.js (detailsHtml)"
  },
  "reader.headers.subject": {
    "message": "Subject",
    "description": "reader > headers. src/renderer/composer.js (template)"
  },
  "reader.headers.to": {
    "message": "To",
    "description": "reader > headers. src/renderer/app.js (detailsHtml); src/renderer/composer.js (template); src/renderer/composer.js (mountComposer)"
  },
  "reader.navigation.back": {
    "message": "Back to message list",
    "description": "reader > navigation. src/renderer/app.js (readerBar)"
  },
  "reader.navigation.expand": {
    "message": "Expand reading pane",
    "description": "reader > navigation. src/renderer/app.js (readerBar)"
  },
  "reader.navigation.next": {
    "message": "Next (Down arrow)",
    "description": "reader > navigation. src/renderer/app.js (readerBar)"
  },
  "reader.navigation.previous": {
    "message": "Previous (Up arrow)",
    "description": "reader > navigation. src/renderer/app.js (readerBar)"
  },
  "reader.navigation.showList": {
    "message": "Show message list (Esc)",
    "description": "reader > navigation. src/renderer/app.js (readerBar)"
  },
  "reader.recipients.me": {
    "message": "me",
    "description": "reader > recipients. Reading pane: replaces a recipient address belonging to the current account."
  },
  "reader.recipients.others": {
    "message": {
      "one": " and {count} other",
      "other": " and {count} others"
    },
    "description": "reader > recipients. src/renderer/app.js (recipientsHtml)"
  },
  "reader.recipients.summary": {
    "message": "to {recipients}",
    "description": "reader > recipients. src/renderer/app.js (recipientsHtml)"
  },
  "reader.recipients.unknown": {
    "message": "to unknown recipients",
    "description": "Reading pane recipient summary when the email has no recipients."
  },
  "reader.unsubscribe.action": {
    "message": "Unsubscribe",
    "description": "reader > unsubscribe. src/renderer/app.js (renderReader); src/renderer/app.js (unsubscribe)"
  },
  "reader.unsubscribe.done": {
    "message": "Unsubscribed from {sender}",
    "description": "reader > unsubscribe. src/renderer/app.js (unsubscribe)"
  },
  "reader.unsubscribe.linkHelp": {
    "message": "Rukoo Mail will use the sender's unsubscribe link.",
    "description": "reader > unsubscribe. src/renderer/app.js (unsubscribe)"
  },
  "reader.unsubscribe.mailHelp": {
    "message": "Rukoo Mail will prepare an unsubscribe email for you.",
    "description": "reader > unsubscribe. src/renderer/app.js (unsubscribe)"
  },
  "reader.unsubscribe.opened": {
    "message": "The unsubscribe page has opened in your browser",
    "description": "reader > unsubscribe. src/renderer/app.js (unsubscribe)"
  },
  "reader.unsubscribe.subject": {
    "message": "Unsubscribe",
    "description": "reader > unsubscribe. src/renderer/app.js (unsubscribe)"
  },
  "reader.unsubscribe.title": {
    "message": "Unsubscribe from {sender}?",
    "description": "reader > unsubscribe. src/renderer/app.js (unsubscribe)"
  },
  "reader.unsubscribe.tooltip": {
    "message": "Unsubscribe from these emails",
    "description": "reader > unsubscribe. src/renderer/app.js (renderReader)"
  },
  "settings.about.description": {
    "message": "An email client for Windows, built with Electron. Data is stored in:",
    "description": "settings > about. src/renderer/settings.js (openSettings)"
  },
  "settings.about.help": {
    "message": "Version and storage location",
    "description": "settings > about. src/renderer/settings.js (render)"
  },
  "settings.about.title": {
    "message": "About Rukoo Mail",
    "description": "settings > about. src/renderer/settings.js (render)"
  },
  "settings.about.version": {
    "message": "Version {version}",
    "description": "settings > about. About dialog: application version."
  },
  "settings.account.color": {
    "message": "Account color",
    "description": "settings > account. src/renderer/settings.js (render); src/renderer/settings.js (openSettings)"
  },
  "settings.account.defaultSuffix": {
    "message": " (default)",
    "description": "settings > account. Account and sender address rows: suffix indicating the default choice; keep leading space."
  },
  "settings.account.from": {
    "message": "Default sender",
    "description": "settings > account. src/renderer/settings.js (render); src/renderer/settings.js (openSettings)"
  },
  "settings.account.googleReauth": {
    "message": "Sign in to Google again",
    "description": "settings > account. src/renderer/settings.js (render)"
  },
  "settings.account.googleReauthHelp": {
    "message": "Use this if Google has revoked access.",
    "description": "settings > account. src/renderer/settings.js (render)"
  },
  "settings.account.googleSwitch": {
    "message": "Switch to Google sign-in",
    "description": "settings > account. src/renderer/settings.js (render)"
  },
  "settings.account.googleSwitchHelp": {
    "message": "Sign in through your browser instead of using an app password.",
    "description": "settings > account. src/renderer/settings.js (render)"
  },
  "settings.account.identities": {
    "message": "Sender addresses",
    "description": "settings > account. src/renderer/settings.js (render)"
  },
  "settings.account.lastSync": {
    "message": "Last synced on {date} at {time}",
    "description": "settings > account. src/renderer/settings.js (render)"
  },
  "settings.account.makeDefault": {
    "message": "Set as default account",
    "description": "settings > account. src/renderer/settings.js (render)"
  },
  "settings.account.makeDefaultHelp": {
    "message": "New emails will be sent from this account.",
    "description": "settings > account. src/renderer/settings.js (render)"
  },
  "settings.account.name": {
    "message": "Display name",
    "description": "settings > account. src/renderer/settings.js (render); src/renderer/settings.js (openSettings)"
  },
  "settings.account.noAliases": {
    "message": "Account address only",
    "description": "settings > account. src/renderer/settings.js (render)"
  },
  "settings.account.remove": {
    "message": "Remove account",
    "description": "settings > account. src/renderer/settings.js (render)"
  },
  "settings.account.removed": {
    "message": "Account removed",
    "description": "settings > account. src/renderer/settings.js (openSettings)"
  },
  "settings.account.removeHelp": {
    "message": "{email} and all locally stored emails for this account will be removed from this PC. Everything on the server will be kept.",
    "description": "settings > account. src/renderer/settings.js (openSettings)"
  },
  "settings.account.removeTitle": {
    "message": "Remove account?",
    "description": "settings > account. src/renderer/settings.js (openSettings)"
  },
  "settings.account.server": {
    "message": "Server settings",
    "description": "settings > account. src/renderer/settings.js (render)"
  },
  "settings.account.sync": {
    "message": "Sync now",
    "description": "settings > account. src/renderer/settings.js (render)"
  },
  "settings.accounts.add": {
    "message": "Add account",
    "description": "settings > accounts. src/renderer/app.js (accountMenu); src/renderer/settings.js (render)"
  },
  "settings.accounts.overview": {
    "message": "Accounts and settings",
    "description": "settings > accounts. src/renderer/app.js (accountMenu)"
  },
  "settings.addresses.removeHint": {
    "message": "Click to remove",
    "description": "settings > addresses. src/renderer/settings.js (render)"
  },
  "settings.agents.access": {
    "message": "Access",
    "description": "Settings, Agents page: row that sets what the agent may do without asking."
  },
  "settings.agents.accessAsk": {
    "message": "Ask before actions",
    "description": "Settings, Agents page: access choice where commands wait for approval."
  },
  "settings.agents.accessAskHint": {
    "message": "Commands and file changes wait for your approval in the chat",
    "description": "Settings, Agents page: explanation of the ask-first access choice."
  },
  "settings.agents.accessFull": {
    "message": "Full access",
    "description": "Settings, Agents page: access choice where the agent runs commands without asking."
  },
  "settings.agents.accessFullHint": {
    "message": "Runs commands without asking. Only for agents you trust completely.",
    "description": "Settings, Agents page: warning under the full access choice."
  },
  "settings.agents.autoMail": {
    "message": "Let agents archive, move and mark mail without asking",
    "description": "Settings, Agents page: toggle for mail actions without an approval card."
  },
  "settings.agents.autoMailHelp": {
    "message": "Deleting and unsubscribing always ask first.",
    "description": "Settings, Agents page: note under the mail actions toggle."
  },
  "settings.agents.configDir": {
    "message": "Claude config folder (optional)",
    "description": "Settings, Agents page: field for the Claude Code configuration folder."
  },
  "settings.agents.configDirHint": {
    "message": "The default folder",
    "description": "Settings, Agents page: placeholder of the Claude config folder field."
  },
  "settings.agents.copied": {
    "message": "Copied. Paste it into ~/.hermes/config.yaml on {name}'s machine.",
    "description": "Settings, Agents page: toast after copying the Hermes setup."
  },
  "settings.agents.copySetup": {
    "message": "Copy Hermes setup",
    "description": "Settings, Agents page: row that copies the config block for Hermes."
  },
  "settings.agents.copySetupHelp": {
    "message": "The block for {name}'s config.yaml. It's the same for all your devices.",
    "description": "Settings, Agents page: description of the copy setup row."
  },
  "settings.agents.default": {
    "message": "Default agent",
    "description": "Settings, Agents page: which agent a new chat goes to."
  },
  "settings.agents.enabled": {
    "message": "Use {name}",
    "description": "Settings, Agents page: toggle that turns an agent on or off; name is the agent."
  },
  "settings.agents.exe": {
    "message": "Program path",
    "description": "Settings, Agents page: field for the Claude Code or Codex program."
  },
  "settings.agents.exeHint": {
    "message": "Found automatically ({exe})",
    "description": "Settings, Agents page: placeholder of the program path field."
  },
  "settings.agents.help": {
    "message": "Agents keep their own tools and memory. Rukoo only adds this chat and lets them read mail and write drafts here.",
    "description": "Settings, Agents page: short explanation at the top."
  },
  "settings.agents.key": {
    "message": "API key",
    "description": "Settings, Agents page: label of the Hermes API key field."
  },
  "settings.agents.keyHide": {
    "message": "Hide key",
    "description": "Settings, Agents page: tooltip of the eye button while the key is visible."
  },
  "settings.agents.keyPlaceholder": {
    "message": "Paste the API server key",
    "description": "Settings, Agents page: placeholder of the API key field."
  },
  "settings.agents.keyReplace": {
    "message": "Replace",
    "description": "Settings, Agents page: link to enter a new API key."
  },
  "settings.agents.keySave": {
    "message": "Save key",
    "description": "Settings, Agents page: button that stores the API key."
  },
  "settings.agents.keySaved": {
    "message": "Key saved",
    "description": "Settings, Agents page: shown instead of the key once it is stored."
  },
  "settings.agents.keyShow": {
    "message": "Show key",
    "description": "Settings, Agents page: tooltip of the eye button on the key field."
  },
  "settings.agents.keyStored": {
    "message": "Key saved. Rukoo keeps it encrypted on this computer.",
    "description": "Settings, Agents page: toast after the API key was stored."
  },
  "settings.agents.model": {
    "message": "Model (optional)",
    "description": "Settings, Agents page: field for the model the agent uses."
  },
  "settings.agents.modelHint": {
    "message": "Empty for the default, for example {example}",
    "description": "Settings, Agents page: placeholder of the Claude model field; example is a model name."
  },
  "settings.agents.name": {
    "message": "Name",
    "description": "Settings, Agents page: field for the name of the Hermes agent."
  },
  "settings.agents.noAddress": {
    "message": "No Tailscale address found on this computer",
    "description": "Settings, Agents page: shown under the remote toggle when Tailscale is not running."
  },
  "settings.agents.optional": {
    "message": "Empty for the default",
    "description": "Settings, Agents page: placeholder of an optional field."
  },
  "settings.agents.remote": {
    "message": "Let {name} use Rukoo",
    "description": "Settings, Agents page: toggle that lets the remote Hermes agent call Rukoo over Tailscale."
  },
  "settings.agents.remoteNeedsKey": {
    "message": "{name} signs in with the API key above. Enter it first.",
    "description": "Settings, Agents page: note under the remote access toggle when it is on but no Hermes API key is saved; name is the agent."
  },
  "settings.agents.rowDesc": {
    "message": "Default: {name} · {status}",
    "description": "Settings overview row description: default agent and its status."
  },
  "settings.agents.rowTitle": {
    "message": "{name}, Claude Code and Codex",
    "description": "Settings overview row that opens the agents page; name is the Hermes agent name."
  },
  "settings.agents.saved": {
    "message": "Saved",
    "description": "Settings, Agents page: short toast after a field was saved."
  },
  "settings.agents.test": {
    "message": "Test",
    "description": "Settings, Agents page: button that checks whether Claude Code or Codex can be started."
  },
  "settings.agents.testConnection": {
    "message": "Test connection",
    "description": "Settings, Agents page: button that checks the connection to Hermes."
  },
  "settings.agents.testing": {
    "message": "Testing...",
    "description": "Settings, Agents page: status line while a test runs."
  },
  "settings.agents.title": {
    "message": "Agents",
    "description": "Settings: title of the page where you set up Hermes, Claude Code and Codex."
  },
  "settings.agents.unavailable": {
    "message": "Agents aren't available in this version.",
    "description": "Settings: shown when this build has no agent support."
  },
  "settings.agents.url": {
    "message": "Server URL",
    "description": "Settings, Agents page: field for the Hermes API server address."
  },
  "settings.aliases.add": {
    "message": "Add alias",
    "description": "settings > aliases. src/renderer/settings.js (render); src/renderer/settings.js (openSettings)"
  },
  "settings.aliases.count": {
    "message": {
      "one": "{count} alias",
      "other": "{count} aliases"
    },
    "description": "settings > aliases. src/renderer/settings.js (render)"
  },
  "settings.aliases.fetch": {
    "message": "Fetch from Gmail",
    "description": "settings > aliases. src/renderer/settings.js (render)"
  },
  "settings.aliases.fetched": {
    "message": {
      "one": "{count} alias fetched from Gmail",
      "other": "{count} aliases fetched from Gmail"
    },
    "description": "settings > aliases. src/renderer/settings.js (openSettings)"
  },
  "settings.aliases.fetchHelp": {
    "message": "Import verified addresses from Gmail's \"Send mail as\" settings.",
    "description": "settings > aliases. src/renderer/settings.js (render)"
  },
  "settings.aliases.help": {
    "message": "Your server must allow sending from this address. In Gmail, see Settings > Accounts > Send mail as.",
    "description": "settings > aliases. src/renderer/settings.js (render)"
  },
  "settings.aliases.makeDefault": {
    "message": "Set as default",
    "description": "settings > aliases. src/renderer/settings.js (openSettings)"
  },
  "settings.aliases.manageHint": {
    "message": "Click to set as default or remove",
    "description": "settings > aliases. src/renderer/settings.js (render)"
  },
  "settings.aliases.primary": {
    "message": "Account address",
    "description": "settings > aliases. src/renderer/settings.js (render)"
  },
  "settings.aliases.sendAs": {
    "message": "Send as",
    "description": "settings > aliases. src/renderer/settings.js (render)"
  },
  "settings.badge.new": {
    "message": "New emails",
    "description": "settings > badge. src/renderer/settings.js"
  },
  "settings.badge.unread": {
    "message": "Unread emails",
    "description": "settings > badge. src/renderer/settings.js"
  },
  "settings.colors.blue": {
    "message": "Blue",
    "description": "settings > colors. src/renderer/settings.js"
  },
  "settings.colors.lightBlue": {
    "message": "Light blue",
    "description": "settings > colors. src/renderer/settings.js"
  },
  "settings.colors.orange": {
    "message": "Orange",
    "description": "settings > colors. src/renderer/settings.js"
  },
  "settings.colors.purple": {
    "message": "Purple",
    "description": "settings > colors. src/renderer/settings.js"
  },
  "settings.colors.red": {
    "message": "Red",
    "description": "settings > colors. src/renderer/settings.js"
  },
  "settings.colors.turquoise": {
    "message": "Turquoise",
    "description": "settings > colors. src/renderer/settings.js"
  },
  "settings.colors.yellow": {
    "message": "Yellow",
    "description": "settings > colors. src/renderer/settings.js"
  },
  "settings.density.compact": {
    "message": "Compact",
    "description": "settings > density. src/renderer/settings.js"
  },
  "settings.density.compactHint": {
    "message": "One line per email",
    "description": "settings > density. src/renderer/settings.js"
  },
  "settings.density.standard": {
    "message": "Standard",
    "description": "settings > density. src/renderer/settings.js"
  },
  "settings.density.standardHint": {
    "message": "Sender, subject, and preview",
    "description": "settings > density. src/renderer/settings.js"
  },
  "settings.folders.show": {
    "message": "Show in sidebar",
    "description": "settings > folders. src/renderer/settings.js (render)"
  },
  "settings.general.badge": {
    "message": "App badge count",
    "description": "settings > general. src/renderer/settings.js (render); src/renderer/settings.js (openSettings)"
  },
  "settings.general.darkEmails": {
    "message": "Dark email display",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.darkEmailsHelp": {
    "message": "Adjust HTML email colors in dark mode.",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.density": {
    "message": "Message list",
    "description": "settings > general. src/renderer/settings.js (render); src/renderer/settings.js (openSettings)"
  },
  "settings.general.fit": {
    "message": "Fit content to window",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.fitHelp": {
    "message": "Shrink wide email to fit the window, down to 80%. Anything still too wide scrolls sideways.",
    "description": "settings > general, help under the \"Fit content to window\" toggle. 80% is MIN_ZOOM in src/renderer/mailframe.js (fillFrame). src/renderer/settings.js (render)"
  },
  "settings.general.folders": {
    "message": "Manage folders",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.foldersHelp": {
    "message": "Show or hide email folders.",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.language": {
    "message": "Language",
    "description": "settings > general. Settings > General: opens the interface language picker."
  },
  "settings.general.languageHelp": {
    "message": "Choose the language used throughout the app.",
    "description": "settings > general. Settings > General: explanation below Language."
  },
  "settings.general.logos": {
    "message": "Sender logos",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.logosHelp": {
    "message": "Show logos for companies that email you. Rukoo Mail fetches each logo once from their website.",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.notifications": {
    "message": "Notifications",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.notificationsHelp": {
    "message": "Show a Windows notification for new emails.",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.signature": {
    "message": "Signature",
    "description": "settings > general. src/renderer/settings.js (render); src/renderer/settings.js (openSettings)"
  },
  "settings.general.spam": {
    "message": "Spam addresses",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.spamHelp": {
    "message": "Edit your list of spam senders.",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.swipe": {
    "message": "Touchscreen swipe actions",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.swipeHelp": {
    "message": "Swipe right to mark as read or unread, and left to delete.",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.sync": {
    "message": "Sync schedule",
    "description": "settings > general. src/renderer/settings.js (render); src/renderer/settings.js (openSettings)"
  },
  "settings.general.theme": {
    "message": "Theme",
    "description": "settings > general. src/renderer/settings.js (render); src/renderer/settings.js (openSettings)"
  },
  "settings.general.vipHelp": {
    "message": "Emails from VIPs appear in the VIPs folder.",
    "description": "settings > general. src/renderer/settings.js (render)"
  },
  "settings.general.zoom": {
    "message": "Zoom",
    "description": "settings > general. Settings > General: title of the zoom row, which shows the zoom level of the main window and the compose windows. src/renderer/settings.js (zoomRow)"
  },
  "settings.general.zoomHelp": {
    "message": "Use Ctrl+Plus and Ctrl+Minus, or Ctrl with the mouse wheel. Ctrl+0 goes back to 100%.",
    "description": "settings > general. Settings > General: explanation below Zoom, naming the keyboard shortcuts and the mouse wheel. src/renderer/settings.js (zoomRow)"
  },
  "settings.general.zoomReset": {
    "message": "Reset to 100%",
    "description": "settings > general. Settings > General: button in the zoom row that sets the zoom back to 100%; disabled at 100%. src/renderer/settings.js (zoomRow)"
  },
  "settings.general.zoomValue": {
    "message": "{percent}%",
    "description": "settings > general. Settings > General: current zoom level in the zoom row; percent is a whole number such as 125. src/renderer/settings.js (zoomRow, showZoom)"
  },
  "settings.groups.about": {
    "message": "About",
    "description": "settings > groups. src/renderer/settings.js (render)"
  },
  "settings.groups.account": {
    "message": "Account",
    "description": "settings > groups. src/renderer/settings.js (render)"
  },
  "settings.groups.accounts": {
    "message": "Accounts",
    "description": "settings > groups. src/renderer/settings.js (render)"
  },
  "settings.groups.agents": {
    "message": "Agents",
    "description": "Settings overview: heading of the group with the chat agents."
  },
  "settings.groups.general": {
    "message": "General",
    "description": "settings > groups. src/renderer/settings.js (render)"
  },
  "settings.server.checking": {
    "message": "Checking...",
    "description": "settings > server. Server settings form: progress label while checking credentials."
  },
  "settings.server.passwordHint": {
    "message": "Leave blank to keep the current password",
    "description": "settings > server. src/renderer/settings.js (render)"
  },
  "settings.server.saved": {
    "message": "Server settings saved",
    "description": "settings > server. src/renderer/settings.js (openSettings)"
  },
  "settings.signature.generalValue": {
    "message": "General: {signature}",
    "description": "settings > signature. src/renderer/settings.js (render)"
  },
  "settings.signature.useGeneral": {
    "message": "Use general signature",
    "description": "settings > signature. src/renderer/settings.js (openSettings)"
  },
  "settings.spam.add": {
    "message": "Add spam address",
    "description": "settings > spam. src/renderer/settings.js (openSettings)"
  },
  "settings.spam.empty": {
    "message": "No spam addresses",
    "description": "settings > spam. src/renderer/settings.js (render)"
  },
  "settings.sync.fifteenMinutes": {
    "message": "Every 15 minutes",
    "description": "settings > sync. src/renderer/settings.js"
  },
  "settings.sync.fiveMinutes": {
    "message": "Every 5 minutes",
    "description": "settings > sync. src/renderer/settings.js"
  },
  "settings.sync.hour": {
    "message": "Every hour",
    "description": "settings > sync. src/renderer/settings.js"
  },
  "settings.sync.manual": {
    "message": "Manual",
    "description": "settings > sync. src/renderer/settings.js"
  },
  "settings.sync.minute": {
    "message": "Every minute",
    "description": "settings > sync. src/renderer/settings.js"
  },
  "settings.sync.thirtyMinutes": {
    "message": "Every 30 minutes",
    "description": "settings > sync. src/renderer/settings.js"
  },
  "settings.theme.dark": {
    "message": "Dark",
    "description": "settings > theme. src/renderer/settings.js"
  },
  "settings.theme.light": {
    "message": "Light",
    "description": "settings > theme. src/renderer/settings.js"
  },
  "settings.theme.system": {
    "message": "Follow system setting",
    "description": "settings > theme. src/renderer/settings.js"
  },
  "settings.title": {
    "message": "Email settings",
    "description": "settings. src/renderer/settings.js (render)"
  },
  "settings.title.short": {
    "message": "Settings",
    "description": "settings > title. src/renderer/app.js (renderSidebar); src/renderer/app.js (listAction)"
  },
  "settings.vip.add": {
    "message": "Add VIP",
    "description": "settings > vip. src/renderer/settings.js (openSettings)"
  },
  "settings.vip.empty": {
    "message": "No VIPs yet. Add a sender from the More actions menu in an email.",
    "description": "settings > vip. src/renderer/settings.js (render)"
  },
  "setup.account.added": {
    "message": "{email} has been added",
    "description": "setup > account. src/renderer/setup.js (done)"
  },
  "setup.demo.action": {
    "message": "Try a demo account first",
    "description": "setup > demo. src/renderer/setup.js (showGrid)"
  },
  "setup.demo.name": {
    "message": "Demo User",
    "description": "setup > demo. src/main/engine.js"
  },
  "setup.fields.email": {
    "message": "Email address",
    "description": "setup > fields. src/renderer/setup.js (showLogin)"
  },
  "setup.fields.emailExample": {
    "message": "name@example.com",
    "description": "setup > fields. src/renderer/settings.js (openSettings); src/renderer/setup.js (showLogin)"
  },
  "setup.fields.hidePassword": {
    "message": "Hide password",
    "description": "Login form password visibility toggle when the password is visible."
  },
  "setup.fields.imap": {
    "message": "IMAP server",
    "description": "setup > fields. src/renderer/settings.js (render); src/renderer/setup.js (showLogin)"
  },
  "setup.fields.password": {
    "message": "Password",
    "description": "setup > fields. src/renderer/settings.js (render); src/renderer/setup.js (showLogin)"
  },
  "setup.fields.passwordHint": {
    "message": "Password or app password",
    "description": "setup > fields. src/renderer/setup.js (showLogin)"
  },
  "setup.fields.port": {
    "message": "Port",
    "description": "setup > fields. src/renderer/settings.js (render); src/renderer/setup.js (showLogin)"
  },
  "setup.fields.showPassword": {
    "message": "Show password",
    "description": "setup > fields. src/renderer/setup.js (showLogin)"
  },
  "setup.fields.smtp": {
    "message": "SMTP server",
    "description": "setup > fields. src/renderer/settings.js (render); src/renderer/setup.js (showLogin)"
  },
  "setup.fields.username": {
    "message": "Username",
    "description": "setup > fields. src/renderer/settings.js (render); src/renderer/setup.js (showLogin)"
  },
  "setup.fields.usernameHint": {
    "message": "Usually your email address",
    "description": "setup > fields. src/renderer/setup.js (showLogin)"
  },
  "setup.google.action": {
    "message": "Sign in with Google",
    "description": "setup > google. src/renderer/setup.js (showGoogle)"
  },
  "setup.google.cancelled": {
    "message": "Sign-in cancelled",
    "description": "setup > google. src/main/google.js"
  },
  "setup.google.closeTab": {
    "message": "You can close this tab.",
    "description": "setup > google. src/main/google.js"
  },
  "setup.google.failed": {
    "message": "Sign-in failed",
    "description": "setup > google. src/main/google.js"
  },
  "setup.google.help": {
    "message": "Your browser will open Google's sign-in page. Choose your account and allow Rukoo Mail to access Gmail. You will then return here automatically.",
    "description": "setup > google. src/renderer/setup.js (showGoogle)"
  },
  "setup.google.import": {
    "message": "Import Google OAuth client",
    "description": "setup > google. src/renderer/setup.js (showGrid); src/main/main.js"
  },
  "setup.google.invalidRequest": {
    "message": "Invalid request. Start sign-in again from Rukoo Mail.",
    "description": "setup > google. src/main/google.js"
  },
  "setup.google.passwordMode": {
    "message": "Use an app password",
    "description": "setup > google. src/renderer/setup.js (showGoogle)"
  },
  "setup.google.ready": {
    "message": "Google sign-in is ready",
    "description": "setup > google. src/renderer/setup.js (openSetup)"
  },
  "setup.google.return": {
    "message": "You can close this tab and return to Rukoo Mail.",
    "description": "setup > google. src/main/google.js"
  },
  "setup.google.signedIn": {
    "message": "Signed in to Google",
    "description": "setup > google. src/renderer/settings.js (openSettings)"
  },
  "setup.google.success": {
    "message": "You are signed in",
    "description": "setup > google. src/main/google.js"
  },
  "setup.google.title": {
    "message": "Sign in to Google",
    "description": "setup > google. src/renderer/setup.js (showGoogle)"
  },
  "setup.google.wait": {
    "message": "Waiting for sign-in in your browser...",
    "description": "setup > google. src/renderer/setup.js (showGoogle)"
  },
  "setup.google.waitToast": {
    "message": "Sign in through your browser...",
    "description": "setup > google. src/renderer/settings.js (openSettings)"
  },
  "setup.language.label": {
    "message": "Language",
    "description": "First-run provider picker: interface language selection."
  },
  "setup.manual.action": {
    "message": "Manual setup",
    "description": "setup > manual. Shared interface label."
  },
  "setup.providers.exchange.note": {
    "message": "Enter the IMAP and SMTP servers for your Exchange environment.",
    "description": "setup > providers > exchange. src/main/providers.js"
  },
  "setup.providers.google.note": {
    "message": "Use an app password from your Google account (myaccount.google.com/apppasswords). IMAP must be enabled in Gmail.",
    "description": "setup > providers > google. src/main/providers.js"
  },
  "setup.providers.office365.note": {
    "message": "Your administrator must enable IMAP and SMTP AUTH for your mailbox.",
    "description": "setup > providers > office365. src/main/providers.js"
  },
  "setup.providers.other.label": {
    "message": "Other",
    "description": "setup > providers > other. src/main/providers.js"
  },
  "setup.providers.other.note": {
    "message": "We suggest servers based on your domain. Adjust them if needed.",
    "description": "setup > providers > other. src/main/providers.js"
  },
  "setup.providers.outlook.note": {
    "message": "Only works if your account allows IMAP with a password or app password.",
    "description": "setup > providers > outlook. src/main/providers.js"
  },
  "setup.providers.yahoo.note": {
    "message": "Yahoo requires an app password (Account security > Generate app password).",
    "description": "setup > providers > yahoo. src/main/providers.js"
  },
  "setup.signIn.action": {
    "message": "Sign in",
    "description": "setup > signIn. src/renderer/setup.js (showLogin); src/renderer/setup.js (openSetup)"
  },
  "setup.signIn.pending": {
    "message": "Signing in...",
    "description": "setup > signIn. Setup login form: progress label while connecting to the account."
  },
  "setup.signIn.title": {
    "message": "Sign in to {provider}",
    "description": "setup > signIn. Provider login form heading; provider is a provider display name."
  },
  "setup.title": {
    "message": "Set up email",
    "description": "setup. src/renderer/setup.js (showGrid)"
  }
};
  if (typeof module === 'object' && module.exports) module.exports = messages;
  else (root.RukooLocales ||= {})['en'] = messages;
})(globalThis);
