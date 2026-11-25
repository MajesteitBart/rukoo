---
pageId: rk-connect-account
slug: mail/connect-account
title: "Connect an IMAP mailbox"
description: "Add a mailbox with a password or app password and your provider's server settings."
docType: how-to
productArea: mail
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Connect a mailbox that accepts IMAP and SMTP password sign-in. Check the [provider requirements](/mail/providers/) first, especially for Google and Microsoft accounts.

## Before you start

Have your email address, password or app password, and your provider's IMAP and SMTP settings ready. Ask your mail administrator for the server names, ports and SSL/TLS requirements if you do not know them.

Start at **Set up email**. To add another mailbox later, open **Settings** and choose **Add account**.

## Sign in

1. Choose your provider. Choose **Other** for a provider without its own tile.
2. Fill in **Email address** and **Password**. For Yahoo, use an app password.
3. If you need to enter server settings, choose **Manual setup**. With **Other**, the fields are already open.
4. Enter **Username**, **IMAP server**, **SMTP server**, each **Port**, and the provider's **SSL/TLS** settings.
5. Choose **Sign in**.

Your account appears in the sidebar's account switcher. Open **Inbox** and select a message to read it.

## If sign-in fails

A refused password can mean your provider requires an app password or a different sign-in method. Check its requirements before trying again. For a server or connection error, check the manual settings against your provider's instructions.

For Gmail or Google Workspace, follow the Google route in [provider requirements](/mail/providers/).

Source: [Mail accounts](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/mail.md), [Setup form](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/src/renderer/setup.js), [English labels](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/src/i18n/en.js), Rukoo Mail 2.4.0.
