//! A lenient URL splitter with Python's `urlparse` behavior. Endpoints are typed by users and
//! may hold placeholders such as `{model}`, so they are split as text instead of being parsed
//! and re-encoded by a strict URL parser.

pub(crate) struct Parts<'a> {
    pub scheme: &'a str,
    pub netloc: &'a str,
    pub path: &'a str,
}

pub(crate) fn split(url: &str) -> Parts<'_> {
    let mut rest = url;
    let mut scheme = "";
    if let Some(colon) = rest.find(':') {
        let candidate = &rest[..colon];
        let valid = candidate
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && candidate
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
        if valid {
            scheme = candidate;
            rest = &rest[colon + 1..];
        }
    }
    let mut netloc = "";
    if let Some(after) = rest.strip_prefix("//") {
        let end = after.find(['/', '?', '#']).unwrap_or(after.len());
        netloc = &after[..end];
        rest = &after[end..];
    }
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    let mut path = &rest[..end];
    // urlparse moves ";params" of the last segment out of the path.
    let last_segment = path.rfind('/').map_or(0, |slash| slash + 1);
    if let Some(semicolon) = path[last_segment..].find(';') {
        path = &path[..last_segment + semicolon];
    }
    Parts {
        scheme,
        netloc,
        path,
    }
}

impl Parts<'_> {
    /// The lowercased host without user info, port or IPv6 brackets.
    pub fn hostname(&self) -> String {
        let host_port = self.netloc.rsplit('@').next().unwrap_or("");
        let host = if let Some(bracketed) = host_port.strip_prefix('[') {
            bracketed.split(']').next().unwrap_or("")
        } else {
            host_port.split(':').next().unwrap_or("")
        };
        host.to_lowercase()
    }

    pub fn port(&self) -> Option<&str> {
        let host_port = self.netloc.rsplit('@').next().unwrap_or("");
        let after_host = match host_port.strip_prefix('[') {
            Some(bracketed) => bracketed.split_once(']').map_or("", |(_, rest)| rest),
            None => host_port.find(':').map_or("", |colon| &host_port[colon..]),
        };
        after_host.strip_prefix(':').filter(|port| !port.is_empty())
    }

    /// Scheme and host with a new path; query, params and fragment are dropped.
    pub fn with_path(&self, path: &str) -> String {
        let mut url = String::new();
        if !self.scheme.is_empty() {
            url.push_str(&self.scheme.to_lowercase());
            url.push(':');
        }
        if !self.netloc.is_empty() {
            url.push_str("//");
            url.push_str(self.netloc);
        }
        url.push_str(path);
        url
    }
}

/// The lowercased host of an endpoint, or "" when it has none.
pub fn endpoint_host(endpoint: &str) -> String {
    split(endpoint.trim()).hostname()
}

/// Whether the endpoint's host accepts a TCP connection: Ownkey's connection check for the
/// audio provider. Port 443 for https and 80 otherwise, unless the URL names one. Only the
/// connection is opened; nothing is sent. The local model never needs this.
pub fn endpoint_reachable(endpoint: &str, timeout: std::time::Duration) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};

    let parts = split(endpoint.trim());
    let host = parts.hostname();
    if host.is_empty() {
        return false;
    }
    let default_port = if parts.scheme.eq_ignore_ascii_case("https") {
        443
    } else {
        80
    };
    let port = match parts.port() {
        Some(port) => match port.parse::<u16>() {
            Ok(port) => port,
            Err(_) => return false,
        },
        None => default_port,
    };
    let Ok(addresses) = (host.as_str(), port).to_socket_addrs() else {
        return false;
    };
    addresses
        .into_iter()
        .any(|address| TcpStream::connect_timeout(&address, timeout).is_ok())
}

/// Hosts on this computer. Audio sent there never leaves it, so it needs no cloud consent.
pub fn is_local_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
}

/// `_replace_endpoint_path`: replaces the first suffix the path ends with, or appends.
pub(crate) fn replace_path_suffix(endpoint: &str, suffixes: &[&str], replacement: &str) -> String {
    let parts = split(endpoint);
    let path = parts.path.trim_end_matches('/');
    let path = match suffixes.iter().find(|suffix| path.ends_with(*suffix)) {
        Some(suffix) => format!("{}{replacement}", &path[..path.len() - suffix.len()]),
        None => format!("{path}{replacement}"),
    };
    parts.with_path(&path)
}

/// Python's `urllib.parse.quote(text, safe=...)`: letters, digits, `_.-~` and `safe` stay,
/// everything else is percent-encoded as UTF-8.
pub(crate) fn quote(text: &str, safe: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let c = byte as char;
        if byte.is_ascii_alphanumeric()
            || "_.-~".contains(c)
            || (byte.is_ascii() && safe.contains(c))
        {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Host and, when the URL names one, port, for messages.
pub(crate) fn host_and_port(url: &str) -> String {
    let parts = split(url.trim());
    let host = parts.hostname();
    match parts.port() {
        Some(port) if host.contains(':') => format!("[{host}]:{port}"),
        Some(port) => format!("{host}:{port}"),
        None => host,
    }
}
