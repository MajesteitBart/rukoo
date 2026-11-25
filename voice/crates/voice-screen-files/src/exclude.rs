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
//!
//! Keeping Rukoo in is a lease (`Policy`): every `exclude` from Voice renews it for
//! [`SHOWN_LEASE`], and without renewal every shown Rukoo is hidden again, so the permission
//! ends soon after Voice stops, also when it crashes. Each change of what the recording leaves
//! out has a revision. A change that hides a window the recording showed holds frames and video
//! back (`Applying`) until the capture says the filter of that revision, or a newer one, is in
//! place, and then lets through only frames captured after that.

use std::time::{Duration, Instant};

/// Voice's app, installed and as a development bundle.
pub const VOICE_BUNDLES: [&str; 2] = ["nl.bvdm.rukoo.voice", "nl.bvdm.rukoo.voice.dev"];
/// Rukoo, as its macOS package names it (`build.appId` in Rukoo's package.json).
pub const RUKOO_BUNDLES: [&str; 1] = ["nl.bvdm.rukoo-mail"];
/// The most pids each list of an `exclude` request takes.
pub const MAX_PIDS: usize = 64;
/// How long Voice's permission to keep a Rukoo in the recording lasts without a renewal.
pub const SHOWN_LEASE: Duration = Duration::from_secs(5);
/// How often Voice renews that permission while a Rukoo is shown: three times a lease, so one
/// slow watchdog round doesn't let it lapse.
pub const SHOWN_RENEW: Duration = Duration::from_millis(1500);

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

    /// These exclusions with every shown Rukoo hidden, by its pid too, so a development Rukoo
    /// without Rukoo's bundle id goes as well: what applies once Voice's permission ended.
    pub fn hiding_shown(&self) -> Exclusions {
        Exclusions::new(self.hidden.iter().chain(&self.shown).copied(), [])
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

/// A change of what the recording leaves out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Update {
    /// Counts the changes, from 1 for the command line's: a filter made for an older revision is
    /// stale.
    pub revision: u64,
    pub exclusions: Exclusions,
    /// The change leaves out a window the recording kept in: a pid newly hidden, or a Rukoo no
    /// longer shown. Frames and video wait for this revision's filter.
    pub hides: bool,
}

/// What the screen process leaves out: what Voice last asked, with the permission to keep a
/// Rukoo in held as a lease.
#[derive(Clone, Debug)]
pub struct Policy {
    wanted: Exclusions,
    /// When `wanted.shown` lapses unless Voice renews it.
    shown_until: Option<Instant>,
    effective: Exclusions,
    revision: u64,
}

