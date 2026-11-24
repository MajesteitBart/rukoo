# Tabs

The title bar has a tab for each part of Rukoo: Mail (`Ctrl+1`), Calendar (`Ctrl+2`), Meet (`Ctrl+3`) and, while the server of your [Rukoo account](account.md) has team chat, Chat (`Ctrl+4`). Settings → General → Tabs turns each of them on or off. Someone who only uses team chat can turn off Mail, Calendar and Meet; someone who only reads mail can turn off the rest.

## What turning a tab off does

A tab you turn off is gone from the desktop app:

- Its tab leaves the title bar, and its shortcut does nothing. With one tab left, the title bar shows no tabs at all.
- The window leaves it at once, for the first tab that still shows, and starts in a tab that shows after a restart.
- It sends no notifications, toasts or sounds, and counts nothing on the taskbar badge, the Dock or the tray icon. Its notifications close when you turn it off: those still on screen, and on Windows also those left in the notification center after their banner timed out. Rukoo keeps track of the last 20 per tab there and takes older ones down. Clicking one that stayed behind does nothing.
- Mail off: new mail doesn't count on the badge or in the tray's tooltip, and New email leaves the tray menu. An email link (`mailto:`) opened with Rukoo starts no email; the main window says Mail is off and offers Turn on, which turns Mail on and then starts that email. Rukoo never asks you to add a mail account for it, and forgets the link when the notice goes, or after two minutes. An email or a draft you open from the chat panel or from the inbox sorting panel gets the same notice, and Turn on opens it as it is then: the draft the card has by then, and the same email even when the server numbered its folder anew. When the email is gone by then, a notice says so and nothing opens. Until then the email stays as it is, unread too, also when you turn Mail off while it was still loading. A chat you pick in the chat panel opens without its email.
- Calendar off: no event reminders and no booking notifications. An invitation in an email shows what it says (title, time, place, guests and the meeting link) without Accept, Add to calendar, Open in calendar or the list of your calendars, and the composer has no calendar button for free times and the booking link, also in a compose window that is open. What was open of them closes at once and adds or inserts nothing: an invitation's list of calendars, the dialog of a calendar file and the free-times dialog. A calendar file (`.ics`) opened with Rukoo shows the notice with Turn on, which turns Calendar on and opens the file. Nothing waits: if you leave Calendar off, open the file again later.
- Meet off: the recording clock leaves the title bar and Record leaves calendar events. Rukoo Voice still records when you start it there.
- Chat off: no chat notifications, and messages that came in while it was off don't alert afterwards. An invitation link you signed up with waits; the window says Chat is off once, and Turn on opens the Join dialog.

The setting is saved with your other settings, applies at once and survives a restart.

### Emails you are writing

Turning Mail off never takes an unsent email out of sight. A compose window you have open stays until you close it, and it still sends, saves its draft and closes as usual. An email that comes back from Undo send, or that the server refused, opens its editor in a compose window while Mail is off. So does an email that Rukoo reopens at the next start because it couldn't send it before quitting.

## What it leaves alone

Turning a tab off isn't disconnecting. Accounts, cached mail and events, meetings, workspaces and background sync stay as they were, and agents keep their tools for mail, calendar and meetings. Turn the tab on again and it picks up where it left off, with what came in meanwhile. Sync costs what it cost before; turning Mail off doesn't stop it.

## Rules

- At least one tab you can use stays on. The switch of the only one left can't be turned off, and says why.
- Mail, Calendar and Meet need a mail account. If you use Rukoo with only a Rukoo account, Chat is the tab you can use, so its switch stays on. A setting from an older version that turned Chat off as well still opens Rukoo in Chat.
- A switch saves the tabs as they show. If the setting turns off a tab that shows anyway, because it is the one that stays, the next switch you use saves that tab as on, so the other switches stay free.
- Chat can be turned off, but turning it on doesn't make it appear: it shows only while the server has team chat. If you turned everything off except Chat and Chat goes away, for example after you sign out, Mail shows until Chat is back.
- Someone who uses team chat without a mail account sees the setup page when they pick Mail, Calendar or Meet. That page also offers "Use Chat only, without email", which turns those three off. Settings then opens on General instead of on mail accounts.
- When the setup page is the first page Rukoo shows, for a profile with a Rukoo account or with tabs turned off, it has a Settings button, so Tabs stays within reach.
- The browser app at rukoo.io has Chat only and doesn't use this setting. Rukoo for Android doesn't have it yet.
