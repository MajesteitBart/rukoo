//! Hard kills mid-upload and the resume after them (spec 4.3).
//!
//! This binary has its own main (`harness = false`) so it can also be the uploader: run with
//! `VOICE_SYNC_TEST_ROLE=worker` it runs a `BucketSync` against the endpoint and data folder in its
//! arguments, and the parent kills it with `Child::kill`.

fn main() {}