impl Policy {
    /// The command line's exclusions at `now`, revision 1. Its shown pids get a lease from the
    /// start too.
    pub fn new(initial: Exclusions, now: Instant) -> Policy {
        let shown_until = (!initial.shown.is_empty()).then(|| now + SHOWN_LEASE);
        Policy {
            effective: initial.clone(),
            wanted: initial,
            shown_until,
            revision: 1,
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// What applies now: what Voice asked, with the shown Rukoo hidden once the lease lapsed.
    pub fn effective(&self) -> &Exclusions {
        &self.effective
    }

    /// Whether Voice's permission to keep a Rukoo in lapsed.
    pub fn lapsed(&self) -> bool {
        !self.wanted.shown.is_empty() && self.effective.shown.is_empty()
    }

    /// An `exclude` from Voice at `now`, which renews the lease. The change, when what applies
    /// changed.
    pub fn set(&mut self, wanted: Exclusions, now: Instant) -> Option<Update> {
        self.shown_until = (!wanted.shown.is_empty()).then(|| now + SHOWN_LEASE);
        self.wanted = wanted;
        self.apply(now)
    }

    /// Checks the lease at `now`: a lapsed one hides the Rukoo it showed, by its pid as well, so
    /// a development Rukoo without Rukoo's bundle id goes too.
    pub fn tick(&mut self, now: Instant) -> Option<Update> {
        self.apply(now)
    }

    fn apply(&mut self, now: Instant) -> Option<Update> {
        let lapsed = self.shown_until.is_some_and(|until| now >= until);
        let next = if lapsed {
            self.wanted.hiding_shown()
        } else {
            self.wanted.clone()
        };
        if next == self.effective {
            return None;
        }
        let hides = next
            .hidden
            .iter()
            .any(|pid| !self.effective.hidden.contains(pid))
            || self
                .effective
                .shown
                .iter()
                .any(|pid| !next.shown.contains(pid));
        self.revision += 1;
        self.effective = next.clone();
        Some(Update {
            revision: self.revision,
            exclusions: next,
            hides,
        })
    }
}

/// Follows the changes until the capture has them in place: which Rukoo the recording keeps in
/// as far as the capture confirmed, and, after a change that hides, which frames may be
/// recorded. Times are on the boot clock frames carry.
#[derive(Clone, Debug, Default)]
pub struct Applying {
    /// The newest change not confirmed yet, and the Rukoo it shows.
    pending: Option<(u64, Vec<u32>)>,
    /// The Rukoo the recording keeps in, as confirmed.
    shown: Vec<u32>,
    /// A change that hides, whose filter isn't in place yet: no frame is recorded meanwhile.
    holding: Option<u64>,
    /// Frames captured before this were taken with an older filter, or while one was changing.
    release_after: u64,
}

impl Applying {
    /// Before the capture confirmed anything, the recording keeps no Rukoo in, as far as it
    /// knows: `initial` is the command line's revision 1.
    pub fn new(initial: &Exclusions) -> Applying {
        Applying {
            pending: Some((1, initial.shown.clone())),
            ..Applying::default()
        }
    }

    /// A change asked at `boot`.
    pub fn changed(&mut self, update: &Update, boot: u64) {
        self.pending = Some((update.revision, update.exclusions.shown.clone()));
        if update.hides {
            self.holding = Some(
                self.holding
                    .map_or(update.revision, |r| r.max(update.revision)),
            );
            self.release_after = self.release_after.max(boot);
        }
    }

    /// What the capture has in place: the newest revision whose filter it applied and the boot
    /// time it confirmed it, or `None` for a capture that applies a change at once, such as the
    /// synthetic screen, read at `now`. Returns whether a hold ended.
    pub fn applied(&mut self, applied: Option<(u64, u64)>, now: u64) -> bool {
        let (revision, at) = applied.unwrap_or((u64::MAX, now));
        if self.pending.as_ref().is_some_and(|(r, _)| *r <= revision) {
            if let Some((_, shown)) = self.pending.take() {
                self.shown = shown;
            }
        }
        match self.holding {
            Some(waiting) if waiting <= revision => {
                self.holding = None;
                self.release_after = self.release_after.max(at);
                true
            }
            _ => false,
        }
    }

    /// Whether a change that hides waits for its filter.
    pub fn holding(&self) -> bool {
        self.holding.is_some()
    }

    /// Whether a frame captured at `boot` may be recorded.
    pub fn passes(&self, boot: u64) -> bool {
        self.holding.is_none() && boot >= self.release_after
    }

    /// The Rukoo pids the recording keeps in, as the capture confirmed.
    pub fn shown(&self) -> &[u32] {
        &self.shown
    }
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
        assert_eq!(ex.hiding_shown(), Exclusions::new([3, 5, 7, 9], []));
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

    /// Keeping Rukoo in is a lease: an `exclude` renews it, and without one the shown Rukoo is
    /// hidden again, by its pid too, as a change that hides.
    #[test]
    fn the_permission_to_show_rukoo_lapses_without_a_renewal() {
        let start = Instant::now();
        let mut policy = Policy::new(Exclusions::new([7], [4821]), start);
        assert_eq!(policy.revision(), 1);
        assert_eq!(policy.effective().shown, [4821]);
        // Renewed before it lapses: nothing changes.
        assert_eq!(policy.tick(start + SHOWN_RENEW), None);
        assert_eq!(
            policy.set(Exclusions::new([7], [4821]), start + SHOWN_RENEW),
            None
        );
        assert_eq!(policy.tick(start + SHOWN_LEASE), None);
        let lapse = start + SHOWN_RENEW + SHOWN_LEASE;
        let update = policy.tick(lapse).expect("the lease lapsed");
        assert_eq!(
            update,
            Update {
                revision: 2,
                exclusions: Exclusions::new([7, 4821], []),
                hides: true,
            }
        );
        assert!(policy.lapsed());
        assert_eq!(policy.tick(lapse + SHOWN_LEASE), None);
        // Voice is back and asks again: Rukoo is shown, which hides nothing.
        let back = policy
            .set(Exclusions::new([7], [4821]), lapse + SHOWN_LEASE)
            .expect("shown again");
        assert_eq!(back.revision, 3);
        assert!(!back.hides);
        assert!(!policy.lapsed());
        // Without anything shown there is no lease to lapse.
        let mut hidden = Policy::new(Exclusions::new([7], []), start);
        assert_eq!(hidden.tick(start + SHOWN_LEASE * 10), None);
    }

    /// Every change gets the next revision; a change hides when it leaves out a window the
    /// recording kept in.
    #[test]
    fn a_change_hides_when_it_takes_a_window_out() {
        let now = Instant::now();
        let mut policy = Policy::new(Exclusions::default(), now);
        let connect = policy.set(Exclusions::new([4821], []), now).unwrap();
        assert_eq!((connect.revision, connect.hides), (2, true));
        let show = policy.set(Exclusions::new([], [4821]), now).unwrap();
        assert_eq!((show.revision, show.hides), (3, false));
        let hide = policy.set(Exclusions::new([4821], []), now).unwrap();
        assert_eq!((hide.revision, hide.hides), (4, true));
        // Rukoo quits: its pid goes, which leaves out nothing new.
        let quit = policy.set(Exclusions::default(), now).unwrap();
        assert_eq!((quit.revision, quit.hides), (5, false));
        // A shown Rukoo that disconnects is hidden by its bundle id again.
        policy.set(Exclusions::new([], [4821]), now).unwrap();
        let gone = policy.set(Exclusions::default(), now).unwrap();
        assert!(gone.hides);
        assert_eq!(policy.set(Exclusions::default(), now), None);
    }

    /// After a change that hides, no frame is recorded until the capture has a filter of that
    /// revision or newer, and then only frames captured after it confirmed that.
    #[test]
    fn frames_wait_for_the_filter_of_a_change_that_hides() {
        let mut applying = Applying::new(&Exclusions::new([], [4821]));
        assert!(applying.shown().is_empty(), "nothing confirmed yet");
        assert!(!applying.applied(Some((1, 100)), 100));
        assert_eq!(applying.shown(), [4821]);
        assert!(applying.passes(50));

        let hide = Update {
            revision: 2,
            exclusions: Exclusions::new([4821], []),
            hides: true,
        };
        applying.changed(&hide, 1_000);
        assert!(applying.holding());
        assert!(!applying.passes(500));
        assert!(!applying.passes(2_000));
        // A stale filter, or none, doesn't end the hold, and the report still says shown.
        assert!(!applying.applied(Some((1, 1_500)), 1_500));
        assert!(!applying.passes(2_000));
        assert_eq!(applying.shown(), [4821]);
        // A newer change shows Rukoo again before the hide was applied: the hold stays until a
        // filter at least as new as the hide is in place.
        let show = Update {
            revision: 3,
            exclusions: Exclusions::new([], [4821]),
            hides: false,
        };
        applying.changed(&show, 1_600);
        assert!(!applying.applied(Some((1, 1_700)), 1_700));
        assert!(applying.applied(Some((3, 2_000)), 2_100));
        assert!(!applying.holding());
        assert_eq!(applying.shown(), [4821]);
        // Frames captured while the filter changed stay out; later ones pass.
        assert!(!applying.passes(1_999));
        assert!(applying.passes(2_000));

        // The capture confirms the hide: Rukoo is no longer reported shown.
        applying.changed(&hide_at(4), 3_000);
        assert!(applying.applied(Some((4, 3_200)), 3_300));
        assert!(applying.shown().is_empty());
        assert!(!applying.passes(3_100));
        assert!(applying.passes(3_200));

        // A capture that applies at once ends a hold when asked, from that moment.
        let mut synthetic = Applying::new(&Exclusions::default());
        synthetic.changed(&hide_at(2), 10);
        assert!(synthetic.applied(None, 20));
        assert!(!synthetic.passes(19));
        assert!(synthetic.passes(20));
    }

    fn hide_at(revision: u64) -> Update {
        Update {
            revision,
            exclusions: Exclusions::new([4821], []),
            hides: true,
        }
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
