//! Behaviour of the recorder binary beyond the two crash tests: finalize, resume numbering,
//! pause and marks, the tap, control authentication, the file source, call-track padding, the
//! length limit and refused starts. All with synthetic or file sources.

mod common;

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use common::*;
use serde_json::json;
use voice_recorder::control::Client;
use voice_recorder::exit;

/// Times the recorder reports may trail the moment a test acted by a tick or two, more on CI.
const SLACK_MS: u64 = 300;
/// A loopback track is padded once it trails the clock by 0.5 s.
const PAD_THRESHOLD_MS: u64 = 500;

#[test]
fn finalize_repairs_headers_and_is_idempotent() {
    let m = TempMeeting::new("finalize");
    let mut child = m.record(&["mic=synthetic:tone:440", "call=synthetic:idle"], &[]);
    m.wait_for_heartbeat(1_500);
    child.kill().unwrap();
    child.wait().unwrap();

    // What a kill between writing samples and patching the sizes leaves: samples the header
    // doesn't count yet, and half a sample.
    let lines = m.lines();
    let mic = segments(&m, &lines, "mic");
    let path = m.segment_path(&mic.last().unwrap().file);
    let counted = mic.last().unwrap().pcm.len();
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    for _ in 0..100 {
        file.write_all(&1000i16.to_le_bytes()).unwrap();
    }
    file.write_all(&[7]).unwrap();
    drop(file);
    // And a timeline line the kill cut in half.
    let mut timeline = OpenOptions::new()
        .append(true)
        .open(m.dir.join("timeline.jsonl"))
        .unwrap();
    timeline
        .write_all(br#"{"kind":"heartbeat","t":99"#)
        .unwrap();
    drop(timeline);
    assert!(
        m.recorder_file().is_some(),
        "a killed recorder leaves recorder.json"
    );

    let dir = m.arg();
    let (status, out) = m.run(&["finalize", "--meeting", &dir]);
    assert!(status.success(), "{out}");
    let report: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(report["ok"], true);
    assert_eq!(report["ended"], 2, "{report}");
    assert_eq!(report["stopped"], true);

    let text = m.timeline_text();
    assert!(text.ends_with('\n'), "the partial line is gone");
    let lines = m.lines();
    let stop = lines.last().unwrap();
    assert_eq!(stop["kind"], "stop");
    assert_eq!(stop["reason"], "interrupted");
    assert_eq!(report["t"], stop["t"]);

    let mic = segments(&m, &lines, "mic");
    let repaired = mic.last().unwrap();
    assert_eq!(
        repaired.pcm.len(),
        counted + 100,
        "the uncounted samples are recovered"
    );
    assert!(repaired.pcm[counted..].iter().all(|&s| s == 1000));
    assert_eq!(
        fs::metadata(&path).unwrap().len(),
        44 + 2 * (counted as u64 + 100)
    );
    let end = lines
        .iter()
        .find(|l| l["kind"] == "segment_end" && l["track"] == "mic" && l["seq"] == repaired.seq)
        .unwrap();
    assert_eq!(end["samples"], (counted + 100) as u64);
    assert_eq!(t(end), repaired.end());
    assert!(
        t(stop) >= repaired.end(),
        "stop at {} before the audio's end",
        t(stop)
    );
    assert!(
        m.recorder_file().is_none(),
        "finalize removes the stale recorder.json"
    );

    // Again: nothing to do, nothing written.
    let before = m.timeline_text();
    let (status, out) = m.run(&["finalize", "--meeting", &dir]);
    assert!(status.success(), "{out}");
    let report: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(report["ended"], 0);
    assert_eq!(report["stopped"], false);
    assert_eq!(m.timeline_text(), before);
}

#[test]
fn resume_continues_numbering_and_stays_paused() {
    let m = TempMeeting::new("resume-paused");
    let tracks = ["mic=synthetic:tone:440", "call=synthetic:tone:660"];
    let mut child = m.record(&tracks, &[]);
    let (mut client, token) = m.connect(1);
    m.wait_for_heartbeat(1_000);
    let paused = command(&mut client, &token, json!({ "cmd": "pause" }));
    assert_eq!(paused["ok"], true, "{paused}");
    let mark = command(
        &mut client,
        &token,
        json!({ "cmd": "mark", "label": "Before" }),
    );
    assert_eq!(mark["id"], "k-1");
    m.wait_for_heartbeat(t(&paused) + 1_000);
    child.kill().unwrap();
    child.wait().unwrap();

    // A file the dead session created but never named in the timeline.
    let orphan = m.dir.join("audio").join("mic").join("000002.wav");
    fs::write(&orphan, voice_audio::segment_header(0)).unwrap();

    let mut child = m.record(&tracks, &["--resume"]);
    let (mut client, token) = m.connect(2);
    let status = command(&mut client, &token, json!({ "cmd": "status" }));
    assert_eq!(
        status["state"], "paused",
        "a restart must not record a paused user"
    );
    let lines = m.lines_so_far();
    let session_at = lines
        .iter()
        .position(|l| l["kind"] == "session" && l["session"] == 2)
        .unwrap();
    let kinds: Vec<&str> = lines[session_at..]
        .iter()
        .map(|l| l["kind"].as_str().unwrap())
        .filter(|k| *k != "track" && *k != "heartbeat")
        .collect();
    assert_eq!(kinds, vec!["session", "crash", "pause"]);
    let resumed_at = t(&lines[session_at]);
    m.wait_for_heartbeat(resumed_at + 1_000);
    assert!(
        !m.lines_so_far()[session_at..]
            .iter()
            .any(|l| l["kind"] == "segment"),
        "audio was recorded while paused"
    );

    let resume = command(&mut client, &token, json!({ "cmd": "resume" }));
    assert_eq!(resume["ok"], true, "{resume}");
    let mark = command(&mut client, &token, json!({ "cmd": "mark" }));
    assert_eq!(mark["id"], "k-2", "mark ids stay unique across sessions");
    m.wait_for_heartbeat(t(&resume) + 1_000);
    let reply = command(&mut client, &token, json!({ "cmd": "stop" }));
    assert_eq!(reply["ok"], true);
    assert!(wait_exit(&mut child).success());

    let lines = m.lines();
    let mic = segments(&m, &lines, "mic");
    let seqs: Vec<u64> = mic.iter().map(|s| s.seq).collect();
    assert_eq!(seqs, vec![1, 3], "numbering skips the orphan file");
    assert_eq!(mic[1].file, "audio/mic/000003.wav");
    assert!(mic[1].t >= t(&resume));
    assert_eq!(fs::read(&orphan).unwrap(), voice_audio::segment_header(0));
    let call: Vec<u64> = segments(&m, &lines, "call").iter().map(|s| s.seq).collect();
    assert_eq!(call, vec![1, 2]);
}

#[test]
fn pause_resume_mark_and_dictation_lines() {
    let m = TempMeeting::new("pause");
    let mut child = m.record(&["mic=synthetic:tone:440", "call=synthetic:idle"], &[]);
    let (mut client, token) = m.connect(1);
    m.wait_for_heartbeat(1_000);

    let mark = command(
        &mut client,
        &token,
        json!({ "cmd": "mark", "label": "Decision" }),
    );
    assert_eq!(
        (mark["ok"].clone(), mark["id"].clone()),
        (json!(true), json!("k-1"))
    );
    let start = command(
        &mut client,
        &token,
        json!({ "cmd": "dictation", "state": "start" }),
    );
    let end = command(
        &mut client,
        &token,
        json!({ "cmd": "dictation", "state": "end" }),
    );
    assert_eq!(
        (start["ok"].clone(), end["ok"].clone()),
        (json!(true), json!(true))
    );
    let pause = command(&mut client, &token, json!({ "cmd": "pause" }));
    let p = t(&pause);
    let again = command(&mut client, &token, json!({ "cmd": "pause" }));
    assert_eq!(again, json!({ "ok": false, "error": "not_recording" }));
    let status = command(&mut client, &token, json!({ "cmd": "status" }));
    assert_eq!(status["state"], "paused");
    let paused_mark = command(&mut client, &token, json!({ "cmd": "mark" }));
    assert_eq!(paused_mark["id"], "k-2");
    m.wait_for_heartbeat(p + 1_000);
    let resume = command(&mut client, &token, json!({ "cmd": "resume" }));
    let r = t(&resume);
    let again = command(&mut client, &token, json!({ "cmd": "resume" }));
    assert_eq!(again, json!({ "ok": false, "error": "not_recording" }));
    m.wait_for_heartbeat(r + 1_000);
    command(&mut client, &token, json!({ "cmd": "stop" }));
    assert!(wait_exit(&mut child).success());

    let lines = m.lines();
    let marks = of_kind(&lines, "mark");
    assert_eq!(marks.len(), 2);
    assert_eq!(marks[0]["label"], "Decision");
    assert_eq!(t(marks[0]), t(&mark));
    assert_eq!(marks[1]["label"], serde_json::Value::Null);
    let dictation: Vec<_> = of_kind(&lines, "dictation")
        .iter()
        .map(|l| (l["state"].as_str().unwrap(), t(l)))
        .collect();
    assert_eq!(dictation, vec![("start", t(&start)), ("end", t(&end))]);
    assert_eq!(
        of_kind(&lines, "pause")
            .iter()
            .map(|l| t(l))
            .collect::<Vec<_>>(),
        vec![p]
    );
    assert_eq!(
        of_kind(&lines, "resume")
            .iter()
            .map(|l| t(l))
            .collect::<Vec<_>>(),
        vec![r]
    );

    // Both segments end before the pause line, and nothing covers the pause.
    let pause_at = lines.iter().position(|l| l["kind"] == "pause").unwrap();
    for track in ["mic", "call"] {
        let segs = segments(&m, &lines, track);
        assert_eq!(segs.len(), 2, "{track}: {segs:?}");
        assert!(segs[0].end() <= p, "{track} records past the pause");
        assert!(segs[1].t >= r, "{track} records before the resume");
        let ended_first = lines[..pause_at]
            .iter()
            .any(|l| l["kind"] == "segment_end" && l["track"] == track && l["seq"] == segs[0].seq);
        assert!(ended_first, "{track} segment ends after the pause line");
    }
    // The idle loopback is padded right up to the pause and again from the resume.
    let call = segments(&m, &lines, "call");
    assert!(
        call[0].end() + 20 >= p,
        "call padded to {} of {p}",
        call[0].end()
    );
    assert_eq!(call[1].t, r);
    assert!(call.iter().all(|s| s.pcm.iter().all(|&v| v == 0)));
}

#[test]
fn tap_streams_the_tone() {
    let m = TempMeeting::new("tap");
    let mut child = m.record(&["mic=synthetic:tone:440"], &[]);
    let (mut client, token) = m.connect(1);
    let port = m.recorder_file().unwrap().port;

    let mut tap = Client::connect(port, Duration::from_secs(2)).unwrap();
    let reply = command(&mut tap, &token, json!({ "cmd": "tap", "track": "mic" }));
    assert_eq!(reply, json!({ "ok": true, "rate": 16000 }));
    let mut pcm = tap.into_pcm();
    let mut bytes = vec![0u8; 16_000 * 2];
    pcm.read_exact(&mut bytes).unwrap();
    let samples: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    // The tap may begin mid-block; the tone itself must be intact.
    assert_tone(&samples, 440.0, "tap");

    let mut other = Client::connect(port, Duration::from_secs(2)).unwrap();
    let reply = command(&mut other, &token, json!({ "cmd": "tap", "track": "call" }));
    assert_eq!(reply, json!({ "ok": false, "error": "unknown_track" }));

    command(&mut client, &token, json!({ "cmd": "stop" }));
    assert!(wait_exit(&mut child).success());
    // The tap ends with the recording.
    let mut rest = Vec::new();
    let _ = pcm.read_to_end(&mut rest);
}

#[test]
fn control_refuses_a_bad_token() {
    let m = TempMeeting::new("auth");
    let mut child = m.record(&["mic=synthetic:tone:440"], &[]);
    let (mut client, token) = m.connect(1);
    let port = m.recorder_file().unwrap().port;

    for request in [
        json!({ "token": "wrong", "cmd": "stop" }),
        json!({ "cmd": "stop" }),
        json!({ "token": format!("{token}x"), "cmd": "tap", "track": "mic" }),
    ] {
        let mut intruder = Client::connect(port, Duration::from_secs(2)).unwrap();
        let reply = intruder.request(&request).unwrap();
        assert_eq!(reply, json!({ "ok": false, "error": "bad_token" }));
        assert!(
            intruder
                .request(&json!({ "token": token, "cmd": "status" }))
                .is_err(),
            "the connection stays open after a bad token"
        );
    }
    let mut raw = TcpStream::connect(("127.0.0.1", port)).unwrap();
    raw.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    raw.write_all(b"not json\n").unwrap();
    let mut reply = String::new();
    raw.read_to_string(&mut reply).unwrap();
    assert_eq!(reply, "{\"error\":\"bad_request\",\"ok\":false}\n");

    let unknown = command(&mut client, &token, json!({ "cmd": "explode" }));
    assert_eq!(unknown, json!({ "ok": false, "error": "unknown_command" }));
    let status = command(&mut client, &token, json!({ "cmd": "status" }));
    assert_eq!(status["state"], "recording");
    assert_eq!(status["tracks"]["mic"]["ok"], true);
    command(&mut client, &token, json!({ "cmd": "stop" }));
    assert!(wait_exit(&mut child).success());
    let lines = m.lines();
    assert_eq!(of_kind(&lines, "stop").len(), 1);
}

fn write_tone(path: &std::path::Path, rate: u32, hz: f64, seconds: f64) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for n in 0..(rate as f64 * seconds) as u64 {
        let v = 0.5 * (std::f64::consts::TAU * hz * n as f64 / rate as f64).sin();
        w.write_sample((v * 32_767.0).round() as i16).unwrap();
    }
    w.finalize().unwrap();
}

