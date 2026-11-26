---
pageId: "rk-google-sign-in"
slug: "mail/google-sign-in"
title: "Set up Google sign-in"
description: "Import a Google desktop OAuth client and connect Gmail or Google Workspace."
docType: "how-to"
productArea: "mail"
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Google sign-in needs a Google OAuth client of type **Desktop app**. Released Rukoo builds do not include one. Ask the person who manages your Google Cloud project for its downloaded client JSON file. For Workspace, your administrator may need to trust the app for the `https://mail.google.com/` scope.

## Import the client and sign in

1. Open the mail setup screen. If you already have a mailbox, choose **Settings** > **Accounts** > **Add account**.
2. Choose **Import Google OAuth client** and select the downloaded JSON file.
3. Choose **Sign in with Google**. Complete sign-in in your browser with the Google account you want to add.
4. Return to Rukoo and check that the account appears in the sidebar and its Inbox loads.

An unverified Google consent screen can show a warning. Check the app and project with the person who supplied the client before granting access.

The imported file is `google-oauth.json` in your Rukoo profile. Rukoo also accepts a client supplied through its environment; that takes priority over the file. [Profile locations](/start/platform-help/) lists the folders.

## Use a Google calendar too

Calendar access also needs the Google Calendar API enabled in the same project and calendar permissions. Follow [Connect a calendar](/calendar/connect/).

## If sign-in fails

Check that the client is a Desktop app client, that Workspace allows it and that the browser used the intended account. A mailbox using [an app password](/mail/providers/) is a separate setup route. [Connection recovery](/mail/connection-help/) explains which provider failures a password can resolve.
