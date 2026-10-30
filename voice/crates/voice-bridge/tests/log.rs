//! The event log in bridge.db.

mod common;

use std::sync::Arc;
use std::thread;

use common::{passage, TempDir};
use serde_json::json;
use voice_bridge::{EventLog, LogError};
use voice_protocol::{is_instance, EventBody, MeetingId, Speaker, Track};

const A: &str = "m-20261030-171203-4f2a";
const B: &str = "m-20261030-180000-0b0b";

#[test]
fn a_new_log_is_empty_with_a_fresh_instance() {
    let dir = TempDir::new("log-new");
    let log = EventLog::open(dir.path()).unwrap();
    assert!(is_instance(log.instance()), "{}", log.instance());
    assert_eq!(log.head(), 0);
    assert_eq!(log.oldest().unwrap(), 1);
    assert!(log.after(0).unwrap().is_empty());
    assert!(dir.path().join("bridge.db").exists());
}

#[test]
fn events_are_numbered_from_one_and_read_back_in_order() {
    let dir = TempDir::new("log-order");
    let log = EventLog::open(dir.path()).unwrap();
    let status = json!({ "recording": A, "dictating": false });
    assert_eq!(log.append("status", None, status.clone()).unwrap(), 1);
    assert_eq!(log.append("passage", Some(A), passage(1000)).unwrap(), 2);
    assert_eq!(log.append("passage", Some(A), passage(2000)).unwrap(), 3);

    let stored = log.after(1).unwrap();
    assert_eq!(stored.iter().map(|s| s.seq).collect::<Vec<_>>(), [2, 3]);
    assert_eq!(stored[0].event, "passage");
    assert_eq!(stored[0].meeting.as_deref(), Some(A));
    assert_eq!(stored[0].data, passage(1000));
    assert!(stored[0].created_at > 1_700_000_000_000);
    assert_eq!(log.after(0).unwrap()[0].data, status);
    assert_eq!(log.after(0).unwrap()[0].meeting, None);
    assert_eq!(log.page(0, 2).unwrap().len(), 2);
    assert_eq!(log.bounds().unwrap(), (3, 1));
}

#[test]
fn stored_events_become_valid_event_messages() {
    let dir = TempDir::new("log-message");
    let log = EventLog::open(dir.path()).unwrap();
    log.append("passage", Some(A), passage(1000)).unwrap();
    log.append(
        "status",
        None,
        json!({ "recording": null, "dictating": true }),
    )
    .unwrap();
    for stored in log.after(0).unwrap() {
        let message = stored.to_message();
        voice_protocol::validate_incoming(voice_protocol::Side::Voice, &message).unwrap();
        assert_eq!(message["seq"], stored.seq);
    }
    let status = &log.after(1).unwrap()[0];
    assert!(status.to_message().get("meeting").is_none());
}

#[test]
fn a_bad_event_is_refused_and_uses_no_number() {
    let dir = TempDir::new("log-invalid");
    let log = EventLog::open(dir.path()).unwrap();
    let mut wrong_id = passage(1000);
    wrong_id["id"] = json!("mic-000000001");
    match log.append("passage", Some(A), wrong_id) {
        Err(LogError::Invalid(invalid)) => assert_eq!(invalid.reason, "id"),
        other => panic!("expected an invalid event, got {other:?}"),
    }
    match log.append("passage", None, passage(1000)) {
        Err(LogError::Invalid(invalid)) => assert_eq!(invalid.reason, "meeting"),
        other => panic!("expected an invalid event, got {other:?}"),
    }
    match log.append("passage", Some("meeting-1"), passage(1000)) {
        Err(LogError::Invalid(invalid)) => assert_eq!(invalid.reason, "meeting"),
        other => panic!("expected an invalid event, got {other:?}"),
    }
    assert!(matches!(
        log.append("status", None, json!("not an object")),
        Err(LogError::Invalid(_))
    ));
    assert_eq!(log.head(), 0);
    assert_eq!(log.append("passage", Some(A), passage(1000)).unwrap(), 1);
}

#[test]
fn an_event_too_large_for_a_message_is_refused() {
    let dir = TempDir::new("log-large");
    let log = EventLog::open(dir.path()).unwrap();
    let mut huge = passage(0);
    huge["text"] = json!("x".repeat(voice_protocol::MAX_VOICE_MESSAGE));
    assert!(matches!(
        log.append("passage", Some(A), huge),
        Err(LogError::TooLarge { .. })
    ));
    assert_eq!(log.head(), 0);
}

#[test]
fn unknown_event_types_are_stored() {
    let dir = TempDir::new("log-unknown");
    let log = EventLog::open(dir.path()).unwrap();
    let seq = log
        .append("agent.suggestion", Some(A), json!({ "text": "Draft it?" }))
        .unwrap();
    assert_eq!(log.after(0).unwrap()[0].seq, seq);
}

