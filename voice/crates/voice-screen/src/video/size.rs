//! The video size rule (spec 1.2): native size within H.264 level 5.1 and 4096 per side, else
//! scaled by one factor; both sides even. The rule lives in `voice-screen-files` so Linux CI
//! tests it too.

pub use voice_screen_files::caps::{video_size, MAX_MACROBLOCKS, MAX_VIDEO_SIDE};

/// A side rounded down to even, at least 2. Captured frames are cropped to this, since H.264 and
/// NV12 take no odd sizes.
pub fn even(side: u32) -> u32 {
    (side & !1).max(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crops_to_even() {
        assert_eq!(even(1441), 1440);
        assert_eq!(even(2560), 2560);
        assert_eq!(even(1), 2);
        assert_eq!(even(0), 2);
    }
}
