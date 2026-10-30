//! Keystroke sequences for `SendInput`, built without touching Windows so
//! they can be tested anywhere.

pub(crate) const VK_RETURN: u16 = 0x0D;
pub(crate) const VK_SHIFT: u16 = 0x10;
pub(crate) const VK_CONTROL: u16 = 0x11;
pub(crate) const VK_C: u16 = 0x43;
pub(crate) const VK_V: u16 = 0x56;

/// One keyboard `INPUT`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stroke {
    /// A virtual key going down or up.
    Key { vk: u16, up: bool },
    /// One UTF-16 code unit sent with `KEYEVENTF_UNICODE`, independent of the
    /// keyboard layout.
    Unicode { unit: u16, up: bool },
}

fn down(vk: u16) -> Stroke {
    Stroke::Key { vk, up: false }
}

fn up(vk: u16) -> Stroke {
    Stroke::Key { vk, up: true }
}

/// Ctrl plus a key. Plain VK_CONTROL maps to the left Ctrl key, as Ownkey sent it.
fn ctrl_chord(vk: u16) -> Vec<Stroke> {
    vec![down(VK_CONTROL), down(vk), up(vk), up(VK_CONTROL)]
}

pub(crate) fn paste() -> Vec<Stroke> {
    ctrl_chord(VK_V)
}

pub(crate) fn copy() -> Vec<Stroke> {
    ctrl_chord(VK_C)
}

/// The batches that type `text`, one per character, so the caller can pace
/// them (Ownkey waits 5 ms between characters).
///
/// A newline is Shift+Enter rather than Enter, so a chat app doesn't send the
/// message halfway through a dictation. This differs from Ownkey on purpose.
pub(crate) fn typing(text: &str) -> Vec<Vec<Stroke>> {
    let mut batches = Vec::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' | '\n' => {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                batches.push(vec![
                    down(VK_SHIFT),
                    down(VK_RETURN),
                    up(VK_RETURN),
                    up(VK_SHIFT),
                ]);
            }
            // Other control characters aren't text a text box should receive.
            c if c.is_control() && c != '\t' => {}
            c => {
                let mut buf = [0u16; 2];
                let units = c.encode_utf16(&mut buf);
                // All downs, then all ups: a surrogate pair is two units of one character.
                let downs = units
                    .iter()
                    .map(|&unit| Stroke::Unicode { unit, up: false });
                let ups = units.iter().map(|&unit| Stroke::Unicode { unit, up: true });
                batches.push(downs.chain(ups).collect());
            }
        }
    }
    batches
}

/// The key-ups that undo a batch Windows inserted only partly, so a cut-off
/// Ctrl+V can't leave Ctrl held down.
pub(crate) fn release_after(inserted: &[Stroke]) -> Vec<Stroke> {
    let mut held: Vec<Stroke> = Vec::new();
    for stroke in inserted {
        match *stroke {
            Stroke::Key { vk, up: false } => held.push(Stroke::Key { vk, up: true }),
            Stroke::Unicode { unit, up: false } => held.push(Stroke::Unicode { unit, up: true }),
            released => held.retain(|h| *h != released),
        }
    }
    held.reverse();
    held
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(unit: u16, up: bool) -> Stroke {
        Stroke::Unicode { unit, up }
    }

    fn shift_enter() -> Vec<Stroke> {
        vec![down(VK_SHIFT), down(VK_RETURN), up(VK_RETURN), up(VK_SHIFT)]
    }

    #[test]
    fn paste_is_left_ctrl_v() {
        assert_eq!(
            paste(),
            [
                Stroke::Key {
                    vk: 0x11,
                    up: false
                },
                Stroke::Key {
                    vk: 0x56,
                    up: false
                },
                Stroke::Key { vk: 0x56, up: true },
                Stroke::Key { vk: 0x11, up: true },
            ]
        );
    }

    #[test]
    fn copy_is_left_ctrl_c() {
        assert_eq!(copy(), [down(0x11), down(0x43), up(0x43), up(0x11)]);
    }

    #[test]
    fn types_each_character_as_a_unicode_down_and_up() {
        assert_eq!(
            typing("Hé"),
            [
                vec![u(0x48, false), u(0x48, true)],
                vec![u(0xE9, false), u(0xE9, true)]
            ]
        );
    }

    #[test]
    fn sends_a_surrogate_pair_as_two_downs_then_two_ups() {
        // U+1F600 is D83D DE00 in UTF-16.
        assert_eq!(
            typing("😀"),
            [vec![
                u(0xD83D, false),
                u(0xDE00, false),
                u(0xD83D, true),
                u(0xDE00, true)
            ]]
        );
    }

    #[test]
    fn a_newline_is_shift_enter() {
        let batches = typing("a\nb");
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[1], shift_enter());
    }

    #[test]
    fn crlf_and_a_lone_cr_are_one_newline_each() {
        assert_eq!(typing("\r\n"), [shift_enter()]);
        assert_eq!(typing("\r"), [shift_enter()]);
        assert_eq!(typing("\n\n"), [shift_enter(), shift_enter()]);
        assert_eq!(typing("\r\r\n"), [shift_enter(), shift_enter()]);
    }

    #[test]
    fn keeps_tabs_and_drops_other_control_characters() {
        assert_eq!(typing("\t"), [vec![u(0x09, false), u(0x09, true)]]);
        assert!(typing("\u{0}\u{8}\u{1b}\u{7f}").is_empty());
    }

    #[test]
    fn empty_text_types_nothing() {
        assert!(typing("").is_empty());
    }

    #[test]
    fn a_cut_off_chord_releases_what_went_down() {
        let chord = paste();
        assert!(release_after(&chord[..0]).is_empty());
        assert_eq!(release_after(&chord[..1]), [up(VK_CONTROL)]);
        assert_eq!(release_after(&chord[..2]), [up(VK_V), up(VK_CONTROL)]);
        assert_eq!(release_after(&chord[..3]), [up(VK_CONTROL)]);
        assert!(release_after(&chord).is_empty());
    }

    #[test]
    fn a_cut_off_surrogate_pair_releases_its_units() {
        let pair = &typing("😀")[0];
        assert_eq!(
            release_after(&pair[..2]),
            [u(0xDE00, true), u(0xD83D, true)]
        );
        assert_eq!(release_after(&pair[..3]), [u(0xDE00, true)]);
    }
}
