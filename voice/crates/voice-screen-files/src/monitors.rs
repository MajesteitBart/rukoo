//! Which monitor to record. Pure; the Windows side gathers the inputs.

use serde::{Deserialize, Serialize};

/// A monitor. `id` is `MONITORINFOEXW.szDevice`, such as `\\.\DISPLAY1`; `x` and `y` are its
/// top-left corner on the virtual desktop.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

/// A top-level window, in Z-order from the foreground window down.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowInfo {
    /// The id of the monitor it is on.
    pub monitor: String,
    pub visible: bool,
    pub minimized: bool,
    pub cloaked: bool,
    /// `WS_EX_TOOLWINDOW`.
    pub tool: bool,
    /// A shell window: `Progman`, `WorkerW`, `Shell_TrayWnd`, `Shell_SecondaryTrayWnd`.
    pub shell: bool,
    /// Excluded from capture (`GetWindowDisplayAffinity != WDA_NONE`).
    pub excluded: bool,
}

impl WindowInfo {
    /// A window the user could be looking at in a call.
    fn counts(&self) -> bool {
        self.visible
            && !self.minimized
            && !self.cloaked
            && !self.tool
            && !self.shell
            && !self.excluded
    }
}

/// The monitor of the topmost window that is visible, not minimized, not cloaked, not a tool or
/// shell window and not excluded from capture; else the cursor's monitor; else the primary.
/// A window or cursor on a monitor that isn't in `monitors` doesn't count. `None` only without
/// monitors.
pub fn choose(
    z_order: &[WindowInfo],
    cursor: Option<&str>,
    monitors: &[MonitorInfo],
) -> Option<String> {
    let known = |id: &str| monitors.iter().any(|m| m.id == id);
    z_order
        .iter()
        .find(|w| w.counts() && known(&w.monitor))
        .map(|w| w.monitor.clone())
        .or_else(|| cursor.filter(|id| known(id)).map(str::to_string))
        .or_else(|| monitors.iter().find(|m| m.primary).map(|m| m.id.clone()))
        .or_else(|| ordered(monitors).first().map(|m| m.id.clone()))
}

/// The monitor after `current`, left to right, wrapping. A `current` that isn't there gives the
/// leftmost.
pub fn next(monitors: &[MonitorInfo], current: &str) -> Option<String> {
    let ordered = ordered(monitors);
    let after = match ordered.iter().position(|m| m.id == current) {
        Some(i) => (i + 1) % ordered.len(),
        None => 0,
    };
    ordered.get(after).map(|m| m.id.clone())
}

