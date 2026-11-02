//! The bucket connection from `config.json`'s `storage_sync` object (spec 2.3). The secret is never
//! part of it: it lives in `bucket-secret.bin`.

use crate::SyncError;

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
    pub fn from_json(value: &serde_json::Value) -> Result<SyncConfig, SyncError> {
        let _ = value;
        todo!()
    }

    /// https, or http to a loopback host; a host and nothing after it but an optional `/`.
    pub fn check_endpoint(endpoint: &str) -> Result<url::Url, SyncError> {
        let _ = endpoint;
        todo!()
    }

    /// The folder with slashes trimmed and one `/` added, or "".
    pub fn key_prefix(&self) -> String {
        todo!()
    }

    /// Hex SHA-256 of service, endpoint, region, bucket, prefix, access key id and URL style (2.3).
    pub fn fingerprint(&self) -> String {
        todo!()
    }
}
