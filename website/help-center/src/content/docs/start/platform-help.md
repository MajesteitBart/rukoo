---
pageId: "rk-platform-help"
slug: "start/platform-help"
title: "Platform and update troubleshooting"
description: "Find your profile, resolve desktop prerequisites and choose an update channel."
docType: "reference"
productArea: "platforms"
appliesTo: ["Mail 2.4.0 desktop", "Android 0.6.0 platform reference"]
reviewed: "2026-11-25"
behaviorChecked: null
---

## Mail platform support

| Platform | Mail 2.4.0 status | Package |
| --- | --- | --- |
| Windows 10 or 11 x64 | Supported | Installer or portable executable |
| Linux x64 | Supported | Debian/Ubuntu `.deb` or AppImage |
| macOS 13+ | Experimental | Apple Silicon or Intel DMG/ZIP |
| Android 12+ | Experimental, Android 0.6.0 | APK |

Voice has [its own requirements](/meetings/requirements/). Browser chat needs a supporting account-server deployment and provides team chat rather than the desktop mailbox and calendar.

## Desktop profiles and credentials

| Platform | Rukoo Mail profile | Required credential storage |
| --- | --- | --- |
| Windows | `%APPDATA%\Rukoo Mail` | Windows user account's DPAPI |
| macOS | `~/Library/Application Support/Rukoo Mail` | Unlocked login Keychain |
| Linux | `$XDG_CONFIG_HOME/Rukoo Mail`, or `~/.config/Rukoo Mail` | Unlocked GNOME Keyring or KWallet |

**Settings** > **About** shows the actual profile path. Sync errors are in `data/logs/rukoo.log`. Sign in again when changing operating systems; encrypted credentials are tied to system storage.

## Updates

Open **Settings** > **About** for **Check for updates** and **Update channel**. **Stable** follows tested releases. **Nightly** follows development builds. Returning from Nightly to Stable waits for the next newer stable version.

| Package | Update route |
| --- | --- |
| Windows installer or Linux AppImage | Can download a newer release when it has update metadata, then offer **Restart to update**. Save work before restarting. |
| Portable Windows, Linux `.deb` or ad-hoc signed Mac app | Opens the release page. Download and install the matching package. |

Use [GitHub Releases](https://github.com/MajesteitBart/rukoo/releases) for manual downloads. Update Voice separately. Keep every computer handling bookings on a compatible current version.

## Common startup problems

- **Linux AppImage will not mount:** install FUSE 2, use the `.deb`, or use the documented `--appimage-extract-and-run` option. Keep Chromium's sandbox enabled.
- **Linux cannot save credentials:** unlock the desktop keyring before trying again.
- **macOS cannot use an email link:** move Rukoo Mail to Applications, then choose **Settings** > **General** > **Email links** > **Use Rukoo Mail**.
- **Notifications are missing:** [send a test notification](/mail/notifications/) and check system permissions.
- **An installed agent cannot be found:** set its executable path in the [agent card](/agents/connect/).

Report the version, package type, operating system, exact error and the steps that led to it. Use fictional data when reproducing a problem.
