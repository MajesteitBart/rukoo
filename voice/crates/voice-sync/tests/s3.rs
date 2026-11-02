//! The S3 client against the fake S3: every call, paging, both URL styles, the error mapping and
//! the Test connection probe.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use voice_s3_fake::{FakeS3, Op};
use voice_sync::s3::{Bucket, Part};
use voice_sync::{BucketRetention, Service, SyncConfig, SyncErrorKind, UrlStyle};

const SECRET: &str = "secret-that-must-never-show-up";

fn config(endpoint: &str, style: UrlStyle, prefix: &str) -> SyncConfig {
    SyncConfig {
        service: Service::Other,
        endpoint: endpoint.to_string(),
        region: "us-east-1".into(),
        bucket: "test".into(),
        prefix: prefix.into(),
        access_key_id: "test-key".into(),
        url_style: style,
        retention: BucketRetention::Keep,
    }
}

fn start() -> FakeS3 {
    FakeS3::start("test", "test-key", None).unwrap()
}

fn bucket(fake: &FakeS3) -> Bucket {
    Bucket::new(
        &config(&fake.endpoint(), UrlStyle::Path, ""),
        SECRET,
        Duration::from_secs(2),
        Duration::from_secs(10),
    )
    .unwrap()
}

fn ops(fake: &FakeS3, op: Op) -> usize {
    fake.log().iter().filter(|l| l.op == op).count()
}

#[test]
fn put_get_head_delete() {
    let fake = start();
    let b = bucket(&fake);
    b.put("rkv1/k/one", b"first object").unwrap();
    assert_eq!(b.get("rkv1/k/one", None).unwrap(), b"first object");
    assert_eq!(b.head("rkv1/k/one").unwrap(), Some(12));
    assert_eq!(b.head("rkv1/k/none").unwrap(), None);
    assert_eq!(
        b.get("rkv1/k/none", None).unwrap_err().kind,
        SyncErrorKind::NotFound
    );
    // An empty object is an object too.
    b.put("rkv1/k/empty", b"").unwrap();
    assert_eq!(b.head("rkv1/k/empty").unwrap(), Some(0));
    assert_eq!(b.get("rkv1/k/empty", None).unwrap(), b"");

    b.delete("rkv1/k/one").unwrap();
    assert_eq!(b.head("rkv1/k/one").unwrap(), None);
    b.delete("rkv1/k/one").unwrap();
    let keys: Vec<String> = fake.objects().into_iter().map(|(k, _)| k).collect();
    assert_eq!(keys, ["rkv1/k/empty"]);
}

#[test]
fn ranges_are_inclusive() {
    let fake = start();
    let b = bucket(&fake);
    let data: Vec<u8> = (0..100u8).collect();
    b.put("r", &data).unwrap();
    assert_eq!(b.get("r", Some((0, 9))).unwrap(), &data[0..10]);
    assert_eq!(b.get("r", Some((10, 10))).unwrap(), &data[10..11]);
    assert_eq!(b.get("r", Some((90, 99))).unwrap(), &data[90..]);
    assert_eq!(b.get("r", Some((90, 1_000))).unwrap(), &data[90..]);
    assert_eq!(
        b.get("r", Some((100, 200))).unwrap_err().kind,
        SyncErrorKind::Crypto
    );
    let gets = fake.log();
    assert!(gets
        .iter()
        .filter(|l| l.op == Op::Get)
        .all(|l| l.bytes <= 100));
}

