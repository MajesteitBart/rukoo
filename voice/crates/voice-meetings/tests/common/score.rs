//! The speaker label scorer: how much of the transcript went to the right speaker. The same
//! function as voice/scripts/lib/speaker-score.mjs; both pass
//! voice/fixtures/speaker-score-vectors.json.
//!
//! - Each passage's reference speaker is the one whose turns overlap it most (ties go to the
//!   name that sorts first); a passage that overlaps no reference turn is left out.
//! - Ids map to reference speakers one to one: for every id and reference speaker, the time of
//!   the id's passages whose reference speaker that is; the largest pair first, ties by id and
//!   then by reference speaker.
//! - Accuracy is the time of passages whose id maps to their reference speaker, over the time
//!   of all scored passages. A passage without an id counts as wrong. A passage's time is its
//!   whole length.

use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: u64,
    pub end: u64,
    pub speaker: Option<String>,
}

/// Each scored passage with its reference speaker, and the id to reference speaker mapping.
fn assign<'a>(
    passages: &'a [Span],
    reference: &[Span],
) -> (Vec<(&'a Span, String)>, BTreeMap<String, String>) {
    let mut scored = Vec::new();
    for p in passages {
        let mut overlap: BTreeMap<&str, u64> = BTreeMap::new();
        for r in reference {
            let shared = p.end.min(r.end).saturating_sub(p.start.max(r.start));
            if let (true, Some(name)) = (shared > 0, r.speaker.as_deref()) {
                *overlap.entry(name).or_insert(0) += shared;
            }
        }
        // The largest overlap; the first name in order on a tie.
        let mut best: Option<(&str, u64)> = None;
        for (&name, &t) in &overlap {
            if best.is_none_or(|(_, b)| t > b) {
                best = Some((name, t));
            }
        }
        if let Some((name, _)) = best {
            scored.push((p, name.to_owned()));
        }
    }
    let mut matrix: BTreeMap<(String, String), u64> = BTreeMap::new();
    for (p, name) in &scored {
        if let Some(id) = &p.speaker {
            *matrix.entry((id.clone(), name.clone())).or_insert(0) += p.end - p.start;
        }
    }
    let mut pairs: Vec<((String, String), u64)> = matrix.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let (mut ids, mut names) = (HashSet::new(), HashSet::new());
    let mut mapping = BTreeMap::new();
    for ((id, name), _) in pairs {
        if !ids.contains(&id) && !names.contains(&name) {
            ids.insert(id.clone());
            names.insert(name.clone());
            mapping.insert(id, name);
        }
    }
    (scored, mapping)
}

/// The fraction of scored passage time whose id maps to its reference speaker; 1 when nothing
/// is scored.
pub fn accuracy(passages: &[Span], reference: &[Span]) -> f64 {
    let (scored, mapping) = assign(passages, reference);
    let total: u64 = scored.iter().map(|(p, _)| p.end - p.start).sum();
    if total == 0 {
        return 1.0;
    }
    let right: u64 = scored
        .iter()
        .filter(|(p, name)| {
            p.speaker
                .as_ref()
                .and_then(|id| mapping.get(id))
                .is_some_and(|mapped| mapped == name)
        })
        .map(|(p, _)| p.end - p.start)
        .sum();
    right as f64 / total as f64
}

/// The reference speaker each id maps to, by the same rule as [`accuracy`].
pub fn mapping(passages: &[Span], reference: &[Span]) -> BTreeMap<String, String> {
    assign(passages, reference).1
}