#[test]
fn file_source_plays_the_file_then_silence_or_loops() {
    let once = TempMeeting::new("file-once");
    let looped = TempMeeting::new("file-loop");
    // 523 whole cycles in one second, so the loop joins without a click.
    let wav = once.root.join("tone.wav");
    write_tone(&wav, 22_050, 523.0, 1.0);
    let source = format!("mic=file:{}", wav.display());
    let looped_source = format!("{source},loop");
    let mut a = once.record(&[&source], &[]);
    let mut b = looped.record(&[&looped_source], &[]);
    let (mut client_a, token_a) = once.connect(1);
    let (mut client_b, token_b) = looped.connect(1);
    once.wait_for_heartbeat(2_500);
    looped.wait_for_heartbeat(2_500);
    command(&mut client_a, &token_a, json!({ "cmd": "stop" }));
    command(&mut client_b, &token_b, json!({ "cmd": "stop" }));
    assert!(wait_exit(&mut a).success());
    assert!(wait_exit(&mut b).success());

    let lines = once.lines();
    let track = of_kind(&lines, "track")[0];
    assert_eq!(track["device"], "File tone.wav");
    assert_eq!(track["nativeRate"], 22_050);
    assert_eq!(track["nativeChannels"], 1);
    let pcm: Vec<i16> = segments(&once, &lines, "mic")
        .into_iter()
        .flat_map(|s| s.pcm)
        .collect();
    assert!(pcm.len() >= 16_000 * 2, "only {} samples", pcm.len());
    assert_tone(&pcm[..16_000], 523.0, "file");
    assert!(
        pcm[16_000 + 160..].iter().all(|&s| s.abs() < 50),
        "silence after the file ends"
    );

    let lines = looped.lines();
    let pcm: Vec<i16> = segments(&looped, &lines, "mic")
        .into_iter()
        .flat_map(|s| s.pcm)
        .collect();
    assert_tone(&pcm[..16_000 * 2], 523.0, "looped file");
}

