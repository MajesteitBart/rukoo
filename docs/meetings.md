# Meetings

[Rukoo Voice](../voice/README.md) records your meetings on this computer: your microphone and the call audio. Rukoo shows them as they happen, next to your agent. The switch at the top of the sidebar, or `Ctrl+3`, replaces the message list and the reader with the meeting view.

Rukoo can't start Rukoo Voice. While Voice isn't running, the view says so and still shows the meetings Rukoo kept from before.

## Recording

There are three ways to start a recording:

- **Record a meeting** at the top of the sidebar in meeting mode.
- **Record with Rukoo Voice** on a calendar event's card, from 15 minutes before the event until it ends, while Voice is connected and nothing records yet. The meeting takes the event's title and is linked to it.
- Voice's own pill or tray. Rukoo opens the meeting as soon as Voice tells it, and links the calendar event that overlaps its start when exactly one fits.

While a meeting records, a red dot and the meeting's clock sit in the title bar in every mode. A click opens the meeting. Its header has Mark, Pause or Resume, and Stop. Stop asks once more ("Stop recording?") before it stops, as Voice's pill does, because a meeting can't be recorded again.

Voice keeps recording when Rukoo quits or loses the connection. When Rukoo comes back, it asks Voice for everything it missed.

## The meeting view

The transcript fills the view. Each line has its meeting time in the margin, and the voice's name shows once per stretch. Lines you dictated into another app during the meeting are greyed out and tagged Dictation: the call heard them, but they weren't part of the conversation. Gaps in the audio, a device that came back and your marks sit between the lines.

Double-click a line, or press Enter on it, to correct its text; Enter saves and Esc cancels. The right-click menu brings back what Voice recognized. In the transcript the arrow keys move between lines.

Beside the transcript:

- **Calendar event**: the event the meeting is linked to. Change picks another event within 15 minutes of the start, or unlinks it, and a click on the title opens the event in the calendar.
- **People**: the voices Voice heard. Your microphone is You. Voice 0.1 hears the whole call as one voice, Speaker 1. Pick who it is from the linked event's guests, or type a name. Rukoo fills the name in by itself only when the event has exactly one other guest.
- **Your notes**: saved a moment after you stop typing. Your agent can read them.

In a narrow window these parts become tabs: Transcript, Notes and Details.

The sidebar lists the meetings by day, newest first. With the chat open the sidebar becomes a rail, where each meeting shows its day of the month.

## The agent

With the chat open in meeting mode, the chat is about the meeting on screen: the panel opens that meeting's newest chat, or starts a new one about it. Its quick actions are Catch me up, What did they ask me?, Write the notes and Draft the follow-up email.

The agent reads the meeting through [Rukoo's meeting tools](agents.md#rukoos-tools). Each turn says how many lines are new since the agent last read the transcript; the transcript itself never goes into the turn. Everyone in a meeting is a third party, so the tools hand the transcript over as untrusted text. No tool starts or stops a recording.

## Settings

Settings → Meetings shows whether Rukoo Voice is connected, and has two switches, both on by default:

- **Hide Rukoo from screen recordings during a meeting.** While a meeting records, every Rukoo window is left out of screen capture.
  - Windows 10 2004 and later: screen recordings and screen shares in apps such as Teams and Zoom leave Rukoo out. Remote access tools that capture the screen show Rukoo's windows black; Remote Desktop still shows them.
  - macOS: Rukoo Voice and older screen recorders leave Rukoo out. On macOS 15 and later, other apps' screen shares still show it.
  - Linux has no way to hide a window. Keep Rukoo on a monitor you don't share or record.
- **Agents can read meetings.** Off, the meeting tools give agents nothing from your meetings.

In meeting mode, the status line at the bottom of the sidebar says how Voice is, and opens these settings.

## Limits

- Rukoo shows the meetings of the Rukoo Voice on this computer. The phone has no meetings.
- Voice 0.1 records audio only, so there are no screen frames yet, and labels the whole call as one voice.
- Rukoo keeps a copy of each transcript in its profile, so the view and the tools work while Voice is closed. Rukoo deletes that copy when Voice deletes the meeting. Your notes stay.
- Native file dialogs and system notifications can't be hidden from screen capture.
