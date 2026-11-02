//! Bucket sync through the whole engine against the real recorder and the fake bucket (spec 4.5).
//!
//! Like tests/meetings.rs, this binary has its own main (`harness = false`) so it can also be the
//! recorder: run with `VOICE_ENGINE_TEST_ROLE=recorder` it calls `voice_recorder::run`.

fn main() {}