#[test]
fn the_users_folder_prefixes_every_key() {
    let fake = start();
    let b = Bucket::new(
        &config(&fake.endpoint(), UrlStyle::Path, "/rukoo-voice/"),
        SECRET,
        Duration::from_secs(2),
        Duration::from_secs(10),
    )
    .unwrap();
    b.put("rkv1/a/b", b"x").unwrap();
    let keys: Vec<String> = fake.objects().into_iter().map(|(k, _)| k).collect();
    assert_eq!(keys, ["rukoo-voice/rkv1/a/b"]);
    let listing = b.list("rkv1/", None).unwrap();
    assert_eq!(listing.keys, [("rkv1/a/b".to_string(), 1)]);
    let listing = b.list("", Some("/")).unwrap();
    assert_eq!(listing.prefixes, ["rkv1/"]);
    assert_eq!(b.get("rkv1/a/b", None).unwrap(), b"x");
}

#[test]
fn a_listing_of_1500_keys_follows_the_pages() {
    let fake = start();
    let b = bucket(&fake);
    for i in 0..1_500 {
        b.put(&format!("many/{i:05}"), &vec![1; i % 7]).unwrap();
    }
    b.put("other/x", b"x").unwrap();
    let listing = b.list("many/", None).unwrap();
    assert_eq!(listing.keys.len(), 1_500);
    assert!(listing.prefixes.is_empty());
    for (i, (key, size)) in listing.keys.iter().enumerate() {
        assert_eq!(key, &format!("many/{i:05}"));
        assert_eq!(*size, (i % 7) as u64);
    }
    assert_eq!(ops(&fake, Op::List), 2, "1,000 keys a page");
}

#[test]
fn a_delimiter_groups_keys_into_prefixes_across_pages() {
    let fake = start();
    let b = bucket(&fake);
    for kid in 0..1_100 {
        b.put(&format!("rkv1/{kid:016x}/index/a"), b"i").unwrap();
        if kid % 100 == 0 {
            b.put(&format!("rkv1/{kid:016x}/m/x/manifest"), b"m")
                .unwrap();
        }
    }
    b.put("rkv1/loose", b"l").unwrap();
    let listing = b.list("rkv1/", Some("/")).unwrap();
    assert_eq!(listing.prefixes.len(), 1_100);
    assert_eq!(listing.prefixes[0], "rkv1/0000000000000000/");
    assert_eq!(listing.prefixes[1_099], format!("rkv1/{:016x}/", 1_099));
    assert_eq!(listing.keys, [("rkv1/loose".to_string(), 1)]);
    let mut sorted = listing.prefixes.clone();
    sorted.dedup();
    assert_eq!(sorted.len(), 1_100, "no prefix twice across pages");
}

#[test]
fn multipart_uploads_create_upload_list_complete_and_abort() {
    let fake = start();
    let b = bucket(&fake);
    let id = b.create_multipart("rkv1/video").unwrap();
    let bodies: [&[u8]; 3] = [b"aaaa", b"bbbb", b"cc"];
    let mut etags = Vec::new();
    for (i, body) in bodies.iter().enumerate() {
        etags.push(
            b.upload_part("rkv1/video", &id, i as u16 + 1, body)
                .unwrap(),
        );
    }
    let parts = b.list_parts("rkv1/video", &id).unwrap();
    assert_eq!(
        parts,
        (0..3)
            .map(|i| Part {
                number: i as u16 + 1,
                etag: etags[i].clone(),
                size: bodies[i].len() as u64
            })
            .collect::<Vec<_>>()
    );
    b.complete_multipart("rkv1/video", &id, &etags).unwrap();
    assert_eq!(b.get("rkv1/video", None).unwrap(), b"aaaabbbbcc");
    assert_eq!(
        b.list_parts("rkv1/video", &id).unwrap_err().kind,
        SyncErrorKind::NoSuchUpload
    );

    let other = b.create_multipart("rkv1/other").unwrap();
    b.upload_part("rkv1/other", &other, 1, b"zz").unwrap();
    b.abort_multipart("rkv1/other", &other).unwrap();
    assert_eq!(
        b.upload_part("rkv1/other", &other, 2, b"zz")
            .unwrap_err()
            .kind,
        SyncErrorKind::NoSuchUpload
    );
    assert_eq!(
        b.abort_multipart("rkv1/other", &other).unwrap_err().kind,
        SyncErrorKind::NoSuchUpload
    );
    assert_eq!(
        b.complete_multipart("rkv1/other", &other, &etags)
            .unwrap_err()
            .kind,
        SyncErrorKind::NoSuchUpload
    );
    assert_eq!(b.head("rkv1/other").unwrap(), None);
}

