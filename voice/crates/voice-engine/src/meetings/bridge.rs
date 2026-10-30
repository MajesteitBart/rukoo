//! Hosts the bridge for Rukoo (voice/PROTOCOL.md): the server, `MeetingControl` over the
//! controller and the meeting library, and what Settings > Rukoo shows about the client.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;
use voice_bridge::{
    BridgeServer, Clients, ControlError, EventLog, Handle, MeetingControl, Refused,
};
use voice_protocol::{MeetingId, MeetingSummary, Refusal, StartArgs, StartedBy, Status};

use super::controller::Controller;

/// What Rukoo's commands do.
pub struct Control {
    pub controller: Arc<Controller>,
    pub log: EventLog,
    pub dictating: Arc<AtomicBool>,
}

impl Control {
    pub fn status(&self) -> Status {
        Status {
            recording: self
                .controller
                .current()
                .and_then(|r| MeetingId::parse(&r.id)),
            dictating: self.dictating.load(Ordering::SeqCst),
        }
    }
}

impl MeetingControl for Control {
    fn start(&self, args: StartArgs) -> Result<String, ControlError> {
        self.controller.start(args, StartedBy::Rukoo)
    }

    fn stop(&self, id: &str) -> Result<(), ControlError> {
        self.controller.stop(Some(id), "rukoo")
    }

    fn pause(&self, id: &str) -> Result<(), ControlError> {
        self.controller.pause(Some(id))
    }

    fn resume(&self, id: &str) -> Result<(), ControlError> {
        self.controller.resume(Some(id))
    }

    fn mark(&self, id: &str, label: Option<&str>) -> Result<(String, u64), ControlError> {
        self.controller.mark(Some(id), label)
    }

    fn list(&self, limit: usize) -> Vec<MeetingSummary> {
        self.controller.library().list(limit)
    }

    fn get(&self, id: &str) -> Result<Value, ControlError> {
        self.controller
            .library()
            .get(id, &self.log)
            .ok_or_else(|| ControlError::not_found("There is no meeting with that id."))
    }

    fn frame(&self, id: &str, _at: u64) -> Result<Value, ControlError> {
        if self.controller.library().dir(id).is_none() {
            return Err(ControlError::not_found("There is no meeting with that id."));
        }
        Err(ControlError::not_available(
            "Voice 0.1 doesn't record the screen.",
        ))
    }

    fn status(&self) -> Status {
        Control::status(self)
    }
}

/// Settings > Rukoo: who is connected, or why nobody is (voice/ui/API.md `rukoo`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RukooInfo {
    /// `connected`, `notRunning`, `rukooOutdated`, `voiceOutdated` or `refused`.
    pub state: &'static str,
    pub client_version: Option<String>,
    pub protocol: Option<u32>,
    /// The log's head minus the last event Rukoo has.
    pub behind: Option<u64>,
}

impl RukooInfo {
    pub fn connected(&self) -> bool {
        self.state == "connected"
    }
}

/// What the bridge's clients say about Rukoo. Pure, so it is tested without a server.
pub fn rukoo_info(clients: &Clients, head: u64) -> RukooInfo {
    let rukoo = clients
        .connected
        .iter()
        .filter(|c| c.client == "rukoo")
        .max_by_key(|c| c.connected_at);
    if let Some(client) = rukoo {
        return RukooInfo {
            state: "connected",
            client_version: client.client_version.clone().filter(|v| !v.is_empty()),
            protocol: Some(client.protocol),
            behind: Some(head.saturating_sub(client.sent)),
        };
    }
    // A refusal only counts until a client gets in again.
    let refused = clients
        .refused
        .as_ref()
        .filter(|r| clients.last_admitted_at.is_none_or(|at| r.at > at));
    let state = match refused {
        Some(Refused {
            refusal: Refusal::BadToken,
            ..
        }) => "refused",
        // PROTOCOL.md, Versioning: the side with the older range needs the update.
        Some(Refused {
            refusal: Refusal::UnsupportedProtocol,
            protocol: Some(asked),
            ..
        }) if *asked > u64::from(voice_protocol::PROTOCOL) => "voiceOutdated",
        Some(Refused {
            refusal: Refusal::UnsupportedProtocol,
            ..
        }) => "rukooOutdated",
        _ => "notRunning",
    };
    RukooInfo {
        state,
        client_version: refused.and_then(|r| r.client_version.clone()),
        protocol: None,
        behind: None,
    }
}

