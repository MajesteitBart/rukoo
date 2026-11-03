//! The S3 calls sync needs, presigned with rusty-s3 and sent with ureq (spec 4.2, D16).
//!
//! Requests are presigned for 15 minutes. A PUT carries `Content-Type: application/octet-stream`
//! and no other header of its own. Error messages never contain the secret or a signed URL.
//!
//! A request without a body may take the request timeout (120 s in Voice). One that moves a body,
//! an upload or a ranged download, gets the time its bytes need at [`MIN_RATE`] on top, so a
//! 16 MiB object or an 8 MiB part still goes up over a slow uplink instead of timing out on every
//! try.
//!
//! Keys passed in and returned are without the user's `<prefix>`; this module adds and strips it.
//!
//! Errors from the status and the XML `<Code>`: a failed connection or DNS lookup is `Network`;
//! a timeout `Timeout`; `InvalidAccessKeyId` and `SignatureDoesNotMatch` `Auth`; `AccessDenied`
//! `Permission` (`Auth` on the probe's first request, `Clock` when the signed URL expired or isn't
//! valid yet); `NoSuchBucket` `Bucket`; `RequestTimeTooSkewed` `Clock`; `NoSuchUpload`
//! `NoSuchUpload`; `NoSuchKey` or 404 `NotFound`; 429 or `SlowDown` `Throttled`; a redirect or a
//! wrong region `Endpoint`; other answers `Server`.

use std::collections::HashSet;
use std::time::Duration;

use rusty_s3::actions::{
    CreateMultipartUpload, DeleteObjectsResponse, ListObjectsV2, ListParts, ObjectIdentifier,
};
use rusty_s3::S3Action;
use url::Url;

use crate::keys::random;
use crate::names::{hex, PROBE_PREFIX, ROOT};
use crate::{SyncConfig, SyncError, SyncErrorKind, UrlStyle};

/// How long a signed URL is valid.
const SIGNED_FOR: Duration = Duration::from_secs(15 * 60);
/// The most an XML answer or an error body may hold.
const XML_LIMIT: u64 = 16 << 20;
/// The most a GET without a range may return.
const GET_LIMIT: u64 = 512 << 20;
/// Keys per DeleteObjects request.
const DELETE_BATCH: usize = 1000;
/// A listing gives up after this many pages: a million keys at S3's 1,000 a page, far more than
/// the folder of one meeting or the indexes hold.
pub const MAX_LIST_PAGES: usize = 1000;
/// The slowest transfer Voice waits for: 32 KiB/s, about 256 kbit/s. A 16 MiB PUT then may take
/// 120 s plus 512 s, still within the 15 minutes its signed URL lasts.
pub const MIN_RATE: u64 = 32 << 10;

pub struct Bucket {
    bucket: rusty_s3::Bucket,
    credentials: rusty_s3::Credentials,
    agent: ureq::Agent,
    /// The agent's whole-request timeout, which a request without a body keeps.
    request: Option<Duration>,
    prefix: String,
    /// The host requests go to, for messages.
    host: String,
}

/// One uploaded part of a multipart upload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    pub number: u16,
    pub etag: String,
    pub size: u64,
}

/// A listing: keys with their sizes, and the common prefixes of a delimited listing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Listing {
    pub keys: Vec<(String, u64)>,
    pub prefixes: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Method {
    Get,
    Head,
    Put,
    Post,
    Delete,
}

struct Reply {
    status: u16,
    etag: Option<String>,
    length: Option<u64>,
    body: Vec<u8>,
}

impl Reply {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

impl Bucket {
    pub fn new(
        cfg: &SyncConfig,
        secret: &str,
        connect: Duration,
        request: Duration,
    ) -> Result<Bucket, SyncError> {
        let agent = ureq::Agent::new_with_config(Bucket::agent_config(connect, request));
        Bucket::with_agent(cfg, secret, agent)
    }

    /// How long a request that moves `bytes` of body may take: the request timeout plus what the
    /// bytes need at [`MIN_RATE`].
    pub fn timeout_for(request: Duration, bytes: u64) -> Duration {
        request.saturating_add(Duration::from_millis(bytes.saturating_mul(1000) / MIN_RATE))
    }