#[test]
fn list_parts_follows_the_part_number_marker() {
    let fake = start();
    let b = bucket(&fake);
    let id = b.create_multipart("rkv1/many-parts").unwrap();
    for n in 1..=1_005u16 {
        b.upload_part("rkv1/many-parts", &id, n, &[n as u8])
            .unwrap();
    }
    let parts = b.list_parts("rkv1/many-parts", &id).unwrap();
    assert_eq!(parts.len(), 1_005);
    assert!(parts
        .iter()
        .enumerate()
        .all(|(i, p)| p.number == i as u16 + 1 && p.size == 1));
    assert_eq!(ops(&fake, Op::ListParts), 2);
}

#[test]
fn delete_many_goes_in_batches_of_1000() {
    let fake = start();
    let b = bucket(&fake);
    let keys: Vec<String> = (0..1_200).map(|i| format!("rkv1/d/{i:04}")).collect();
    for key in &keys {
        b.put(key, b"x").unwrap();
    }
    b.put("rkv1/keep", b"k").unwrap();
    let failed = b.delete_many(&keys).unwrap();
    assert!(failed.is_empty());
    let left: Vec<String> = fake.objects().into_iter().map(|(k, _)| k).collect();
    assert_eq!(left, ["rkv1/keep"]);
    assert_eq!(ops(&fake, Op::DeleteMany), 2);
    assert!(b.delete_many(&[]).unwrap().is_empty());

    fake.faults().fail = vec![(Op::DeleteMany, 403, "AccessDenied")];
    assert_eq!(
        b.delete_many(&["rkv1/keep".to_string()]).unwrap_err().kind,
        SyncErrorKind::Permission
    );
}

#[derive(Debug)]
struct ToLoopback {
    port: u16,
    hosts: Arc<Mutex<Vec<String>>>,
}

impl ureq::unversioned::resolver::Resolver for ToLoopback {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        _config: &ureq::config::Config,
        _timeout: ureq::unversioned::transport::NextTimeout,
    ) -> Result<ureq::unversioned::resolver::ResolvedSocketAddrs, ureq::Error> {
        self.hosts
            .lock()
            .unwrap()
            .push(uri.host().unwrap_or_default().to_string());
        let mut addrs = self.empty();
        addrs.push(SocketAddr::from(([127, 0, 0, 1], self.port)));
        Ok(addrs)
    }
}

#[test]
fn both_url_styles_reach_the_bucket() {
    let fake = start();
    let port: u16 = fake.endpoint().rsplit(':').next().unwrap().parse().unwrap();
    let endpoint = format!("http://localhost:{port}");
    for style in [UrlStyle::Path, UrlStyle::VirtualHost] {
        let hosts = Arc::new(Mutex::new(Vec::new()));
        let agent = ureq::Agent::with_parts(
            Bucket::agent_config(Duration::from_secs(2), Duration::from_secs(10)),
            ureq::unversioned::transport::DefaultConnector::new(),
            ToLoopback {
                port,
                hosts: Arc::clone(&hosts),
            },
        );
        let b = Bucket::with_agent(&config(&endpoint, style, "voice"), SECRET, agent).unwrap();
        let key = format!("rkv1/{}", style.as_str());
        b.put(&key, b"styled").unwrap();
        assert_eq!(b.get(&key, Some((0, 2))).unwrap(), b"sty");
        assert!(b
            .list("rkv1/", None)
            .unwrap()
            .keys
            .contains(&(key.clone(), 6)));
        let id = b.create_multipart(&key).unwrap();
        b.abort_multipart(&key, &id).unwrap();
        b.delete(&key).unwrap();
        let want = match style {
            UrlStyle::Path => "localhost",
            UrlStyle::VirtualHost => "test.localhost",
        };
        let hosts = hosts.lock().unwrap();
        assert!(
            !hosts.is_empty() && hosts.iter().all(|h| h == want),
            "{hosts:?}"
        );
    }
    // Every request found the bucket and the same keys, whichever way it was named.
    assert!(
        fake.log().iter().all(|l| l.status < 300),
        "{:?}",
        fake.log()
    );
    assert!(fake
        .log()
        .iter()
        .filter(|l| l.op == Op::Put)
        .all(|l| l.key.starts_with("voice/rkv1/")));
}

