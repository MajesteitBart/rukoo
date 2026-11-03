//! The `write-fail=video@<ms>` test switch (spec 4.2): the MP4 byte stream's writes fail with a
//! full disk from that moment. The sink writer gets Media Foundation's own file byte stream
//! wrapped in this one, so the failure reaches it the way a real full disk does: the write
//! completes with `0x80070070`, and the sink writer reports it from `WriteSample`.
//!
//! The wrapper is a small COM object written out by hand, because `#[implement]` needs the
//! `windows-core` crate as a direct dependency. Every method passes its arguments unchanged to
//! the same method of the inner stream; only `Write`, `BeginWrite`, `EndWrite` and `SetLength`
//! look at the switch. It is only ever made in a development copy, with `--test`.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use windows::core::{IUnknown, IUnknown_Vtbl, Interface, BOOL, GUID, HRESULT};
use windows::Win32::Foundation::{E_NOINTERFACE, E_POINTER};
use windows::Win32::Media::MediaFoundation::{
    IMFByteStream, IMFByteStream_Vtbl, MFBYTESTREAM_SEEK_ORIGIN,
};
use windows::Win32::System::Com::IAgileObject;

/// `ERROR_DISK_FULL` as an HRESULT.
pub const DISK_FULL: HRESULT = HRESULT(0x8007_0070u32 as i32);

/// The object: the vtable pointer first, as COM lays it out.
#[repr(C)]
struct FailingStream {
    vtable: &'static IMFByteStream_Vtbl,
    refs: AtomicU32,
    inner: IMFByteStream,
    failing: Arc<AtomicBool>,
}

/// Wraps `inner`; its writes fail with a full disk once `failing` is set.
pub fn wrap(inner: IMFByteStream, failing: Arc<AtomicBool>) -> IMFByteStream {
    let object = Box::new(FailingStream {
        vtable: &VTABLE,
        refs: AtomicU32::new(1),
        inner,
        failing,
    });
    // Takes over the one reference the box was made with.
    unsafe { IMFByteStream::from_raw(Box::into_raw(object).cast()) }
}

static VTABLE: IMFByteStream_Vtbl = IMFByteStream_Vtbl {
    base__: IUnknown_Vtbl {
        QueryInterface: query_interface,
        AddRef: add_ref,
        Release: release,
    },
    GetCapabilities: get_capabilities,
    GetLength: get_length,
    SetLength: set_length,
    GetCurrentPosition: get_current_position,
    SetCurrentPosition: set_current_position,
    IsEndOfStream: is_end_of_stream,
    Read: read,
    BeginRead: begin_read,
    EndRead: end_read,
    Write: write,
    BeginWrite: begin_write,
    EndWrite: end_write,
    Seek: seek,
    Flush: flush,
    Close: close,
};

/// # Safety
/// `this` is a `FailingStream` that `wrap` made and that still has a reference.
unsafe fn object<'a>(this: *mut c_void) -> &'a FailingStream {
    unsafe { &*(this as *const FailingStream) }
}

/// The inner stream's raw pointer and vtable, to pass a call on unchanged.
///
/// # Safety
/// As for `object`.
unsafe fn inner<'a>(this: *mut c_void) -> (*mut c_void, &'a IMFByteStream_Vtbl) {
    let stream = unsafe { object(this) };
    (stream.inner.as_raw(), stream.inner.vtable())
}

unsafe fn failing(this: *mut c_void) -> bool {
    unsafe { object(this) }.failing.load(Ordering::SeqCst)
}

unsafe extern "system" fn query_interface(
    this: *mut c_void,
    iid: *const GUID,
    out: *mut *mut c_void,
) -> HRESULT {
    if iid.is_null() || out.is_null() {
        return E_POINTER;
    }
    let iid = unsafe { *iid };
    if iid == IUnknown::IID || iid == IMFByteStream::IID || iid == IAgileObject::IID {
        unsafe {
            add_ref(this);
            *out = this;
        }
        HRESULT(0)
    } else {
        unsafe { *out = std::ptr::null_mut() };
        E_NOINTERFACE
    }
}

