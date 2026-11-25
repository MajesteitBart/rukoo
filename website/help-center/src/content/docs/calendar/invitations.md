---
pageId: rk-answer-invitation
slug: calendar/invitations
title: "Answer a calendar invitation"
description: "Respond from an email or open an ICS invitation."
docType: how-to
productArea: calendar
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

An invitation in an email appears as a card above the message. Check the organizer, time, place and guests before answering.

## Reply from the email

1. Open the invitation email.
2. Read the card's explanation of how your answer will reach the organizer.
3. Select **Yes**, **Maybe** or **No**.

When the event belongs to a calendar that can answer it, Rukoo sends your response through that calendar. **Open in calendar** opens the event.

Otherwise Rukoo emails an iCalendar response from the account that received the invitation. The card names the organizer's address and remembers your answer.

## Open an ICS file

Open the `.ics` attachment in Rukoo, or choose Rukoo from your operating system's **Open with** menu for a saved `.ics` file. Rukoo shows the same event card in a dialog. Response buttons appear when the file invites one of your accounts.

On Windows, the installer registers Rukoo as an available app for `.ics` files. You can choose it under **Settings** > **Apps** > **Default apps** in Windows.

## Keep a copy in a calendar

Use **Add to calendar** and pick a calendar if you want your own copy. The copy has no guests and later changes from the organizer will not update it. Rukoo refuses to copy a series with moved or cancelled occurrences because its repeat rule alone would give the wrong dates.

A cancelled invitation shows as cancelled and has no response buttons. For a CalDAV calendar whose server does not send invitations, an emailed response leaves any separate calendar copy as it was.

Read more: [Calendar guide (GitHub)](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/calendar.md).
