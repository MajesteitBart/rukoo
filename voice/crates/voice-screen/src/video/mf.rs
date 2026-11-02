//! Media Foundation, loaded at run time.
//!
//! The `windows` crate binds every Media Foundation free function as a load-time import of
//! mfplat.dll or mfreadwrite.dll. A Windows N edition without the Media Feature Pack has neither,
//! and an exe with such an import doesn't start there at all, which would cost the frames too.
//! So this file resolves the few functions the screen process calls with `LoadLibraryExW` and
//! `GetProcAddress`, and nothing else in the crate names them: `clippy.toml` forbids direct calls
//! and the unit test `no_direct_media_foundation_calls` scans the sources. COM interfaces come
//! from the `windows` crate's types; calling their methods imports nothing.

use std::ffi::c_void;
use std::mem::transmute_copy;
use std::sync::OnceLock;

use windows::core::{s, w, Interface, BOOL, GUID, HRESULT, HSTRING, PCSTR, PCWSTR, PWSTR};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFAttributes, IMFByteStream, IMFDXGIDeviceManager, IMFMediaBuffer, IMFMediaType,
    IMFSample, IMFSinkWriter, IMFSourceReader, MFSTARTUP_FULL, MFT_REGISTER_TYPE_INFO,
    MF_FILE_ACCESSMODE, MF_FILE_FLAGS, MF_FILE_OPENMODE, MF_VERSION,
};
use windows::Win32::System::Com::{CoTaskMemFree, IStream};
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
};

type Startup = unsafe extern "system" fn(u32, u32) -> HRESULT;
type Shutdown = unsafe extern "system" fn() -> HRESULT;
type CreateAttributes = unsafe extern "system" fn(*mut *mut c_void, u32) -> HRESULT;
type CreateObject = unsafe extern "system" fn(*mut *mut c_void) -> HRESULT;
type CreateMemoryBuffer = unsafe extern "system" fn(u32, *mut *mut c_void) -> HRESULT;
type CreateDeviceManager = unsafe extern "system" fn(*mut u32, *mut *mut c_void) -> HRESULT;
type CreateSurfaceBuffer =
    unsafe extern "system" fn(*const GUID, *mut c_void, u32, BOOL, *mut *mut c_void) -> HRESULT;
type TEnumEx = unsafe extern "system" fn(
    GUID,
    u32,
    *const MFT_REGISTER_TYPE_INFO,
    *const MFT_REGISTER_TYPE_INFO,
    *mut *mut *mut c_void,
    *mut u32,
) -> HRESULT;
type CreateFile = unsafe extern "system" fn(
    MF_FILE_ACCESSMODE,
    MF_FILE_OPENMODE,
    MF_FILE_FLAGS,
    PCWSTR,
    *mut *mut c_void,
) -> HRESULT;
type ByteStreamOnStream = unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> HRESULT;
type SinkWriterFromUrl =
    unsafe extern "system" fn(PCWSTR, *mut c_void, *mut c_void, *mut *mut c_void) -> HRESULT;
type SourceReaderFromUrl =
    unsafe extern "system" fn(PCWSTR, *mut c_void, *mut *mut c_void) -> HRESULT;

/// The Media Foundation functions the screen process calls, resolved at run time. `MFStartup`
/// has run once `load` returns it.
pub struct Mf {
    shutdown: Shutdown,
    create_attributes: CreateAttributes,
    create_media_type: CreateObject,
    create_sample: CreateObject,
    create_memory_buffer: CreateMemoryBuffer,
    create_device_manager: CreateDeviceManager,
    create_surface_buffer: CreateSurfaceBuffer,
    tenum_ex: TEnumEx,
    create_file: CreateFile,
    byte_stream_on_stream: ByteStreamOnStream,
    sink_writer_from_url: SinkWriterFromUrl,
    source_reader_from_url: SourceReaderFromUrl,
}

impl std::fmt::Debug for Mf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Mf")
    }
}

