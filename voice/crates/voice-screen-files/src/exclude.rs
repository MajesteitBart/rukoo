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
    /// Pids hidden now that weren't before.
    pub newly_hidden: Vec<u32>,
    /// Rukoo pids shown before and not now.
    pub unshown: Vec<u32>,
}

impl Update {
    /// Whether the change takes out a window the recording may have: a Rukoo no longer shown,
    /// or a newly hidden pid that `already_out` doesn't say the capture's filter leaves out
    /// already. Then frames and video wait for this revision's filter.
    pub fn hides(&self, already_out: impl Fn(u32) -> bool) -> bool {
        !self.unshown.is_empty() || self.newly_hidden.iter().any(|&pid| !already_out(pid))
    }
}

/// What the screen process leaves out: what Voice last asked, with the permission to keep a
/// Rukoo in held as a lease, and every Rukoo it ever showed hidden again once Voice stops
/// showing it, by pid, for as long as that process runs: a development Rukoo has no bundle id
/// that would leave it out otherwise.
#[derive(Clone, Debug)]
pub struct Policy {
    wanted: Exclusions,
    /// When `wanted.shown` lapses unless Voice renews it.
    shown_until: Option<Instant>,
    /// Every pid Voice asked to show, while its process runs.
    once_shown: Vec<u32>,
    effective: Exclusions,
    revision: u64,
}

impl Policy {
    /// The command line's exclusions at `now`, revision 1. Its shown pids get a lease from the
    /// start too.
    pub fn new(initial: Exclusions, now: Instant) -> Policy {
        let shown_until = (!initial.shown.is_empty()).then(|| now + SHOWN_LEASE);
        Policy {
            once_shown: initial.shown.clone(),
            effective: initial.clone(),
            wanted: initial,
            shown_until,
            revision: 1,
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// What applies now: what Voice asked, with the shown Rukoo hidden once the lease lapsed,
    /// and every Rukoo shown before and not now hidden.
    pub fn effective(&self) -> &Exclusions {
        &self.effective
    }

    /// Whether Voice's permission to keep a Rukoo in lapsed.
    pub fn lapsed(&self) -> bool {
        !self.wanted.shown.is_empty() && self.effective.shown.is_empty()
    }

    /// An `exclude` from Voice at `now`, which renews the lease. `alive` says whether a process
    /// still runs. The change, when what applies changed.
    pub fn set(
        &mut self,
        wanted: Exclusions,
        now: Instant,
        alive: impl Fn(u32) -> bool,
    ) -> Option<Update> {
        self.shown_until = (!wanted.shown.is_empty()).then(|| now + SHOWN_LEASE);
        self.wanted = wanted;
        self.apply(now, alive)
    }

    /// Checks the lease at `now`: a lapsed one hides the Rukoo it showed, by its pid as well.
    /// A Rukoo shown before whose process ended is let go.
    pub fn tick(&mut self, now: Instant, alive: impl Fn(u32) -> bool) -> Option<Update> {
        self.apply(now, alive)
    }

    fn apply(&mut self, now: Instant, alive: impl Fn(u32) -> bool) -> Option<Update> {
        self.once_shown.retain(|&pid| alive(pid));
        for &pid in &self.wanted.shown {
            if !self.once_shown.contains(&pid) {
                self.once_shown.push(pid);
            }
        }
        let lapsed = self.shown_until.is_some_and(|until| now >= until);
        let base = if lapsed {
            self.wanted.hiding_shown()
        } else {
            self.wanted.clone()
        };
        let next = Exclusions::new(
            base.hidden.iter().copied().chain(
                self.once_shown
                    .iter()
                    .copied()
                    .filter(|pid| !base.shown.contains(pid)),
            ),
            base.shown.iter().copied(),
        );
        if next == self.effective {
            return None;
        }
        let newly_hidden = next
            .hidden
            .iter()
            .copied()
            .filter(|pid| !self.effective.hidden.contains(pid))
            .collect();
        let unshown = self
            .effective
            .shown
            .iter()
            .copied()
            .filter(|pid| !next.shown.contains(pid))
            .collect();
        self.revision += 1;
        self.effective = next.clone();
        Some(Update {
            revision: self.revision,
            exclusions: next,
            newly_hidden,
            unshown,
        })
    }
}

/// What the capture has in place: the newest revision whose filter a stream applied, the boot
/// time it confirmed that, and the Rukoo pids the active stream's filter keeps in.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Applied {
    pub revision: u64,
    pub at: u64,
    pub shown: Vec<u32>,
}

/// How long a change that hides may wait for its filter and the first frame after it before
/// the capture starts over on a new stream.
pub const HOLD_LIMIT: Duration = Duration::from_secs(3);

/// Follows the changes until the capture has them in place: which Rukoo the recording keeps in
/// as the capture's filter applies it, and, after a change that hides, which frames may be
/// recorded. Boot times are on the clock frames carry.
#[derive(Clone, Debug, Default)]
pub struct Applying {
    /// The Rukoo the newest change shows, for a capture that applies a change at once.
    latest: Vec<u32>,
    /// The Rukoo the recording keeps in, as the capture applies it.
    shown: Vec<u32>,
    /// A change that hides, whose filter isn't in place yet: no frame is recorded meanwhile.
    holding: Option<u64>,
    /// Frames captured before this were taken with an older filter, or while one was changing.
    release_after: u64,
    /// Since when a change that hides waits for its filter and a frame after it.
    waiting_since: Option<Instant>,
}

impl Applying {
    /// Before the capture applied anything, the recording keeps no Rukoo in: `initial` is the
    /// command line's revision 1.
    pub fn new(initial: &Exclusions) -> Applying {
        Applying {
            latest: initial.shown.clone(),
            ..Applying::default()
        }
    }