#[test]
fn segments_rotate_without_gaps() {
    let m = TempMeeting::new("rotate");
    let mut child = m.record(
        &["mic=synthetic:tone:440", "call=synthetic:idle"],
        &["--segment-ms", "1000"],
    );
    let (mut client, token) = m.connect(1);
    m.wait_for_heartbeat(3_500);
    command(&mut client, &token, json!({ "cmd": "stop" }));
    assert!(wait_exit(&mut child).success());

    let lines = m.lines();
    let position = |kind: &str, track: &str, seq: u64| {
        lines
            .iter()
            .position(|l| l["kind"] == kind && l["track"] == track && l["seq"] == seq)
            .unwrap()
    };
    for track in ["mic", "call"] {
        let segs = segments(&m, &lines, track);
        assert!(segs.len() >= 4, "{track}: {} segments", segs.len());
        let seqs: Vec<u64> = segs.iter().map(|s| s.seq).collect();
        assert_eq!(seqs, (1..=segs.len() as u64).collect::<Vec<_>>());
        for pair in segs.windows(2) {
            assert_eq!(
                pair[0].pcm.len(),
                16_000,
                "{track} {} isn't full",
                pair[0].seq
            );
            assert_eq!(
                pair[1].t,
                pair[0].t + 1_000,
                "{track} {} moved",
                pair[1].seq
            );
            assert!(
                position("segment_end", track, pair[0].seq)
                    < position("segment", track, pair[1].seq),
                "{track} {} ends after the next one starts",
                pair[0].seq
            );
        }
    }
    for seg in segments(&m, &lines, "mic") {
        if seg.pcm.len() > 2_000 {
            assert_tone(&seg.pcm, 440.0, &format!("mic segment {}", seg.seq));
        }
    }
}

