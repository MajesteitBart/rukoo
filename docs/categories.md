# Inbox categories

Inbox categories split the inbox into tabs, like Gmail does, for every kind of account: Gmail, Outlook, any IMAP server and the demo account. Rukoo doesn't label, flag or move anything on the mail server, so other mail apps see your inbox as before. The categories, the category each email got and your corrections live in Rukoo's own data, and with a [Rukoo account](account.md) every device shows the same.

Turn them on in Settings → General → Inbox categories.

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

Each email goes to one category. When several fit, the one higher in the list wins. The **All** tab shows the whole inbox, and **When Rukoo isn't sure** picks the category for mail Rukoo can't place.

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

## Limits

- Categories apply to the inbox, in the newest messages Rukoo keeps for it.
- Without Jev, mail from people is split only by whether you're in To or Cc, so Needs you and To read are a rough guess.
