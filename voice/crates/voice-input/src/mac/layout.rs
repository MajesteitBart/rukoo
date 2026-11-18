//! The key that types a Command shortcut's letter in the current keyboard layout.
//!
//! Cmd+V and Cmd+C go out as key codes, and a key code is a position on the keyboard, not a
//! letter. On QWERTY the V position types v, but on a layout that moves V for Command shortcuts,
//! such as Dvorak, Workman, Colemak-DH or Bépo, the same position gives another shortcut: a paste
//! would become Cmd+K or Cmd+. and the dictation would never arrive. So before a chord goes out,
//! Voice asks the current layout which key gives the letter with Command held, the way macOS
//! itself resolves the shortcut. "Dvorak - QWERTY ⌘" types Dvorak but switches to QWERTY while
//! Command is down, so there the answer stays the ANSI position.
//!
//! Text Input Sources only answers on the main thread, so the layout is read there and copied;
//! the translation itself works on that copy on any thread. When the main thread doesn't answer
//! in time, or the layout has no such key, the ANSI position goes out as before.

use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Duration;

use crate::strokes::{mac_key, Stroke};

/// How long a chord waits for the main thread to read the layout before it falls back to ANSI.
const MAIN_THREAD_WAIT: Duration = Duration::from_millis(300);

/// The key codes a layout can put a letter on: the main block and the keys around it, below the
/// function and keypad codes. The modifier keys type nothing and are skipped.
const CODES: std::ops::Range<u16> = 0..0x40;

/// `batch` with the ANSI V and C of its Command chords moved to the keys that give v and c with
/// Command held in the current layout.
pub(crate) fn shortcut_keys(batch: &[Stroke]) -> Vec<Stroke> {
    let has_letter = batch.iter().any(
        |s| matches!(s, Stroke::MacKey { code, .. } if *code == mac_key::V || *code == mac_key::C),
    );
    if !has_letter {
        return batch.to_vec();
    }
    let layout = current_layout();
    let key_for = |code: u16, letter: char| match &layout {
        Some(layout) => pick(code, letter, |candidate| layout.command_char(candidate)),
        None => code,
    };
    let v = key_for(mac_key::V, 'v');
    let c = key_for(mac_key::C, 'c');
    remap(batch, v, c)
}

/// `batch` with every ANSI V key code replaced by `v` and every ANSI C by `c`. Only the Command
/// chords carry those codes: typing goes out as Unicode events and a newline is Shift+Return.
fn remap(batch: &[Stroke], v: u16, c: u16) -> Vec<Stroke> {
    batch
        .iter()
        .map(|stroke| match *stroke {
            Stroke::MacKey { code, up } if code == mac_key::V => Stroke::MacKey { code: v, up },
            Stroke::MacKey { code, up } if code == mac_key::C => Stroke::MacKey { code: c, up },
            other => other,
        })
        .collect()
}

/// The key code that gives `letter` with Command held: `ansi` when it does, as on QWERTY and on
/// layouts that switch to QWERTY for shortcuts, else the lowest code that does, else `ansi`, so a
/// layout without the letter keeps today's chord.
fn pick(ansi: u16, letter: char, command_char: impl Fn(u16) -> Option<char>) -> u16 {
    let gives = |code: u16| command_char(code).is_some_and(|c| c.to_ascii_lowercase() == letter);
    if gives(ansi) {
        return ansi;
    }
    CODES
        .filter(|code| !is_modifier(*code))
        .find(|code| gives(*code))
        .unwrap_or(ansi)
}

fn is_modifier(code: u16) -> bool {
    // kVK_Command up to kVK_Function: Command, Shift, Caps Lock, Option, Control, the right-hand
    // ones and Fn.
    (0x36..=0x3F).contains(&code)
}

/// A copy of the current layout's `uchr` data and the keyboard type, read on the main thread.
struct Layout {
    data: Vec<u8>,
    keyboard_type: u32,
}