/// Left to right: by `x`, then `y`.
pub fn ordered(monitors: &[MonitorInfo]) -> Vec<MonitorInfo> {
    let mut ordered = monitors.to_vec();
    ordered.sort_by_key(|m| (m.x, m.y));
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE: &str = r"\\.\DISPLAY1";
    const TWO: &str = r"\\.\DISPLAY2";
    const THREE: &str = r"\\.\DISPLAY3";

    /// This PC: a 2560 x 1440 primary and a portrait 1440 x 2560 to its left and above.
    fn this_pc() -> Vec<MonitorInfo> {
        vec![
            MonitorInfo {
                id: ONE.into(),
                name: "DELL S3220DGF".into(),
                x: 0,
                y: 0,
                width: 2560,
                height: 1440,
                primary: true,
            },
            MonitorInfo {
                id: TWO.into(),
                name: "PHL 275V8".into(),
                x: -1440,
                y: -425,
                width: 1440,
                height: 2560,
                primary: false,
            },
        ]
    }

    fn window(monitor: &str) -> WindowInfo {
        WindowInfo {
            monitor: monitor.into(),
            visible: true,
            minimized: false,
            cloaked: false,
            tool: false,
            shell: false,
            excluded: false,
        }
    }

    #[test]
    fn the_topmost_plain_window_picks_the_monitor() {
        let monitors = this_pc();
        let call = window(TWO);
        assert_eq!(
            choose(&[call.clone(), window(ONE)], Some(ONE), &monitors),
            Some(TWO.into())
        );
    }

    #[test]
    fn protected_rukoo_on_top_is_skipped() {
        let monitors = this_pc();
        // A start from Rukoo: Rukoo is the foreground window and hides from capture.
        let rukoo = WindowInfo {
            excluded: true,
            ..window(ONE)
        };
        assert_eq!(
            choose(&[rukoo, window(TWO)], Some(ONE), &monitors),
            Some(TWO.into())
        );
    }

    #[test]
    fn an_unexcluded_rukoo_on_top_wins() {
        // With Rukoo's hiding switch off it is an ordinary window, and its monitor is chosen:
        // the documented limit.
        let monitors = this_pc();
        assert_eq!(
            choose(&[window(ONE), window(TWO)], Some(TWO), &monitors),
            Some(ONE.into())
        );
    }

    #[test]
    fn hidden_minimized_cloaked_tool_and_shell_windows_are_skipped() {
        let monitors = this_pc();
        let skipped = [
            WindowInfo {
                visible: false,
                ..window(ONE)
            },
            WindowInfo {
                minimized: true,
                ..window(ONE)
            },
            WindowInfo {
                cloaked: true,
                ..window(ONE)
            },
            WindowInfo {
                tool: true,
                ..window(ONE)
            },
            WindowInfo {
                shell: true,
                ..window(ONE)
            },
        ];
        for w in &skipped {
            assert_eq!(
                choose(&[w.clone(), window(TWO)], None, &monitors),
                Some(TWO.into()),
                "{w:?}"
            );
        }
        // A window on a monitor that went away doesn't count either.
        assert_eq!(
            choose(&[window(THREE), window(TWO)], None, &monitors),
            Some(TWO.into())
        );
    }

    #[test]
    fn falls_back_to_the_cursor_then_the_primary() {
        let monitors = this_pc();
        let nothing = [WindowInfo {
            shell: true,
            ..window(ONE)
        }];
        assert_eq!(choose(&nothing, Some(TWO), &monitors), Some(TWO.into()));
        assert_eq!(choose(&[], Some(TWO), &monitors), Some(TWO.into()));
        assert_eq!(choose(&[], None, &monitors), Some(ONE.into()));
        assert_eq!(choose(&[], Some(THREE), &monitors), Some(ONE.into()));
        // Without a primary, the leftmost.
        let no_primary: Vec<MonitorInfo> = monitors
            .iter()
            .cloned()
            .map(|m| MonitorInfo {
                primary: false,
                ..m
            })
            .collect();
        assert_eq!(choose(&[], None, &no_primary), Some(TWO.into()));
        assert_eq!(choose(&[window(ONE)], Some(ONE), &[]), None);
    }

    #[test]
    fn next_goes_left_to_right_and_wraps() {
        let monitors = this_pc();
        // The portrait monitor at negative x is the leftmost.
        let ids: Vec<String> = ordered(&monitors).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec![TWO.to_string(), ONE.to_string()]);
        assert_eq!(next(&monitors, TWO), Some(ONE.into()));
        assert_eq!(next(&monitors, ONE), Some(TWO.into()));
        assert_eq!(next(&monitors, THREE), Some(TWO.into()));
        assert_eq!(next(&monitors[..1], ONE), Some(ONE.into()));
        assert_eq!(next(&[], ONE), None);
        // Stacked monitors at the same x go top to bottom.
        let mut stacked = monitors.clone();
        stacked.push(MonitorInfo {
            id: THREE.into(),
            name: "Display 3".into(),
            x: 0,
            y: -1440,
            width: 2560,
            height: 1440,
            primary: false,
        });
        let ids: Vec<String> = ordered(&stacked).into_iter().map(|m| m.id).collect();
        assert_eq!(
            ids,
            vec![TWO.to_string(), THREE.to_string(), ONE.to_string()]
        );
        assert_eq!(next(&stacked, THREE), Some(ONE.into()));
    }

    #[test]
    fn monitors_serialize_in_camel_case() {
        let json = serde_json::to_value(&this_pc()[1]).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "id": TWO, "name": "PHL 275V8", "x": -1440, "y": -425, "width": 1440, "height": 2560, "primary": false })
        );
    }
}
