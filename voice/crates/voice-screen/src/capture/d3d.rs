//! The one Direct3D 11 device that capture, thumbnails, JPEG and video share. A lost device
//! takes them all, so the screen process recreates the device and the capture session together.

use windows::core::Interface;
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D,
    D3D11_BIND_FLAG, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_FLAG, D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter3, IDXGIDevice, DXGI_ERROR_DEVICE_HUNG, DXGI_ERROR_DEVICE_REMOVED,
    DXGI_ERROR_DEVICE_RESET, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
};
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;

/// The device, its immediate context (multithread protected, so every thread may use it) and
/// the WinRT device capture needs. `video` says whether it was made with
/// `D3D11_CREATE_DEVICE_VIDEO_SUPPORT`, which Media Foundation's GPU path needs.
#[derive(Clone)]
pub struct D3D {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub winrt: IDirect3DDevice,
    pub video: bool,
    pub warp: bool,
}

// The device is free-threaded and its context multithread protected; the WinRT device that
// CreateDirect3D11DeviceFromDXGIDevice returns is agile.
unsafe impl Send for D3D {}

/// Creates the device: the GPU with video support when `video`, else the GPU without it, else
/// WARP, Microsoft's software rasterizer (CI runners have no GPU, and WARP refuses video
/// support). `warp` goes to WARP at once.
pub fn create(video: bool, warp: bool) -> windows::core::Result<D3D> {
    let mut tries: Vec<(D3D_DRIVER_TYPE, bool)> = Vec::new();
    if !warp {
        if video {
            tries.push((D3D_DRIVER_TYPE_HARDWARE, true));
        }
        tries.push((D3D_DRIVER_TYPE_HARDWARE, false));
    }
    tries.push((D3D_DRIVER_TYPE_WARP, false));
    let mut last = windows::core::Error::empty();
    for (kind, with_video) in tries {
        match create_with(kind, with_video) {
            Ok(d3d) => return Ok(d3d),
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn create_with(kind: D3D_DRIVER_TYPE, video: bool) -> windows::core::Result<D3D> {
    let mut flags: D3D11_CREATE_DEVICE_FLAG = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    if video {
        flags |= D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
    }
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            None,
            kind,
            HMODULE::default(),
            flags,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    let device: ID3D11Device = device.ok_or_else(windows::core::Error::empty)?;
    let context = context.ok_or_else(windows::core::Error::empty)?;
    unsafe {
        let _ = device
            .cast::<ID3D11Multithread>()?
            .SetMultithreadProtected(true);
    }
    let dxgi: IDXGIDevice = device.cast()?;
    let winrt: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
    Ok(D3D {
        device,
        context,
        winrt,
        video,
        warp: kind == D3D_DRIVER_TYPE_WARP,
    })
}

/// Whether an error means the device is gone: removed, reset or hung.
pub fn is_device_lost(e: &windows::core::Error) -> bool {
    let code = e.code();
    code == DXGI_ERROR_DEVICE_REMOVED
        || code == DXGI_ERROR_DEVICE_RESET
        || code == DXGI_ERROR_DEVICE_HUNG
}

fn desc(width: u32, height: u32) -> D3D11_TEXTURE2D_DESC {
    D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    }
}

impl D3D {
    /// Whether the device was removed, even when no call has failed yet.
    pub fn removed(&self) -> bool {
        unsafe { self.device.GetDeviceRemovedReason() }.is_err()
    }

    /// The local video memory this process uses on the device's adapter, for the measurements.
    pub fn memory_in_use(&self) -> Option<u64> {
        unsafe {
            let adapter = self.device.cast::<IDXGIDevice>().ok()?.GetAdapter().ok()?;
            let adapter: IDXGIAdapter3 = adapter.cast().ok()?;
            let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
            adapter
                .QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info)
                .ok()?;
            Some(info.CurrentUsage)
        }
    }

    /// A BGRA texture the GPU reads and draws, the kind every captured frame is copied into.
    pub fn texture(&self, width: u32, height: u32) -> windows::core::Result<ID3D11Texture2D> {
        self.make(&desc(width, height), None)
    }

    /// A texture with `bgra` in it, rows top-down without padding.
    pub fn upload(
        &self,
        width: u32,
        height: u32,
        bgra: &[u8],
    ) -> windows::core::Result<ID3D11Texture2D> {
        let data = D3D11_SUBRESOURCE_DATA {
            pSysMem: bgra.as_ptr().cast(),
            SysMemPitch: width * 4,
            SysMemSlicePitch: 0,
        };
        self.make(&desc(width, height), Some(&data))
    }

    /// A texture the CPU can map and read.
    pub fn staging(&self, width: u32, height: u32) -> windows::core::Result<ID3D11Texture2D> {
        let mut d = desc(width, height);
        d.Usage = D3D11_USAGE_STAGING;
        d.BindFlags = D3D11_BIND_FLAG(0).0 as u32;
        d.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        self.make(&d, None)
    }

    pub fn make(
        &self,
        desc: &D3D11_TEXTURE2D_DESC,
        data: Option<&D3D11_SUBRESOURCE_DATA>,
    ) -> windows::core::Result<ID3D11Texture2D> {
        let mut texture = None;
        unsafe {
            self.device
                .CreateTexture2D(desc, data.map(|d| d as *const _), Some(&mut texture))?;
        }
        texture.ok_or_else(windows::core::Error::empty)
    }

    /// The description of a texture `texture` makes, to adjust.
    pub fn texture_desc(&self, width: u32, height: u32) -> D3D11_TEXTURE2D_DESC {
        desc(width, height)
    }

    /// Copies subresource 0 of `source` through `staging` (same size) and calls `rows` with each
    /// mapped row of `width * 4` bytes, top-down.
    pub fn read_rows(
        &self,
        staging: &ID3D11Texture2D,
        source: &ID3D11Texture2D,
        width: u32,
        height: u32,
        rows: impl FnMut(usize, &[u8]),
    ) -> windows::core::Result<()> {
        unsafe { self.context.CopyResource(staging, source) };
        self.map_rows(staging, width, height, rows)
    }

    /// Maps `staging` and calls `rows` with each row of `width * 4` bytes, top-down.
    pub fn map_rows(
        &self,
        staging: &ID3D11Texture2D,
        width: u32,
        height: u32,
        mut rows: impl FnMut(usize, &[u8]),
    ) -> windows::core::Result<()> {
        unsafe {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let base = mapped.pData as *const u8;
            let pitch = mapped.RowPitch as usize;
            let len = width as usize * 4;
            for y in 0..height as usize {
                rows(y, std::slice::from_raw_parts(base.add(y * pitch), len));
            }
            self.context.Unmap(staging, 0);
        }
        Ok(())
    }

    /// The pixels of `source`, BGRA, top-down, without padding.
    pub fn read_bgra(
        &self,
        source: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> windows::core::Result<Vec<u8>> {
        let staging = self.staging(width, height)?;
        let row = width as usize * 4;
        let mut out = vec![0u8; row * height as usize];
        self.read_rows(&staging, source, width, height, |y, bytes| {
            out[y * row..(y + 1) * row].copy_from_slice(bytes);
        })?;
        Ok(out)
    }
}