#[test]
fn errors_map_to_kinds() {
    let fake = start();
    let b = bucket(&fake);
    b.put("k", b"x").unwrap();
    let cases: &[(Op, u16, &str, SyncErrorKind)] = &[
        (Op::Put, 403, "InvalidAccessKeyId", SyncErrorKind::Auth),
        (Op::Put, 403, "SignatureDoesNotMatch", SyncErrorKind::Auth),
        (Op::Put, 403, "AccessDenied", SyncErrorKind::Permission),
        (Op::Get, 404, "NoSuchBucket", SyncErrorKind::Bucket),
        (Op::Put, 403, "RequestTimeTooSkewed", SyncErrorKind::Clock),
        (
            Op::UploadPart,
            404,
            "NoSuchUpload",
            SyncErrorKind::NoSuchUpload,
        ),
        (Op::Get, 404, "NoSuchKey", SyncErrorKind::NotFound),
        (Op::Put, 503, "SlowDown", SyncErrorKind::Throttled),
        (Op::Put, 429, "TooManyRequests", SyncErrorKind::Throttled),
        (Op::Put, 500, "InternalError", SyncErrorKind::Server),
        (Op::Put, 503, "ServiceUnavailable", SyncErrorKind::Server),
        (Op::List, 301, "PermanentRedirect", SyncErrorKind::Endpoint),
        (Op::Complete, 400, "InvalidPart", SyncErrorKind::Server),
    ];
    let id = b.create_multipart("big").unwrap();
    for &(op, status, code, kind) in cases {
        fake.faults().fail = vec![(op, status, code)];
        let error = match op {
            Op::Put => b.put("k", b"y").unwrap_err(),
            Op::Get => b.get("k", None).unwrap_err(),
            Op::UploadPart => b.upload_part("big", &id, 1, b"p").unwrap_err(),
            Op::List => b.list("", None).unwrap_err(),
            Op::Complete => b
                .complete_multipart("big", &id, &["\"x\"".into()])
                .unwrap_err(),
            _ => unreachable!(),
        };
        assert_eq!(error.kind, kind, "{code}: {}", error.message);
        assert!(error.message.contains(code), "{}", error.message);
        assert_eq!(
            error.transient(),
            matches!(kind, SyncErrorKind::Throttled | SyncErrorKind::Server)
        );
        assert!(!error.message.contains(SECRET) && !error.message.contains("X-Amz-"));
    }
    // A HEAD has no body to read a code from: the status says it.
    fake.faults().fail = vec![(Op::Head, 403, "AccessDenied")];
    assert_eq!(b.head("k").unwrap_err().kind, SyncErrorKind::Permission);
    fake.faults().fail = vec![(Op::Head, 500, "InternalError")];
    assert_eq!(b.head("k").unwrap_err().kind, SyncErrorKind::Server);
}

