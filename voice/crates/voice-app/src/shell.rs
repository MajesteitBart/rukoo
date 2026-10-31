//! Opening folders and links and choosing a folder, behind a trait so the commands can be tested without
//! opening anything.

use std::path::{Path, PathBuf};

pub trait Shell: Send + Sync {
    fn open_path(&self, path: &Path) -> Result<(), String>;
    fn open_url(&self, url: &str) -> Result<(), String>;
    /// The system's folder picker over `owner` (a window handle). `Ok(None)` when the user cancels.
    fn pick_folder(&self, title: &str, owner: Option<isize>) -> Result<Option<PathBuf>, String>;
}

pub struct SystemShell;

#[cfg(windows)]
impl Shell for SystemShell {
    fn open_path(&self, path: &Path) -> Result<(), String> {
        shell_open(&path.to_string_lossy())
    }

    fn open_url(&self, url: &str) -> Result<(), String> {
        shell_open(url)
    }

    fn pick_folder(&self, title: &str, owner: Option<isize>) -> Result<Option<PathBuf>, String> {
        let title = title.to_string();
        // Its own single-threaded apartment, as the dialog requires; the command thread may have another.
        std::thread::spawn(move || pick_folder_sta(&title, owner))
            .join()
            .map_err(|_| "The folder picker stopped unexpectedly.".to_string())?
    }
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &HSTRING::from(target),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute reports success as a value above 32.
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "Windows could not open {target} (error {}).",
            result.0 as isize
        ))
    }
}

#[cfg(windows)]
fn pick_folder_sta(title: &str, owner: Option<isize>) -> Result<Option<PathBuf>, String> {
    use windows::core::{HRESULT, HSTRING};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS,
        SIGDN_FILESYSPATH,
    };

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
            .ok()
            .map_err(|e| e.to_string())?;
        let result = (|| -> windows::core::Result<Option<PathBuf>> {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            let options = dialog.GetOptions()?;
            dialog
                .SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)?;
            dialog.SetTitle(&HSTRING::from(title))?;
            if let Err(error) = dialog.Show(owner.map(|h| HWND(h as *mut _))) {
                if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                    return Ok(None);
                }
                return Err(error);
            }
            let item = dialog.GetResult()?;
            let name = item.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = name.to_string();
            CoTaskMemFree(Some(name.0 as *const _));
            Ok(Some(PathBuf::from(path.map_err(|e| {
                windows::core::Error::new(HRESULT(-1), e.to_string())
            })?)))
        })();
        CoUninitialize();
        result.map_err(|e| e.message())
    }
}

#[cfg(not(windows))]
impl Shell for SystemShell {
    fn open_path(&self, path: &Path) -> Result<(), String> {
        open_with_system(&path.to_string_lossy())
    }

    fn open_url(&self, url: &str) -> Result<(), String> {
        open_with_system(url)
    }

    fn pick_folder(&self, _title: &str, _owner: Option<isize>) -> Result<Option<PathBuf>, String> {
        Err("Choosing a folder is only supported on Windows for now.".to_string())
    }
}

#[cfg(not(windows))]
fn open_with_system(target: &str) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open {target}: {e}"))
}
