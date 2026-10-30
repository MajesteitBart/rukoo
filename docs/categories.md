# Inbox categories

Inbox categories split the inbox, like Gmail's tabs, for every kind of account: Gmail, Outlook, any IMAP server and the demo account. Rukoo doesn't label, flag or move anything on the mail server, so other mail apps see your inbox as before. The categories, the category each email got and your corrections live in Rukoo's own data, and with a [Rukoo account](account.md) every device shows the same.

They show under Inbox in the sidebar, on the phone in the folder drawer. Inbox itself still shows all of it, unless you [keep a category out of it](#keeping-a-category-out-of-inbox). Each email in Inbox carries a label with its category's color and name, on the computer and on the phone. Search results and views built from the inbox, such as VIPs, show the label too. A category's own tab has its color at the top of the list, with a dot before its name. The first start of Rukoo 2.1 offers to set them up step by step (Settings → About → What's new opens that again), or turn them on in Settings → General → Inbox categories.

## The categories

Rukoo starts with five:

| Category | What goes there |
| --- | --- |
| Needs you | Mail from people that asks you to do something: reply, decide, approve, sign, pay or show up |
| To read | Mail worth reading that needs nothing from you: news from colleagues, threads you're copied on |
| Money | Invoices, payment requests, receipts, order confirmations, bank and tax mail |
| Updates | Automatic notifications: deliveries, account and security alerts, comments and mentions in apps |
| Promotions | Newsletters, marketing, offers and discounts |

Change their names, descriptions and colors, move them up and down, delete them, or add your own, up to twelve. The description says what belongs in a category; Jev reads it to decide (see below). Rukoo's own five follow the app's language until you change their text.

Each email goes to one category. When several fit, the one higher in the list wins. **Inbox** shows the whole inbox, apart from the categories you keep out of it, and **When Rukoo isn't sure** picks the category for mail Rukoo can't place.

## Keeping a category out of Inbox

Each category has a **Show in Inbox** switch in its dialog under Settings → Inbox categories. It is on for every category until you turn it off. Then that category's mail leaves Inbox itself, both for one account and for All inboxes, and a crossed-out eye marks the category under Inbox in the sidebar (on the phone, the folder drawer) and in Settings. The category itself still shows all its mail and its own unread count.

Its unread mail no longer counts toward Inbox: not in the sidebar's Inbox count, the counts per account, the taskbar badge or the tray icon. That holds for both badge settings, new mail and unread mail. Unread mail older than the messages Rukoo keeps for the inbox has no category, so it keeps counting. On the phone, the folder drawer's Inbox count and the number on the launcher badge leave it out. **Mark all as read** in Inbox marks only what Inbox lists, and in a category only that category's mail.

A search covers every category, as it always does, so it still finds this mail. The Unread and VIP views also still show it, and so do its notifications. The switch is part of the category, so with a Rukoo account every computer and phone follows it.

## Notifications

Each category has a **Notifications** switch in its dialog, under Settings → General → Inbox categories (on the phone, Settings → Inbox categories). It starts on. Turn it off, and new mail in that category shows no notification; a bell with a line through it marks the category in the list. The switch is set per device, like Settings → General → Notifications, so a phone and a computer can differ.

While a category's notifications are off and Jev is on, the notification for an email the rules aren't sure about waits for Jev and follows the category Jev gives it. After 20 seconds without an answer, the category the email has by then decides. Rukoo decides straight away for mail the rules are sure about, and when Jev is off, waits for TypeSafe or stopped because TypeSafe refused the key. While every category notifies, notifications come at once, as without categories. The taskbar badge still counts all new mail. On the phone, mail that waited for Jev joins its account's notification without a second sound, and a background sync waits for it before it ends.

## Moving mail

Right-click an email, or choose More with several selected, and pick **Move to category**. On Android, press and hold an email (or select several) and choose More, or use More in the open email. The toast that follows offers **Also future mail**: then every later email from that sender goes there too. Settings lists these senders, and you can remove a rule there.

## How Rukoo sorts

An email's category is the first that applies of:

1. the category you moved that email to;
2. a rule for its sender;
3. the category it got when it was first sorted;
4. what the rules say now.

The rules read what an email says about itself: unsubscribe links, bulk and campaign headers, automatic senders such as `noreply@`, money words in the subject in English and Dutch, whether you're in To or only in Cc, whether you've written to the sender, and for Gmail accounts the tab Gmail put it in (`X-GM-RAW "category:…"`). VIPs go to Needs you. The rules only know Rukoo's own five categories.

The first device to sort an email stores the result in the Rukoo account; the others use it, so a phone and a computer show the same. **Sort the inbox again** sorts every inbox email from the start, apart from the ones you moved yourself.

## Jev

Jev, a decision model by [TypeSafe](https://docs.typesafe.ai), can sort the mail the rules aren't sure about, into any of your categories, using their descriptions. It needs your own TypeSafe API key: add it under Settings → General → Inbox categories → TypeSafe API key. The key stays on that computer, encrypted like your mail passwords.

With Jev on, that computer sends each new inbox email's sender, subject and first 1,000 characters, a few header facts (mailing list, sent in bulk or automatically, Gmail's tab) and your category names and descriptions to TypeSafe, Inc. in the United States. TypeSafe's own terms apply to what it keeps. Nothing else leaves the computer, and mail the rules are sure about, such as a `noreply@` alert, doesn't go to Jev. Rukoo asks for one category per email, with `jev-1.13.0`, and takes Jev's answer when its confidence is at least 0.5; otherwise the email goes to the category for when Rukoo isn't sure.

When TypeSafe refuses the key, Rukoo stops using Jev until you enter another one. When TypeSafe is busy or out of reach, Rukoo tries again after a few minutes. Meanwhile the rules give every email a category.

### Seeing what Jev does

While Jev works through the inbox, a line above the sync status in the sidebar says so and counts along, such as "Jev is sorting 12/48"; emails move to their categories as Jev answers. After a sort you asked for (turning categories on, a new key, Sort the inbox again) it says how many emails were sorted for a few seconds. When TypeSafe is busy or out of reach it says until when Jev waits, and when TypeSafe refused the key it says that until you enter another one. A quick sort of new mail shows nothing.

Click the line for the details: how far the sort is, with an estimate of the time left, why Jev waits and how many emails wait for it, and Jev's last decisions, each with the category it went to and how sure Jev was. Click a decision to open that email in its category. After the "What's new" guide sets up Jev, these details open by themselves. On the phone the line is in the folder drawer, and a tap opens the details as a sheet.

## Limits

- Categories apply to the inbox, in the newest messages Rukoo keeps for it.
- Without Jev, mail from people is split only by whether you're in To or Cc, so Needs you and To read are a rough guess.
- On the phone, a new-mail notification that lists only mail of a hidden category can still put a dot on the launcher icon: Android badges every notification, and only the number leaves that mail out.
