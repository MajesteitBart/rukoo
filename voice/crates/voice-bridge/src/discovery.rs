//! The discovery file, where Rukoo finds Voice's port and token.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::{fmt, thread, time::Duration};

use serde_json::Value;

/// How often a rename blocked by another process (a virus scanner, Rukoo reading the old file)
/// is tried again.
const RENAME_ATTEMPTS: u32 = 10;
const RENAME_PAUSE: Duration = Duration::from_millis(20);

/// A discovery file this Voice wrote. Dropping it removes the file.
pub struct Discovery {
    path: PathBuf,
    token: String,
}

impl Discovery {
    /// Writes `file` to `path`, readable only by the current user.
    ///
    /// The file is written under a temporary name and renamed into place, so Rukoo never reads
    /// half of it. On Windows its access list grants only the current user and doesn't inherit
    /// from the folder; elsewhere it has mode 0600, and missing folders are made with 0700.
    pub fn write(path: &Path, file: &voice_protocol::Discovery) -> io::Result<Discovery> {
        let name = path.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "the discovery path has no file name",
            )
        })?;
        let folder = match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        };
        private::create_dir_all(folder)?;

        let mut json = serde_json::to_vec_pretty(file)?;
        json.push(b'\n');
        let temporary = folder.join(format!(
            ".{}.{}.tmp",
            name.to_string_lossy(),
            std::process::id()
        ));
        let written = write_then_rename(&temporary, path, &json);
        if written.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        written?;
        Ok(Discovery {
            path: path.to_owned(),
            token: file.token.clone(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        // Another Voice sharing this path (two development copies paired through
        // RUKOO_VOICE_BRIDGE) may have replaced the file since. That file is the other Voice's
        // to remove.
        if written_with(&self.path, &self.token) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl fmt::Debug for Discovery {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Discovery")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

fn write_then_rename(temporary: &Path, path: &Path, json: &[u8]) -> io::Result<()> {
    // A leftover from a crashed start would keep its old access list, so start from nothing.
    match fs::remove_file(temporary) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut file = private::create_new(temporary)?;
    file.write_all(json)?;
    file.sync_all()?;
    drop(file);
    rename_into_place(temporary, path)
}

fn rename_into_place(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Err(e) if attempt < RENAME_ATTEMPTS && is_transient(&e) => {
                attempt += 1;
                thread::sleep(RENAME_PAUSE);
            }
            result => return result,
        }
    }
}

fn is_transient(e: &io::Error) -> bool {
    // ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION: someone has the old file open.
    cfg!(windows)
        && (e.kind() == io::ErrorKind::PermissionDenied
            || matches!(e.raw_os_error(), Some(32 | 33)))
}

fn written_with(path: &Path, token: &str) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .is_some_and(|file| file["token"].as_str() == Some(token))
}

#[cfg(unix)]
mod private {
    use std::fs::{self, DirBuilder, File, OpenOptions};
    use std::io;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    /// Creates the missing folders with mode 0700. Folders that exist keep their mode: with
    /// RUKOO_VOICE_BRIDGE the file can sit in a folder Voice doesn't own.
    pub fn create_dir_all(folder: &Path) -> io::Result<()> {
        DirBuilder::new().recursive(true).mode(0o700).create(folder)
    }

    pub fn create_new(path: &Path) -> io::Result<File> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        // The umask can only take bits away; set the mode exactly anyway.
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        Ok(file)
    }
}

#[cfg(windows)]
mod private {
    use std::fs::{self, File};
    use std::io;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::path::Path;

    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, LocalFree, GENERIC_WRITE, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// The folder lives in the user's profile and keeps the access list it inherits; the file
    /// itself carries the restriction.
    pub fn create_dir_all(folder: &Path) -> io::Result<()> {
        fs::create_dir_all(folder)
    }

    /// Creates `path`, which must not exist, with an access list that grants only the current
    /// user. The list is set as the file is created, so the token is never readable by others.
    pub fn create_new(path: &Path) -> io::Result<File> {
        let sid = current_user_sid()?;
        // "D:P" is a DACL protected from inheritance; its one entry gives the user full access.
        let sddl = HSTRING::from(format!("D:P(A;;FA;;;{sid})"));
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &sddl,
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let created = unsafe {
            CreateFileW(
                &HSTRING::from(path),
                GENERIC_WRITE.0,
                FILE_SHARE_NONE,
                Some(&attributes),
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        };
        unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
        let handle = created?;
        // The handle is ours alone from here on; File closes it.
        Ok(unsafe { File::from_raw_handle(handle.0 as RawHandle) })
    }

    /// The SID of the user this process runs as, such as `S-1-5-21-…-1001`.
    pub fn current_user_sid() -> io::Result<String> {
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }?;
        let sid = token_user_sid(token);
        let _ = unsafe { CloseHandle(token) };
        sid
    }

