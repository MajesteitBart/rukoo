//! Keeps native output out of the protocol.
//!
//! A copy of `claim_stdout` from voice-local's `src/stdio.rs` (a binary crate, so it can't be
//! shared). The worker keeps a private copy of stdout for protocol lines and points descriptor 1
//! at stderr before anything native runs.
//!
//! The NeMo DLLs use the dynamic C runtime, so they have descriptor tables of their own. They
//! still write to stderr: in a console program, `dup2` onto descriptor 1 also calls
//! `SetStdHandle(STD_OUTPUT_HANDLE)`, and the dynamic runtime takes its standard handles from
//! there when the DLLs load, which is after this runs.

use std::io::{self, Write};

use libc::c_int;

const STDOUT: c_int = 1;
const STDERR: c_int = 2;

#[cfg(windows)]
extern "C" {
    fn _setmode(fd: c_int, mode: c_int) -> c_int;
}

/// Protocol output on a private duplicate of the original stdout.
pub struct ProtocolOut {
    fd: c_int,
}

/// Takes stdout for protocol lines and sends everything else written to descriptor 1 to stderr.
/// Call once, at startup, before anything native runs.
pub fn claim_stdout() -> io::Result<ProtocolOut> {
    let fd = unsafe { libc::dup(STDOUT) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // The C runtime opens stdout in text mode on Windows, which would turn "\n" into "\r\n".
    #[cfg(windows)]
    if unsafe { _setmode(fd, libc::O_BINARY) } < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::dup2(STDERR, STDOUT) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(ProtocolOut { fd })
}

impl Write for ProtocolOut {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let len = buf.len().min(i32::MAX as usize);
        let written = unsafe { libc::write(self.fd, buf.as_ptr().cast(), len as _) };
        if written < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(written as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        // Unbuffered: every write goes straight to the descriptor.
        Ok(())
    }
}