    /// The agent settings [`new`](Self::new) uses: connect and whole-request timeouts, HTTP
    /// errors as answers, no redirects. A request with a body gets a longer whole-request timeout
    /// of its own ([`timeout_for`](Self::timeout_for)).
    #[doc(hidden)]
    pub fn agent_config(connect: Duration, request: Duration) -> ureq::config::Config {
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(connect))
            .timeout_global(Some(request))
            .max_redirects(0)
            .user_agent(format!("rukoo-voice/{}", env!("CARGO_PKG_VERSION")))
            .build()
    }

    /// [`new`](Self::new) with an agent of the caller's, such as one whose resolver sends a
    /// virtual-host name to the fake S3 in a test.
    #[doc(hidden)]
    pub fn with_agent(
        cfg: &SyncConfig,
        secret: &str,
        agent: ureq::Agent,
    ) -> Result<Bucket, SyncError> {
        let endpoint = SyncConfig::check_endpoint(&cfg.endpoint)?;
        if secret.is_empty() {
            return Err(SyncError::new(
                SyncErrorKind::NoSecret,
                "Save the secret access key first.",
            ));
        }
        if cfg.bucket.is_empty() {
            return Err(SyncError::new(
                SyncErrorKind::Bucket,
                "Fill in the bucket's name.",
            ));
        }
        let style = match cfg.url_style {
            UrlStyle::Path => rusty_s3::UrlStyle::Path,
            UrlStyle::VirtualHost => rusty_s3::UrlStyle::VirtualHost,
        };
        let bucket = rusty_s3::Bucket::new(endpoint, style, cfg.bucket.clone(), cfg.region.clone())
            .map_err(|_| {
                SyncError::new(
                    SyncErrorKind::Endpoint,
                    "Voice can't make an address for this bucket at this endpoint.",
                )
            })?;
        let host = bucket.base_url().host_str().unwrap_or_default().to_string();
        let request = agent.config().timeouts().global;
        Ok(Bucket {
            bucket,
            credentials: rusty_s3::Credentials::new(cfg.access_key_id.clone(), secret.to_string()),
            agent,
            request,
            prefix: cfg.key_prefix(),
            host,
        })
    }

    pub fn put(&self, key: &str, body: &[u8]) -> Result<(), SyncError> {
        let full = self.full(key);
        let url = self
            .bucket
            .put_object(Some(&self.credentials), &full)
            .sign(SIGNED_FOR);
        let reply = self.send(
            Method::Put,
            url,
            &[("Content-Type", "application/octet-stream".into())],
            Some(body),
            XML_LIMIT,
        )?;
        self.expect(&reply, &[200], "Uploading")
    }

    /// `range` is inclusive, like HTTP's.
    pub fn get(&self, key: &str, range: Option<(u64, u64)>) -> Result<Vec<u8>, SyncError> {
        let full = self.full(key);
        let url = self
            .bucket
            .get_object(Some(&self.credentials), &full)
            .sign(SIGNED_FOR);
        let headers = match range {
            Some((from, to)) => {
                if to < from {
                    return Ok(Vec::new());
                }
                vec![("Range", format!("bytes={from}-{to}"))]
            }
            None => Vec::new(),
        };
        // A server that ignores Range sends the whole object, so the cap stays the same.
        let expected = range.map_or(0, |(from, to)| to - from + 1);
        let reply = self.send_sized(Method::Get, url, &headers, None, GET_LIMIT, expected)?;
        match (reply.status, range) {
            (206, Some((from, to))) if reply.body.len() as u64 > to - from + 1 => {
                Err(SyncError::new(
                    SyncErrorKind::Server,
                    "Downloading failed: the bucket sent more than the range asked for.",
                ))
            }
            (206, Some(_)) | (200, None) => Ok(reply.body),
            // A server that ignores Range sends everything; keep the part asked for.
            (200, Some((from, to))) => {
                let len = reply.body.len() as u64;
                if from >= len {
                    return Err(short_object());
                }
                Ok(reply.body[from as usize..=to.min(len - 1) as usize].to_vec())
            }
            (416, _) => Err(short_object()),
            _ => Err(self.status_error(&reply, "Downloading")),
        }
    }