    /// A change asked at `boot` and `now`; `hides` from `Update::hides`.
    pub fn changed(&mut self, update: &Update, hides: bool, boot: u64, now: Instant) {
        self.latest = update.exclusions.shown.clone();
        if hides {
            self.holding = Some(
                self.holding
                    .map_or(update.revision, |r| r.max(update.revision)),
            );
            self.release_after = self.release_after.max(boot);
            self.waiting_since.get_or_insert(now);
        }
    }

    /// What the capture has in place, or `None` for one that applies a change at once, such as
    /// the synthetic screen, read at boot time `now`. Returns whether a hold ended.
    pub fn applied(&mut self, applied: Option<Applied>, now: u64) -> bool {
        let (revision, at) = match applied {
            Some(applied) => {
                self.shown = applied.shown;
                (applied.revision, applied.at)
            }
            None => {
                self.shown = self.latest.clone();
                (u64::MAX, now)
            }
        };
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

    /// A frame passed: the change that hid is done.
    pub fn recorded(&mut self) {
        if self.holding.is_none() {
            self.waiting_since = None;
        }
    }

    /// Whether a change that hides has waited longer than [`HOLD_LIMIT`] at `now` for its
    /// filter or a frame after it: the capture starts over then.
    pub fn overdue(&self, now: Instant) -> bool {
        self.waiting_since
            .is_some_and(|since| now.duration_since(since) >= HOLD_LIMIT)
    }

    /// The capture started over at `now`: the wait counts from here.
    pub fn restarted(&mut self, now: Instant) {
        if self.waiting_since.is_some() {
            self.waiting_since = Some(now);
        }
    }

    /// The Rukoo pids the recording keeps in, as the capture's filter applies them.
    pub fn shown(&self) -> &[u32] {
        &self.shown
    }
}

/// What a running stream's filter applies, as far as is known. A filter update that failed or
/// didn't answer may still land later, so from then on nothing about the stream's filter is
/// trusted: the stream starts over.
#[derive(Clone, Debug)]
pub struct StreamFilter {
    /// The applications the installed filter leaves out and the exclusions it was made from, or
    /// `None` once an update was lost.
    installed: Option<(Matched, Exclusions)>,
    revision: u64,
    /// After a lost update: every Rukoo the stream may keep in, the installed filter's and the
    /// lost one's.
    maybe_shown: Vec<u32>,
}

/// What a read of the running applications calls for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterStep {
    /// A newer change came meanwhile; its read follows.
    Stale,
    /// The installed filter already leaves out what this revision asks.
    InPlace,
    Install,
}

impl StreamFilter {
    /// A stream started with the filter of `revision`.
    pub fn started(revision: u64, matched: Matched, exclusions: Exclusions) -> StreamFilter {
        StreamFilter {
            installed: Some((matched, exclusions)),
            revision,
            maybe_shown: Vec::new(),
        }
    }

