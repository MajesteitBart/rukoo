# Tabs

The title bar has a tab for each part of Rukoo: Mail (`Ctrl+1`), Calendar (`Ctrl+2`), Meet (`Ctrl+3`) and, while the server of your [Rukoo account](account.md) has team chat, Chat (`Ctrl+4`). Settings → General → Tabs turns each of them on or off. Someone who only uses team chat can turn off Mail, Calendar and Meet; someone who only reads mail can turn off the rest.

## What turning a tab off does

A tab you turn off is gone from the desktop app:

- Its tab leaves the title bar, and its shortcut does nothing. With one tab left, the title bar shows no tabs at all.
- The window leaves it at once, for the first tab that still shows, and starts in a tab that shows after a restart.
- It sends no notifications, toasts or sounds, and counts nothing on the taskbar badge, the Dock or the tray icon.
- Mail off: new mail doesn't count on the badge or in the tray's tooltip, and New email leaves the tray menu. An email link (`mailto:`) opened with Rukoo starts no email; the main window says Mail is off and offers Turn on. Rukoo never asks you to add a mail account for it.
- Calendar off: no event reminders and no booking notifications. A calendar file (`.ics`) opened with Rukoo waits until Calendar is on again, and Open in calendar leaves invitation cards.
- Meet off: the recording clock leaves the title bar and Record leaves calendar events. Rukoo Voice still records when you start it there.
- Chat off: no chat notifications, and messages that came in while it was off don't alert afterwards. An invitation link you signed up with waits; the window says Chat is off once, and Turn on opens the Join dialog.

The setting is saved with your other settings, applies at once and survives a restart.

## What it leaves alone

Turning a tab off isn't disconnecting. Accounts, cached mail and events, meetings, workspaces and background sync stay as they were, and agents keep their tools for mail, calendar and meetings. Turn the tab on again and it picks up where it left off, with what came in meanwhile. Sync costs what it cost before; turning Mail off doesn't stop it.

## Rules

- At least one tab stays on. The switch of the only tab that shows can't be turned off.
- Chat can be turned off, but turning it on doesn't make it appear: it shows only while the server has team chat. If you turned everything off except Chat and Chat goes away, for example after you sign out, Mail shows until Chat is back.
- Someone who uses team chat without a mail account sees the setup page when they pick Mail, Calendar or Meet. That page also offers "Use Chat only, without email", which turns those three off.
- The browser app at rukoo.io has Chat only and doesn't use this setting. Rukoo for Android doesn't have it yet.