    pub fn head(&self, key: &str) -> Result<Option<u64>, SyncError> {
        let full = self.full(key);
        let url = self
            .bucket
            .head_object(Some(&self.credentials), &full)
            .sign(SIGNED_FOR);
        let reply = self.send(Method::Head, url, &[], None, 0)?;
        match reply.status {
            200 => reply.length.map(Some).ok_or_else(|| {
                SyncError::new(
                    SyncErrorKind::Server,
                    "The bucket didn't say how large the object is.",
                )
            }),
            404 => Ok(None),
            _ => Err(self.status_error(&reply, "Checking an object")),
        }
    }

    /// Deleting an object that isn't there succeeds.
    pub fn delete(&self, key: &str) -> Result<(), SyncError> {
        let full = self.full(key);
        let url = self
            .bucket
            .delete_object(Some(&self.credentials), &full)
            .sign(SIGNED_FOR);
        let reply = self.send(Method::Delete, url, &[], None, XML_LIMIT)?;
        if reply.status == 404 && error_code(&reply.text()).as_deref() != Some("NoSuchBucket") {
            return Ok(());
        }
        self.expect(&reply, &[200, 204], "Deleting")
    }

    /// Batches of 1,000; returns the keys that failed.
    pub fn delete_many(&self, keys: &[String]) -> Result<Vec<String>, SyncError> {
        let mut failed = Vec::new();
        for batch in keys.chunks(DELETE_BATCH) {
            let ids: Vec<ObjectIdentifier> = batch
                .iter()
                .map(|key| ObjectIdentifier::new(self.full(key)))
                .collect();
            let mut action = self
                .bucket
                .delete_objects(Some(&self.credentials), ids.iter());
            action.set_quiet(true);
            let url = action.sign(SIGNED_FOR);
            let (body, md5) = action.body_with_md5();
            let reply = self.send(
                Method::Post,
                url,
                &[("Content-MD5", md5)],
                Some(body.as_bytes()),
                XML_LIMIT,
            )?;
            self.expect(&reply, &[200], "Deleting objects")?;
            let parsed = DeleteObjectsResponse::parse(&reply.text())
                .map_err(|_| unreadable("Deleting objects"))?;
            failed.extend(
                parsed
                    .errors
                    .into_iter()
                    .filter_map(|error| self.strip(&error.key)),
            );
        }
        Ok(failed)
    }

    /// Follows continuation tokens, at most [`MAX_LIST_PAGES`] pages. A token the bucket sent
    /// before fails the listing, so a bucket that sends tokens in a circle can't keep Voice
    /// listing, and collecting keys, for good.
    pub fn list(&self, prefix: &str, delimiter: Option<&str>) -> Result<Listing, SyncError> {
        self.list_checked(prefix, delimiter, &|| Ok(()))
    }

    /// [`Bucket::list`] with `check` run before every page's request: its error stops the listing,
    /// so turning sync off or moving it to another bucket stops a long listing between pages.
    pub fn list_checked(
        &self,
        prefix: &str,
        delimiter: Option<&str>,
        check: &dyn Fn() -> Result<(), SyncError>,
    ) -> Result<Listing, SyncError> {
        let full = self.full(prefix);
        let mut listing = Listing::default();
        let mut token: Option<String> = None;
        let mut seen = HashSet::new();
        for _ in 0..MAX_LIST_PAGES {
            check()?;
            let mut action = self.bucket.list_objects_v2(Some(&self.credentials));
            action.with_prefix(full.as_str());
            if let Some(delimiter) = delimiter {
                action.with_delimiter(delimiter);
            }
            if let Some(token) = &token {
                action.with_continuation_token(token.as_str());
            }
            let url = action.sign(SIGNED_FOR);
            let reply = self.send(Method::Get, url, &[], None, XML_LIMIT)?;
            self.expect(&reply, &[200], "Listing")?;
            let page =
                ListObjectsV2::parse_response(&reply.text()).map_err(|_| unreadable("Listing"))?;
            for object in page.contents {
                if let Some(key) = self.strip(&object.key) {
                    listing.keys.push((key, object.size));
                }
            }
            for common in page.common_prefixes {
                if let Some(prefix) = self.strip(&common.prefix) {
                    listing.prefixes.push(prefix);
                }
            }
            match page.next_continuation_token {
                Some(next) if !next.is_empty() => {
                    if !seen.insert(next.clone()) {
                        return Err(SyncError::new(
                            SyncErrorKind::Server,
                            "Listing failed: the bucket sent the same page twice.",
                        ));
                    }
                    token = Some(next);
                }
                _ => return Ok(listing),
            }
        }
        Err(SyncError::new(
            SyncErrorKind::Server,
            format!("Listing failed: the bucket sent more than {MAX_LIST_PAGES} pages."),
        ))
    }