/// The running server, which a new token replaces.
pub struct Bridge {
    log: EventLog,
    control: Arc<Control>,
    path: PathBuf,
    version: String,
    handle: Mutex<Option<Handle>>,
    error: Mutex<Option<String>>,
}

impl Bridge {
    pub fn start(log: EventLog, control: Arc<Control>, path: PathBuf, version: &str) -> Bridge {
        let bridge = Bridge {
            log,
            control,
            path,
            version: version.to_string(),
            handle: Mutex::new(None),
            error: Mutex::new(None),
        };
        let _ = bridge.listen();
        bridge
    }

    fn listen(&self) -> io::Result<()> {
        let control: Arc<dyn MeetingControl> = self.control.clone();
        let result = BridgeServer::start(self.log.clone(), control, &self.path, &self.version);
        let mut handle = self.handle.lock().unwrap_or_else(PoisonError::into_inner);
        let mut error = self.error.lock().unwrap_or_else(PoisonError::into_inner);
        match result {
            Ok(started) => {
                *handle = Some(started);
                *error = None;
                Ok(())
            }
            Err(e) => {
                *error = Some(e.to_string());
                Err(e)
            }
        }
    }

    pub fn port(&self) -> Option<u16> {
        self.handle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(Handle::port)
    }

    pub fn discovery_path(&self) -> &Path {
        &self.path
    }

    /// The clients the server has now; empty while it doesn't run.
    pub fn clients(&self) -> Clients {
        self.handle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(Handle::clients)
            .unwrap_or_default()
    }

    pub fn rukoo(&self) -> RukooInfo {
        rukoo_info(&self.clients(), self.log.head())
    }

    /// A new token: the server restarts, which writes a new discovery file and closes every
    /// client; Rukoo reconnects with the new file (PROTOCOL.md, Connecting).
    pub fn new_token(&self) -> io::Result<()> {
        self.stop();
        self.listen()
    }

    pub fn stop(&self) {
        let handle = self
            .handle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(handle) = handle {
            handle.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use voice_bridge::Client;

    fn client(name: &str, at: u64, sent: u64) -> Client {
        Client {
            client: name.into(),
            client_version: Some("2.2.0".into()),
            protocol: 1,
            after: 0,
            sent,
            connected_at: at,
        }
    }

    fn refused(refusal: Refusal, protocol: Option<u64>, at: u64) -> Option<Refused> {
        Some(Refused {
            refusal,
            protocol,
            client: Some("rukoo".into()),
            client_version: Some("2.3.0".into()),
            at,
        })
    }

    #[test]
    fn settings_say_who_is_connected_or_why_nobody_is() {
        let none = rukoo_info(&Clients::default(), 10);
        assert_eq!((none.state, none.behind), ("notRunning", None));

        let mut clients = Clients {
            connected: vec![client("probe", 5, 0), client("rukoo", 3, 7)],
            ..Clients::default()
        };
        let connected = rukoo_info(&clients, 10);
        assert_eq!(
            connected,
            RukooInfo {
                state: "connected",
                client_version: Some("2.2.0".into()),
                protocol: Some(1),
                behind: Some(3),
            }
        );
        assert!(connected.connected());

        // Another program on the bridge isn't Rukoo.
        clients.connected.retain(|c| c.client != "rukoo");
        assert_eq!(rukoo_info(&clients, 10).state, "notRunning");

        clients.refused = refused(Refusal::BadToken, Some(1), 20);
        assert_eq!(rukoo_info(&clients, 10).state, "refused");
        clients.refused = refused(Refusal::UnsupportedProtocol, Some(2), 20);
        let newer = rukoo_info(&clients, 10);
        assert_eq!(
            (newer.state, newer.client_version.as_deref()),
            ("voiceOutdated", Some("2.3.0"))
        );
        clients.refused = refused(Refusal::UnsupportedProtocol, Some(0), 20);
        assert_eq!(rukoo_info(&clients, 10).state, "rukooOutdated");
        // Once a client got in after the refusal, the refusal is history.
        clients.last_admitted_at = Some(25);
        assert_eq!(rukoo_info(&clients, 10).state, "notRunning");
    }
}