unsafe extern "system" fn add_ref(this: *mut c_void) -> u32 {
    unsafe { object(this) }.refs.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn release(this: *mut c_void) -> u32 {
    let left = unsafe { object(this) }.refs.fetch_sub(1, Ordering::AcqRel) - 1;
    if left == 0 {
        // The last reference: the inner stream is released with the box.
        drop(unsafe { Box::from_raw(this as *mut FailingStream) });
    }
    left
}

unsafe extern "system" fn get_capabilities(this: *mut c_void, out: *mut u32) -> HRESULT {
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.GetCapabilities)(raw, out) }
}

unsafe extern "system" fn get_length(this: *mut c_void, out: *mut u64) -> HRESULT {
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.GetLength)(raw, out) }
}

unsafe extern "system" fn set_length(this: *mut c_void, length: u64) -> HRESULT {
    if unsafe { failing(this) } {
        return DISK_FULL;
    }
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.SetLength)(raw, length) }
}

unsafe extern "system" fn get_current_position(this: *mut c_void, out: *mut u64) -> HRESULT {
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.GetCurrentPosition)(raw, out) }
}

unsafe extern "system" fn set_current_position(this: *mut c_void, position: u64) -> HRESULT {
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.SetCurrentPosition)(raw, position) }
}

unsafe extern "system" fn is_end_of_stream(this: *mut c_void, out: *mut BOOL) -> HRESULT {
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.IsEndOfStream)(raw, out) }
}

unsafe extern "system" fn read(this: *mut c_void, pb: *mut u8, cb: u32, out: *mut u32) -> HRESULT {
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.Read)(raw, pb, cb, out) }
}

unsafe extern "system" fn begin_read(
    this: *mut c_void,
    pb: *mut u8,
    cb: u32,
    callback: *mut c_void,
    state: *mut c_void,
) -> HRESULT {
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.BeginRead)(raw, pb, cb, callback, state) }
}

unsafe extern "system" fn end_read(
    this: *mut c_void,
    result: *mut c_void,
    out: *mut u32,
) -> HRESULT {
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.EndRead)(raw, result, out) }
}

unsafe extern "system" fn write(
    this: *mut c_void,
    pb: *const u8,
    cb: u32,
    out: *mut u32,
) -> HRESULT {
    if unsafe { failing(this) } {
        return DISK_FULL;
    }
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.Write)(raw, pb, cb, out) }
}

/// A failing write writes nothing and completes as usual; `EndWrite` then reports the full
/// disk, as Media Foundation's file stream does when `WriteFile` fails.
unsafe extern "system" fn begin_write(
    this: *mut c_void,
    pb: *const u8,
    cb: u32,
    callback: *mut c_void,
    state: *mut c_void,
) -> HRESULT {
    let cb = if unsafe { failing(this) } { 0 } else { cb };
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.BeginWrite)(raw, pb, cb, callback, state) }
}

unsafe extern "system" fn end_write(
    this: *mut c_void,
    result: *mut c_void,
    out: *mut u32,
) -> HRESULT {
    let (raw, vtable) = unsafe { inner(this) };
    let done = unsafe { (vtable.EndWrite)(raw, result, out) };
    if unsafe { failing(this) } {
        return DISK_FULL;
    }
    done
}

unsafe extern "system" fn seek(
    this: *mut c_void,
    origin: MFBYTESTREAM_SEEK_ORIGIN,
    offset: i64,
    flags: u32,
    out: *mut u64,
) -> HRESULT {
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.Seek)(raw, origin, offset, flags, out) }
}

unsafe extern "system" fn flush(this: *mut c_void) -> HRESULT {
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.Flush)(raw) }
}

unsafe extern "system" fn close(this: *mut c_void) -> HRESULT {
    let (raw, vtable) = unsafe { inner(this) };
    unsafe { (vtable.Close)(raw) }
}
