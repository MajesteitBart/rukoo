---
pageId: "rk-hermes-connect"
slug: "agents/hermes"
title: "Connect Hermes Agent"
description: "Connect a Hermes API server and give it Rukoo tools."
docType: "how-to"
productArea: "agents"
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

You need a running Hermes API server, its address and its API key. If Hermes runs on another computer, both computers need the supported Tailscale route for its bridge.

1. Open **Settings** > **Agents** and the Hermes card.
2. Enter the API server address and key, and test the connection.
3. To give Hermes Rukoo tools, turn on **Let Clark use Rukoo** and choose **Copy Hermes setup**.
4. Follow the copied setup on the Hermes computer. It downloads the bridge for this Rukoo release and supplies the Hermes configuration block.
5. Follow the [tagged Hermes setup guide on GitHub](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/integrations/hermes/README.md) to finish the bridge setup.
6. Keep Rukoo open, choose Hermes in the agent panel and ask it about a test email.

The API connection lets you chat. The bridge is the return connection that lets Hermes use Rukoo's mail, calendar and meeting tools. Check [Permission level](/agents/permissions/) before asking it to act.

## If chatting works but tools fail

Check that the bridge can find a running Rukoo device. Keep desktop devices updated: an older device can advertise an older tool set. Updating Rukoo does not update the bridge on the Hermes computer. A bridge protocol mismatch names which side needs updating; copy the setup again for the current release.

Rukoo can remain open in the tray when its window closes. Check **Close to the tray** in **Settings** > **General** if the connection disappears when you close the window.
