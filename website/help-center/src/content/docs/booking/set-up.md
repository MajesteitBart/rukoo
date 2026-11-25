---
pageId: rk-set-up-booking
slug: booking/set-up
title: "Set up a booking page"
description: "Publish a link where guests can choose a time with you."
docType: how-to
productArea: calendar
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

You need a [Rukoo account](/account/create/), an account server that supports booking pages, and a Google calendar or a CalDAV calendar whose server sends invitations. Keep Rukoo running on the computer that will handle bookings. A demo calendar lets you try setup, but sends no invitations.

## Turn on your page

1. Open **Settings** > **Booking page**. Sign in to your Rukoo account if asked.
2. Set **Link** to a handle of 3 to 32 lowercase letters, digits or hyphens. Wait for Rukoo to say it is available.
3. Check **Your name on the page** and **Time zone**.
4. Check **Available hours**. Setup starts with your working hours from **Settings** > **Calendar**.
5. Under **Check these calendars for conflicts**, include every calendar whose busy time should block a booking.
6. Under **Add bookings to**, choose the calendar that should create events and send invitations. Read the address shown for the invitations.
7. Select **Turn on**.
8. Use **Preview page** to check the page, then **Copy link** to share its address.

The page starts with a **30 minute meeting** type. Review its [booking rules](/booking/rules/) before sharing the link widely.

## Keep invitations moving

The server takes bookings while the computer is off. Your computer adds them to the calendar and causes invitations to go out when Rukoo runs again. Leave it on when you expect bookings.

For a second computer, read [How bookings reach your calendar](/booking/how-it-works/) before selecting **Use this computer**.

## Add your link to mail

Choose **Add to signature** after setup, or open **Settings** > **Signatures** > **Booking link under signature**. In the composer, the calendar button also offers **Insert booking link**.

Turning on a booking page shares your open and busy times and meeting types with the account server. Read the [booking privacy explanation](/booking/how-it-works/#what-the-server-handles) before using it for a private calendar.

Read more: [Booking guide (GitHub)](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/booking.md).

Next: [add a video service](/booking/video/), [change hours for a date](/booking/hours/) or [turn the page off](/booking/turn-off/).