#[test]
fn typed_events_append_like_raw_ones() {
    let dir = TempDir::new("log-typed");
    let log = EventLog::open(dir.path()).unwrap();
    let meeting = MeetingId::parse(A).unwrap();
    let speaker = EventBody::Speaker(Speaker {
        id: "mic".into(),
        track: Track::Mic,
        label: "You".into(),
    });
    assert_eq!(log.append_event(Some(&meeting), speaker).unwrap(), 1);
    let stored = &log.after(0).unwrap()[0];
    assert_eq!(stored.event, "speaker");
    assert_eq!(
        stored.data,
        json!({ "id": "mic", "track": "mic", "label": "You" })
    );
}

#[test]
fn numbers_and_instance_survive_reopening() {
    let dir = TempDir::new("log-reopen");
    let instance = {
        let log = EventLog::open(dir.path()).unwrap();
        for start in [0, 1000, 2000] {
            log.append("passage", Some(A), passage(start)).unwrap();
        }
        log.instance().to_owned()
    };
    let log = EventLog::open(dir.path()).unwrap();
    assert_eq!(log.instance(), instance);
    assert_eq!(log.head(), 3);
    assert_eq!(log.append("passage", Some(A), passage(3000)).unwrap(), 4);
    assert_eq!(log.after(0).unwrap().len(), 4);
}

#[test]
fn opening_a_folder_twice_gives_the_same_log() {
    let dir = TempDir::new("log-shared");
    let first = EventLog::open(dir.path()).unwrap();
    let mut live = first.subscribe();
    // Another spelling of the same folder still finds the open log.
    let second = EventLog::open(&dir.path().join(".")).unwrap();
    assert_eq!(second.instance(), first.instance());
    assert_eq!(second.append("passage", Some(A), passage(0)).unwrap(), 1);
    assert_eq!(first.append("passage", Some(A), passage(1000)).unwrap(), 2);
    assert_eq!(
        live.try_recv().unwrap().seq,
        1,
        "the first log's subscriber saw it"
    );
    assert_eq!(live.try_recv().unwrap().seq, 2);
}

#[test]
fn numbers_given_out_by_another_process_are_skipped() {
    let dir = TempDir::new("log-two-processes");
    let log = EventLog::open(dir.path()).unwrap();
    assert_eq!(log.append("passage", Some(A), passage(0)).unwrap(), 1);
    // What a second Voice on the same folder leaves behind after appending nine events.
    let other = rusqlite::Connection::open(dir.path().join("bridge.db")).unwrap();
    other
        .execute("UPDATE meta SET head = 10 WHERE id = 1", [])
        .unwrap();
    assert_eq!(log.append("passage", Some(A), passage(1000)).unwrap(), 11);
    assert_eq!(log.remove_meeting(B).unwrap(), 12);
}

#[test]
fn a_new_data_folder_starts_again_with_another_instance() {
    let first = TempDir::new("log-first");
    let second = TempDir::new("log-second");
    let one = EventLog::open(first.path()).unwrap();
    one.append("passage", Some(A), passage(0)).unwrap();
    let two = EventLog::open(second.path()).unwrap();
    assert_ne!(one.instance(), two.instance());
    assert_eq!(two.append("passage", Some(A), passage(0)).unwrap(), 1);
}

#[test]
fn removing_a_meeting_deletes_its_events_and_keeps_the_numbers() {
    let dir = TempDir::new("log-remove");
    {
        let log = EventLog::open(dir.path()).unwrap();
        log.append("passage", Some(A), passage(0)).unwrap(); // 1
        log.append("passage", Some(A), passage(1000)).unwrap(); // 2
        log.append("passage", Some(B), passage(0)).unwrap(); // 3
        log.append("passage", Some(A), passage(2000)).unwrap(); // 4

        assert_eq!(log.remove_meeting(A).unwrap(), 5);
        let left = log.after(0).unwrap();
        assert_eq!(left.iter().map(|s| s.seq).collect::<Vec<_>>(), [3, 5]);
        assert_eq!(left[0].meeting.as_deref(), Some(B));
        assert_eq!(left[1].event, "meeting.removed");
        assert_eq!(left[1].meeting.as_deref(), Some(A));
        assert_eq!(left[1].data, json!({}));
        assert_eq!(log.bounds().unwrap(), (5, 3));

        // Removing B too leaves only the two meeting.removed events; the oldest moves on.
        assert_eq!(log.remove_meeting(B).unwrap(), 6);
        assert_eq!(log.bounds().unwrap(), (6, 5));
    }
    let log = EventLog::open(dir.path()).unwrap();
    assert_eq!(log.head(), 6);
    assert_eq!(log.oldest().unwrap(), 5);
    assert_eq!(log.append("passage", Some(B), passage(0)).unwrap(), 7);
}

#[test]
fn removing_the_newest_events_never_hands_their_numbers_out_again() {
    let dir = TempDir::new("log-remove-newest");
    {
        let log = EventLog::open(dir.path()).unwrap();
        log.append("passage", Some(A), passage(0)).unwrap(); // 1
        log.append("passage", Some(A), passage(1000)).unwrap(); // 2
        log.remove_meeting(A).unwrap(); // 3, and 1 and 2 go
                                        // Removing it again takes the first meeting.removed with it: nothing is stored below 4.
        assert_eq!(log.remove_meeting(A).unwrap(), 4);
        assert_eq!(log.bounds().unwrap(), (4, 4));
    }
    let log = EventLog::open(dir.path()).unwrap();
    assert_eq!(log.head(), 4);
    assert_eq!(
        log.append(
            "status",
            None,
            json!({ "recording": null, "dictating": false })
        )
        .unwrap(),
        5
    );
}

