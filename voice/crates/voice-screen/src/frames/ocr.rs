//! The text on a frame, read on this computer by `Windows.Media.Ocr`: the user profile's
//! language when Windows has an OCR pack for it, else the first pack installed, else no text.
//! Small text reads better twice as large, so frames up to 1080 px high are upscaled first.

use windows::Globalization::Language;
use windows::Graphics::Imaging::SoftwareBitmap;
use windows::Media::Ocr::OcrEngine;

use super::jpeg::{self, Pixels};

/// Frames at most this high are read at twice their size.
pub const UPSCALE_MAX_HEIGHT: u32 = 1080;

pub struct Ocr {
    engine: Option<OcrEngine>,
    language: Option<String>,
    max_side: u32,
}

impl Ocr {
    pub fn new() -> Ocr {
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()
            .ok()
            .or_else(|| {
                let languages = OcrEngine::AvailableRecognizerLanguages().ok()?;
                let first: Language = languages.GetAt(0).ok()?;
                OcrEngine::TryCreateFromLanguage(&first).ok()
            });
        let language = engine.as_ref().and_then(|e| {
            e.RecognizerLanguage()
                .and_then(|l| l.LanguageTag())
                .ok()
                .map(|tag| tag.to_string())
        });
        Ocr {
            engine,
            language,
            max_side: OcrEngine::MaxImageDimension().unwrap_or(4096),
        }
    }

    /// The BCP-47 tag of the language it reads, or `None` without an OCR pack.
    pub fn language(&self) -> Option<String> {
        self.language.clone()
    }

    pub fn available(&self) -> bool {
        self.engine.is_some()
    }

    /// The text lines on a bitmap.
    pub fn read(&self, bitmap: &SoftwareBitmap) -> windows::core::Result<Vec<String>> {
        let Some(engine) = &self.engine else {
            return Ok(Vec::new());
        };
        let result = engine.RecognizeAsync(bitmap)?.join()?;
        let mut lines = Vec::new();
        for line in &result.Lines()? {
            lines.push(line.Text()?.to_string());
        }
        Ok(lines)
    }

    /// Reads a frame's pixels, upscaled when it is small enough to gain from it.
    pub fn read_pixels(&self, pixels: &Pixels) -> windows::core::Result<Vec<String>> {
        let upscale = pixels.height <= UPSCALE_MAX_HEIGHT
            && pixels.width * 2 <= self.max_side
            && pixels.height * 2 <= self.max_side;
        let bitmap = if upscale {
            jpeg::bitmap(&upscale_2x(pixels))?
        } else if pixels.width > self.max_side || pixels.height > self.max_side {
            return Ok(Vec::new());
        } else {
            jpeg::bitmap(pixels)?
        };
        self.read(&bitmap)
    }
}

impl Default for Ocr {
    fn default() -> Ocr {
        Ocr::new()
    }
}

/// Every OCR language Windows has a pack for, as BCP-47 tags.
pub fn languages() -> Vec<String> {
    let Ok(list) = OcrEngine::AvailableRecognizerLanguages() else {
        return Vec::new();
    };
    (&list)
        .into_iter()
        .filter_map(|l| l.LanguageTag().ok().map(|t| t.to_string()))
        .collect()
}

/// Twice the size, bilinear: each new pixel between two old ones is their mean.
pub fn upscale_2x(pixels: &Pixels) -> Pixels {
    let (w, h) = (pixels.width as usize, pixels.height as usize);
    let (ow, oh) = (w * 2, h * 2);
    let src = &pixels.bgra;
    let mut out = vec![0u8; ow * oh * 4];
    let at = |x: usize, y: usize, c: usize| u16::from(src[(y * w + x) * 4 + c]);
    for y in 0..h {
        let y1 = (y + 1).min(h - 1);
        for x in 0..w {
            let x1 = (x + 1).min(w - 1);
            for c in 0..4 {
                let p = at(x, y, c);
                let right = at(x1, y, c);
                let down = at(x, y1, c);
                let diagonal = at(x1, y1, c);
                let (ox, oy) = (x * 2, y * 2);
                out[(oy * ow + ox) * 4 + c] = p as u8;
                out[(oy * ow + ox + 1) * 4 + c] = ((p + right) / 2) as u8;
                out[((oy + 1) * ow + ox) * 4 + c] = ((p + down) / 2) as u8;
                out[((oy + 1) * ow + ox + 1) * 4 + c] = ((p + right + down + diagonal) / 4) as u8;
            }
        }
    }
    Pixels {
        bgra: out,
        width: ow as u32,
        height: oh as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upscales_between_pixels() {
        let pixels = Pixels {
            bgra: vec![0, 0, 0, 255, 200, 200, 200, 255],
            width: 2,
            height: 1,
        };
        let big = upscale_2x(&pixels);
        assert_eq!((big.width, big.height), (4, 2));
        let blue: Vec<u8> = big.bgra.chunks(4).map(|p| p[0]).collect();
        assert_eq!(blue, vec![0, 100, 200, 200, 0, 100, 200, 200]);
        assert!(big.bgra.chunks(4).all(|p| p[3] == 255));
    }

    #[test]
    fn lists_languages_and_reads_nothing_on_a_blank_frame() {
        crate::com::init_mta();
        let ocr = Ocr::new();
        assert_eq!(ocr.available(), !languages().is_empty());
        let blank = Pixels {
            bgra: vec![255u8; 200 * 100 * 4],
            width: 200,
            height: 100,
        };
        let lines = ocr.read_pixels(&blank).unwrap();
        assert!(lines.iter().all(|l| l.trim().is_empty()), "{lines:?}");
    }
}
