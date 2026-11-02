//! The 1/8-scale luma thumbnail of a frame, made on the GPU: the frame goes into mip 0 of a
//! texture with a mip chain, `GenerateMips` averages it down, and only mip 3 (240 x 135 for
//! 1080p, about 130 KB) is read back.

use voice_screen_files::frames::Thumb;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11ShaderResourceView, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_RESOURCE_MISC_GENERATE_MIPS,
};

use crate::capture::d3d::D3D;

/// Mip 3: an eighth of each side.
pub const LEVEL: u32 = 3;

pub struct Thumbnailer {
    d3d: D3D,
    mips: ID3D11Texture2D,
    view: ID3D11ShaderResourceView,
    staging: ID3D11Texture2D,
    width: u32,
    height: u32,
    thumb_width: u32,
    thumb_height: u32,
}

impl Thumbnailer {
    pub fn new(d3d: &D3D, width: u32, height: u32) -> windows::core::Result<Thumbnailer> {
        let mut desc = d3d.texture_desc(width, height);
        desc.MipLevels = LEVEL + 1;
        desc.BindFlags = (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32;
        desc.MiscFlags = D3D11_RESOURCE_MISC_GENERATE_MIPS.0 as u32;
        let mips = d3d.make(&desc, None)?;
        let mut view = None;
        unsafe {
            d3d.device
                .CreateShaderResourceView(&mips, None, Some(&mut view))?;
        }
        let view = view.ok_or_else(windows::core::Error::empty)?;
        let (thumb_width, thumb_height) = ((width >> LEVEL).max(1), (height >> LEVEL).max(1));
        let staging = d3d.staging(thumb_width, thumb_height)?;
        Ok(Thumbnailer {
            d3d: d3d.clone(),
            mips,
            view,
            staging,
            width,
            height,
            thumb_width,
            thumb_height,
        })
    }

    /// The frame size this thumbnailer takes.
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// The thumbnail of `texture`, a frame of this thumbnailer's size.
    pub fn thumb(&mut self, texture: &ID3D11Texture2D) -> windows::core::Result<Thumb> {
        let context = &self.d3d.context;
        unsafe {
            context.CopySubresourceRegion(&self.mips, 0, 0, 0, 0, texture, 0, None);
            context.GenerateMips(&self.view);
        }
        let (w, h) = (self.thumb_width, self.thumb_height);
        let mut luma = vec![0u8; (w * h) as usize];
        unsafe {
            // Mip 3 of the chain into the small staging texture, then map it.
            context.CopySubresourceRegion(&self.staging, 0, 0, 0, 0, &self.mips, LEVEL, None);
        }
        self.d3d.map_rows(&self.staging, w, h, |y, row| {
            for (x, px) in row.chunks_exact(4).enumerate() {
                luma[y * w as usize + x] = luma_of(px[0], px[1], px[2]);
            }
        })?;
        Ok(Thumb {
            width: w,
            height: h,
            luma,
        })
    }
}

/// BT.601 luma from BGRA.
pub fn luma_of(b: u8, g: u8, r: u8) -> u8 {
    ((u32::from(b) * 29 + u32::from(g) * 150 + u32::from(r) * 77) >> 8) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luma_of_primaries() {
        assert_eq!(luma_of(0, 0, 0), 0);
        assert_eq!(luma_of(255, 255, 255), 255);
        assert!(luma_of(0, 255, 0) > luma_of(0, 0, 255));
        assert!(luma_of(0, 0, 255) > luma_of(255, 0, 0));
    }

    /// A white frame with a black bar thumbnails to light cells and some dark ones, on WARP so
    /// any machine runs it.
    #[test]
    fn thumbnails_a_frame_on_the_gpu() {
        crate::com::init_mta();
        let d3d = crate::capture::d3d::create(false, true).unwrap();
        let (w, h) = (640u32, 360u32);
        let mut pixels = vec![255u8; (w * h * 4) as usize];
        for y in 96..136 {
            for x in 0..w as usize {
                let i = (y * w as usize + x) * 4;
                pixels[i..i + 3].copy_from_slice(&[0, 0, 0]);
            }
        }
        let texture = d3d.upload(w, h, &pixels).unwrap();
        let mut thumbs = Thumbnailer::new(&d3d, w, h).unwrap();
        let thumb = thumbs.thumb(&texture).unwrap();
        assert_eq!((thumb.width, thumb.height), (80, 45));
        assert_eq!(thumb.luma[0], 255);
        let dark = thumb.luma.iter().filter(|&&l| l < 64).count();
        assert_eq!(dark, 80 * 5, "rows 96..136 are cells 12..17");
    }
}
