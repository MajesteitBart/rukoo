//! The opt-in check for new Voice releases.
//!
//! Voice is released from the Rukoo repository under `voice-v<version>` tags; every other tag
//! there belongs to Rukoo. The daily check only asks GitHub when the user turned it on, and
//! GitHub sees the user's IP address when it does. "Check now" in Settings asks regardless,
//! because the user asked.

use std::cmp::Ordering;
use std::fmt;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::config::Config;

pub const RELEASES_URL: &str =
    "https://api.github.com/repos/MajesteitBart/rukoo/releases?per_page=100";
pub const TAG_PREFIX: &str = "voice-v";
pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Release {
    pub version: String,
    pub tag: String,
    pub name: String,
    /// The release page on GitHub.
    pub url: String,
    pub prerelease: bool,
    pub published_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateError {
    Network(String),
    Invalid(String),
    BadVersion(String),
}

impl fmt::Display for UpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UpdateError::Network(_) => f.write_str("Couldn't reach GitHub. Try again later."),
            UpdateError::Invalid(_) => {
                f.write_str("GitHub sent a release list Voice couldn't read. Try again later.")
            }
            UpdateError::BadVersion(version) => {
                write!(f, "This copy of Voice has an unexpected version: {version}")
            }
        }
    }
}

impl std::error::Error for UpdateError {}

/// What the daily check did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scheduled {
    /// The check is off or ran less than a day ago; nothing was sent anywhere.
    Skipped,
    Checked(Option<Release>),
}

/// Asks GitHub now and returns the newest Voice release newer than `current`, if any.
pub fn check(current: &str) -> Result<Option<Release>, UpdateError> {
    check_at(RELEASES_URL, current)
}

pub fn check_at(url: &str, current: &str) -> Result<Option<Release>, UpdateError> {
    let current_version =
        Version::parse(current).ok_or_else(|| UpdateError::BadVersion(current.to_string()))?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(TIMEOUT))
        .user_agent(format!("rukoo-voice/{current}"))
        .build()
        .into();
    let mut response = agent
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|error| UpdateError::Network(error.to_string()))?;
    if !response.status().is_success() {
        return Err(UpdateError::Network(format!(
            "GitHub answered {}",
            response.status()
        )));
    }
    let body = response
        .body_mut()
        .read_to_vec()
        .map_err(|error| UpdateError::Network(error.to_string()))?;
    let releases: Value =
        serde_json::from_slice(&body).map_err(|error| UpdateError::Invalid(error.to_string()))?;
    newest_release(&releases, &current_version)
}

/// Whether the daily check should run: it is on and the last check is a day old or missing.
pub fn is_due(cfg: &Config, last_check_ms: Option<u64>, now_ms: u64) -> bool {
    cfg.updates_check
        && last_check_ms
            .is_none_or(|last| now_ms.saturating_sub(last) >= CHECK_INTERVAL.as_millis() as u64)
}

/// The daily check. Never touches the network unless the user turned the check on.
pub fn scheduled_check(
    cfg: &Config,
    current: &str,
    last_check_ms: Option<u64>,
    now_ms: u64,
) -> Result<Scheduled, UpdateError> {
    scheduled_check_at(RELEASES_URL, cfg, current, last_check_ms, now_ms)
}

pub fn scheduled_check_at(
    url: &str,
    cfg: &Config,
    current: &str,
    last_check_ms: Option<u64>,
    now_ms: u64,
) -> Result<Scheduled, UpdateError> {
    if !is_due(cfg, last_check_ms, now_ms) {
        return Ok(Scheduled::Skipped);
    }
    check_at(url, current).map(Scheduled::Checked)
}

/// The newest release in a GitHub release list that is a Voice release, isn't a draft and is
/// newer than `current`. Prereleases count only when `current` is a prerelease itself.
pub fn newest_release(releases: &Value, current: &Version) -> Result<Option<Release>, UpdateError> {
    let Some(list) = releases.as_array() else {
        return Err(UpdateError::Invalid("not a list".into()));
    };
    let mut best: Option<(Version, Release)> = None;
    for item in list {
        if item.get("draft").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let Some(tag) = item.get("tag_name").and_then(Value::as_str) else {
            continue;
        };
        let Some(version) = tag.strip_prefix(TAG_PREFIX).and_then(Version::parse) else {
            continue;
        };
        let prerelease = item
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || !version.pre.is_empty();
        if prerelease && current.pre.is_empty() {
            continue;
        }
        if version <= *current || best.as_ref().is_some_and(|(newest, _)| version <= *newest) {
            continue;
        }
        let text = |key: &str| item.get(key).and_then(Value::as_str).map(str::to_string);
        let release = Release {
            version: version.to_string(),
            tag: tag.to_string(),
            name: text("name")
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| tag.to_string()),
            url: text("html_url").unwrap_or_default(),
            prerelease,
            published_at: text("published_at"),
        };
        best = Some((version, release));
    }
    Ok(best.map(|(_, release)| release))
}

/// A semantic version. Build metadata is ignored, as SemVer says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Vec<String>,
}

impl Version {
    pub fn parse(text: &str) -> Option<Version> {
        let text = text.trim();
        let text = text
            .split_once('+')
            .map_or(text, |(version, _build)| version);
        let (core, pre) = match text.split_once('-') {
            Some((core, pre)) => (core, pre.split('.').map(str::to_string).collect::<Vec<_>>()),
            None => (text, Vec::new()),
        };
        if pre.iter().any(|part| {
            part.is_empty() || !part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        }) {
            return None;
        }
        let numbers: Vec<u64> = core
            .split('.')
            .map(|part| {
                if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
                    None
                } else {
                    part.parse().ok()
                }
            })
            .collect::<Option<_>>()?;
        let [major, minor, patch] = numbers[..] else {
            return None;
        };
        Some(Version {
            major,
            minor,
            patch,
            pre,
        })
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if !self.pre.is_empty() {
            write!(f, "-{}", self.pre.join("."))?;
        }
        Ok(())
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                // A release ranks above its own prereleases.
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => compare_pre(&self.pre, &other.pre),
            })
    }
}

fn compare_pre(a: &[String], b: &[String]) -> Ordering {
    for (left, right) in a.iter().zip(b) {
        let order = match (left.parse::<u64>(), right.parse::<u64>()) {
            (Ok(l), Ok(r)) => l.cmp(&r),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => left.cmp(right),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    a.len().cmp(&b.len())
}
