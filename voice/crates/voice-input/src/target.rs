//! Whether the focused window looks like it takes text, as Ownkey judged it
//! (`is_text_input_selected`, `ownkey.py:631-658`).

/// Ownkey's text-target status. Only [`TextTarget::NotSelected`] has an
/// effect there: the pill says "Select a text box" and a notification warns
/// before inserting, but the text is inserted anyway, because many apps' text
/// fields can't be detected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextTarget {
    /// A caret is showing or a known edit control has focus.
    Selected,
    /// The taskbar, desktop or Start menu has focus.
    NotSelected,
    /// Anything else, or Windows wouldn't say.
    Unknown,
}

impl TextTarget {
    /// The pill's value: `"selected"`, `"not_selected"` or `"unknown"`.
    pub fn as_str(self) -> &'static str {
        match self {
            TextTarget::Selected => "selected",
            TextTarget::NotSelected => "not_selected",
            TextTarget::Unknown => "unknown",
        }
    }
}

const TEXT_INPUT_CLASSES: [&str; 4] = ["Edit", "RichEdit20W", "RICHEDIT50W", "Scintilla"];
/// The taskbar, the desktop (two classes) and the Start menu.
const NON_INPUT_CLASSES: [&str; 4] = ["Shell_TrayWnd", "Progman", "WorkerW", "DV2ControlHost"];

/// Classifies the focus: `focus_class` is the class of the focused control
/// (or of the foreground window when nothing inside it has focus), `None`
/// when the focus couldn't be read.
pub fn classify(focus_class: Option<&str>, has_caret: bool) -> TextTarget {
    let Some(class) = focus_class else {
        return TextTarget::Unknown;
    };
    if has_caret || TEXT_INPUT_CLASSES.contains(&class) {
        TextTarget::Selected
    } else if NON_INPUT_CLASSES.contains(&class) {
        TextTarget::NotSelected
    } else {
        TextTarget::Unknown
    }
}

/// The foreground window and its focus.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowInfo {
    /// The window handle as a number, for telling windows apart over time.
    pub hwnd: isize,
    pub process_id: u32,
    /// The foreground window's class.
    pub class_name: String,
    /// The focused control's class, or the foreground window's when nothing
    /// inside it has focus. `None` when Windows wouldn't say.
    pub focus_class: Option<String>,
    /// The focused thread shows a text caret.
    pub has_caret: bool,
    pub target: TextTarget,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_caret_means_a_text_box() {
        assert_eq!(
            classify(Some("Chrome_RenderWidgetHostHWND"), true),
            TextTarget::Selected
        );
        assert_eq!(classify(Some("Shell_TrayWnd"), true), TextTarget::Selected);
    }

    #[test]
    fn known_edit_controls_are_text_boxes() {
        for class in TEXT_INPUT_CLASSES {
            assert_eq!(
                classify(Some(class), false),
                TextTarget::Selected,
                "{class}"
            );
        }
    }

    #[test]
    fn taskbar_desktop_and_start_menu_are_not() {
        for class in NON_INPUT_CLASSES {
            assert_eq!(
                classify(Some(class), false),
                TextTarget::NotSelected,
                "{class}"
            );
        }
    }

    #[test]
    fn anything_else_is_unknown() {
        assert_eq!(
            classify(Some("Chrome_WidgetWin_1"), false),
            TextTarget::Unknown
        );
        assert_eq!(
            classify(Some("edit"), false),
            TextTarget::Unknown,
            "class names are case-sensitive"
        );
        assert_eq!(
            classify(None, true),
            TextTarget::Unknown,
            "no focus information at all"
        );
    }

    #[test]
    fn pill_values_match_ownkey() {
        assert_eq!(TextTarget::Selected.as_str(), "selected");
        assert_eq!(TextTarget::NotSelected.as_str(), "not_selected");
        assert_eq!(TextTarget::Unknown.as_str(), "unknown");
    }
}
