---
pageId: rk-connect-calendar
slug: calendar/connect
title: "Connect a calendar"
description: "Show Google and CalDAV calendars in Rukoo."
docType: how-to
productArea: calendar
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Open **Calendar** to see calendars from your connected accounts. These steps apply to the desktop app. Android 0.6.0 has no calendar.

## Connect Google Calendar

Start with a Gmail or Google Workspace account connected through Google sign-in. The Google OAuth client used for that account needs the Google Calendar API enabled in its Cloud project. If someone manages the client for you, ask them to enable it.

1. Open **Calendar** in the title bar.
2. If the account offers **Connect calendar**, select it.
3. Sign in to Google in the browser and allow calendar access.
4. Return to Rukoo and check the calendars in the sidebar. Press `F5` to sync if needed.

A Google API error in the calendar has a button to the API's Google Cloud page. Enable the Google Calendar API there, then try again. Your existing mail access stays in place when you connect the calendar.

## Connect a CalDAV calendar

You need an IMAP account whose provider offers CalDAV. Rukoo uses that account's mail username and password for the calendar too.

1. Open the account's **Server settings**.
2. In **Calendar server (CalDAV)**, enter the provider's CalDAV address. A host name is enough when the server supports CalDAV discovery.
3. Save the settings. Rukoo checks the address before saving.
4. Open **Calendar** and check the calendars in the sidebar.

Use the address your provider supplies. If the server redirects to another host, Rukoo names it. Check it with your provider before entering that host yourself.

## Show a colleague's calendar

For Google, first add the shared calendar under **Other calendars** in Google Calendar. Your access must include event details. Back in Rukoo, press `F5` and switch the calendar on in the sidebar.

CalDAV calendars shared into your calendar home appear at the next sync. A calendar marked **Read-only** in **Settings** > **Calendar** can be viewed. Choose a writable calendar when you [create an event](/calendar/create-event/).

Microsoft 365 and Outlook calendars are not supported in this version.

Read more: [Calendar guide (GitHub)](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/calendar.md).
