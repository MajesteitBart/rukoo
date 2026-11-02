# Meetings

[Rukoo Voice](../voice/README.md) records your meetings on this computer: your microphone, the call audio and, if you want, the screen. Rukoo shows them as they happen, next to your agent. **Meet** in the switch at the top of the sidebar, or `Ctrl+3`, replaces the message list and the reader with the meeting view.

Rukoo can't start Rukoo Voice. While Voice isn't running, the view says so and still shows the meetings Rukoo kept from before.

## Recording

There are three ways to start a recording:

- **Record a meeting** at the top of the sidebar in meeting mode.
- **Record with Rukoo Voice** on a calendar event's card, from 15 minutes before the event until it ends, while Voice is connected and nothing records yet. The meeting takes the event's title and is linked to it.
- Voice's own pill or tray. Rukoo opens the meeting as soon as Voice tells it, and links the calendar event that overlaps its start when exactly one fits.

### The screen

Voice can record the screen with the audio. Its Settings (Meetings, Screen recording) set the default: off, frames or video. Frames are still images, saved when the screen changes, with the text Windows reads on them on this computer. Video adds a video of the screen, made by the computer's hardware video encoder; without one, Voice records frames only.

Record in the sidebar, Record in the empty meeting view and Record with Rukoo Voice on a calendar card use Voice's default. The arrow beside each of them chooses for this meeting: Voice's default (the menu says which), Audio only, Audio and screen frames, or Audio and screen video. A meeting started from Voice's pill or tray uses Voice's default.

Voice records one monitor: the one with the window you're working in, which skips Rukoo while Rukoo is hidden from screen recordings. In a recording meeting, **Screen** in the header lists the monitors and moves the recording to another one; Voice's pill has a button for the next monitor too. A move shows in the transcript.

When Voice starts a meeting itself, it waits up to half a second for Rukoo to hide its windows before it captures the first frame. Windows draws a coloured border around the recorded monitor while Voice captures it.

While a meeting records, a red dot and the meeting's clock sit in the title bar in every mode. A click opens the meeting. Its header has Mark, Pause or Resume, and Stop, and Screen when the meeting records the screen. Stop asks once more ("Stop recording?") before it stops, as Voice's pill does, because a meeting can't be recorded again.

Voice keeps recording when Rukoo quits or loses the connection. When Rukoo comes back, it asks Voice for everything it missed.

## The meeting view

The transcript fills the view. Each line has its meeting time in the margin, and the voice's name shows once per stretch. Lines you dictated into another app during the meeting are greyed out and tagged Dictation: the call heard them, but they weren't part of the conversation. Gaps in the audio, a device that came back and your marks sit between the lines.

In a meeting that records the screen, each frame sits at the moment the screen changed: a thumbnail with the first line of the text on it. A click on the thumbnail, or Enter on the row, opens it at the transcript's width with all of its text, which you can select and copy; **Text on screen** does the same. Rukoo asks Voice for an image when its row comes into view and keeps the last 60 of the meeting on screen. Marks say when Voice stopped the video or the whole screen recording to keep the audio, when it moved to another monitor, and when there were no frames for a while, for example while the computer was locked.

The header says what the meeting records of the screen (Screen: frames or Screen: video). While it records with Rukoo not hidden from screen recordings, **Visible in screen recordings** warns that Rukoo can show in the frames.

Double-click a line, or press Enter on it, to correct its text; Enter saves and Esc cancels. The right-click menu brings back what Voice recognized. In the transcript the arrow keys move between lines.

Beside the transcript:

- **Calendar event**: the event the meeting is linked to. Change picks another event within 15 minutes of the start, or unlinks it, and a click on the title opens the event in the calendar.
- **People**: the voices Voice heard. Your microphone is You. Voice 0.1 hears the whole call as one voice, Speaker 1. Pick who it is from the linked event's guests, or type a name. Rukoo fills the name in by itself only when the event has exactly one other guest.
- **Your notes**: saved a moment after you stop typing. Your agent can read them.

In a narrow window these parts become tabs: Transcript, Notes and Details.

The sidebar lists the meetings by day, newest first. With the chat open the sidebar becomes a rail, where each meeting shows its day of the month.

## The agent

With the chat open in meeting mode, the chat is about the meeting on screen: the panel opens that meeting's newest chat, or starts a new one about it. Its quick actions are Catch me up, What did they ask me?, Write the notes and Draft the follow-up email.

The agent reads the meeting through [Rukoo's meeting tools](agents.md#rukoos-tools). Each turn says how many lines are new since the agent last read the transcript; the transcript itself never goes into the turn. Everyone in a meeting is a third party, so the tools hand the transcript over as untrusted text. In a meeting that records the screen, the agent can look at the frames at a moment or over a stretch; anything can be on a screen, so their text is untrusted too, and a video clip goes only to an agent on this computer. No tool starts or stops a recording.

## Settings

Settings → Meetings shows whether Rukoo Voice is connected, and has two switches, both on by default:

- **Hide Rukoo from screen recordings during a meeting.** While a meeting records, every Rukoo window is left out of screen capture.
  - Windows 10 2004 and later: screen recordings and screen shares in apps such as Teams and Zoom leave Rukoo out. Remote access tools that capture the screen show Rukoo's windows black; Remote Desktop still shows them.
  - macOS: Rukoo Voice and older screen recorders leave Rukoo out. On macOS 15 and later, other apps' screen shares still show it.
  - Linux has no way to hide a window. Keep Rukoo on a monitor you don't share or record.
- **Agents can read meetings.** Off, the meeting tools give agents nothing from your meetings, and a new chat about a meeting is named after your first message instead of the meeting.

While a meeting records the screen, Rukoo holds back its mail and booking notifications, so their text stays out of the frames. The badge still counts new mail. When Voice stops recording the screen for good, for example because the disk is nearly full, the notifications come back for the rest of the meeting; the ones held until then aren't shown later. Calendar reminders still show, because a missed reminder costs more than its title on the screen.

In meeting mode, the status line at the bottom of the sidebar says how Voice is, and opens these settings.

## Limits

- Rukoo shows the meetings of the Rukoo Voice on this computer. The phone has no meetings.
- Voice 0.1 labels the whole call as one voice.
- Rukoo keeps a copy of each transcript in its profile, so the view and the tools work while Voice is closed. Rukoo deletes that copy when Voice deletes the meeting. Your notes stay.
- Frame images stay with Voice. Rukoo keeps their text, so while Voice isn't running a frame's row shows its text, and an image only when Rukoo loaded it before. After Voice removed the meeting's screen media with its audio, the rows keep their text and say the image is gone.
- Rukoo doesn't play a meeting's video. Agents on this computer can get a clip of it (see [the meeting tools](agents.md#rukoos-tools)).
- Windows' capture border stays around the recorded monitor; Voice doesn't hide it.
- Other apps' notifications and pop-ups on the recorded monitor end up in the frames. Rukoo holds back only its own.
- With Rukoo's hide switch off, a meeting started from Rukoo records Rukoo's monitor, because Rukoo is the window you're working in. Move it with Screen in the header or with the pill's monitor button.
- A Rukoo that isn't connected to Voice when a meeting starts from Voice can show in that meeting's first frames. Voice waits up to 5 seconds only for a Rukoo it has seen since Voice started, so right after Voice restarts it doesn't wait at all.
- Native file dialogs and system notifications can't be hidden from screen capture.
