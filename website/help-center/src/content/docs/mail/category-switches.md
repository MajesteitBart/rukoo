---
pageId: rk-category-switches
slug: mail/category-switches
title: "Inbox category switches"
description: "Look up Show in Inbox and Notifications, their defaults and device behavior."
docType: reference
productArea: mail
appliesTo: ["Mail 2.4.0 desktop", "Android 0.6.0"]
reviewed: "2026-11-24"
behaviorChecked: null
---

Each inbox category has separate switches for visibility and notifications. This reference follows the guides included in Rukoo Mail 2.4.0, paired with Android 0.6.0.

| Switch | Default | When off | Scope |
| --- | --- | --- | --- |
| **Show in Inbox** | On | Excludes the category's mail from Inbox and its unread contribution from the Inbox count and badge. The category keeps its own mail and count. | Synced across computers and phones with a Rukoo account. |
| **Notifications** | On | Suppresses new-mail notifications for that category. | Per device. A phone and a computer can differ. |

## Locations

- **Show in Inbox**: the category dialog under **Settings > Inbox categories**.
- **Notifications**, desktop: **Settings > General > Inbox categories**.
- **Notifications**, Android: **Settings > Inbox categories**.

## Related behavior

Turning off **Show in Inbox** leaves the mail available in search, Unread and VIP views. Notifications follow their own switch. Unread mail older than the messages kept for the inbox can lack a category and still count toward Inbox.

Turning off **Notifications** leaves the taskbar's new-mail badge counting all new mail. While Jev is enabled, uncertain mail can wait up to 20 seconds for classification before its category decides whether to notify.

For steps, see [Hide Promotions from Inbox](/mail/hide-category/).

Source: [Inbox categories](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/categories.md), Rukoo Mail 2.4.0.