    pub fn create_multipart(&self, key: &str) -> Result<String, SyncError> {
        let full = self.full(key);
        let url = self
            .bucket
            .create_multipart_upload(Some(&self.credentials), &full)
            .sign(SIGNED_FOR);
        let reply = self.send(
            Method::Post,
            url,
            &[("Content-Type", "application/octet-stream".into())],
            Some(&[]),
            XML_LIMIT,
        )?;
        self.expect(&reply, &[200], "Starting a multipart upload")?;
        let parsed = CreateMultipartUpload::parse_response(&reply.text())
            .map_err(|_| unreadable("Starting a multipart upload"))?;
        Ok(parsed.upload_id().to_string())
    }

    /// The part's ETag as the bucket gave it, quotes included.
    pub fn upload_part(
        &self,
        key: &str,
        upload_id: &str,
        number: u16,
        body: &[u8],
    ) -> Result<String, SyncError> {
        let full = self.full(key);
        let url = self
            .bucket
            .upload_part(Some(&self.credentials), &full, number, upload_id)
            .sign(SIGNED_FOR);
        let reply = self.send(Method::Put, url, &[], Some(body), XML_LIMIT)?;
        self.expect(&reply, &[200], "Uploading a part")?;
        reply.etag.ok_or_else(|| {
            SyncError::new(
                SyncErrorKind::Server,
                "Uploading a part failed: the bucket sent no ETag.",
            )
        })
    }

    /// Follows `part-number-marker`.
    pub fn list_parts(&self, key: &str, upload_id: &str) -> Result<Vec<Part>, SyncError> {
        let full = self.full(key);
        let mut parts = Vec::new();
        let mut marker: Option<u16> = None;
        loop {
            let mut action = self
                .bucket
                .list_parts(Some(&self.credentials), &full, upload_id);
            if let Some(marker) = marker {
                action.set_part_number_marker(marker);
            }
            let url = action.sign(SIGNED_FOR);
            let reply = self.send(Method::Get, url, &[], None, XML_LIMIT)?;
            self.expect(&reply, &[200], "Listing the uploaded parts")?;
            let page = ListParts::parse_response(&reply.text())
                .map_err(|_| unreadable("Listing the uploaded parts"))?;
            parts.extend(page.parts.into_iter().map(|part| Part {
                number: part.number,
                etag: part.etag,
                size: part.size,
            }));
            match page.next_part_number_marker {
                Some(next) if marker.is_none_or(|m| next > m) => marker = Some(next),
                Some(_) => {
                    return Err(SyncError::new(
                        SyncErrorKind::Server,
                        "Listing the uploaded parts failed: the bucket sent the same page twice.",
                    ))
                }
                None => return Ok(parts),
            }
        }
    }

    /// `etags` in part order, numbered from 1.
    pub fn complete_multipart(
        &self,
        key: &str,
        upload_id: &str,
        etags: &[String],
    ) -> Result<(), SyncError> {
        let full = self.full(key);
        let action = self.bucket.complete_multipart_upload(
            Some(&self.credentials),
            &full,
            upload_id,
            etags.iter().map(String::as_str),
        );
        let url = action.sign(SIGNED_FOR);
        let body = action.body();
        let reply = self.send(Method::Post, url, &[], Some(body.as_bytes()), XML_LIMIT)?;
        self.expect(&reply, &[200], "Finishing a multipart upload")?;
        // S3 may answer 200 and put the error in the body.
        if error_code(&reply.text()).is_some() {
            return Err(self.status_error(&reply, "Finishing a multipart upload"));
        }
        Ok(())
    }

