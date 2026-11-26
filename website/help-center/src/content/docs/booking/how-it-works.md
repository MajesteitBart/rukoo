---
pageId: rk-booking-model
slug: booking/how-it-works
title: "How bookings reach your calendar"
description: "Understand the server, the handling computer and booking privacy."
docType: explanation
productArea: calendar
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

A booking page has two jobs in two places. The account server offers the times your computer last published and takes bookings. Rukoo on one computer reads your calendars and turns those bookings into events.

This lets someone reserve a time while your computer is off. The calendar invitation follows when the handling computer runs Rukoo again.

## One computer handles the page

The computer that turns the page on handles bookings. It checks for new bookings every minute and publishes availability after calendar changes and at least every 30 minutes.

Other computers signed in to your Rukoo account can show the page and its bookings. **Settings** > **Booking page** says **Bookings are handled by …**. **Use this computer** transfers that job to the current computer.

Connect any video meeting service on the new computer before taking over. Those sign-ins belong to each computer and do not sync through your Rukoo account. Keep every computer on the same current release so they understand the same booking settings.

## Availability ages while the computer is off

The server initially keeps offering the last published times. After 24 hours without an update, new bookings need approval and guests cannot move confirmed bookings. After seven days, the page offers no times and shows your contact line.

If one calendar becomes unreadable, Rukoo uses its last good busy times for up to 12 hours. After that bookings need approval. Check the named account and reconnect before treating the page as current.

## What the server handles

The account server can read the page's name, introduction, time zone, meeting types, open hours and busy times rounded out to the quarter hour. Calendar event titles are left out of the published busy times.

A guest's name, email, note and assistant name pass through the server readable when they book. The server then seals those details for your devices. The server operator could read them at the moment of booking. It retains the booking time, type and status alongside the sealed details.

The booking settings and keys in your Rukoo account sync end-to-end encrypted. Your calendar provider receives the event and invitation through your calendar account.

The two guest links in an invitation give whoever has them control to move or cancel that booking. Keep them with the people who should have that control.

[Set up a page](/booking/set-up/) or [look up its time and approval rules](/booking/rules/).

Read more: [Booking guide (GitHub)](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/booking.md).
