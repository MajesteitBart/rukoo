use crate::Replay;

/// The highest version both ranges hold, or `None` when they don't overlap. Each range is
/// `(min, max)`: Rukoo's own, and Voice's `minProtocol` and `protocol`.
pub fn negotiate(client: (u32, u32), voice: (u32, u32)) -> Option<u32> {
    let highest = client.1.min(voice.1);
    let lowest = client.0.max(voice.0);
    (highest >= lowest).then_some(highest)
}

/// Which events follow `welcome`, and the first sequence number to send.
///
/// `hello_instance` and `after` come from `hello`; `instance`, `head` and `oldest` describe
/// Voice's event log, where `oldest` is `head + 1` when nothing is stored.
pub fn replay_plan(
    hello_instance: Option<&str>,
    after: u64,
    instance: &str,
    head: u64,
    oldest: u64,
) -> (Replay, u64) {
    if hello_instance != Some(instance) || after > head {
        return (Replay::Full, oldest);
    }
    let next = after.saturating_add(1);
    if next >= oldest {
        (Replay::Partial, next)
    } else {
        (Replay::Gap, oldest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation_picks_the_highest_shared_version() {
        assert_eq!(negotiate((1, 1), (1, 1)), Some(1));
        assert_eq!(negotiate((2, 5), (1, 3)), Some(3));
        assert_eq!(negotiate((1, 1), (2, 2)), None);
    }

    #[test]
    fn a_fresh_log_replays_from_one() {
        assert_eq!(replay_plan(None, 0, "i", 0, 1), (Replay::Full, 1));
        assert_eq!(replay_plan(Some("i"), 0, "i", 0, 1), (Replay::Partial, 1));
    }
}