    pub fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<(), SyncError> {
        let full = self.full(key);
        let url = self
            .bucket
            .abort_multipart_upload(Some(&self.credentials), &full, upload_id)
            .sign(SIGNED_FOR);
        let reply = self.send(Method::Delete, url, &[], None, XML_LIMIT)?;
        self.expect(&reply, &[200, 204], "Cancelling a multipart upload")
    }

    /// Test connection: PUT a probe, GET and compare it, list the prefix, create and abort a
    /// multipart upload, DELETE the probe. The error names the step that failed. Returns how many
    /// other kids sit under `rkv1/`.
    ///
    /// The probe is `rkv1/probe/<32 hex>` holding 32 random bytes. When a step after the first
    /// fails, the probe is still deleted if the bucket lets Voice.
    pub fn probe(&self, own_kid: Option<&str>) -> Result<u32, SyncError> {
        let mut name = [0u8; 16];
        let mut payload = [0u8; 32];
        random(&mut name)?;
        random(&mut payload)?;
        let key = format!("{PROBE_PREFIX}{}", hex(&name));

        self.put(&key, &payload).map_err(|mut e| {
            if e.kind == SyncErrorKind::Permission {
                e.kind = SyncErrorKind::Auth;
            }
            step("Writing a test file", e)
        })?;
        let rest = (|| {
            let back = self
                .get(&key, None)
                .map_err(|e| step("Reading the test file back", e))?;
            if back != payload {
                return Err(SyncError::new(
                    SyncErrorKind::Server,
                    "Reading the test file back failed: the bucket gave back other bytes.",
                ));
            }
            let listing = self
                .list(ROOT, Some("/"))
                .map_err(|e| step("Listing the bucket", e))?;
            let upload = self
                .create_multipart(&key)
                .map_err(|e| step("Starting a multipart upload", e))?;
            self.abort_multipart(&key, &upload)
                .map_err(|e| step("Cancelling a multipart upload", e))?;
            Ok(listing)
        })();
        let listing = match rest {
            Ok(listing) => listing,
            Err(e) => {
                let _ = self.delete(&key);
                return Err(e);
            }
        };
        self.delete(&key)
            .map_err(|e| step("Deleting the test file", e))?;
        let others = listing
            .prefixes
            .iter()
            .filter_map(|prefix| prefix.strip_prefix(ROOT)?.strip_suffix('/'))
            .filter(|kid| {
                kid.len() == 16
                    && kid.bytes().all(|b| b.is_ascii_hexdigit())
                    && Some(*kid) != own_kid
            })
            .count();
        Ok(others as u32)
    }

    // ---- Requests ----------------------------------------------------------------------------

    fn full(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }

    fn strip(&self, key: &str) -> Option<String> {
        key.strip_prefix(self.prefix.as_str()).map(str::to_string)
    }

