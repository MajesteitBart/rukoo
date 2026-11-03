//! Free space on the meeting folder's volume.

use std::path::Path;

use windows::core::HSTRING;
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

/// Bytes free for this user on the volume of `path`. With `test_file` (the `free-bytes-file`
/// test switch) the number written in that file instead, so tests can step through the drop
/// thresholds. `None` when neither can be read.
pub fn free_bytes(path: &Path, test_file: Option<&Path>) -> Option<u64> {
    if let Some(file) = test_file {
        return std::fs::read_to_string(file).ok()?.trim().parse().ok();
    }
    let mut available = 0u64;
    let dir = HSTRING::from(path.as_os_str());
    unsafe { GetDiskFreeSpaceExW(&dir, Some(&mut available), None, None) }.ok()?;
    Some(available)
}

/// Whether a write failed because the disk is full: `ERROR_DISK_FULL`, `ERROR_HANDLE_DISK_FULL`.
pub fn is_disk_full(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(112) | Some(39))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_volume_or_the_test_file() {
        let dir = std::env::temp_dir();
        assert!(free_bytes(&dir, None).unwrap() > 0);
        let file = dir.join(format!("voice-screen-free-{}.txt", std::process::id()));
        std::fs::write(&file, "3221225472\n").unwrap();
        assert_eq!(free_bytes(&dir, Some(&file)), Some(3 << 30));
        std::fs::write(&file, "lots").unwrap();
        assert_eq!(free_bytes(&dir, Some(&file)), None);
        std::fs::remove_file(&file).unwrap();
        assert!(is_disk_full(&std::io::Error::from_raw_os_error(112)));
        assert!(!is_disk_full(&std::io::Error::from_raw_os_error(5)));
    }
}