    fn token_user_sid(token: HANDLE) -> io::Result<String> {
        let mut size = 0u32;
        // This call only reports the size; it fails with ERROR_INSUFFICIENT_BUFFER.
        let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut size) };
        // u64 keeps the buffer aligned for TOKEN_USER and the SID that follows it.
        let mut buffer = vec![0u64; (size as usize).div_ceil(8).max(1)];
        unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                size,
                &mut size,
            )
        }?;
        let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
        sid_string(user.User.Sid)
    }

    pub fn sid_string(sid: PSID) -> io::Result<String> {
        let mut text = PWSTR::null();
        unsafe { ConvertSidToStringSidW(sid, &mut text) }?;
        let converted = unsafe { text.to_string() };
        unsafe { LocalFree(Some(HLOCAL(text.0.cast()))) };
        converted.map_err(io::Error::other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const TOKEN: &str = "q7hR0lJ3x2b8Yc5vN1mK4sT9wE6uA0dF3gH2jL5pZ8o";

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Scratch {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "voice-bridge-discovery-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            Scratch(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn file(token: &str, port: u16) -> voice_protocol::Discovery {
        voice_protocol::Discovery {
            protocol: 1,
            min_protocol: 1,
            port,
            token: token.into(),
            pid: std::process::id(),
            instance: "Vb3kQ9m2X7pL1sR4tY8wZQ".into(),
            voice_version: "0.1.0".into(),
            started_at: 1_793_000_000_000,
        }
    }

    fn read(path: &Path) -> voice_protocol::Discovery {
        let value: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        voice_protocol::validate_discovery(&value).unwrap()
    }

    #[test]
    fn writes_a_valid_file_and_removes_it_on_drop() {
        let scratch = Scratch::new();
        let path = scratch.0.join("nested").join("bridge.json");
        let discovery = Discovery::write(&path, &file(TOKEN, 49821)).unwrap();
        assert_eq!(read(&path), file(TOKEN, 49821));
        let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, ["bridge.json"], "no temporary file stays behind");
        drop(discovery);
        assert!(!path.exists());
    }

    #[test]
    fn replaces_a_stale_file() {
        let scratch = Scratch::new();
        let path = scratch.0.join("bridge.json");
        fs::create_dir_all(&scratch.0).unwrap();
        fs::write(&path, "{\"token\":\"left over from a crash\"}").unwrap();
        let _discovery = Discovery::write(&path, &file(TOKEN, 1234)).unwrap();
        assert_eq!(read(&path).port, 1234);
    }

    #[test]
    fn leaves_a_file_another_voice_wrote_since() {
        let scratch = Scratch::new();
        let path = scratch.0.join("bridge.json");
        let ours = Discovery::write(&path, &file(TOKEN, 1111)).unwrap();
        let other_token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let theirs = Discovery::write(&path, &file(other_token, 2222)).unwrap();
        drop(ours);
        assert_eq!(read(&path).port, 2222);
        drop(theirs);
        assert!(!path.exists());
    }

    #[test]
    fn debug_output_hides_the_token() {
        let scratch = Scratch::new();
        let discovery = Discovery::write(&scratch.0.join("bridge.json"), &file(TOKEN, 1)).unwrap();
        assert!(!format!("{discovery:?}").contains(TOKEN));
    }

    #[cfg(unix)]
    #[test]
    fn only_the_user_can_read_it() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new();
        let path = scratch.0.join("voice").join("bridge.json");
        let _discovery = Discovery::write(&path, &file(TOKEN, 1)).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
    }

    #[cfg(windows)]
    #[test]
    fn only_the_user_can_read_it() {
        let scratch = Scratch::new();
        let path = scratch.0.join("bridge.json");
        let _discovery = Discovery::write(&path, &file(TOKEN, 1)).unwrap();
        let acl = windows_acl::read(&path).unwrap();
        assert!(
            acl.protected,
            "the access list must not inherit from the folder"
        );
        let user = private::current_user_sid().unwrap();
        assert_eq!(
            acl.entries,
            [windows_acl::Entry {
                allowed: true,
                mask: windows_acl::FILE_ALL_ACCESS,
                sid: user,
            }]
        );
    }

    /// Reads a file's access list back, to check what `create_new` set.
    #[cfg(windows)]
    mod windows_acl {
        use std::io;
        use std::path::Path;

        use windows::core::HSTRING;
        use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
        use windows::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
        use windows::Win32::Security::{
            AclSizeInformation, GetAce, GetAclInformation, GetSecurityDescriptorControl,
            ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
            PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
        };

        pub const FILE_ALL_ACCESS: u32 = 0x001F_01FF;
        const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

        #[derive(Debug, PartialEq)]
        pub struct Entry {
            pub allowed: bool,
            pub mask: u32,
            pub sid: String,
        }

        pub struct Acl {
            pub protected: bool,
            pub entries: Vec<Entry>,
        }

        pub fn read(path: &Path) -> io::Result<Acl> {
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            let status = unsafe {
                GetNamedSecurityInfoW(
                    &HSTRING::from(path),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    None,
                    None,
                    Some(&mut dacl),
                    None,
                    &mut descriptor,
                )
            };
            if status != ERROR_SUCCESS {
                return Err(io::Error::from_raw_os_error(status.0 as i32));
            }
            let acl = entries(descriptor, dacl);
            unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
            acl
        }

        fn entries(descriptor: PSECURITY_DESCRIPTOR, dacl: *mut ACL) -> io::Result<Acl> {
            let mut control = 0u16;
            let mut revision = 0u32;
            unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) }?;
            let mut size = ACL_SIZE_INFORMATION::default();
            unsafe {
                GetAclInformation(
                    dacl,
                    (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
                    size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                )
            }?;
            let mut entries = Vec::new();
            for index in 0..size.AceCount {
                let mut ace = std::ptr::null_mut();
                unsafe { GetAce(dacl, index, &mut ace) }?;
                let header = unsafe { &*ace.cast::<ACE_HEADER>() };
                let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
                let sid = PSID(unsafe { std::ptr::addr_of_mut!((*allowed).SidStart) }.cast());
                entries.push(Entry {
                    allowed: header.AceType == ACCESS_ALLOWED_ACE_TYPE,
                    mask: unsafe { (*allowed).Mask },
                    sid: super::private::sid_string(sid)?,
                });
            }
            Ok(Acl {
                protected: control & SE_DACL_PROTECTED.0 != 0,
                entries,
            })
        }
    }
}
