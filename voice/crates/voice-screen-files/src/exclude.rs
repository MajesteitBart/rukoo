//! Whose windows a screen recording on macOS leaves out.
//!
//! ScreenCaptureKit filters by application, so the screen process decides per running app, and
//! the monitor choice looks past the same windows. Voice's own app always stays out: its pill,
//! Settings and dialogs aren't part of the meeting. Rukoo stays out by its bundle id, also while
//! it isn't connected or is starting again, unless a connected Rukoo named its process in
//! `shown`: the user turned off "Hide Rukoo from screen recordings" in Rukoo's Settings ›
//! Meetings. A development Rukoo runs from Electron, whose bundle id says nothing, so it stays
//! out by its pid in `hidden` only. These rules build on every platform, so Linux CI tests them;
//! the macOS capture applies them.

/// Voice's app, installed and as a development bundle.
pub const VOICE_BUNDLES: [&str; 2] = ["nl.bvdm.rukoo.voice", "nl.bvdm.rukoo.voice.dev"];
/// Rukoo, as its macOS package names it (`build.appId` in Rukoo's package.json).
pub const RUKOO_BUNDLES: [&str; 1] = ["nl.bvdm.rukoo-mail"];
/// The most pids each list of an `exclude` request takes.
pub const MAX_PIDS: usize = 64;

/// The processes a recording leaves out besides Voice's app, and the Rukoo processes it keeps.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Exclusions {
    /// Processes whose windows stay out: the screen process, the app that started it, and each
    /// connected Rukoo that hides its windows. Sorted, without repeats or 0.
    pub hidden: Vec<u32>,
    /// Rukoo processes whose windows stay in, although their bundle is Rukoo's. Sorted, without
    /// repeats or 0, and none of them in `hidden`: a process both hides and shows only when two
    /// connections disagree, and then it stays out.
    pub shown: Vec<u32>,
}

impl Exclusions {
    pub fn new(
        hidden: impl IntoIterator<Item = u32>,
        shown: impl IntoIterator<Item = u32>,
    ) -> Exclusions {
        let mut hidden: Vec<u32> = hidden.into_iter().filter(|&pid| pid != 0).collect();
        hidden.sort_unstable();
        hidden.dedup();
        let mut shown: Vec<u32> = shown
            .into_iter()
            .filter(|pid| *pid != 0 && !hidden.contains(pid))
            .collect();
        shown.sort_unstable();
        shown.dedup();
        Exclusions { hidden, shown }
    }

    /// These exclusions with `more` processes hidden too.
    pub fn hiding(&self, more: impl IntoIterator<Item = u32>) -> Exclusions {
        Exclusions::new(
            self.hidden.iter().copied().chain(more),
            self.shown.iter().copied(),
        )
    }
}

/// Whether the windows of the process `pid`, whose app has the bundle ids `bundles`, stay out of
/// the recording. A process can sit in more than one bundle: an Electron helper lies inside its
/// app's bundle, and counts as that app. pid 0 and below are no process.
pub fn leaves_out(pid: i32, bundles: &[&str], exclusions: &Exclusions) -> bool {
    let Ok(pid) = u32::try_from(pid) else {
        return false;
    };
    if pid == 0 {
        return false;
    }
    if exclusions.hidden.contains(&pid) || bundles.iter().any(|b| VOICE_BUNDLES.contains(b)) {
        return true;
    }
    bundles.iter().any(|b| RUKOO_BUNDLES.contains(b)) && !exclusions.shown.contains(&pid)
}

/// What a filter leaves out, from one list of running applications: for the log, and to tell
/// whether a running stream needs a new filter.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Matched {
    /// The pids of the applications left out. Sorted.
    pub pids: Vec<u32>,
    /// The Voice and Rukoo bundle ids among them. Sorted.
    pub bundles: Vec<String>,
    /// The Rukoo applications that stay in because Rukoo asked. Sorted.
    pub kept: Vec<u32>,
    /// Pids asked to be hidden that no application has, such as a process without a window.
    pub unmatched: Vec<u32>,
}

impl Matched {
    /// For the log: pids and bundle ids only, never window titles.
    pub fn describe(&self) -> String {
        let mut line = format!(
            "leaves out pids {:?} (bundles {:?})",
            self.pids, self.bundles
        );
        if !self.kept.is_empty() {
            line.push_str(&format!("; keeps Rukoo pids {:?} in", self.kept));
        }
        if !self.unmatched.is_empty() {
            line.push_str(&format!(
                "; no shareable application has pids {:?}",
                self.unmatched
            ));
        }
        line
    }
}

/// Which of the `listed` applications (pid, bundle id) a filter leaves out, by index, and what
/// matched.
pub fn matching(listed: &[(i32, String)], exclusions: &Exclusions) -> (Vec<usize>, Matched) {
    let mut chosen = Vec::new();
    let mut matched = Matched::default();
    for (n, (pid, bundle)) in listed.iter().enumerate() {
        let known =
            VOICE_BUNDLES.contains(&bundle.as_str()) || RUKOO_BUNDLES.contains(&bundle.as_str());
        if !leaves_out(*pid, &[bundle.as_str()], exclusions) {
            if known && *pid > 0 {
                matched.kept.push(*pid as u32);
            }
            continue;
        }
        chosen.push(n);
        matched.pids.push(*pid as u32);
        if known && !matched.bundles.contains(bundle) {
            matched.bundles.push(bundle.clone());
        }
    }
    matched.pids.sort_unstable();
    matched.pids.dedup();
    matched.bundles.sort();
    matched.kept.sort_unstable();
    matched.kept.dedup();
    matched.unmatched = exclusions
        .hidden
        .iter()
        .copied()
        .filter(|pid| !matched.pids.contains(pid))
        .collect();
    (chosen, matched)
}

