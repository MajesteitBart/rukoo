---
pageId: "rk-account-recovery"
slug: "account/devices-and-recovery"
title: "Devices, passwords and account recovery"
description: "Look up sign-in on another device and recovery-key consequences."
docType: "reference"
productArea: "account"
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

A Rukoo account syncs categories, corrections and booking settings. Set up mail-provider sign-ins separately on each computer. [Account sync](/account/sync/) lists what the account carries.

## Another device

Choose **Sign in** in **Settings** > **Rukoo account**, using the same server, email and password. The device downloads account records and adds its own. The newest change to the same item wins. **Sync now** requests a sync immediately.

Signing in does not transfer responsibility for bookings. Check which computer handles your page and connect its video services before [using another booking computer](/booking/how-it-works/).

## Password and recovery controls

| Control | Effect |
| --- | --- |
| Devices | Lists signed-in devices and lets you sign one out. Local account records can remain; chat's local copy is removed when its session ends. |
| Change password | Signs out other devices. Use the new password there. |
| New recovery key | Replaces the previous key, which stops working. |
| Forgot your password? | Uses your saved recovery key and a new password. Signs out every device. |

The recovery key is shown once when the account is created. Keep it in a password manager or another place you can recover independently of this computer.

If both password and recovery key are lost, the server cannot recover the encrypted account records. That includes your corrections and custom categories. Keep access to the current device while checking what you still need.

For a workspace's messages and the effects of signing out, see [Workspace roles and limits](/chat/roles-and-limits/). For meeting media, use [Voice storage](/voice/storage/); it has its own bucket encryption key.
