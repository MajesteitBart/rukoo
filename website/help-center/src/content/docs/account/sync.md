---
pageId: rk-account-sync
slug: account/sync
title: "What a Rukoo account syncs"
description: "Understand settings sync, mail connections and signing in on another device."
docType: explanation
productArea: account
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Your Rukoo account keeps Rukoo's own data the same on your devices. Your mail provider continues to hold your mailbox.

## What travels between devices

The account syncs your inbox categories, the category assigned to each email, your corrections and your booking-page settings. The device encrypts these records before sending them. The password gives your devices access to the key that opens them.

Your mail and mail passwords stay with your mail provider and on each device. Connect the mailbox separately on another device to read that mail there.

## Add a second device

On the other device, open **Settings > Rukoo account** and choose **Sign in** with the same server, email address and password. It downloads the account's records and adds its own. When the same item changed on two devices, the newest change wins.

Sync runs every five minutes, shortly after a change and when you choose **Sync now**. Changes made offline wait for the next connection.

## Which settings can differ

**Show in Inbox** for a category syncs through the account. Its **Notifications** setting belongs to each device. You can keep a quiet phone and a notifying computer. See [inbox category switches](/mail/category-switches/).

## Team conversations

Chat messages live on the workspace server. The host can read them, including direct messages. Read [how account and chat privacy differ](/chat/privacy/) before sharing sensitive information.

Source: [Account sync](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/account.md), [Category sync](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/categories.md), [Account labels](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/src/i18n/en.js), Rukoo Mail 2.4.0.