impl Layout {
    /// What `code` types with Command held and nothing else, without dead keys.
    fn command_char(&self, code: u16) -> Option<char> {
        let mut dead_keys = 0u32;
        let mut length: usize = 0;
        let mut units = [0u16; 4];
        // SAFETY: `data` is a whole `uchr` resource copied from the layout, which UCKeyTranslate
        // only reads, and the out pointers live for the call.
        let status = unsafe {
            UCKeyTranslate(
                self.data.as_ptr().cast(),
                code,
                K_UC_KEY_ACTION_DOWN,
                COMMAND_MODIFIER_STATE,
                self.keyboard_type,
                K_UC_KEY_TRANSLATE_NO_DEAD_KEYS_MASK,
                &mut dead_keys,
                units.len(),
                &mut length,
                units.as_mut_ptr(),
            )
        };
        if status != 0 || length == 0 {
            return None;
        }
        let mut chars = char::decode_utf16(units[..length.min(units.len())].iter().copied());
        match (chars.next(), chars.next()) {
            (Some(Ok(c)), None) => Some(c),
            _ => None,
        }
    }
}

/// The current layout, read on the main thread: directly when this is the main thread, else
/// through the main queue with a short wait.
fn current_layout() -> Option<Layout> {
    if objc2::MainThreadMarker::new().is_some() {
        return read_layout();
    }
    let (tx, rx) = mpsc::sync_channel::<Option<Layout>>(1);
    let context = Box::into_raw(Box::new(tx)).cast::<c_void>();
    extern "C" fn on_main(context: *mut c_void) {
        // SAFETY: `context` is the sender boxed below, handed over exactly once.
        let tx = unsafe { Box::from_raw(context.cast::<mpsc::SyncSender<Option<Layout>>>()) };
        let _ = tx.send(read_layout());
    }
    // SAFETY: the main queue outlives the process; `on_main` takes ownership of `context`.
    unsafe {
        dispatch_async_f(
            std::ptr::addr_of!(_dispatch_main_q).cast(),
            context,
            on_main,
        )
    };
    // A main thread that doesn't answer in time leaves the ANSI keys, as before.
    rx.recv_timeout(MAIN_THREAD_WAIT).ok().flatten()
}

/// Copies the current keyboard layout's `uchr` data. Main thread only.
fn read_layout() -> Option<Layout> {
    // SAFETY: called on the main thread, as Text Input Sources requires. The source is a +1
    // reference released below; the property is owned by the source and copied before that.
    unsafe {
        let source = TISCopyCurrentKeyboardLayoutInputSource();
        if source.is_null() {
            return None;
        }
        let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
        let layout = if data.is_null() {
            None
        } else {
            let bytes = CFDataGetBytePtr(data);
            let len = CFDataGetLength(data);
            (!bytes.is_null() && len > 0).then(|| Layout {
                data: std::slice::from_raw_parts(bytes, len as usize).to_vec(),
                keyboard_type: u32::from(LMGetKbdType()),
            })
        };
        CFRelease(source);
        layout
    }
}

/// `kUCKeyActionDown`.
const K_UC_KEY_ACTION_DOWN: u16 = 0;
/// `(cmdKey >> 8) & 0xFF`: the Command bit of the modifier state UCKeyTranslate takes.
const COMMAND_MODIFIER_STATE: u32 = 1;
/// `1 << kUCKeyTranslateNoDeadKeysBit`.
const K_UC_KEY_TRANSLATE_NO_DEAD_KEYS_MASK: u32 = 1;

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    static kTISPropertyUnicodeKeyLayoutData: *const c_void;
    fn TISCopyCurrentKeyboardLayoutInputSource() -> *const c_void;
    fn TISGetInputSourceProperty(source: *const c_void, key: *const c_void) -> *const c_void;
    fn LMGetKbdType() -> u8;
    #[allow(clippy::too_many_arguments)]
    fn UCKeyTranslate(
        layout: *const c_void,
        virtual_key_code: u16,
        key_action: u16,
        modifier_key_state: u32,
        keyboard_type: u32,
        key_translate_options: u32,
        dead_key_state: *mut u32,
        max_string_length: usize,
        actual_string_length: *mut usize,
        unicode_string: *mut u16,
    ) -> i32;
}

