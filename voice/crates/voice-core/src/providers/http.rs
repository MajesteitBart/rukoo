//! The HTTP client every provider uses, and the mapping of transport failures to user-facing errors.

use std::time::Duration;

use ureq::http::StatusCode;

use super::urls::{host_and_port, is_local_host, split};
use super::{describe_api_error, ErrorKind, ProviderError};

pub(crate) struct Http {
    agent: ureq::Agent,
    timeout: Duration,
    label: &'static str,
}

pub(crate) struct Reply {
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(&self, label: &str) -> Result<serde_json::Value, ProviderError> {
        serde_json::from_slice(&self.body).map_err(|_| {
            ProviderError::provider(format!("{label} sent a response Voice couldn't read."))
        })
    }
}

impl Http {
    pub fn new(timeout: Duration, label: &'static str) -> Http {
        // Python's requests applied its timeout to the connection and to each wait for data, not
        // to the whole call, so a long upload on a slow line still goes through. These phase
        // timeouts do the same.
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(timeout))
            .timeout_per_write(Some(timeout))
            .timeout_recv_response(Some(timeout))
            .timeout_recv_body(Some(timeout))
            .user_agent(format!("rukoo-voice/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Http {
            agent,
            timeout,
            label,
        }
    }

    pub fn post(
        &self,
        url: &str,
        headers: &[(&'static str, String)],
        content_type: &str,
        body: &[u8],
    ) -> Result<Reply, ProviderError> {
        let mut request = self.agent.post(url).header("Content-Type", content_type);
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        self.finish(request.send(body), url)
    }

    pub fn get(
        &self,
        url: &str,
        headers: &[(&'static str, String)],
        query: &[(&str, &str)],
    ) -> Result<Reply, ProviderError> {
        let mut request = self.agent.get(url);
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        for (name, value) in query {
            request = request.query(*name, *value);
        }
        self.finish(request.call(), url)
    }

    fn finish(
        &self,
        result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
        url: &str,
    ) -> Result<Reply, ProviderError> {
        let mut response = result.map_err(|error| self.transport_error(error, url))?;
        let status = response.status();
        let body = response
            .body_mut()
            .read_to_vec()
            .map_err(|error| self.transport_error(error, url))?;
        if !status.is_success() {
            let text = String::from_utf8_lossy(&body);
            return Err(ProviderError::new(
                status_kind(status),
                describe_api_error(Some(status.as_u16()), status.canonical_reason(), &text),
            ));
        }
        Ok(Reply { body })
    }

    fn transport_error(&self, error: ureq::Error, url: &str) -> ProviderError {
        match error {
            ureq::Error::Timeout(_) => timeout_error(self.label, self.timeout),
            ureq::Error::Io(io)
                if matches!(
                    io.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                timeout_error(self.label, self.timeout)
            }
            ureq::Error::Io(_)
            | ureq::Error::HostNotFound
            | ureq::Error::ConnectionFailed
            | ureq::Error::Tls(_)
            | ureq::Error::Rustls(_) => network_error(url),
            ureq::Error::BadUri(_) => ProviderError::config(format!(
                "This endpoint isn't a valid web address: {}",
                url.trim()
            )),
            other => {
                ProviderError::provider(format!("The request to {} failed: {other}", self.label))
            }
        }
    }
}

fn status_kind(status: StatusCode) -> ErrorKind {
    match status.as_u16() {
        401 | 403 => ErrorKind::Auth,
        _ => ErrorKind::Provider,
    }
}

/// Differs from Ownkey on purpose: Ownkey said "Network error - check internet connection." even
/// for a local server that wasn't running. The message names the host and fits the case.
pub(crate) fn network_error(url: &str) -> ProviderError {
    let host = split(url.trim()).hostname();
    let message = if is_local_host(&host) {
        format!(
            "Couldn't connect to {}. Check that the server is running.",
            host_and_port(url)
        )
    } else if host.is_empty() {
        "Couldn't connect. Check the endpoint in Settings.".to_string()
    } else {
        format!("Couldn't reach {host}. Check your internet connection.")
    };
    ProviderError::new(ErrorKind::Network, message)
}

/// Differs from Ownkey on purpose: a slow provider is a timeout with its own message, not
/// "Transcription failed: HTTPSConnectionPool(...): Read timed out."
pub(crate) fn timeout_error(label: &str, timeout: Duration) -> ProviderError {
    ProviderError::new(
        ErrorKind::Timeout,
        format!(
            "{label} didn't answer within {}. Try again.",
            seconds_text(timeout)
        ),
    )
}

/// "1 second", "30 seconds": a timeout rounded up to whole seconds.
pub(crate) fn seconds_text(timeout: Duration) -> String {
    let seconds = timeout.as_secs_f64().ceil().max(1.0) as u64;
    if seconds == 1 {
        "1 second".to_string()
    } else {
        format!("{seconds} seconds")
    }
}