    /// The revision of the installed filter.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Whether an update was lost: the stream must start over.
    pub fn lost(&self) -> bool {
        self.installed.is_none()
    }

    /// A read for `revision` found the applications `matched`; `latest` is the newest change.
    pub fn next(&self, revision: u64, latest: u64, matched: &Matched) -> FilterStep {
        if revision < latest {
            return FilterStep::Stale;
        }
        match &self.installed {
            Some((installed, _)) if installed == matched => FilterStep::InPlace,
            _ => FilterStep::Install,
        }
    }

    /// The installed filter serves `revision` as it is.
    pub fn in_place(&mut self, revision: u64, exclusions: &Exclusions) {
        if let Some((_, applied)) = self.installed.as_mut() {
            *applied = exclusions.clone();
            self.revision = self.revision.max(revision);
        }
    }

    /// The filter for `revision` is in place.
    pub fn installed(&mut self, revision: u64, matched: Matched, exclusions: Exclusions) {
        if self.installed.is_some() {
            self.installed = Some((matched, exclusions));
            self.revision = revision;
        }
    }

    /// An update to `attempted` failed or didn't answer.
    pub fn lose(&mut self, attempted: &Exclusions) {
        let mut maybe: Vec<u32> = self.shown().to_vec();
        maybe.extend(&attempted.shown);
        maybe.sort_unstable();
        maybe.dedup();
        self.maybe_shown = maybe;
        self.installed = None;
    }

    /// The Rukoo pids the stream keeps in: the installed filter's, or after a lost update every
    /// one it may keep in.
    pub fn shown(&self) -> &[u32] {
        match &self.installed {
            Some((_, exclusions)) => &exclusions.shown,
            None => &self.maybe_shown,
        }
    }