#[test]
fn a_new_default_device_moves_the_track() {
    let m = TempMeeting::new("default-change");
    let mut child = m.record(&["mic=synthetic:tone:440,switch-at=1000"], &[]);
    let (mut client, token) = m.connect(1);
    m.wait_for_heartbeat(4_500);
    command(&mut client, &token, json!({ "cmd": "stop" }));
    assert!(wait_exit(&mut child).success());

    let lines = m.lines();
    assert!(of_kind(&lines, "device_lost").is_empty());
    let moved = of_kind(&lines, "device");
    assert_eq!(moved.len(), 1, "{moved:?}");
    assert_eq!(moved[0]["reason"], "default");
    assert_eq!(moved[0]["device"], "Synthetic 440 Hz tone 2");
    // The default is polled every 2 s.
    let at = t(moved[0]);
    assert!(
        (1_000..=1_000 + 2_000 + SLACK_MS).contains(&at),
        "moved at {at}"
    );
    let opened = of_kind(&lines, "track");
    assert_eq!(opened.len(), 2);
    assert!(opened[1]["deviceId"].as_str().unwrap().ends_with("#2"));
    let segs = segments(&m, &lines, "mic");
    assert_eq!(segs.len(), 2, "{segs:?}");
    assert!(segs[0].end() <= at);
    assert!(segs[1].t >= at);
    for seg in &segs {
        assert_tone(&seg.pcm, 440.0, &format!("mic segment {}", seg.seq));
    }
}

