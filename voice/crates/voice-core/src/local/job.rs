//! A kill-on-close job object for the local speech worker on Windows.
//!
//! When Voice exits or crashes, Windows closes the job handle and ends the worker with it, so a
//! 1 GB model never lingers in a process nobody talks to. Only the worker goes in here: the
//! meeting recorder must outlive the app.

use std::process::Child;

pub(crate) struct Job(windows::Win32::Foundation::HANDLE);

// SAFETY: a job handle is a kernel handle; any thread may use or close it.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn new() -> Option<Job> {
        use windows::core::PCWSTR;
        use windows::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        // SAFETY: plain Win32 calls with valid arguments; the handle is closed in Drop.
        unsafe {
            let handle = CreateJobObjectW(None, PCWSTR::null()).ok()?;
            let job = Job(handle);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;
            Some(job)
        }
    }

    /// Puts a child in the job. Returns false if Windows refused, in which case the worker still
    /// runs and is stopped by the engine, just not by Windows on a crash.
    pub fn assign(&self, child: &Child) -> bool {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;

        // SAFETY: both handles are valid for the duration of the call: the job is owned by self
        // and the process handle by `child`.
        unsafe { AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle())).is_ok() }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateJobObjectW and is closed exactly once.
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
