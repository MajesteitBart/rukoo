//! Checks every vector in `voice/fixtures/protocol-vectors.json`, which Rukoo's tests read too.
//! The file is read where it is, not from a copy, so both sides always test the same examples.

use std::collections::HashMap;
use std::fs;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use voice_protocol::{
    negotiate, paths, replay_plan, validate_discovery, validate_incoming, Discovery, EventBody,
    Message, Platform, Replay, Side, PROTOCOL,
};

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/protocol-vectors.json"
    );
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("reading {path}: {e}"));
    serde_json::from_str(&text).expect("the vectors are JSON")
}

fn section<'a>(vectors: &'a Value, path: &[&str]) -> &'a [Value] {
    let mut value = vectors;
    for key in path {
        value = &value[*key];
    }
    let list = value
        .as_array()
        .unwrap_or_else(|| panic!("section {path:?} is missing"));
    assert!(!list.is_empty(), "section {path:?} is empty");
    list
}

fn text<'a>(vector: &'a Value, key: &str) -> &'a str {
    vector[key]
        .as_str()
        .unwrap_or_else(|| panic!("vector {vector} has no {key}"))
}

fn side(vector: &Value) -> Side {
    Side::parse(text(vector, "from")).expect("from is voice or rukoo")
}

#[test]
fn the_vectors_describe_this_version() {
    assert_eq!(vectors()["protocol"], json!(PROTOCOL));
}

#[test]
fn every_valid_message_is_accepted_and_serializes_back() {
    let vectors = vectors();
    for vector in section(&vectors, &["valid"]) {
        let name = text(vector, "name");
        let input = &vector["message"];
        let message = validate_incoming(side(vector), input)
            .unwrap_or_else(|e| panic!("{name}: rejected with reason {:?}", e.reason));

        let output = message.to_value();
        assert_eq!(output, expected_output(name, input), "{name}: serialized");
        let again = validate_incoming(side(vector), &output)
            .unwrap_or_else(|e| panic!("{name}: own output rejected: {e}"));
        assert_eq!(again, message, "{name}: round trip");
        assert_data_deserializes_alike(name, &message, input);
    }
}

/// What serializing the typed message gives: the input without the fields this version doesn't
/// know, and with the defaults filled in.
fn expected_output(name: &str, input: &Value) -> Value {
    let mut expected = input.clone();
    let object = expected.as_object_mut().unwrap();
    match name {
        "hello with a cursor and an unknown field" => {
            object.remove("future");
        }
        "start a meeting with the defaults"
        | "start a meeting with null arguments, which count as left out"
        | "status request with null args, which count as {}" => {
            object.insert("args".into(), json!({}));
        }
        "hello with a null clientVersion, which counts as left out" => {
            object.remove("clientVersion");
        }
        "list with a null limit, which counts as left out" => {
            object.insert("args".into(), json!({ "limit": 50 }));
        }
        "status event with a null meeting, which counts as left out" => {
            object.remove("meeting");
        }
        _ => {}
    }
    expected
}

/// The serde `Deserialize` impls must read a checked event's data as the checks do.
fn assert_data_deserializes_alike(name: &str, message: &Message, input: &Value) {
    fn same<T: DeserializeOwned + PartialEq + std::fmt::Debug>(
        name: &str,
        checked: &T,
        data: &Value,
    ) {
        let read: T = serde_json::from_value(data.clone())
            .unwrap_or_else(|e| panic!("{name}: data doesn't deserialize: {e}"));
        assert_eq!(&read, checked, "{name}: deserialized data");
    }
    let Message::Event(event) = message else {
        return;
    };
    let data = &input["data"];
    match &event.body {
        EventBody::Status(v) => same(name, v, data),
        EventBody::MeetingStarted(v) => same(name, v, data),
        EventBody::MeetingState(v) => same(name, v, data),
        EventBody::Speaker(v) => same(name, v, data),
        EventBody::Passage(v) => same(name, v, data),
        EventBody::PassageRemoved(v) => same(name, v, data),
        EventBody::Mark(v) => same(name, v, data),
        EventBody::Frame(v) => same(name, v, data),
        EventBody::MeetingRemoved | EventBody::Unknown { .. } => {}
    }
}

#[test]
fn every_invalid_message_is_rejected_for_its_reason() {
    let vectors = vectors();
    for vector in section(&vectors, &["invalid"]) {
        let name = text(vector, "name");
        match validate_incoming(side(vector), &vector["message"]) {
            Ok(message) => panic!("{name}: accepted as {message:?}"),
            Err(invalid) => assert_eq!(invalid.reason, text(vector, "reason"), "{name}"),
        }
    }
}

#[test]
fn every_valid_discovery_file_is_accepted() {
    let vectors = vectors();
    for vector in section(&vectors, &["discovery", "valid"]) {
        let name = text(vector, "name");
        let file = &vector["file"];
        let discovery = validate_discovery(file).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(serde_json::to_value(&discovery).unwrap(), *file, "{name}");
        let read: Discovery = serde_json::from_value(file.clone()).unwrap();
        assert_eq!(read, discovery, "{name}: deserialized");
    }
}

#[test]
fn every_invalid_discovery_file_is_rejected_for_its_reason() {
    let vectors = vectors();
    for vector in section(&vectors, &["discovery", "invalid"]) {
        let name = text(vector, "name");
        match validate_discovery(&vector["file"]) {
            Ok(file) => panic!("{name}: accepted as {file:?}"),
            Err(invalid) => assert_eq!(invalid.reason, text(vector, "reason"), "{name}"),
        }
    }
}

#[test]
fn every_path_is_computed_with_its_platform_separators() {
    let vectors = vectors();
    for vector in section(&vectors, &["paths"]) {
        let name = text(vector, "name");
        let side = Side::parse(text(vector, "side")).expect("side");
        let platform = Platform::parse(text(vector, "platform")).expect("platform");
        let env: HashMap<String, String> = vector["env"]
            .as_object()
            .expect("env")
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    v.as_str().expect("env values are text").to_owned(),
                )
            })
            .collect();
        let path = paths::bridge_path(side, platform, &|key| env.get(key).cloned());
        assert_eq!(path.as_deref(), Some(text(vector, "expected")), "{name}");
    }
}

#[test]
fn every_negotiation_agrees() {
    let vectors = vectors();
    for vector in section(&vectors, &["negotiation"]) {
        let name = text(vector, "name");
        let range = |key: &str| {
            let pair = vector[key].as_array().expect("a [min, max] pair");
            let version = |i: usize| u32::try_from(pair[i].as_u64().unwrap()).unwrap();
            (version(0), version(1))
        };
        let expected = vector["expected"]
            .as_u64()
            .map(|v| u32::try_from(v).unwrap());
        assert_eq!(
            negotiate(range("rukoo"), range("voice")),
            expected,
            "{name}"
        );
    }
}

#[test]
fn every_replay_plan_agrees() {
    let vectors = vectors();
    for vector in section(&vectors, &["replay"]) {
        let name = text(vector, "name");
        let hello = &vector["hello"];
        let voice = &vector["voice"];
        let (replay, from) = replay_plan(
            hello["instance"].as_str(),
            hello["after"].as_u64().unwrap(),
            voice["instance"].as_str().unwrap(),
            voice["head"].as_u64().unwrap(),
            voice["oldest"].as_u64().unwrap(),
        );
        let expected = &vector["expected"];
        assert_eq!(
            Some(replay),
            Replay::parse(expected["replay"].as_str().unwrap()),
            "{name}"
        );
        assert_eq!(from, expected["from"].as_u64().unwrap(), "{name}: from");
    }
}