#[test]
fn a_wrong_access_key_or_bucket_is_refused_by_the_bucket() {
    let fake = start();
    let mut cfg = config(&fake.endpoint(), UrlStyle::Path, "");
    cfg.access_key_id = "someone-else".into();
    let b = Bucket::new(
        &cfg,
        SECRET,
        Duration::from_secs(2),
        Duration::from_secs(10),
    )
    .unwrap();
    let error = b.put("k", b"x").unwrap_err();
    assert_eq!(error.kind, SyncErrorKind::Auth);
    assert!(!error.message.contains(SECRET));

    let mut cfg = config(&fake.endpoint(), UrlStyle::Path, "");
    cfg.bucket = "missing".into();
    let b = Bucket::new(
        &cfg,
        SECRET,
        Duration::from_secs(2),
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(b.put("k", b"x").unwrap_err().kind, SyncErrorKind::Bucket);
    assert!(fake.objects().is_empty());
}

#[test]
fn network_failures_and_timeouts() {
    let fake = start();
    let endpoint = fake.endpoint();
    let b = Bucket::new(
        &config(&endpoint, UrlStyle::Path, ""),
        SECRET,
        Duration::from_secs(2),
        Duration::from_millis(500),
    )
    .unwrap();
    b.put("k", b"x").unwrap();

    fake.faults().stall = Some(Duration::from_secs(2));
    let error = b.get("k", None).unwrap_err();
    assert_eq!(error.kind, SyncErrorKind::Timeout, "{}", error.message);
    assert!(error.transient());
    assert_eq!(error.code(), "network");
    fake.faults().stall = None;

    fake.faults().refuse = true;
    let error = b.put("k", b"y").unwrap_err();
    assert_eq!(error.kind, SyncErrorKind::Network, "{}", error.message);
    assert!(error.transient());
    fake.faults().refuse = false;

    fake.faults().drop_after = Some(3);
    let error = b.put("k", &[9; 50_000]).unwrap_err();
    assert_eq!(error.kind, SyncErrorKind::Network, "{}", error.message);
    assert_eq!(b.get("k", None).unwrap(), b"x");

    // Nothing listens any more. Windows retries a refused loopback connection for about two
    // seconds, longer than this bucket's 500 ms, so a bucket with the usual timeouts asks.
    fake.stop();
    let b = Bucket::new(
        &config(&endpoint, UrlStyle::Path, ""),
        SECRET,
        Duration::from_secs(10),
        Duration::from_secs(20),
    )
    .unwrap();
    let error = b.put("k", b"z").unwrap_err();
    assert_eq!(error.kind, SyncErrorKind::Network, "{}", error.message);
    assert!(!error.message.contains(SECRET) && !error.message.contains("X-Amz-"));
}

#[test]
fn an_expired_signed_url_is_refused() {
    let fake = start();
    bucket(&fake).put("k", b"x").unwrap();
    // A URL signed for one second, used three seconds later.
    let creds = rusty_s3::Credentials::new("test-key", SECRET);
    let bucket = rusty_s3::Bucket::new(
        fake.endpoint().parse().unwrap(),
        rusty_s3::UrlStyle::Path,
        "test",
        "us-east-1",
    )
    .unwrap();
    use rusty_s3::S3Action;
    let url = bucket
        .get_object(Some(&creds), "k")
        .sign(Duration::from_secs(1));
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let fresh = agent.get(url.as_str()).call().unwrap();
    assert_eq!(fresh.status().as_u16(), 200);
    std::thread::sleep(Duration::from_millis(2_100));
    let mut late = agent.get(url.as_str()).call().unwrap();
    assert_eq!(late.status().as_u16(), 403);
    let body = late.body_mut().read_to_string().unwrap();
    assert!(body.contains("<Code>AccessDenied</Code>") && body.contains("Request has expired"));
}

#[test]
fn the_probe_passes_and_counts_other_keys() {
    let fake = start();
    let b = bucket(&fake);
    assert_eq!(b.probe(None).unwrap(), 0);
    assert!(fake.objects().is_empty(), "the probe cleans up");
    let ops: Vec<Op> = fake.log().iter().map(|l| l.op).collect();
    assert_eq!(
        ops,
        [
            Op::Put,
            Op::Get,
            Op::List,
            Op::Create,
            Op::Abort,
            Op::Delete
        ]
    );
    let probe = &fake.log()[0];
    assert!(probe.key.starts_with("rkv1/probe/") && probe.key.len() == 11 + 32);
    assert_eq!(probe.bytes, 32);

    for kid in ["0f1e2d3c4b5a6978", "1111111111111111", "2222222222222222"] {
        b.put(&format!("rkv1/{kid}/index/w"), b"i").unwrap();
    }
    b.put("rkv1/not-a-kid/x", b"i").unwrap();
    assert_eq!(b.probe(Some("0f1e2d3c4b5a6978")).unwrap(), 2);
    assert_eq!(b.probe(None).unwrap(), 3);
    assert_eq!(fake.objects().len(), 4);
}

#[test]
fn the_probe_names_the_step_that_failed() {
    let steps: &[(Op, &str, SyncErrorKind)] = &[
        (Op::Put, "Writing a test file", SyncErrorKind::Auth),
        (
            Op::Get,
            "Reading the test file back",
            SyncErrorKind::Permission,
        ),
        (Op::List, "Listing the bucket", SyncErrorKind::Permission),
        (
            Op::Create,
            "Starting a multipart upload",
            SyncErrorKind::Permission,
        ),
        (
            Op::Abort,
            "Cancelling a multipart upload",
            SyncErrorKind::Permission,
        ),
        (
            Op::Delete,
            "Deleting the test file",
            SyncErrorKind::Permission,
        ),
    ];
    for &(op, step, kind) in steps {
        let fake = start();
        let b = bucket(&fake);
        fake.faults().fail = vec![(op, 403, "AccessDenied")];
        let error = b.probe(None).unwrap_err();
        assert_eq!(error.kind, kind, "{step}: {}", error.message);
        assert!(
            error.message.starts_with(&format!("{step} failed: ")),
            "{}",
            error.message
        );
        assert!(error.message.contains("AccessDenied"), "{}", error.message);
        // Every step but the last deletes the probe on its way out.
        if op != Op::Delete {
            assert!(fake.objects().is_empty(), "{step}");
        }
    }
    // A failing first step that isn't about permission keeps its kind.
    let fake = start();
    fake.faults().fail = vec![(Op::Put, 404, "NoSuchBucket")];
    let error = bucket(&fake).probe(None).unwrap_err();
    assert_eq!(error.kind, SyncErrorKind::Bucket);
    assert_eq!(error.code(), "bucket");
    fake.faults().fail = vec![(Op::Put, 403, "InvalidAccessKeyId")];
    assert_eq!(bucket(&fake).probe(None).unwrap_err().code(), "auth");
}

#[test]
fn a_bucket_needs_a_secret_and_a_valid_endpoint() {
    let cfg = config("http://127.0.0.1:9", UrlStyle::Path, "");
    let d = Duration::from_secs(1);
    assert_eq!(
        Bucket::new(&cfg, "", d, d).err().unwrap().kind,
        SyncErrorKind::NoSecret
    );
    let insecure = config("http://s3.example.com", UrlStyle::Path, "");
    assert_eq!(
        Bucket::new(&insecure, SECRET, d, d).err().unwrap().kind,
        SyncErrorKind::Endpoint
    );
    let mut no_bucket = cfg.clone();
    no_bucket.bucket.clear();
    assert_eq!(
        Bucket::new(&no_bucket, SECRET, d, d).err().unwrap().kind,
        SyncErrorKind::Bucket
    );
    // An IP address can't carry the bucket in its host name.
    let ip_virtual = config("http://127.0.0.1:9", UrlStyle::VirtualHost, "");
    assert_eq!(
        Bucket::new(&ip_virtual, SECRET, d, d).err().unwrap().kind,
        SyncErrorKind::Endpoint
    );
}