/// Resolves one export, as the type it has in the SDK headers.
unsafe fn symbol<T: Copy>(module: HMODULE, name: PCSTR) -> Option<T> {
    let f = unsafe { GetProcAddress(module, name) }?;
    debug_assert_eq!(size_of::<T>(), size_of::<usize>());
    Some(unsafe { transmute_copy::<unsafe extern "system" fn() -> isize, T>(&f) })
}

impl Mf {
    /// Loads mfplat.dll and mfreadwrite.dll from System32 and starts Media Foundation. `None`
    /// on a Windows without it, such as an N edition without the Media Feature Pack: then the
    /// screen process records frames only.
    pub fn load() -> Option<Mf> {
        unsafe {
            let plat = LoadLibraryExW(w!("mfplat.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
            let rw =
                LoadLibraryExW(w!("mfreadwrite.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
            let startup: Startup = symbol(plat, s!("MFStartup"))?;
            let mf = Mf {
                shutdown: symbol(plat, s!("MFShutdown"))?,
                create_attributes: symbol(plat, s!("MFCreateAttributes"))?,
                create_media_type: symbol(plat, s!("MFCreateMediaType"))?,
                create_sample: symbol(plat, s!("MFCreateSample"))?,
                create_memory_buffer: symbol(plat, s!("MFCreateMemoryBuffer"))?,
                create_device_manager: symbol(plat, s!("MFCreateDXGIDeviceManager"))?,
                create_surface_buffer: symbol(plat, s!("MFCreateDXGISurfaceBuffer"))?,
                tenum_ex: symbol(plat, s!("MFTEnumEx"))?,
                create_file: symbol(plat, s!("MFCreateFile"))?,
                byte_stream_on_stream: symbol(plat, s!("MFCreateMFByteStreamOnStream"))?,
                sink_writer_from_url: symbol(rw, s!("MFCreateSinkWriterFromURL"))?,
                source_reader_from_url: symbol(rw, s!("MFCreateSourceReaderFromURL"))?,
            };
            // The libraries stay loaded for the life of the process.
            startup(MF_VERSION, MFSTARTUP_FULL).ok().ok()?;
            Some(mf)
        }
    }

    pub fn create_attributes(&self, size: u32) -> windows::core::Result<IMFAttributes> {
        let mut out = std::ptr::null_mut();
        unsafe {
            (self.create_attributes)(&mut out, size).ok()?;
            Ok(IMFAttributes::from_raw(out))
        }
    }

    pub fn create_media_type(&self) -> windows::core::Result<IMFMediaType> {
        let mut out = std::ptr::null_mut();
        unsafe {
            (self.create_media_type)(&mut out).ok()?;
            Ok(IMFMediaType::from_raw(out))
        }
    }

    pub fn create_sample(&self) -> windows::core::Result<IMFSample> {
        let mut out = std::ptr::null_mut();
        unsafe {
            (self.create_sample)(&mut out).ok()?;
            Ok(IMFSample::from_raw(out))
        }
    }

    pub fn create_memory_buffer(&self, len: u32) -> windows::core::Result<IMFMediaBuffer> {
        let mut out = std::ptr::null_mut();
        unsafe {
            (self.create_memory_buffer)(len, &mut out).ok()?;
            Ok(IMFMediaBuffer::from_raw(out))
        }
    }

    /// A DXGI device manager and its reset token.
    pub fn create_dxgi_device_manager(&self) -> windows::core::Result<(u32, IMFDXGIDeviceManager)> {
        let mut token = 0u32;
        let mut out = std::ptr::null_mut();
        unsafe {
            (self.create_device_manager)(&mut token, &mut out).ok()?;
            Ok((token, IMFDXGIDeviceManager::from_raw(out)))
        }
    }

    /// A media buffer over subresource 0 of `texture`, rows top-down.
    pub fn create_dxgi_surface_buffer(
        &self,
        texture: &ID3D11Texture2D,
    ) -> windows::core::Result<IMFMediaBuffer> {
        let mut out = std::ptr::null_mut();
        unsafe {
            (self.create_surface_buffer)(
                &ID3D11Texture2D::IID,
                texture.as_raw(),
                0,
                BOOL(0),
                &mut out,
            )
            .ok()?;
            Ok(IMFMediaBuffer::from_raw(out))
        }
    }

    /// `MFTEnumEx` for one category, flags and output type.
    pub fn enum_transforms(
        &self,
        category: GUID,
        flags: u32,
        output: &MFT_REGISTER_TYPE_INFO,
    ) -> windows::core::Result<Vec<IMFActivate>> {
        let mut array: *mut *mut c_void = std::ptr::null_mut();
        let mut count = 0u32;
        unsafe {
            (self.tenum_ex)(
                category,
                flags,
                std::ptr::null(),
                output,
                &mut array,
                &mut count,
            )
            .ok()?;
            let mut list = Vec::with_capacity(count as usize);
            for i in 0..count as usize {
                let raw = *array.add(i);
                if !raw.is_null() {
                    // Takes over the reference the array held.
                    list.push(IMFActivate::from_raw(raw));
                }
            }
            if !array.is_null() {
                CoTaskMemFree(Some(array as *const c_void));
            }
            Ok(list)
        }
    }

    pub fn create_file(
        &self,
        access: MF_FILE_ACCESSMODE,
        open: MF_FILE_OPENMODE,
        flags: MF_FILE_FLAGS,
        path: &HSTRING,
    ) -> windows::core::Result<IMFByteStream> {
        let mut out = std::ptr::null_mut();
        unsafe {
            (self.create_file)(access, open, flags, PCWSTR(path.as_ptr()), &mut out).ok()?;
            Ok(IMFByteStream::from_raw(out))
        }
    }

    pub fn byte_stream_on_stream(&self, stream: &IStream) -> windows::core::Result<IMFByteStream> {
        let mut out = std::ptr::null_mut();
        unsafe {
            (self.byte_stream_on_stream)(stream.as_raw(), &mut out).ok()?;
            Ok(IMFByteStream::from_raw(out))
        }
    }

    /// A sink writer onto `stream`; the container comes from `attributes`
    /// (`MF_TRANSCODE_CONTAINERTYPE`).
    pub fn create_sink_writer(
        &self,
        stream: &IMFByteStream,
        attributes: &IMFAttributes,
    ) -> windows::core::Result<IMFSinkWriter> {
        let mut out = std::ptr::null_mut();
        unsafe {
            (self.sink_writer_from_url)(
                PCWSTR::null(),
                stream.as_raw(),
                attributes.as_raw(),
                &mut out,
            )
            .ok()?;
            Ok(IMFSinkWriter::from_raw(out))
        }
    }

    pub fn create_source_reader(&self, url: &HSTRING) -> windows::core::Result<IMFSourceReader> {
        let mut out = std::ptr::null_mut();
        unsafe {
            (self.source_reader_from_url)(PCWSTR(url.as_ptr()), std::ptr::null_mut(), &mut out)
                .ok()?;
            Ok(IMFSourceReader::from_raw(out))
        }
    }

    /// Reads an allocated string attribute, such as an encoder's friendly name.
    pub fn string_attribute(attributes: &IMFAttributes, key: &GUID) -> Option<String> {
        let mut value = PWSTR::null();
        let mut len = 0u32;
        unsafe {
            attributes
                .GetAllocatedString(key, &mut value, &mut len)
                .ok()?;
            let text = value.to_string().ok();
            CoTaskMemFree(Some(value.0 as *const c_void));
            text.filter(|t| !t.is_empty())
        }
    }
}

impl Drop for Mf {
    fn drop(&mut self) {
        unsafe {
            let _ = (self.shutdown)();
        }
    }
}

/// The process's Media Foundation, loaded on first use; `None` when the computer has none.
pub fn shared() -> Option<&'static Mf> {
    static MF: OnceLock<Option<Mf>> = OnceLock::new();
    MF.get_or_init(Mf::load).as_ref()
}
