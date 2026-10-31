//! File-descriptor plumbing for the native recognizer.
//!
//! sherpa-onnx and onnxruntime print through the C runtime's stdout and stderr. The worker keeps a
//! private copy of stdout for protocol lines and points descriptor 1 at stderr, so nothing native
//! can corrupt the protocol. While a model loads, descriptor 2 goes through a pipe, because stderr
//! is the only place sherpa-onnx says why it refused a model.
//!
//! The crate links the C runtime statically on Windows (`voice/.cargo/config.toml`), so these
//! descriptors are the same ones the prebuilt sherpa-onnx libraries write to.

use std::io::{self, Write};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};

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
        write_fd(self.fd, buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        // Unbuffered: every write goes straight to the descriptor.
        Ok(())
    }
}

fn write_fd(fd: c_int, buf: &[u8]) -> io::Result<usize> {
    let len = buf.len().min(i32::MAX as usize);
    let written = unsafe { libc::write(fd, buf.as_ptr().cast(), len as _) };
    if written < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(written as usize)
}

/// Descriptor 2 is shared by the whole process, so captures must not overlap.
static CAPTURE: Mutex<()> = Mutex::new(());

/// Collects what is written to descriptor 2 until [`StderrCapture::finish`] or drop.
pub struct StderrCapture {
    saved: c_int,
    reader: Option<JoinHandle<Vec<u8>>>,
    _guard: MutexGuard<'static, ()>,
}

impl StderrCapture {
    /// Starts capturing. The text still reaches stderr as it arrives.
    pub fn start() -> io::Result<Self> {
        Self::begin(true)
    }

    fn begin(pass_on: bool) -> io::Result<Self> {
        let guard = CAPTURE.lock().unwrap_or_else(PoisonError::into_inner);
        let [read_fd, write_fd] = pipe()?;
        let saved = unsafe { libc::dup(STDERR) };
        if saved < 0 {
            let error = io::Error::last_os_error();
            close_all(&[read_fd, write_fd]);
            return Err(error);
        }
        if unsafe { libc::dup2(write_fd, STDERR) } < 0 {
            let error = io::Error::last_os_error();
            close_all(&[read_fd, write_fd, saved]);
            return Err(error);
        }
        close_all(&[write_fd]);
        // Drained on its own thread: a model that prints more than the pipe holds would otherwise
        // block the load. Passing each chunk on at once also gets the text out when sherpa-onnx
        // ends the process with _Exit, which it does for some damaged models.
        let forward = pass_on.then_some(saved);
        let reader = thread::spawn(move || drain(read_fd, forward));
        Ok(Self {
            saved,
            reader: Some(reader),
            _guard: guard,
        })
    }

    /// Restores stderr and returns what was written to it in the meantime.
    pub fn finish(mut self) -> String {
        self.stop()
    }

    fn stop(&mut self) -> String {
        let Some(reader) = self.reader.take() else {
            return String::new();
        };
        // Replacing descriptor 2 closes the pipe's last write end, so the reader drains and ends.
        // The saved descriptor stays open until then because the reader passes text on through it.
        unsafe {
            libc::dup2(self.saved, STDERR);
        }
        let captured = reader.join().unwrap_or_default();
        close_all(&[self.saved]);
        String::from_utf8_lossy(&captured).into_owned()
    }
}

impl Drop for StderrCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
fn pipe() -> io::Result<[c_int; 2]> {
    let mut fds = [0; 2];
    let flags = libc::O_BINARY | libc::O_NOINHERIT;
    if unsafe { libc::pipe(fds.as_mut_ptr(), 64 * 1024, flags) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(fds)
}

#[cfg(unix)]
fn pipe() -> io::Result<[c_int; 2]> {
    let mut fds = [0; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(fds)
}

fn drain(fd: c_int, forward: Option<c_int>) -> Vec<u8> {
    let mut captured = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = unsafe { libc::read(fd, chunk.as_mut_ptr().cast(), chunk.len() as _) };
        if read <= 0 {
            break;
        }
        let chunk = &chunk[..read as usize];
        if let Some(forward) = forward {
            let mut rest = chunk;
            while !rest.is_empty() {
                match write_fd(forward, rest) {
                    Ok(written) if written > 0 => rest = &rest[written..],
                    _ => break,
                }
            }
        }
        captured.extend_from_slice(chunk);
    }
    close_all(&[fd]);
    captured
}

fn close_all(fds: &[c_int]) {
    for &fd in fds {
        unsafe {
            libc::close(fd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fd2(text: &str) {
        assert_eq!(write_fd(STDERR, text.as_bytes()).unwrap(), text.len());
    }

    #[test]
    fn captures_what_native_code_writes_to_descriptor_2() {
        let capture = StderrCapture::begin(false).unwrap();
        write_fd2("first line\n");
        write_fd2("second line\n");
        let captured = capture.finish();
        assert!(
            captured.contains("first line\nsecond line\n"),
            "{captured:?}"
        );

        // Descriptor 2 is back: a second capture starts clean.
        let capture = StderrCapture::begin(false).unwrap();
        write_fd2("third\n");
        let captured = capture.finish();
        assert!(captured.contains("third\n"));
        assert!(!captured.contains("first line"));
    }

    #[test]
    fn output_larger_than_the_pipe_does_not_block() {
        let capture = StderrCapture::begin(false).unwrap();
        let line = "x".repeat(1023) + "\n";
        for _ in 0..256 {
            write_fd2(&line);
        }
        assert!(capture.finish().len() >= 256 * 1024);
    }

    #[test]
    fn dropping_a_capture_restores_stderr() {
        drop(StderrCapture::begin(false).unwrap());
        let capture = StderrCapture::begin(false).unwrap();
        write_fd2("after drop\n");
        assert!(capture.finish().contains("after drop\n"));
    }
}
