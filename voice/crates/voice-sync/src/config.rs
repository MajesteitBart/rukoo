//! The bucket connection from `config.json`'s `storage_sync` object (spec 2.3). The secret is never
//! part of it: it lives in `bucket-secret.bin`.

use sha2::{Digest, Sha256};

use crate::{SyncError, SyncErrorKind};

/// Generates `as_str` and `parse` for an enum of fixed names.
macro_rules! named {
    ($ty:ident { $($variant:ident => $name:literal),+ $(,)? }) => {
        impl $ty {
            pub fn as_str(self) -> &'static str {
                match self {
                    $($ty::$variant => $name,)+
                }
            }

            pub fn parse(name: &str) -> Option<$ty> {
                match name {
                    $($name => Some($ty::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Service {
    Upcloud,
    R2,
    Other,
}
named!(Service { Upcloud => "upcloud", R2 => "r2", Other => "other" });

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UrlStyle {
    Path,
    VirtualHost,
}
named!(UrlStyle { Path => "path", VirtualHost => "virtual" });

/// How long the bucket keeps a meeting's media. Text stays in every case.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BucketRetention {
    Keep,
    Days365,
    Days90,
}
named!(BucketRetention { Keep => "keep", Days365 => "days365", Days90 => "days90" });

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncConfig {
    pub service: Service,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub access_key_id: String,
    pub url_style: UrlStyle,
    pub retention: BucketRetention,
}

impl SyncConfig {
    /// From config.json's `storage_sync` object. An empty region becomes `auto` for R2 and
    /// `us-east-1` for other services.
    ///
    /// Text fields are trimmed. A missing `service` is `upcloud`, as on the Settings page; an
    /// unknown one is `other`. A missing or unknown `urlStyle` is `path` and `retention` is
    /// `keep`. Refused: an endpoint [`check_endpoint`](Self::check_endpoint) refuses
    /// (`Endpoint`), an empty or malformed bucket name (`Bucket`) and an empty access key id
    /// (`Auth`). Other keys, such as `enabled` and `tested`, are the engine's.
    pub fn from_json(value: &serde_json::Value) -> Result<SyncConfig, SyncError> {
        let text = |name: &str| {
            value
                .get(name)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .unwrap_or("")
                .to_string()
        };
        let service = match value.get("service").and_then(serde_json::Value::as_str) {
            None => Service::Upcloud,
            Some(name) => Service::parse(name.trim()).unwrap_or(Service::Other),
        };
        let endpoint = text("endpoint");
        SyncConfig::check_endpoint(&endpoint)?;
        let bucket = text("bucket");
        if bucket.is_empty() {
            return Err(SyncError::new(
                SyncErrorKind::Bucket,
                "Fill in the bucket's name.",
            ));
        }
        if bucket
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_whitespace() || c.is_control())
        {
            return Err(SyncError::new(
                SyncErrorKind::Bucket,
                "A bucket name has no slashes or spaces.",
            ));
        }
        let access_key_id = text("accessKeyId");
        if access_key_id.is_empty() {
            return Err(SyncError::new(
                SyncErrorKind::Auth,
                "Fill in the access key ID.",
            ));
        }
        let mut region = text("region");
        if region.is_empty() {
            region = match service {
                Service::R2 => "auto",
                Service::Upcloud | Service::Other => "us-east-1",
            }
            .to_string();
        }
        let url_style = UrlStyle::parse(&text("urlStyle")).unwrap_or(UrlStyle::Path);
        let retention = BucketRetention::parse(&text("retention")).unwrap_or(BucketRetention::Keep);
        Ok(SyncConfig {
            service,
            endpoint,
            region,
            bucket,
            prefix: text("prefix"),
            access_key_id,
            url_style,
            retention,
        })
    }

    /// https, or http to a loopback host; a host and nothing after it but an optional `/`.
    ///
    /// Plain http elsewhere is refused (D17): anyone on the path could replay a signed URL
    /// within its 15 minutes.
    pub fn check_endpoint(endpoint: &str) -> Result<url::Url, SyncError> {
        let refuse = |message: &str| SyncError::new(SyncErrorKind::Endpoint, message);
        let text = endpoint.trim();
        if text.is_empty() {
            return Err(refuse("Fill in the endpoint URL."));
        }
        let url = url::Url::parse(text)
            .map_err(|_| refuse("The endpoint isn't a web address. It starts with https://."))?;
        let Some(host) = url.host() else {
            return Err(refuse("The endpoint has no host name."));
        };
        match url.scheme() {
            "https" => {}
            "http" if is_loopback(&host) => {}
            "http" => return Err(refuse("The endpoint must start with https://.")),
            _ => {
                return Err(refuse(
                    "The endpoint isn't a web address. It starts with https://.",
                ))
            }
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(refuse("The endpoint can't hold a user name or password."));
        }
        if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
            return Err(refuse(
                "The endpoint is the service's address without a path. The bucket and the folder have their own fields.",
            ));
        }
        Ok(url)
    }

    /// The folder with slashes trimmed and one `/` added, or "".
    pub fn key_prefix(&self) -> String {
        let folder = self.prefix.trim().trim_matches('/');
        if folder.is_empty() {
            String::new()
        } else {
            format!("{folder}/")
        }
    }

    /// Where the objects go: hex SHA-256 of the endpoint's origin, the bucket and the folder. The
    /// queue's rows say what reached this place, so another one means everything goes up again.
    /// The region, the access key, the URL style and the service name only change how Voice
    /// reaches the same objects, so they don't count.
    pub fn target(&self) -> String {
        let origin = SyncConfig::check_endpoint(&self.endpoint)
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_else(|_| self.endpoint.trim().to_ascii_lowercase());
        let mut hash = Sha256::new();
        for (i, field) in [origin.as_str(), &self.bucket, &self.key_prefix()]
            .iter()
            .enumerate()
        {
            if i > 0 {
                hash.update([0u8]);
            }
            hash.update(field.as_bytes());
        }
        crate::names::hex(&hash.finalize())
    }

    /// Hex SHA-256 of service, endpoint, region, bucket, prefix, access key id and URL style (2.3).
    pub fn fingerprint(&self) -> String {
        let mut hash = Sha256::new();
        let fields = [
            self.service.as_str(),
            &self.endpoint,
            &self.region,
            &self.bucket,
            &self.prefix,
            &self.access_key_id,
            self.url_style.as_str(),
        ];
        for (i, field) in fields.iter().enumerate() {
            if i > 0 {
                hash.update([0u8]);
            }
            hash.update(field.as_bytes());
        }
        crate::names::hex(&hash.finalize())
    }
}

fn is_loopback(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn sample() -> serde_json::Value {
        json!({
            "enabled": true,
            "service": "r2",
            "endpoint": " https://abc.r2.cloudflarestorage.com ",
            "region": "",
            "bucket": "meetings",
            "prefix": "/rukoo-voice/",
            "accessKeyId": "AKID",
            "urlStyle": "virtual",
            "retention": "days90",
            "tested": "x",
        })
    }

    #[test]
    fn reads_the_fields_and_fills_the_region() {
        let cfg = SyncConfig::from_json(&sample()).unwrap();
        assert_eq!(cfg.service, Service::R2);
        assert_eq!(cfg.endpoint, "https://abc.r2.cloudflarestorage.com");
        assert_eq!(cfg.region, "auto");
        assert_eq!(cfg.bucket, "meetings");
        assert_eq!(cfg.key_prefix(), "rukoo-voice/");
        assert_eq!(cfg.access_key_id, "AKID");
        assert_eq!(cfg.url_style, UrlStyle::VirtualHost);
        assert_eq!(cfg.retention, BucketRetention::Days90);

        let mut other = sample();
        other["service"] = json!("upcloud");
        other["urlStyle"] = json!("sideways");
        other.as_object_mut().unwrap().remove("retention");
        let cfg = SyncConfig::from_json(&other).unwrap();
        assert_eq!(cfg.region, "us-east-1");
        assert_eq!(cfg.url_style, UrlStyle::Path);
        assert_eq!(cfg.retention, BucketRetention::Keep);

        other.as_object_mut().unwrap().remove("service");
        assert_eq!(
            SyncConfig::from_json(&other).unwrap().service,
            Service::Upcloud
        );
        other["service"] = json!("minio");
        assert_eq!(
            SyncConfig::from_json(&other).unwrap().service,
            Service::Other
        );
    }

    #[test]
    fn refuses_missing_fields() {
        let kind = |patch: serde_json::Value| {
            let mut value = sample();
            for (k, v) in patch.as_object().unwrap() {
                value[k] = v.clone();
            }
            SyncConfig::from_json(&value).unwrap_err().kind
        };
        assert_eq!(kind(json!({ "endpoint": "" })), SyncErrorKind::Endpoint);
        assert_eq!(kind(json!({ "bucket": "" })), SyncErrorKind::Bucket);
        assert_eq!(kind(json!({ "bucket": "a/b" })), SyncErrorKind::Bucket);
        assert_eq!(kind(json!({ "accessKeyId": " " })), SyncErrorKind::Auth);
        assert_eq!(
            SyncConfig::from_json(&serde_json::Value::Null)
                .unwrap_err()
                .kind,
            SyncErrorKind::Endpoint
        );
    }

    #[test]
    fn endpoints_need_https_except_on_this_computer() {
        for ok in [
            "https://s3.example.com",
            "https://s3.example.com/",
            "https://s3.example.com:8443",
            "http://127.0.0.1:9000",
            "http://127.4.5.6",
            "http://localhost:9000/",
            "http://LOCALHOST",
            "http://[::1]:9000",
        ] {
            assert!(SyncConfig::check_endpoint(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "s3.example.com",
            "http://s3.example.com",
            "http://10.0.0.1:9000",
            "ftp://s3.example.com",
            "https://s3.example.com/bucket",
            "https://s3.example.com/?x=1",
            "https://user:pw@s3.example.com",
            "https://s3.example.com/#top",
        ] {
            let error = SyncConfig::check_endpoint(bad).unwrap_err();
            assert_eq!(error.kind, SyncErrorKind::Endpoint, "{bad}");
        }
    }

    #[test]
    fn key_prefix_trims_slashes() {
        let mut cfg = SyncConfig::from_json(&sample()).unwrap();
        for (prefix, want) in [
            ("", ""),
            ("/", ""),
            ("//", ""),
            ("a", "a/"),
            ("/a/b/", "a/b/"),
            ("a//", "a/"),
        ] {
            cfg.prefix = prefix.to_string();
            assert_eq!(cfg.key_prefix(), want, "{prefix:?}");
        }
    }

    #[test]
    fn the_fingerprint_follows_every_connection_field_but_retention() {
        let base = SyncConfig::from_json(&sample()).unwrap();
        let print = base.fingerprint();
        assert_eq!(print.len(), 64);
        assert_eq!(print, base.clone().fingerprint());

        let changes: [fn(&mut SyncConfig); 7] = [
            |c| c.service = Service::Other,
            |c| c.endpoint.push('/'),
            |c| c.region = "eu".into(),
            |c| c.bucket = "other".into(),
            |c| c.prefix = "x".into(),
            |c| c.access_key_id = "B".into(),
            |c| c.url_style = UrlStyle::Path,
        ];
        for change in changes {
            let mut cfg = base.clone();
            change(&mut cfg);
            assert_ne!(cfg.fingerprint(), print);
        }
        let mut cfg = base.clone();
        cfg.retention = BucketRetention::Keep;
        assert_eq!(cfg.fingerprint(), print);

        // The separator keeps neighbouring fields apart.
        let mut a = base.clone();
        let mut b = base.clone();
        a.bucket = "ab".into();
        a.prefix = "c".into();
        b.bucket = "a".into();
        b.prefix = "bc".into();
        assert_ne!(a.fingerprint(), b.fingerprint());
    }

    #[test]
    fn the_target_follows_the_endpoint_bucket_and_folder_only() {
        let base = SyncConfig::from_json(&sample()).unwrap();
        let target = base.target();
        assert_eq!(target.len(), 64);
        // Other ways to reach the same objects.
        let same: [fn(&mut SyncConfig); 8] = [
            |c| c.service = Service::Other,
            |c| c.region = "eu".into(),
            |c| c.access_key_id = "B".into(),
            |c| c.url_style = UrlStyle::Path,
            |c| c.retention = BucketRetention::Keep,
            |c| c.endpoint.push('/'),
            |c| c.endpoint = "https://ABC.r2.cloudflarestorage.com:443".into(),
            |c| c.prefix = "rukoo-voice".into(),
        ];
        for change in same {
            let mut cfg = base.clone();
            change(&mut cfg);
            assert_eq!(cfg.target(), target, "{cfg:?}");
        }
        let other: [fn(&mut SyncConfig); 4] = [
            |c| c.endpoint = "https://def.r2.cloudflarestorage.com".into(),
            |c| c.endpoint = "https://abc.r2.cloudflarestorage.com:8443".into(),
            |c| c.bucket = "other".into(),
            |c| c.prefix = "elsewhere".into(),
        ];
        for change in other {
            let mut cfg = base.clone();
            change(&mut cfg);
            assert_ne!(cfg.target(), target, "{cfg:?}");
        }
    }

    #[test]
    fn the_fingerprint_is_pinned() {
        let cfg = SyncConfig {
            service: Service::Upcloud,
            endpoint: "https://e".into(),
            region: "r".into(),
            bucket: "b".into(),
            prefix: "p".into(),
            access_key_id: "k".into(),
            url_style: UrlStyle::Path,
            retention: BucketRetention::Keep,
        };
        assert_eq!(
            cfg.fingerprint(),
            crate::names::sha256_hex(b"upcloud\0https://e\0r\0b\0p\0k\0path")
        );
    }
}