    fn send(
        &self,
        method: Method,
        url: Url,
        headers: &[(&'static str, String)],
        body: Option<&[u8]>,
        limit: u64,
    ) -> Result<Reply, SyncError> {
        let sent = body.map_or(0, |b| b.len() as u64);
        self.send_sized(method, url, headers, body, limit, sent)
    }

    /// [`send`](Self::send) for a request that moves `bytes` of body either way, which may take
    /// that much longer.
    fn send_sized(
        &self,
        method: Method,
        url: Url,
        headers: &[(&'static str, String)],
        body: Option<&[u8]>,
        limit: u64,
        bytes: u64,
    ) -> Result<Reply, SyncError> {
        fn with_headers<B>(
            mut request: ureq::RequestBuilder<B>,
            headers: &[(&'static str, String)],
        ) -> ureq::RequestBuilder<B> {
            for (name, value) in headers {
                request = request.header(*name, value.as_str());
            }
            request
        }
        fn timed<B>(
            request: ureq::RequestBuilder<B>,
            timeout: Option<Duration>,
        ) -> ureq::RequestBuilder<B> {
            request.config().timeout_global(timeout).build()
        }
        let timeout = self.request.map(|r| Bucket::timeout_for(r, bytes));
        let url = url.as_str();
        let body = body.unwrap_or(&[]);
        let result = match method {
            Method::Get => timed(with_headers(self.agent.get(url), headers), timeout).call(),
            Method::Head => timed(with_headers(self.agent.head(url), headers), timeout).call(),
            Method::Delete => timed(with_headers(self.agent.delete(url), headers), timeout).call(),
            Method::Put => timed(with_headers(self.agent.put(url), headers), timeout).send(body),
            Method::Post => timed(with_headers(self.agent.post(url), headers), timeout).send(body),
        };
        let mut response = result.map_err(|e| self.transport_error(e))?;
        let status = response.status().as_u16();
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        let etag = header("etag");
        let length = header("content-length").and_then(|v| v.parse().ok());
        let body = if method == Method::Head {
            Vec::new()
        } else if (200..300).contains(&status) {
            response
                .body_mut()
                .with_config()
                .limit(limit + 1) // ureq refuses a body that reaches its limit exactly.
                .read_to_vec()
                .map_err(|e| self.transport_error(e))?
        } else {
            // An error's body only says why; a broken one says nothing.
            response
                .body_mut()
                .with_config()
                .limit(XML_LIMIT + 1)
                .read_to_vec()
                .unwrap_or_default()
        };
        Ok(Reply {
            status,
            etag,
            length,
            body,
        })
    }

    fn expect(&self, reply: &Reply, ok: &[u16], what: &str) -> Result<(), SyncError> {
        if ok.contains(&reply.status) {
            Ok(())
        } else {
            Err(self.status_error(reply, what))
        }
    }

    fn transport_error(&self, error: ureq::Error) -> SyncError {
        let host = &self.host;
        match error {
            ureq::Error::Timeout(_) => SyncError::new(
                SyncErrorKind::Timeout,
                format!("{host} didn't answer in time."),
            ),
            ureq::Error::Io(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                SyncError::new(
                    SyncErrorKind::Timeout,
                    format!("{host} didn't answer in time."),
                )
            }
            ureq::Error::Io(e) => SyncError::new(
                SyncErrorKind::Network,
                format!("Voice can't reach {host}: {e}"),
            ),
            ureq::Error::HostNotFound => SyncError::new(
                SyncErrorKind::Network,
                format!("Voice can't find {host}. Check the endpoint and the internet connection."),
            ),
            ureq::Error::BodyExceedsLimit(_) => SyncError::new(
                SyncErrorKind::Server,
                format!("{host} sent more than Voice asked for."),
            ),
            ureq::Error::Tls(_) | ureq::Error::Rustls(_) => SyncError::new(
                SyncErrorKind::Network,
                format!("The secure connection to {host} failed."),
            ),
            // Other errors may quote the signed URL, so none of their text is kept.
            _ => SyncError::new(SyncErrorKind::Network, format!("Voice can't reach {host}.")),
        }
    }

    fn status_error(&self, reply: &Reply, what: &str) -> SyncError {
        let text = reply.text();
        let code = error_code(&text);
        let provider = element(&text, "Message");
        // The kind comes from the whole answer, before anything is left out of the message.
        let kind = kind_for(reply.status, code.as_deref(), provider.as_deref());
        // The provider's text is checked whole and only then cut short, so no part of the secret
        // or a signed URL can end up in the message.
        let message = provider
            .filter(|m| {
                let lower = m.to_ascii_lowercase();
                !lower.contains("x-amz-")
                    && !lower.contains("signature=")
                    && !m.contains(self.credentials.secret())
            })
            .map(|m| m.chars().take(300).collect::<String>());
        let mut out = format!("{what} failed: the bucket answered {}", reply.status);
        // An S3 code is a short name; anything else is left out.
        if let Some(code) = code
            .as_deref()
            .filter(|c| c.len() <= 64 && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.'))
        {
            out.push(' ');
            out.push_str(code);
        }
        if let Some(message) = &message {
            out.push_str(": ");
            out.push_str(message);
        } else {
            out.push('.');
        }
        SyncError::new(kind, out)
    }
}

/// The kind of an S3 error answer (module docs).
fn kind_for(status: u16, code: Option<&str>, message: Option<&str>) -> SyncErrorKind {
    let expired = message.is_some_and(|m| {
        let m = m.to_ascii_lowercase();
        m.contains("expired") || m.contains("not yet valid") || m.contains("not valid yet")
    });
    match code {
        Some("InvalidAccessKeyId" | "SignatureDoesNotMatch" | "InvalidToken" | "ExpiredToken") => {
            SyncErrorKind::Auth
        }
        Some("AccessDenied") if expired => SyncErrorKind::Clock,
        Some("AccessDenied" | "AllAccessDisabled" | "AccountProblem") => SyncErrorKind::Permission,
        Some("NoSuchBucket") => SyncErrorKind::Bucket,
        Some("RequestTimeTooSkewed") => SyncErrorKind::Clock,
        Some("NoSuchUpload") => SyncErrorKind::NoSuchUpload,
        Some("NoSuchKey") => SyncErrorKind::NotFound,
        Some("SlowDown" | "TooManyRequests" | "RequestLimitExceeded") => SyncErrorKind::Throttled,
        Some(
            "PermanentRedirect"
            | "TemporaryRedirect"
            | "AuthorizationHeaderMalformed"
            | "AuthorizationQueryParametersError"
            | "IllegalLocationConstraintException"
            | "InvalidRegion",
        ) => SyncErrorKind::Endpoint,
        _ => match status {
            429 => SyncErrorKind::Throttled,
            300..=399 => SyncErrorKind::Endpoint,
            401 => SyncErrorKind::Auth,
            403 => SyncErrorKind::Permission,
            404 => SyncErrorKind::NotFound,
            _ => SyncErrorKind::Server,
        },
    }
}

/// The `<Code>` of an S3 error body.
fn error_code(text: &str) -> Option<String> {
    if !text.contains("<Error") {
        return None;
    }
    element(text, "Code")
}

/// The text of the first `<tag>…</tag>`, unescaped.
fn element(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = start + text[start..].find(&close)?;
    let inner = text[start..end]
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    let inner = inner.trim().to_string();
    (!inner.is_empty()).then_some(inner)
}

fn step(what: &str, error: SyncError) -> SyncError {
    let message = match error.message.split_once(" failed: ") {
        // The request's own label is replaced by the probe's step.
        Some((_, reason)) => format!("{what} failed: {reason}"),
        None => format!("{what} failed: {}", error.message),
    };
    SyncError::new(error.kind, message)
}

fn unreadable(what: &str) -> SyncError {
    SyncError::new(
        SyncErrorKind::Server,
        format!("{what} failed: the bucket's answer isn't S3 XML Voice can read."),
    )
}

fn short_object() -> SyncError {
    SyncError::new(
        SyncErrorKind::Crypto,
        "The bucket holds an object shorter than Voice wrote.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s3_codes_map_to_kinds() {
        use SyncErrorKind::*;
        let cases: &[(u16, Option<&str>, Option<&str>, SyncErrorKind)] = &[
            (403, Some("InvalidAccessKeyId"), None, Auth),
            (403, Some("SignatureDoesNotMatch"), None, Auth),
            (403, Some("AccessDenied"), Some("Access Denied"), Permission),
            (
                403,
                Some("AccessDenied"),
                Some("Request has expired"),
                Clock,
            ),
            (
                403,
                Some("AccessDenied"),
                Some("Request is not valid yet"),
                Clock,
            ),
            (404, Some("NoSuchBucket"), None, Bucket),
            (403, Some("RequestTimeTooSkewed"), None, Clock),
            (404, Some("NoSuchUpload"), None, NoSuchUpload),
            (404, Some("NoSuchKey"), None, NotFound),
            (404, None, None, NotFound),
            (503, Some("SlowDown"), None, Throttled),
            (429, None, None, Throttled),
            (500, Some("InternalError"), None, Server),
            (503, None, None, Server),
            (301, Some("PermanentRedirect"), None, Endpoint),
            (400, Some("AuthorizationHeaderMalformed"), None, Endpoint),
            (307, None, None, Endpoint),
            (401, None, None, Auth),
            (403, None, None, Permission),
            (400, Some("InvalidPart"), None, Server),
        ];
        for &(status, code, message, want) in cases {
            assert_eq!(kind_for(status, code, message), want, "{status} {code:?}");
        }
    }

    #[test]
    fn error_bodies_are_read() {
        let body = "<?xml version=\"1.0\"?>\n<Error><Code>NoSuchKey</Code><Message>The key &amp; more</Message></Error>";
        assert_eq!(error_code(body).as_deref(), Some("NoSuchKey"));
        assert_eq!(element(body, "Message").as_deref(), Some("The key & more"));
        assert_eq!(error_code("<CompleteMultipartUploadResult/>"), None);
    }

    #[test]
    fn delete_results_name_the_failed_keys() {
        let body = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Deleted><Key>p/a</Key></Deleted><Error><Key>p/b</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error></DeleteResult>";
        let parsed = DeleteObjectsResponse::parse(body).unwrap();
        assert_eq!(parsed.errors.len(), 1);
        assert_eq!(parsed.errors[0].key, "p/b");
        let quiet = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"></DeleteResult>";
        assert!(DeleteObjectsResponse::parse(quiet)
            .unwrap()
            .errors
            .is_empty());
    }

    #[test]
    fn provider_text_never_carries_the_secret_or_a_signed_url() {
        const SECRET: &str = "the-bucket-secret-value";
        let cfg = SyncConfig {
            service: crate::Service::Other,
            endpoint: "http://127.0.0.1:9".into(),
            region: "us-east-1".into(),
            bucket: "test".into(),
            prefix: String::new(),
            access_key_id: "key".into(),
            url_style: UrlStyle::Path,
            retention: crate::BucketRetention::Keep,
        };
        let d = Duration::from_secs(1);
        let bucket = Bucket::new(&cfg, SECRET, d, d).unwrap();
        let answer = |status: u16, code: &str, message: &str| Reply {
            status,
            etag: None,
            length: None,
            body: format!("<Error><Code>{code}</Code><Message>{message}</Message></Error>")
                .into_bytes(),
        };

        // A secret that starts where the message would be cut is still caught.
        let long = format!("{}{SECRET}", "x".repeat(295));
        let error = bucket.status_error(&answer(403, "AccessDenied", &long), "Uploading");
        assert!(!error.message.contains("the-b"), "{}", error.message);
        assert_eq!(
            error.message,
            "Uploading failed: the bucket answered 403 AccessDenied."
        );

        // Lowercase query names are signed URLs too.
        let quoted = "Bad request to /test/k?x-amz-signature=abc";
        let error = bucket.status_error(&answer(400, "InvalidRequest", quoted), "Listing");
        assert!(!error.message.contains("abc"), "{}", error.message);

        // The kind is read from the whole answer, even when its text is left out.
        let expired = "Request has expired; X-Amz-Expires was 900";
        let error = bucket.status_error(&answer(403, "AccessDenied", expired), "Downloading");
        assert_eq!(error.kind, SyncErrorKind::Clock);
        assert!(!error.message.contains("X-Amz-"), "{}", error.message);

        // A code that isn't an S3 name stays out of the message.
        let odd = format!("<b>{SECRET}</b>");
        let error = bucket.status_error(&answer(500, &odd, "Oops"), "Uploading");
        assert!(!error.message.contains(SECRET), "{}", error.message);
        assert_eq!(error.kind, SyncErrorKind::Server);

        // Ordinary provider text is kept, cut at 300 characters.
        let chatty = "y".repeat(400);
        let error = bucket.status_error(&answer(503, "SlowDown", &chatty), "Uploading");
        assert!(error.message.ends_with(&"y".repeat(300)));
        assert!(!error.message.contains(&"y".repeat(301)));
    }

    #[test]
    fn a_probe_step_replaces_the_request_label() {
        let e = step(
            "Listing the bucket",
            SyncError::new(
                SyncErrorKind::Permission,
                "Listing failed: the bucket answered 403.",
            ),
        );
        assert_eq!(
            e.message,
            "Listing the bucket failed: the bucket answered 403."
        );
        assert_eq!(e.kind, SyncErrorKind::Permission);
    }
}
