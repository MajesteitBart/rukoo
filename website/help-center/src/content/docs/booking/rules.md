---
pageId: rk-booking-rules
slug: booking/rules
title: "Booking page rules and limits"
description: "Look up meeting lengths, notice, buffers and approval rules."
docType: reference
productArea: calendar
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Open **Settings** > **Booking page** and edit a meeting type. These are the rules supported by Mail 2.4.0. The account server also needs support for the selected features.

## Meeting types

A page supports up to 10 meeting types. Each has its own link.

| Setting | Default | Choices or behavior |
| --- | --- | --- |
| Available durations | 30 minutes | 15, 20, 30, 45 or 90 minutes, or 1 to 4 hours |
| Default duration | The selected duration | One of the available durations; selected when the guest opens the page |
| Free time before / Free time after | None | 5, 10, 15, 30, 45 or 60 minutes |
| Minimum notice | 4 hours | None, 30 minutes, 1, 2, 4, 8 or 12 hours, 1 or 2 days, or a week |
| How far ahead | 30 days | 7, 14, 30, 60 or 90 days |
| Start times every | Same as the chosen duration | 5, 10, 15, 20, 30 or 60 minutes |
| At most per day | No limit | 1 to 6, 8, 10, 15 or 20 |
| Needs your approval | Off | Bookings wait as requests until accepted |
| Hide from the page | Off | Guests need the meeting type's own link |

The time rules sit under **When guests can book**. Approval and hiding sit under **More options**.

With several durations, the guest chooses the length on the page. A booking keeps that length when it moves. Update every computer that uses your Rukoo account before setting several durations: older versions can reduce a type to its default duration when they save settings or take over bookings.

## Busy time and hours

The page uses working hours from **Settings** > **Calendar** until **Use different hours for my booking page** is on. A separate schedule supports up to six time ranges a day. **Dates with other hours** can block a whole day or change one date's hours.

Calendars with **Counts toward availability** on supply busy time. Busy events you have not declined count, including unanswered invitations and **Maybe** responses. A busy all-day event blocks the day in the page's time zone.

## Requests and stale availability

| Condition | Result |
| --- | --- |
| A meeting type needs approval | A request holds the time until you accept or decline |
| An unanswered request | Lapses after 48 hours or at its start minus minimum notice, whichever is sooner |
| No availability update for 24 hours | New bookings become requests; guests cannot move confirmed bookings |
| No availability update for 7 days | No times offered; the contact line appears |
| A calendar cannot be read for 12 hours | New bookings need approval |

## Page-wide limits

**Bookings per day** defaults to 20 and can be set from 1 to 50. The page holds at most 500 future bookings. A guest can move a booking twice.

The daily mail limit is 10 changes that cause your calendar to send mail: new bookings, accepted requests, and guest moves or cancellations. Past it, new bookings become requests and guest moves wait. Requests you accept can still send invitations. Guests can still cancel. Google then removes the event without cancellation mail; CalDAV servers that send invitations send their own mail.

See [Move or cancel a booking](/booking/manage/) for the host's steps.

Read more: [Booking guide (GitHub)](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/booking.md).
