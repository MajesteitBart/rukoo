//! Which captured frames go to the video encoder, so the frame rate stays low while the screen
//! is still and goes up when it changes (RUK-108 work item 3).
//!
//! Windows can hand over frames at the capture's 15 a second while nothing on the monitor
//! changes, for instance while a window kept out of the capture redraws. A frame goes to the
//! encoder when the screen moved since the last frame sent: its dirty regions, added up since that
//! frame, cover at least `DIRTY_SKIP` of the screen, or there are none to tell, and its thumbnail
//! differs from the one sent last by at least `STILL`. The other frames are held: the video keeps
//! the newest and writes it at its next re-submit, a quarter to half a second on, so a small change
//! such as typed text still reaches the video. Thumbnails come at most five a second; a frame
//! that needs one between them follows what the last one showed.

use crate::frames::{changed_fraction, Thumb, DIRTY_SKIP, STILL};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// The encoder takes the frame.
    Send,
    /// The video keeps it as its newest picture, for the next re-submit.
    Hold,
}

/// Pure: call `frame` for every captured frame of one video file, in order.
#[derive(Debug, Default)]
pub struct VideoGate {
    /// The file has a frame: its first one is always sent.
    started: bool,
    /// The thumbnail of the last frame sent with one.
    sent: Option<Thumb>,
    /// The dirty regions of the frames since the last one sent or seen to match it, added up.
    unsent: f32,
    /// What the last thumbnail showed: the screen moving.
    moving: bool,
}

impl VideoGate {
    pub fn new() -> VideoGate {
        VideoGate::default()
    }

    /// Whether `frame` needs the thumbnail of a frame whose dirty regions cover `dirty` of the
    /// screen.
    pub fn wants_thumb(&self, dirty: Option<f32>) -> bool {
        !self.started || self.sent.is_none() || dirty.is_none_or(|d| self.unsent + d >= DIRTY_SKIP)
    }

    /// A captured frame, with its thumbnail when the caller read one.
    pub fn frame(&mut self, dirty: Option<f32>, thumb: Option<&Thumb>) -> Gate {
        if !self.started {
            self.started = true;
            return self.send(thumb);
        }
        if let Some(d) = dirty {
            self.unsent += d;
            if self.unsent < DIRTY_SKIP {
                // Next to nothing changed since the frame sent last.
                self.moving = false;
                return Gate::Hold;
            }
        }
        match thumb {
            Some(thumb) => {
                let moved = self
                    .sent
                    .as_ref()
                    .map_or(1.0, |sent| changed_fraction(sent, thumb));
                self.moving = moved >= STILL;
                if self.moving {
                    self.send(Some(thumb))
                } else {
                    // The same picture as the frame sent last, as far as a thumbnail tells.
                    self.unsent = 0.0;
                    Gate::Hold
                }
            }
            None if self.moving => self.send(None),
            None => Gate::Hold,
        }
    }

    fn send(&mut self, thumb: Option<&Thumb>) -> Gate {
        if let Some(thumb) = thumb {
            self.sent = Some(thumb.clone());
        }
        self.unsent = 0.0;
        Gate::Send
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grey thumbnail of 100 x 100 pixels with the first `dark` of them black.
    fn screen(dark: usize) -> Thumb {
        let mut luma = vec![200u8; 10_000];
        luma[..dark].fill(0);
        Thumb {
            width: 100,
            height: 100,
            luma,
        }
    }

    /// Feeds frames as the screen process does: a thumbnail only when the gate wants one and the
    /// five-a-second pace allows it (every third frame at 15 a second). Returns the frames sent.
    fn run(frames: &[(Option<f32>, Thumb)]) -> Vec<usize> {
        let mut gate = VideoGate::new();
        let mut sent = Vec::new();
        let mut last_thumb: Option<usize> = None;
        for (n, (dirty, picture)) in frames.iter().enumerate() {
            let paced = last_thumb.is_none_or(|at| n - at >= 3);
            let thumb = (gate.wants_thumb(*dirty) && paced).then(|| {
                last_thumb = Some(n);
                picture
            });
            if gate.frame(*dirty, thumb) == Gate::Send {
                sent.push(n);
            }
        }
        sent
    }

    #[test]
    fn a_still_screen_sends_its_first_frame_only() {
        // Fifteen frames a second for ten seconds, nothing changed: Windows reports no dirty
        // regions, or the frames come without any and the thumbnails tell.
        for dirty in [Some(0.0), None] {
            let frames: Vec<_> = (0..150).map(|_| (dirty, screen(0))).collect();
            assert_eq!(run(&frames), vec![0], "{dirty:?}");
        }
        // A window kept out of the capture redraws: dirty regions, the same picture.
        let frames: Vec<_> = (0..150).map(|_| (Some(0.02), screen(0))).collect();
        assert_eq!(run(&frames), vec![0]);
    }

    #[test]
    fn a_moving_screen_sends_every_frame() {
        // Shared video: a different picture in every frame. Once a thumbnail finds the screen
        // moving, every frame goes out, also those between thumbnails.
        for dirty in [Some(0.4), None] {
            let frames: Vec<_> = (0..60).map(|n| (dirty, screen(n % 2 * 5_000))).collect();
            let mut all = vec![0];
            all.extend(3..60);
            assert_eq!(run(&frames), all, "{dirty:?}");
        }
    }

    #[test]
    fn a_slide_change_sends_until_a_thumbnail_sees_it_settled() {
        // Still, then a new slide drawn over three frames, then still again.
        let mut frames: Vec<_> = (0..30).map(|_| (Some(0.0), screen(0))).collect();
        frames.extend((0..3).map(|_| (Some(0.5), screen(4_000))));
        frames.extend((0..30).map(|_| (Some(0.0), screen(4_000))));
        let sent = run(&frames);
        assert_eq!(sent[0], 0);
        assert!(sent.contains(&30), "{sent:?}");
        assert!(
            sent.iter().all(|&n| n == 0 || (30..33).contains(&n)),
            "{sent:?}"
        );
    }

    #[test]
    fn small_changes_are_held_until_they_add_up() {
        // Typing, a keystroke a frame: a small dirty region and one more dark thumbnail pixel
        // each. The frames are held for the re-submit to show until the screen strays from the
        // frame sent last by STILL.
        let frames: Vec<_> = (0..120).map(|n| (Some(0.0003), screen(n))).collect();
        let sent = run(&frames);
        assert!(sent.len() >= 3 && sent.len() <= 8, "{sent:?}");
        // Without dirty regions the thumbnails tell. A thumbnail that finds the change sends the
        // frames up to the next one too.
        let frames: Vec<_> = (0..120).map(|n| (None, screen(n))).collect();
        let sent = run(&frames);
        assert!(sent.len() >= 3 && sent.len() <= 20, "{sent:?}");
    }
}