extern "C" {
    fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
    fn CFDataGetLength(data: *const c_void) -> isize;
    fn CFRelease(cf: *const c_void);
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(
        queue: *const c_void,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a layout types with Command held at the codes that matter here: QWERTY's V and C, and
    /// the positions Dvorak puts them on (kVK_ANSI_Period and kVK_ANSI_I).
    fn layout(table: &'static [(u16, char)]) -> impl Fn(u16) -> Option<char> {
        move |code| table.iter().find(|(c, _)| *c == code).map(|(_, ch)| *ch)
    }

    const QWERTY: &[(u16, char)] = &[(0x09, 'v'), (0x08, 'c'), (0x2F, '.'), (0x22, 'i')];
    /// Plain Dvorak keeps its own letters with Command held.
    const DVORAK: &[(u16, char)] = &[(0x09, 'k'), (0x08, 'j'), (0x2F, 'v'), (0x22, 'c')];
    /// "Dvorak - QWERTY ⌘": Dvorak while typing, QWERTY with Command held.
    const DVORAK_QWERTY_COMMAND: &[(u16, char)] = QWERTY;
    /// A layout with neither letter anywhere, even with Command held.
    const NO_LATIN: &[(u16, char)] = &[(0x09, 'м'), (0x08, 'с')];

    #[test]
    fn qwerty_keeps_the_ansi_keys() {
        assert_eq!(pick(mac_key::V, 'v', layout(QWERTY)), mac_key::V);
        assert_eq!(pick(mac_key::C, 'c', layout(QWERTY)), mac_key::C);
    }

    #[test]
    fn dvorak_takes_the_keys_that_give_v_and_c_with_command() {
        assert_eq!(pick(mac_key::V, 'v', layout(DVORAK)), 0x2F);
        assert_eq!(pick(mac_key::C, 'c', layout(DVORAK)), 0x22);
    }

    #[test]
    fn a_layout_that_switches_to_qwerty_for_command_keeps_the_ansi_keys() {
        assert_eq!(
            pick(mac_key::V, 'v', layout(DVORAK_QWERTY_COMMAND)),
            mac_key::V
        );
        assert_eq!(
            pick(mac_key::C, 'c', layout(DVORAK_QWERTY_COMMAND)),
            mac_key::C
        );
    }

    #[test]
    fn a_layout_without_the_letter_keeps_the_ansi_key() {
        assert_eq!(pick(mac_key::V, 'v', layout(NO_LATIN)), mac_key::V);
    }

    #[test]
    fn an_uppercase_answer_counts_and_modifiers_are_never_picked() {
        const CAPS: &[(u16, char)] = &[(0x09, 'K'), (0x2F, 'V')];
        assert_eq!(pick(mac_key::V, 'v', layout(CAPS)), 0x2F);
        let modifier_says_v = |code: u16| (code == mac_key::COMMAND).then_some('v');
        assert_eq!(pick(mac_key::V, 'v', modifier_says_v), mac_key::V);
    }

    #[test]
    fn only_the_letters_of_the_command_chords_move() {
        let paste = crate::strokes::paste();
        let moved = remap(&paste, 0x2F, 0x22);
        assert_eq!(
            moved,
            [
                Stroke::MacKey {
                    code: mac_key::COMMAND,
                    up: false
                },
                Stroke::MacKey {
                    code: 0x2F,
                    up: false
                },
                Stroke::MacKey {
                    code: 0x2F,
                    up: true
                },
                Stroke::MacKey {
                    code: mac_key::COMMAND,
                    up: true
                },
            ]
        );
        let copy = remap(&crate::strokes::copy(), 0x2F, 0x22);
        assert!(copy.contains(&Stroke::MacKey {
            code: 0x22,
            up: false
        }));
        let newline = crate::strokes::newline();
        assert_eq!(remap(&newline, 0x2F, 0x22), newline);
    }
}