    /// Whether the installed filter leaves out the process `pid` already.
    pub fn leaves_out(&self, pid: u32) -> bool {
        self.installed
            .as_ref()
            .is_some_and(|(matched, _)| matched.pids.contains(&pid))
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

    const ALIVE: fn(u32) -> bool = |_| true;

    /// Keeping Rukoo in is a lease: an `exclude` renews it, and without one the shown Rukoo is
    /// hidden again, by its pid too, as a change that hides.
    #[test]
    fn the_permission_to_show_rukoo_lapses_without_a_renewal() {
        let start = Instant::now();
        let mut policy = Policy::new(Exclusions::new([7], [4821]), start);
        assert_eq!(policy.revision(), 1);
        assert_eq!(policy.effective().shown, [4821]);
        // Renewed before it lapses: nothing changes.
        assert_eq!(policy.tick(start + SHOWN_RENEW, ALIVE), None);
        assert_eq!(
            policy.set(Exclusions::new([7], [4821]), start + SHOWN_RENEW, ALIVE),
            None
        );
        assert_eq!(policy.tick(start + SHOWN_LEASE, ALIVE), None);
        let lapse = start + SHOWN_RENEW + SHOWN_LEASE;
        let update = policy.tick(lapse, ALIVE).expect("the lease lapsed");
        assert_eq!(update.revision, 2);
        assert_eq!(update.exclusions, Exclusions::new([7, 4821], []));
        assert_eq!(update.unshown, [4821]);
        assert!(update.hides(|_| true));
        assert!(policy.lapsed());
        assert_eq!(policy.tick(lapse + SHOWN_LEASE, ALIVE), None);
        // Voice is back and asks again: Rukoo is shown, which hides nothing.
        let back = policy
            .set(Exclusions::new([7], [4821]), lapse + SHOWN_LEASE, ALIVE)
            .expect("shown again");
        assert_eq!(back.revision, 3);
        assert!(!back.hides(|_| false));
        assert!(!policy.lapsed());
        // Without anything shown there is no lease to lapse.
        let mut hidden = Policy::new(Exclusions::new([7], []), start);
        assert_eq!(hidden.tick(start + SHOWN_LEASE * 10, ALIVE), None);
    }

    /// A Rukoo Voice showed stays hidden by its pid once Voice stops showing it, as when its
    /// connection closes, until its process ends or Voice shows it again: a development Rukoo
    /// has no bundle id that would leave it out.
    #[test]
    fn a_rukoo_shown_once_stays_hidden_while_it_runs() {
        let now = Instant::now();
        let running = std::cell::Cell::new(true);
        let alive = |pid: u32| pid != 4821 || running.get();
        let mut policy = Policy::new(Exclusions::new([], [4821]), now);
        let closed = policy
            .set(Exclusions::default(), now, alive)
            .expect("the connection closed");
        assert_eq!(closed.exclusions, Exclusions::new([4821], []));
        assert_eq!(
            (closed.newly_hidden.clone(), closed.unshown.clone()),
            (vec![4821], vec![4821])
        );
        // Asked to show again by a new connection.
        let again = policy
            .set(Exclusions::new([], [4821]), now, alive)
            .expect("shown again");
        assert_eq!(again.exclusions, Exclusions::new([], [4821]));
        policy.set(Exclusions::default(), now, alive).unwrap();
        // The process ended: it is let go, which hides nothing.
        running.set(false);
        let gone = policy.tick(now, alive).expect("let go");
        assert_eq!(gone.exclusions, Exclusions::default());
        assert!(!gone.hides(|_| false));
        // A pid only ever hidden is not remembered.
        let mut hidden = Policy::new(Exclusions::new([77], []), now);
        let dropped = hidden.set(Exclusions::default(), now, ALIVE).unwrap();
        assert_eq!(dropped.exclusions, Exclusions::default());
    }

    /// A change hides when it leaves out a window the recording may have: a Rukoo no longer
    /// shown, or a newly hidden pid the filter doesn't leave out already.
    #[test]
    fn a_change_hides_when_it_takes_a_window_out() {
        let now = Instant::now();
        let mut policy = Policy::new(Exclusions::default(), now);
        let connect = policy.set(Exclusions::new([4821], []), now, ALIVE).unwrap();
        assert_eq!(connect.revision, 2);
        // A packaged Rukoo is out by its bundle id already: nothing to wait for.
        assert!(!connect.hides(|pid| pid == 4821));
        // A development Rukoo whose windows were in the recording.
        assert!(connect.hides(|_| false));
        let show = policy.set(Exclusions::new([], [4821]), now, ALIVE).unwrap();
        assert!(!show.hides(|_| false));
        let hide = policy.set(Exclusions::new([4821], []), now, ALIVE).unwrap();
        // A shown Rukoo that goes out always waits, whatever the old filter says.
        assert!(hide.hides(|_| true));
        assert_eq!(policy.set(Exclusions::new([4821], []), now, ALIVE), None);
    }

    fn update(revision: u64, hidden: &[u32], shown: &[u32]) -> Update {
        Update {
            revision,
            exclusions: Exclusions::new(hidden.iter().copied(), shown.iter().copied()),
            newly_hidden: hidden.to_vec(),
            unshown: Vec::new(),
        }
    }

    fn applied(revision: u64, at: u64, shown: &[u32]) -> Option<Applied> {
        Some(Applied {
            revision,
            at,
            shown: shown.to_vec(),
        })
    }

    /// After a change that hides, no frame is recorded until the capture has a filter of that
    /// revision or newer, and then only frames captured after it confirmed that. The report says
    /// what the active stream's filter applies, not what was asked.
    #[test]
    fn frames_wait_for_the_filter_of_a_change_that_hides() {
        let now = Instant::now();
        let mut applying = Applying::new(&Exclusions::new([], [4821]));
        assert!(applying.shown().is_empty(), "nothing applied yet");
        assert!(!applying.applied(applied(1, 100, &[4821]), 100));
        assert_eq!(applying.shown(), [4821]);
        assert!(applying.passes(50));

        applying.changed(&update(2, &[4821], &[]), true, 1_000, now);
        assert!(applying.holding());
        assert!(!applying.passes(500));
        assert!(!applying.passes(2_000));
        // A stale filter doesn't end the hold, and the report still says what it applies.
        assert!(!applying.applied(applied(1, 1_500, &[4821]), 1_500));
        assert!(!applying.passes(2_000));
        assert_eq!(applying.shown(), [4821]);
        // A newer change shows Rukoo again before the hide was applied: the hold stays until a
        // filter at least as new as the hide is in place.
        applying.changed(&update(3, &[], &[4821]), false, 1_600, now);
        assert!(!applying.applied(applied(1, 1_700, &[4821]), 1_700));
        assert!(applying.applied(applied(3, 2_000, &[4821]), 2_100));
        assert!(!applying.holding());
        // Frames captured while the filter changed stay out; later ones pass.
        assert!(!applying.passes(1_999));
        assert!(applying.passes(2_000));

        // The filter of the hide is in place: Rukoo is reported out.
        applying.changed(&update(4, &[4821], &[]), true, 3_000, now);
        assert!(applying.applied(applied(4, 3_200, &[]), 3_300));
        assert!(applying.shown().is_empty());
        assert!(!applying.passes(3_100));
        assert!(applying.passes(3_200));
        // No active stream: nothing is kept in.
        applying.applied(applied(4, 3_200, &[]), 3_400);
        assert!(applying.shown().is_empty());

        // A capture that applies at once ends a hold when asked, from that moment, and reports
        // the newest change.
        let mut synthetic = Applying::new(&Exclusions::default());
        synthetic.changed(&update(2, &[], &[4821]), false, 5, now);
        synthetic.changed(&update(3, &[4821], &[]), true, 10, now);
        assert!(synthetic.applied(None, 20));
        assert!(!synthetic.passes(19));
        assert!(synthetic.passes(20));
        assert!(synthetic.shown().is_empty());
    }

    /// A change that hides may wait for its filter and a frame after it for `HOLD_LIMIT`; then the
    /// capture starts over, and the wait counts again.
    #[test]
    fn a_hold_that_lasts_too_long_starts_the_capture_over() {
        let now = Instant::now();
        let mut applying = Applying::new(&Exclusions::default());
        assert!(!applying.overdue(now + HOLD_LIMIT * 10));
        applying.changed(&update(2, &[4821], &[]), true, 10, now);
        assert!(!applying.overdue(now + HOLD_LIMIT / 2));
        assert!(applying.overdue(now + HOLD_LIMIT));
        applying.restarted(now + HOLD_LIMIT);
        assert!(!applying.overdue(now + HOLD_LIMIT + HOLD_LIMIT / 2));
        // The filter is in place, but no frame came yet: still waiting.
        applying.applied(applied(2, 20, &[]), 30);
        assert!(applying.overdue(now + HOLD_LIMIT * 2));
        applying.recorded();
        assert!(!applying.overdue(now + HOLD_LIMIT * 10));
        // A change that doesn't hide doesn't start a wait.
        applying.changed(&update(3, &[], &[4821]), false, 40, now);
        assert!(!applying.overdue(now + HOLD_LIMIT * 10));
    }

    /// An update that didn't answer may land late, so the installed filter is no longer known:
    /// a later hide installs a filter even when the applications match the old one, the stream
    /// is due to start over, and the report counts every Rukoo it may keep in.
    #[test]
    fn a_lost_update_trusts_nothing_about_the_stream() {
        let hidden = Matched {
            pids: vec![40, 4821],
            ..Matched::default()
        };
        let mut filter = StreamFilter::started(1, hidden.clone(), Exclusions::new([4821], []));
        assert_eq!(filter.next(2, 2, &hidden), FilterStep::InPlace);
        assert_eq!(filter.next(2, 3, &hidden), FilterStep::Stale);
        assert!(filter.leaves_out(4821));
        assert!(filter.shown().is_empty());
        // The show didn't answer.
        filter.lose(&Exclusions::new([], [4821]));
        assert!(filter.lost());
        assert_eq!(filter.shown(), [4821]);
        assert!(!filter.leaves_out(4821));
        assert_eq!(filter.next(3, 3, &hidden), FilterStep::Install);
        // Nothing installs on a lost stream: it starts over.
        filter.installed(3, hidden.clone(), Exclusions::new([4821], []));
        assert!(filter.lost());
        filter.in_place(3, &Exclusions::new([4821], []));
        assert_eq!(filter.revision(), 1);

        let mut fine = StreamFilter::started(1, hidden.clone(), Exclusions::new([4821], []));
        let shown = Matched {
            pids: vec![40],
            ..Matched::default()
        };
        fine.installed(2, shown.clone(), Exclusions::new([], [4821]));
        assert_eq!((fine.revision(), fine.shown()), (2, &[4821][..]));
        fine.in_place(3, &Exclusions::new([], [4821, 90]));
        assert_eq!(fine.revision(), 3);
        assert_eq!(fine.shown(), [90, 4821]);
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
