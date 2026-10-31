//! The opt-in update check, from a fixture release list and a local fake GitHub.
//!
//! This file isn't called update.rs: Windows' installer detection asks for elevation before it
//! runs an exe with "update" in its name.

mod support;

use serde_json::{json, Value};
use support::{closed_port, FakeServer, Reply};
use voice_core::config::Config;
use voice_core::update::{
    check_at, is_due, newest_release, scheduled_check_at, Scheduled, UpdateError, Version,
};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/github-releases.json")).unwrap()
}

fn newest(current: &str) -> Option<String> {
    newest_release(&fixture(), &Version::parse(current).unwrap())
        .unwrap()
        .map(|release| release.tag)
}

#[test]
fn only_voice_tags_count_and_drafts_never() {
    // v9.9.9 is Rukoo's; voice-v0.3.0 is a draft; the prereleases are skipped for a stable copy.
    assert_eq!(newest("0.1.0").as_deref(), Some("voice-v0.1.2"));
    assert_eq!(newest("0.1.2"), None);
    assert_eq!(newest("0.2.0"), None);
    let release = newest_release(&fixture(), &Version::parse("0.1.0").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(release.version, "0.1.2");
    assert_eq!(release.name, "Voice 0.1.2");
    assert_eq!(
        release.url,
        "https://github.com/MajesteitBart/rukoo/releases/tag/voice-v0.1.2"
    );
    assert!(!release.prerelease);
    assert_eq!(
        release.published_at.as_deref(),
        Some("2026-10-25T09:00:00Z")
    );
}

#[test]
fn prereleases_count_only_for_a_prerelease_copy() {
    assert_eq!(
        newest("0.2.0-beta.1").as_deref(),
        Some("voice-v0.2.0-beta.2")
    );
    assert_eq!(newest("0.2.0-beta.2"), None);
    assert_eq!(newest("0.1.4-rc.1").as_deref(), Some("voice-v0.2.0-beta.2"));
}

#[test]
fn a_release_without_a_name_uses_its_tag() {
    let releases =
        json!([{"tag_name": "voice-v0.1.1", "name": "", "draft": false, "prerelease": false}]);
    let release = newest_release(&releases, &Version::parse("0.1.0").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(release.name, "voice-v0.1.1");
}

#[test]
fn version_order_follows_semver() {
    let ordered = [
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "1.0.0-alpha.beta",
        "1.0.0-beta",
        "1.0.0-beta.2",
        "1.0.0-beta.11",
        "1.0.0-rc.1",
        "1.0.0",
        "1.0.1",
        "1.2.0",
        "2.0.0",
    ];
    for pair in ordered.windows(2) {
        assert!(
            Version::parse(pair[0]).unwrap() < Version::parse(pair[1]).unwrap(),
            "{pair:?}"
        );
    }
    assert_eq!(
        Version::parse("1.0.0+build.5").unwrap(),
        Version::parse("1.0.0").unwrap()
    );
    assert_eq!(
        Version::parse("0.2.0-beta.1").unwrap().to_string(),
        "0.2.0-beta.1"
    );
    for bad in [
        "1.0",
        "1.0.0.0",
        "a.b.c",
        "1.0.0-",
        "1.0.0-beta..1",
        "",
        "v1.0.0",
    ] {
        assert_eq!(Version::parse(bad), None, "{bad:?}");
    }
}

#[test]
fn a_check_asks_github_the_way_its_api_wants() {
    let body = include_str!("fixtures/github-releases.json").to_string();
    let server = FakeServer::start(move |_| Reply {
        status: 200,
        body: body.clone().into_bytes(),
        content_type: "application/json",
        hang: false,
    });
    let release = check_at(
        &server.url("/repos/MajesteitBart/rukoo/releases?per_page=100"),
        "0.1.0",
    )
    .unwrap()
    .unwrap();
    assert_eq!(release.tag, "voice-v0.1.2");
    let request = server.only_request();
    assert_eq!(request.method, "GET");
    assert_eq!(
        request.target,
        "/repos/MajesteitBart/rukoo/releases?per_page=100"
    );
    assert_eq!(
        request.header("accept"),
        Some("application/vnd.github+json")
    );
    assert_eq!(request.header("user-agent"), Some("rukoo-voice/0.1.0"));
}

#[test]
fn the_daily_check_stays_offline_unless_turned_on() {
    let server = FakeServer::always(Reply::json(200, fixture()));
    let url = server.url("/releases");
    let now = 100 * DAY_MS;
    let mut cfg = Config::defaults(false);

    assert!(!cfg.updates_check);
    assert_eq!(
        scheduled_check_at(&url, &cfg, "0.1.0", None, now).unwrap(),
        Scheduled::Skipped
    );
    assert!(
        server.requests().is_empty(),
        "a disabled check sent a request"
    );

    cfg.updates_check = true;
    assert_eq!(
        scheduled_check_at(&url, &cfg, "0.1.0", Some(now - DAY_MS / 24), now).unwrap(),
        Scheduled::Skipped
    );
    assert!(
        server.requests().is_empty(),
        "a check within a day sent a request"
    );

    let Scheduled::Checked(Some(release)) =
        scheduled_check_at(&url, &cfg, "0.1.0", Some(now - DAY_MS), now).unwrap()
    else {
        panic!("expected a release");
    };
    assert_eq!(release.version, "0.1.2");
    assert_eq!(server.requests().len(), 1);
    assert!(is_due(&cfg, None, now));
    assert!(!is_due(&Config::defaults(false), None, now));
}

#[test]
fn failures_are_reported_without_detail_for_the_user() {
    let error = check_at(
        &format!("http://127.0.0.1:{}/releases", closed_port()),
        "0.1.0",
    )
    .unwrap_err();
    assert!(matches!(error, UpdateError::Network(_)));
    assert_eq!(error.to_string(), "Couldn't reach GitHub. Try again later.");

    let server = FakeServer::always(Reply::json(
        403,
        json!({"message": "API rate limit exceeded"}),
    ));
    assert!(matches!(
        check_at(&server.url("/releases"), "0.1.0"),
        Err(UpdateError::Network(_))
    ));

    let server = FakeServer::always(Reply::json(200, json!({"message": "not a list"})));
    let error = check_at(&server.url("/releases"), "0.1.0").unwrap_err();
    assert!(matches!(error, UpdateError::Invalid(_)));
    assert_eq!(
        error.to_string(),
        "GitHub sent a release list Voice couldn't read. Try again later."
    );

    assert!(matches!(
        check_at(&server.url("/releases"), "not-a-version"),
        Err(UpdateError::BadVersion(_))
    ));
}
