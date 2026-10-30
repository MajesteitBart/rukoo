//! Dictation's microphone outside a meeting: the default input device through cpal, converted
//! to 16 kHz mono. Opened at every press and closed at every release, as Ownkey did, so a new
//! default microphone applies from the next dictation (ownkey-dictation.md 4.3).

use crate::services::{AudioSink, MicStream, Microphone};

pub struct DefaultMicrophone;

impl Microphone for DefaultMicrophone {
    fn open(&self, on_audio: AudioSink) -> Result<Box<dyn MicStream>, String> {
        #[cfg(windows)]
        {
            cpal_mic::open(on_audio).map(|mic| Box::new(mic) as Box<dyn MicStream>)
        }
        #[cfg(not(windows))]
        {
            let _ = on_audio;
            Err("Dictation isn't supported on this platform yet.".into())
        }
    }
}

#[cfg(windows)]
mod cpal_mic {
    use std::sync::mpsc;
    use std::thread::{self, JoinHandle};

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{Data, SampleFormat};
    use voice_audio::Resampler;

    use crate::services::{AudioSink, MicStream};

    /// The stream lives on its own thread, which drops it when the microphone closes.
    pub struct CpalMic {
        stop: Option<mpsc::Sender<()>>,
        thread: Option<JoinHandle<()>>,
    }

    impl MicStream for CpalMic {}

    impl Drop for CpalMic {
        fn drop(&mut self) {
            drop(self.stop.take());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    pub fn open(on_audio: AudioSink) -> Result<CpalMic, String> {
        let (opened_tx, opened_rx) = mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let thread = thread::Builder::new()
            .name("dictation-mic".into())
            .spawn(move || {
                let stream = match build(on_audio) {
                    Ok(stream) => stream,
                    Err(e) => {
                        let _ = opened_tx.send(Err(e));
                        return;
                    }
                };
                let _ = opened_tx.send(Ok(()));
                // Until the release drops the sender.
                let _ = stop_rx.recv();
                drop(stream);
            })
            .map_err(|e| format!("Couldn't start the microphone: {e}"))?;
        match opened_rx.recv() {
            Ok(Ok(())) => Ok(CpalMic {
                stop: Some(stop_tx),
                thread: Some(thread),
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err("The microphone stopped while it opened.".into())
            }
        }
    }

    fn build(mut on_audio: AudioSink) -> Result<cpal::Stream, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or("No microphone is available.")?;
        // The device's own format: cpal doesn't ask Windows to convert capture streams.
        let config = device.default_input_config().map_err(|e| e.to_string())?;
        let format = config.sample_format();
        let mut resampler =
            Resampler::new(config.sample_rate(), config.channels()).ok_or_else(|| {
                format!(
                    "The microphone's format ({} Hz) isn't supported.",
                    config.sample_rate()
                )
            })?;
        let on_data = move |data: &Data, _: &cpal::InputCallbackInfo| {
            if let Some(samples) = to_f32(data) {
                let pcm = resampler.process(&samples);
                if !pcm.is_empty() {
                    on_audio(&pcm);
                }
            }
        };
        // A lost device just stops delivering; the release ends the dictation as usual.
        let on_error = |_: cpal::Error| {};
        let stream = device
            .build_input_stream_raw(config.config(), format, on_data, on_error, None)
            .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok(stream)
    }

    fn to_f32(data: &Data) -> Option<Vec<f32>> {
        Some(match data.sample_format() {
            SampleFormat::F32 => data.as_slice::<f32>()?.to_vec(),
            SampleFormat::F64 => data.as_slice::<f64>()?.iter().map(|&s| s as f32).collect(),
            SampleFormat::I16 => data
                .as_slice::<i16>()?
                .iter()
                .map(|&s| f32::from(s) / 32_768.0)
                .collect(),
            SampleFormat::I32 => data
                .as_slice::<i32>()?
                .iter()
                .map(|&s| s as f32 / 2_147_483_648.0)
                .collect(),
            SampleFormat::U16 => data
                .as_slice::<u16>()?
                .iter()
                .map(|&s| (f32::from(s) - 32_768.0) / 32_768.0)
                .collect(),
            SampleFormat::U8 => data
                .as_slice::<u8>()?
                .iter()
                .map(|&s| (f32::from(s) - 128.0) / 128.0)
                .collect(),
            SampleFormat::I8 => data
                .as_slice::<i8>()?
                .iter()
                .map(|&s| f32::from(s) / 128.0)
                .collect(),
            _ => return None,
        })
    }
}