#[test]
fn removing_needs_a_meeting_id() {
    let dir = TempDir::new("log-remove-bad");
    let log = EventLog::open(dir.path()).unwrap();
    assert!(matches!(
        log.remove_meeting("meeting-1"),
        Err(LogError::Invalid(_))
    ));
    assert_eq!(log.head(), 0);
}

#[test]
fn subscribers_get_appends_in_order() {
    let dir = TempDir::new("log-subscribe");
    let log = EventLog::open(dir.path()).unwrap();
    log.append("passage", Some(A), passage(0)).unwrap();
    let mut live = log.subscribe();
    log.append("passage", Some(A), passage(1000)).unwrap();
    log.remove_meeting(A).unwrap();
    let first = live.try_recv().unwrap();
    let second = live.try_recv().unwrap();
    assert_eq!((first.seq, first.event.as_str()), (2, "passage"));
    assert_eq!((second.seq, second.event.as_str()), (3, "meeting.removed"));
    assert!(live.try_recv().is_err());
}

#[test]
fn concurrent_appends_get_distinct_consecutive_numbers() {
    let dir = TempDir::new("log-concurrent");
    let log = Arc::new(EventLog::open(dir.path()).unwrap());
    let writers: Vec<_> = (0..4u64)
        .map(|writer| {
            let log = log.clone();
            thread::spawn(move || {
                for i in 0..100u64 {
                    log.append("passage", Some(A), passage(writer * 1_000_000 + i * 1000))
                        .unwrap();
                }
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }
    let seqs: Vec<u64> = log.after(0).unwrap().iter().map(|s| s.seq).collect();
    assert_eq!(seqs, (1..=400).collect::<Vec<_>>());
}

#[test]
fn a_meetings_events_come_with_the_head_they_are_complete_up_to() {
    let dir = TempDir::new("log-meeting-events");
    let log = EventLog::open(dir.path()).unwrap();
    log.append("passage", Some(A), passage(1000)).unwrap();
    log.append("passage", Some(B), passage(1000)).unwrap();
    log.append(
        "status",
        None,
        json!({ "recording": A, "dictating": false }),
    )
    .unwrap();
    log.append("passage", Some(A), passage(2000)).unwrap();

    let (head, events) = log.meeting_events(A).unwrap();
    assert_eq!(head, 4);
    assert_eq!(events.iter().map(|s| s.seq).collect::<Vec<_>>(), [1, 4]);
    assert!(events.iter().all(|s| s.meeting.as_deref() == Some(A)));
    let (head, events) = log.meeting_events("m-20261030-000000-0000").unwrap();
    assert_eq!((head, events.len()), (4, 0));

    let latest = log.latest(A, "passage").unwrap().unwrap();
    assert_eq!((latest.seq, latest.data.clone()), (4, passage(2000)));
    assert!(log.latest(A, "meeting.state").unwrap().is_none());
    log.remove_meeting(A).unwrap();
    let (head, events) = log.meeting_events(A).unwrap();
    assert_eq!(head, 5);
    assert_eq!(
        events.iter().map(|s| s.event.as_str()).collect::<Vec<_>>(),
        ["meeting.removed"]
    );
    assert!(log.latest(A, "passage").unwrap().is_none());
}

#[test]
fn only_the_newest_status_is_kept() {
    let dir = TempDir::new("log-status");
    let log = EventLog::open(dir.path()).unwrap();
    let status = |dictating: bool| json!({ "recording": null, "dictating": dictating });
    assert_eq!(log.append("status", None, status(false)).unwrap(), 1);
    assert_eq!(log.append("passage", Some(A), passage(0)).unwrap(), 2);
    // A dictation: two status events, and only the last one stays.
    assert_eq!(log.append("status", None, status(true)).unwrap(), 3);
    assert_eq!(log.append("status", None, status(false)).unwrap(), 4);
    let stored = log.after(0).unwrap();
    assert_eq!(
        stored
            .iter()
            .map(|s| (s.seq, s.event.as_str()))
            .collect::<Vec<_>>(),
        [(2, "passage"), (4, "status")]
    );
    assert_eq!(stored[1].data, status(false));
    assert_eq!(log.bounds().unwrap(), (4, 2));
    // The numbers of the replaced ones are never given out again, also after reopening.
    drop(log);
    let log = EventLog::open(dir.path()).unwrap();
    assert_eq!(log.append("passage", Some(A), passage(1000)).unwrap(), 5);
    for _ in 0..100 {
        log.append("status", None, status(true)).unwrap();
    }
    assert_eq!(
        log.after(0).unwrap().len(),
        3,
        "bridge.db doesn't grow with status events"
    );
    assert_eq!(log.head(), 105);
}