#[test]
fn idle_loopback_is_padded_only_while_healthy() {
    let m = TempMeeting::new("padding");
    let mut child = m.record(&["call=synthetic:idle,fail-at=1500,back-at=3000"], &[]);
    let (mut client, token) = m.connect(1);
    m.wait_for_heartbeat(4_500);
    command(&mut client, &token, json!({ "cmd": "stop" }));
    assert!(wait_exit(&mut child).success());

    let lines = m.lines();
    let lost = t(of_kind(&lines, "device_lost")[0]);
    assert!((1_500..=1_500 + SLACK_MS).contains(&lost), "lost at {lost}");
    let back = of_kind(&lines, "device")[0];
    assert_eq!(back["reason"], "reconnected");
    let back = t(back);
    let stop = t(lines.last().unwrap());
    let call = segments(&m, &lines, "call");
    assert_eq!(call.len(), 2, "{call:?}");
    // Silence from the clock up to the failure, never after it.
    assert!(call[0].t <= SLACK_MS);
    assert!(call[0].end() <= lost, "padded past the failure");
    assert!(call[0].end() + PAD_THRESHOLD_MS + SLACK_MS >= lost);
    // From the moment the device is back, up to the stop.
    assert_eq!(call[1].t, back);
    assert!(call[1].end() + 20 >= stop);
    assert!(call.iter().all(|s| s.pcm.iter().all(|&v| v == 0)));
    let heartbeat_while_lost = of_kind(&lines, "heartbeat")
        .into_iter()
        .find(|l| t(l) > lost + 100 && t(l) < back)
        .unwrap();
    assert_eq!(heartbeat_while_lost["samples"], json!({}));
}