/// The window owners whose windows stay out, from each owner's pid and the bundle ids of the app
/// bundles that hold its executable: what the monitor choice looks past.
pub fn owners_left_out(owners: &[(i32, Vec<String>)], exclusions: &Exclusions) -> Vec<u32> {
    let mut pids: Vec<u32> = exclusions.hidden.clone();
    for (pid, bundles) in owners {
        let bundles: Vec<&str> = bundles.iter().map(String::as_str).collect();
        if leaves_out(*pid, &bundles, exclusions) {
            pids.push(*pid as u32);
        }
    }
    pids.sort_unstable();
    pids.dedup();
    pids
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUKOO: &str = "nl.bvdm.rukoo-mail";

    #[test]
    fn exclusions_are_sorted_without_repeats_and_hidden_wins() {
        let ex = Exclusions::new([7, 3, 7, 0], [9, 3, 9, 0, 5]);
        assert_eq!(ex.hidden, [3, 7]);
        assert_eq!(ex.shown, [5, 9]);
        let more = ex.hiding([9, 1]);
        assert_eq!(more.hidden, [1, 3, 7, 9]);
        assert_eq!(more.shown, [5]);
    }

    /// Voice and Rukoo are left out by bundle id, anything else by pid, and a Rukoo that asked to
    /// be shown stays in.
    #[test]
    fn voice_stays_out_and_rukoo_stays_out_unless_it_asked() {
        let none = Exclusions::default();
        assert!(leaves_out(10, &[RUKOO], &none));
        assert!(leaves_out(11, &["nl.bvdm.rukoo.voice"], &none));
        assert!(leaves_out(12, &["nl.bvdm.rukoo.voice.dev"], &none));
        assert!(!leaves_out(15, &["com.apple.Safari"], &none));
        assert!(!leaves_out(0, &[RUKOO], &none));
        assert!(!leaves_out(-1, &[RUKOO], &none));

        // A development Rukoo from Electron: only its pid says it is Rukoo.
        let dev = Exclusions::new([13], []);
        assert!(leaves_out(13, &["com.github.Electron"], &dev));
        assert!(!leaves_out(14, &["com.github.Electron"], &dev));
        // A process without a bundle id, as some helpers have, is still left out by pid.
        assert!(leaves_out(16, &[""], &Exclusions::new([16], [])));

        // The user turned hiding off: that Rukoo stays in, another Rukoo process doesn't.
        let shown = Exclusions::new([], [10]);
        assert!(!leaves_out(10, &[RUKOO], &shown));
        assert!(leaves_out(17, &[RUKOO], &shown));
        // Voice's own app never stays in, whatever a client sends.
        assert!(leaves_out(
            11,
            &["nl.bvdm.rukoo.voice"],
            &Exclusions::new([], [11])
        ));
        // Two connections disagree: hidden wins.
        assert!(leaves_out(10, &[RUKOO], &Exclusions::new([10], [10])));
    }

    /// The filter leaves out the applications with the pids asked for and Voice's and Rukoo's
    /// bundles, keeps a shown Rukoo, and says which asked-for pids no application has.
    #[test]
    fn the_filter_leaves_out_pids_and_bundles() {
        let listed = vec![
            (10, "com.apple.finder".to_string()),
            (20, RUKOO.to_string()),
            (30, String::new()),
            (40, "nl.bvdm.rukoo.voice.dev".to_string()),
            (50, "com.github.Electron".to_string()),
            (0, "nl.bvdm.rukoo.voice".to_string()),
        ];
        let ex = Exclusions::new([50, 30, 77], []);
        let (chosen, matched) = matching(&listed, &ex);
        assert_eq!(chosen, [1, 2, 3, 4]);
        assert_eq!(matched.pids, [20, 30, 40, 50]);
        assert_eq!(matched.bundles, [RUKOO, "nl.bvdm.rukoo.voice.dev"]);
        assert!(matched.kept.is_empty());
        assert_eq!(matched.unmatched, [77]);
        assert!(
            matched.describe().contains("[77]"),
            "{}",
            matched.describe()
        );
        // A restarted Voice is a new pid with the same bundle: the set the filter needs changes.
        let mut restarted = listed.clone();
        restarted[3].0 = 41;
        assert_ne!(matching(&restarted, &ex).1, matched);

        // Rukoo asks to be in the recording: the same list keeps it, and the filter changes.
        let shown = Exclusions::new([50, 30, 77], [20]);
        let (chosen, kept) = matching(&listed, &shown);
        assert_eq!(chosen, [2, 3, 4]);
        assert_eq!(kept.pids, [30, 40, 50]);
        assert_eq!(kept.bundles, ["nl.bvdm.rukoo.voice.dev"]);
        assert_eq!(kept.kept, [20]);
        assert_ne!(kept, matched);
        assert!(
            kept.describe().contains("keeps Rukoo pids [20]"),
            "{}",
            kept.describe()
        );
    }

    /// The monitor choice looks past the same windows the filter leaves out: a helper inside
    /// Rukoo's bundle counts as Rukoo.
    #[test]
    fn the_monitor_choice_looks_past_the_same_owners() {
        let owners = vec![
            (10, vec!["com.apple.finder".to_string()]),
            (20, vec![format!("{RUKOO}.helper"), RUKOO.to_string()]),
            (21, vec![RUKOO.to_string()]),
            (40, vec!["nl.bvdm.rukoo.voice".to_string()]),
            (50, vec!["com.github.Electron".to_string()]),
        ];
        assert_eq!(
            owners_left_out(&owners, &Exclusions::new([50, 77], [])),
            [20, 21, 40, 50, 77]
        );
        assert_eq!(
            owners_left_out(&owners, &Exclusions::new([], [21])),
            [20, 40]
        );
    }
}
