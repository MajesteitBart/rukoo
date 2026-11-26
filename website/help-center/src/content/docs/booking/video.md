---
pageId: "rk-booking-video"
slug: "booking/video"
title: "Add a video service to bookings"
description: "Connect Jitsi, Zoom or Teams on the computer that handles bookings."
docType: "how-to"
productArea: "calendar"
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

You need a [booking page](/booking/set-up/) and a Google or invitation-capable CalDAV calendar. Connect the video service on the computer that handles bookings. Sign-ins stay on that computer.

## Connect a service

1. Open **Settings** > **Video meetings**.
2. For Jitsi Meet, turn it on. You can use meet.jit.si or your own Jitsi server.
3. For Zoom or Microsoft Teams, supply a registered OAuth client if the card offers **Add client file…**, then connect and complete sign-in in your browser. Teams needs a work or school account with Teams.
4. Open **Settings** > **Booking page** and edit a meeting type. Choose the connected service under **Location**.
5. Check that this is the computer handling bookings before sharing the type's link.

Each booking gets its own link when Rukoo creates the calendar event. The guest receives it in the invitation. The calendar's ordinary event dialog still offers Google Meet only.

## OAuth client requirements

Released builds include no Zoom or Teams client. The [tagged client-registration guide on GitHub](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/booking.md#zoom-and-teams-clients) lists redirects, scopes and file formats for the person registering your app. Use `zoom-oauth.json` or `teams-oauth.json` through Add client file…. Microsoft organizations may require administrator consent.

On meet.jit.si, the first person in a room must sign in before others can join.

## Recover a missing link

A service failure can leave a confirmed booking and its calendar invitation without a video link. Open the notice's **Video meetings** button. Renew the connection if asked, then add a meeting link to the event yourself or cancel the booking.

Connect the service on a replacement booking computer before **Use this computer**. Update every Rukoo computer before using video locations. Moving or cancelling a booking also moves or deletes its Zoom or Teams meeting; a Jitsi room keeps its name.