#[test]
fn length_limit_stops_the_recording() {
    let m = TempMeeting::new("limit");
    let mut child = m.record(&["mic=synthetic:tone:440"], &["--limit-ms", "1500"]);
    assert!(wait_exit(&mut child).success());
    let lines = m.lines();
    let stop = lines.last().unwrap();
    assert_eq!(stop["kind"], "stop");
    assert_eq!(stop["reason"], "limit");
    assert!((1_500..=1_500 + SLACK_MS).contains(&t(stop)), "{stop}");
    assert!(m.recorder_file().is_none());
}

#[test]
fn refuses_conflicting_starts() {
    let m = TempMeeting::new("conflict");
    let dir = m.arg();
    let mut child = m.record(&["mic=synthetic:tone:440"], &[]);
    let (mut client, token) = m.connect(1);
    let track = ["--track", "mic=synthetic:tone:440"];
    let mut resume = vec!["record", "--meeting", dir.as_str(), "--resume"];
    resume.extend(track);
    let (status, _) = m.run(&resume);
    assert_eq!(
        status.code(),
        Some(exit::BUSY),
        "a second recorder into a live meeting"
    );
    let (status, _) = m.run(&["finalize", "--meeting", &dir]);
    assert_eq!(
        status.code(),
        Some(exit::BUSY),
        "finalize of a live meeting"
    );
    command(
        &mut client,
        &token,
        json!({ "cmd": "stop", "reason": "rukoo" }),
    );
    assert!(wait_exit(&mut child).success());
    assert_eq!(m.lines().last().unwrap()["reason"], "rukoo");

    let (status, _) = m.run(&resume);
    assert_eq!(status.code(), Some(exit::CONFLICT), "nothing follows stop");
    let mut fresh = vec!["record", "--meeting", dir.as_str()];
    fresh.extend(track);
    let (status, _) = m.run(&fresh);
    assert_eq!(
        status.code(),
        Some(exit::CONFLICT),
        "a new recording over an old one"
    );
    let (status, _) = m.run(&["record", "--meeting", &dir, "--track", "mic=nothing"]);
    assert_eq!(status.code(), Some(exit::USAGE));
    assert_eq!(of_kind(&m.lines(), "session").len(), 1);
}
