# Review the help center

Use Mail 2.4.0 desktop with the English interface. The source has 60 pages and preserves every ID and URL from the 34-page source. Start the built preview with the commands in README.md.

## Product walkthrough

Use test mail and a test workspace with two people. Record the operating system, Mail version, account-server address and page ID with each result.

1. Install the matching stable package. Reach Set up email and read a demo message.
2. Connect a mailbox that permits IMAP/SMTP password access. Check the provider table against Google and Microsoft requirements.
3. Find a known message in This folder, This account and All accounts. Try an older server result while online.
4. Narrow a message list, mark it as read, and use Undo. Check that grouped messages are included.
5. Send a test message to yourself, then use Undo during the delay. Check 5 and 10 second settings.
6. Create a Rukoo account on a server accepting your invitation or operator-issued code. Save the recovery key. Sign in on a second test device and choose Sync now.
7. On a fresh install without a mailbox, paste a workspace invitation, sign in or create the account, join and send a greeting.
8. Invite one member and one guest. Check channels, the one-use link and expiry. Withdraw a spare invitation.
9. Reply in a thread and mention the other test person from the picker. In 2.4.0 the reply also appears in the main conversation.
10. Hide a category from Inbox, check notification behavior, and compare the account/privacy explanations with the host information shown in the app.

After a page passes, set its behaviorChecked date. Return corrections by page ID and step number. Keep real mailbox contents, invite links, recovery keys and account data outside the source tree.

## Calendar, booking, meetings and agent walkthrough

Use fictional mail and calendar data. Keep test booking links and credentials outside the source tree. Record the operating system, Mail and Voice versions, server address, page ID and result for each check.

1. Connect a Google calendar and a CalDAV calendar. Test a shared read-only calendar and a failed connection. Follow `rk-connect-calendar`.
2. Create, move and resize a test event. Check guest notifications and a recurring-event edit. Follow `rk-create-event`.
3. Answer an email invitation through a calendar, then through an emailed response. Open an ICS file and distinguish a copied event from an invitation. Follow `rk-answer-invitation`.
4. Include a shared calendar in availability, hide it, and check that its busy time still counts. Copy free times and insert them in a draft. Follow `rk-share-free-times`.
5. Turn on a test booking page, check each setup field and preview the guest page. Book a test slot, accept a request, move and cancel it. Test the handling computer while on and off. Follow `rk-set-up-booking`, `rk-booking-rules`, `rk-manage-booking` and `rk-booking-model`.
6. Pair Mail 2.4.0 and Voice 0.2.0 on the same supported computer. Follow the audio-only route, pause, resume and stop. Check microphone and call audio, transcription consent and reconnection. Follow `rk-voice-versions` and `rk-record-meeting`.
7. Correct a passage, listen to a voice, name it and save Markdown notes. Check the saved indicator and meeting-access switch. Follow `rk-review-meeting`.
8. Connect an installed and signed-in Claude Code or Codex, test it and review the separate Access and Permission level controls. With Ask, draft a reply and approve a test mail action. Compare Auto and Full permission with the reference in a disposable test mailbox. Follow `rk-connect-local-agent`, `rk-agent-permissions` and `rk-agent-reply`.
9. Steer a running task and queue another. Stop and restart with waiting messages. Follow `rk-agent-queue`.
10. Compose, reply, mention a recipient, attach a file, resize an image and check a per-account signature when changing From. Follow `rk-write-mail`, `rk-mail-attachments` and `rk-mail-signatures`.

## Editorial review

Check that each page answers one user need and uses its Diataxis type. Read steps in order and confirm every prerequisite appears before it is needed. Keep UI labels as shown in the English app. Check that a person can reach the page from the home page, navigation and search. Check a 390px-wide phone viewport.

## Remaining task walkthroughs

Record a result against each page ID. A help-site browser check does not complete these app checks.

| Pages | Test |
| --- | --- |
| rk-google-sign-in; rk-mail-connection-help | Import a test Desktop OAuth client, connect Google and test a permitted password mailbox. Reproduce an auth failure and check the log path. |
| rk-organize-mail; rk-notification-help; rk-manage-categories | Select non-adjacent mail, undo an action, test notifications, correct a category and check a sender rule on a second device. |
| rk-chat-direct; rk-chat-channels; rk-chat-rich; rk-chat-quiet; rk-chat-roles | Use test owner, member and guest accounts. Create a private channel, group message, reaction and file; check mute on two devices and block consequences in a disposable group. |
| rk-booking-video; rk-booking-hours; rk-booking-off | Test a date override, a service-generated invitation, a failed service and page shutdown. Check guest links and calendar effects with test addresses only. |
| rk-voice-dictation; rk-meeting-screen; rk-voice-storage; rk-voice-recovery | Dictate and rewrite demo text, change capture modes and monitors, test permission recovery, a bucket upload and restore, and deletion on disposable media. |
| rk-hermes-connect; rk-openclaw-connect; rk-custom-agent | Chat, test tool access, check local and remote addresses and verify an Ask approval for each configured adapter. |
| rk-agent-context; rk-agent-model-skills; rk-phone-pair | Attach fictional files and mail, change models, start a skill, pair a phone and check approvals and reconnect behavior. |
| rk-platform-help; rk-account-recovery; rk-android-use | Check package updates, profile paths, a second-device sign-in and disposable-account password/recovery changes. Check Android setup and background sync. |

Before publishing, confirm the hosted account, chat-file and booking capabilities of the chosen deployment. Test from a fresh browser and a fresh app profile with fictional data.
