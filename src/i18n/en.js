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
    "description": "common > status. Shared interface label."
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
    "description": "native > attachments. src/renderer/composer.js (mountComposer); src/main/main.js"
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
    "message": "Scale email content to fit the window.",
    "description": "settings > general. src/renderer/settings.js (render)"
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
