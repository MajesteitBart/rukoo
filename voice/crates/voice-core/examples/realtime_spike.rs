//! A spike against Mistral's realtime socket, run by hand before the stream follower is finished.
//! It streams a WAV through Voice's own client ([`MistralRealtime`]), logs every server message
//! with its arrival time and the stream position sent by then, and answers the questions RUK-109
//! asked: do realtime segments carry times, are reference clips accepted and echoed as
//! `speaker_id`, can Voice push faster than real time, how many speakers and what accuracy on the
//! AMI excerpt, and does the host serve the model.
//!
//! ```text
//! cargo run -p voice-core --example realtime_spike -- --wav <ami.wav> --key-env MISTRAL_API_KEY
//!     [--host api.mistral.ai] [--model voxtral-mini-transcribe-realtime-3] [--diarize]
//!     [--references] [--rttm <file>] [--speed 1] [--delay 480] [--seconds 60]
//!     [--language en] [--out <folder>]
//! cargo run -p voice-core --example realtime_spike -- --key-env MISTRAL_API_KEY --probe-delays
//! ```
//!
//! `--speed 0` pushes as fast as the socket takes it. `--references` cuts one clip of 3 to 15 s
//! per speaker of the RTTM next to the WAV and sends them as `speaker_references` named `call-1`,
//! `call-2`, as the follower does after a reconnect. `--probe-delays` opens one session per
//! streaming delay Voice can send and closes it without audio.
//!
//! The key comes from the named environment variable and is never printed or written. Send only
//! public audio, such as the AMI excerpt NeMo-Speech.cpp ships for its tests. The log holds what
//! Mistral transcribed, so it goes under `tmp/`, never into the repository.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{env, fs, process};

use serde_json::{json, Value};
use voice_core::providers::stream::{SpeechStream, StreamEvent, StreamSession};
use voice_core::providers::{
    parse_realtime_event, realtime_url, streaming_delay_ms, wav_bytes, MistralRealtime,
    MistralStream, ProviderConfig, Purpose,
};

const RATE: usize = 16_000;
const USAGE: &str = "usage: realtime_spike --key-env NAME (--wav FILE [--host HOST] [--model ID] [--diarize] [--references] [--rttm FILE] [--speed X] [--delay MS] [--seconds S] [--language CODE] [--chunk-ms MS] [--out FOLDER] | --probe-delays [--host HOST])";

struct Args {
    key_env: String,
    wav: Option<PathBuf>,
    rttm: Option<PathBuf>,
    host: String,
    model: String,
    diarize: bool,
    references: bool,
    speed: f64,
    delay: u32,
    seconds: Option<f64>,
    language: Option<String>,
    chunk_ms: u32,
    out: PathBuf,
    probe_delays: bool,
}

fn fail(message: impl AsRef<str>) -> ! {
    eprintln!("{}", message.as_ref());
    process::exit(2)
}

fn parse_args() -> Args {
    let mut args = Args {
        key_env: String::new(),
        wav: None,
        rttm: None,
        host: "api.mistral.ai".into(),
        model: "voxtral-mini-transcribe-realtime-3".into(),
        diarize: false,
        references: false,
        speed: 1.0,
        delay: 480,
        seconds: None,
        language: None,
        chunk_ms: 100,
        out: PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tmp/voice-next/mistral-spike"
        )),
        probe_delays: false,
    };
    let mut rest = env::args().skip(1);
    while let Some(flag) = rest.next() {
        let mut value = || rest.next().unwrap_or_else(|| fail(USAGE));
        match flag.as_str() {
            "--key-env" => args.key_env = value(),
            "--wav" => args.wav = Some(value().into()),
            "--rttm" => args.rttm = Some(value().into()),
            "--host" => args.host = value(),
            "--model" => args.model = value(),
            "--diarize" => args.diarize = true,
            "--references" => args.references = true,
            "--speed" => args.speed = value().parse().unwrap_or_else(|_| fail(USAGE)),
            "--delay" => args.delay = value().parse().unwrap_or_else(|_| fail(USAGE)),
            "--seconds" => args.seconds = Some(value().parse().unwrap_or_else(|_| fail(USAGE))),
            "--language" => args.language = Some(value()),
            "--chunk-ms" => args.chunk_ms = value().parse().unwrap_or_else(|_| fail(USAGE)),
            "--out" => args.out = value().into(),
            "--probe-delays" => args.probe_delays = true,
            _ => fail(USAGE),
        }
    }
    if args.key_env.is_empty() || (args.wav.is_none() && !args.probe_delays) {
        fail(USAGE);
    }
    if args.references {
        args.diarize = true;
    }
    args
}

fn main() {
    let args = parse_args();
    // The key stays in memory: it goes into the config and the Authorization header only.
    let key = env::var(&args.key_env)
        .ok()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .unwrap_or_else(|| fail(format!("Set {} to the API key.", args.key_env)));
    let cfg = ProviderConfig {
        provider: "mistral".into(),
        api_key: key,
        endpoint: format!("https://{}/v1/audio/transcriptions", args.host),
        model: args.model.clone(),
        timeout: Duration::from_secs(30),
        purpose: Purpose::Meetings,
    };
    let client = MistralRealtime::new(&cfg).unwrap_or_else(|error| fail(error.message));
    let url = realtime_url(&cfg.endpoint, &cfg.model).unwrap_or_else(|error| fail(error.message));
    drop(cfg);
    fs::create_dir_all(&args.out)
        .unwrap_or_else(|e| fail(format!("Can't create {}: {e}", args.out.display())));
    if args.probe_delays {
        probe_delays(&client, &args, &url);
    } else {
        stream_wav(&client, &args, &url);
    }
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis())
}

fn write_report(args: &Args, name: &str, report: &Value) {
    let path = args
        .out
        .join(format!("{}-{}-{name}.json", unix_ms(), args.host));
    fs::write(&path, serde_json::to_vec_pretty(report).unwrap())
        .unwrap_or_else(|e| fail(format!("Can't write {}: {e}", path.display())));
    println!("Log: {}", path.display());
}

/// Opens one session per delay Voice can send, without audio, and reads what `session.updated`
/// says was applied. No audio means nothing is billed.
fn probe_delays(client: &MistralRealtime, args: &Args, url: &str) {
    let delays: BTreeSet<u32> = (0..=2400).map(streaming_delay_ms).collect();
    let mut results = Vec::new();
    for delay in delays {
        let session = StreamSession {
            delay_ms: delay,
            ..StreamSession::default()
        };
        let result = match client.open(&session) {
            Ok(mut stream) => {
                let messages = stream.poll_raw(Duration::ZERO).unwrap_or_default();
                let applied = messages
                    .iter()
                    .find(|m| m["type"] == "session.updated")
                    .map(|m| m["session"]["target_streaming_delay_ms"].clone())
                    .unwrap_or(Value::Null);
                println!("{delay:>5} ms: accepted, session.updated says {applied}");
                json!({"delayMs": delay, "accepted": true, "applied": applied, "messages": messages})
            }
            Err(error) => {
                println!(
                    "{delay:>5} ms: refused, {:?}: {}",
                    error.kind, error.message
                );
                json!({"delayMs": delay, "accepted": false, "error": {"kind": error.kind, "message": error.message}})
            }
        };
        results.push(result);
        std::thread::sleep(Duration::from_millis(200));
    }
    write_report(
        args,
        "probe-delays",
        &json!({"url": url, "model": args.model, "results": results}),
    );
}

/// A canonical 16 kHz mono 16-bit WAV, as Voice records.
fn read_wav(path: &Path) -> Vec<i16> {
    let bytes =
        fs::read(path).unwrap_or_else(|e| fail(format!("Can't read {}: {e}", path.display())));
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        fail(format!("{} isn't a WAV file.", path.display()));
    }
    let mut at = 12;
    let mut format = None;
    let mut data = None;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        let body = &bytes[at + 8..(at + 8 + len).min(bytes.len())];
        match id {
            b"fmt " if body.len() >= 16 => {
                let u16_at = |i: usize| u16::from_le_bytes([body[i], body[i + 1]]);
                let rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
                format = Some((u16_at(0), u16_at(2), rate, u16_at(14)));
            }
            b"data" => data = Some(body),
            _ => {}
        }
        at += 8 + len + (len & 1);
    }
    if format != Some((1, 1, RATE as u32, 16)) {
        fail(format!(
            "{} must be 16 kHz mono 16-bit PCM, not {format:?}.",
            path.display()
        ));
    }
    data.unwrap_or_else(|| fail("The WAV file has no data."))
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect()
}

#[derive(Clone, Debug)]
struct Turn {
    start: f64,
    end: f64,
    speaker: String,
}

/// `SPEAKER <file> 1 <start> <duration> <NA> <NA> <speaker> <NA> <NA>`
fn read_rttm(path: &Path, limit: f64) -> Vec<Turn> {
    let text = fs::read_to_string(path)
        .unwrap_or_else(|e| fail(format!("Can't read {}: {e}", path.display())));
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 8 || fields[0] != "SPEAKER" {
                return None;
            }
            let start: f64 = fields[3].parse().ok()?;
            let duration: f64 = fields[4].parse().ok()?;
            let end = (start + duration).min(limit);
            (end > start).then(|| Turn {
                start,
                end,
                speaker: fields[7].to_string(),
            })
        })
        .collect()
}

struct Clip {
    name: String,
    speaker: String,
    start: f64,
    end: f64,
}

/// One clip per reference speaker, most speech first: the longest stretch where only they speak,
/// at least 3 s and cut to 15 s. Named `call-1`, `call-2`, as the follower names them.
fn reference_clips(turns: &[Turn]) -> Vec<Clip> {
    let mut totals: BTreeMap<&str, f64> = BTreeMap::new();
    for turn in turns {
        *totals.entry(&turn.speaker).or_default() += turn.end - turn.start;
    }
    let mut speakers: Vec<(&str, f64)> = totals.into_iter().collect();
    speakers.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut clips = Vec::new();
    for (speaker, _) in speakers {
        let mut others: Vec<(f64, f64)> = turns
            .iter()
            .filter(|turn| turn.speaker != speaker)
            .map(|turn| (turn.start, turn.end))
            .collect();
        others.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut best: Option<(f64, f64)> = None;
        for turn in turns.iter().filter(|turn| turn.speaker == speaker) {
            let mut cursor = turn.start;
            let mut pieces = Vec::new();
            for &(start, end) in &others {
                if end <= cursor || start >= turn.end {
                    continue;
                }
                if start > cursor {
                    pieces.push((cursor, start));
                }
                cursor = cursor.max(end);
            }
            if cursor < turn.end {
                pieces.push((cursor, turn.end));
            }
            for piece in pieces {
                if best.is_none_or(|b| piece.1 - piece.0 > b.1 - b.0) {
                    best = Some(piece);
                }
            }
        }
        if let Some((start, end)) = best.filter(|b| b.1 - b.0 >= 3.0) {
            clips.push(Clip {
                name: format!("call-{}", clips.len() + 1),
                speaker: speaker.to_string(),
                start,
                end: end.min(start + 15.0),
            });
        }
        if clips.len() == 8 {
            break;
        }
    }
    clips
}

fn slice(pcm: &[i16], start: f64, end: f64) -> &[i16] {
    let from = ((start * RATE as f64) as usize).min(pcm.len());
    let to = ((end * RATE as f64) as usize).clamp(from, pcm.len());
    &pcm[from..to]
}

struct Segment {
    text: String,
    speaker: Option<String>,
    start: Option<f64>,
    end: Option<f64>,
    /// Stream samples sent when the segment arrived.
    sent: usize,
    at_ms: f64,
}

/// Every message, with its arrival time and the stream position sent by then.
struct Recorder {
    t0: Instant,
    log: Vec<Value>,
    segments: Vec<Segment>,
    error: Option<Value>,
    done_ms: Option<f64>,
    /// When the first audio went out, in ms since `t0`.
    push_start_ms: f64,
    /// How long pushing every chunk took.
    push_ms: f64,
}

impl Recorder {
    fn ms(&self) -> f64 {
        self.t0.elapsed().as_secs_f64() * 1000.0
    }

    fn poll(&mut self, stream: &mut MistralStream, wait: Duration, sent: usize) {
        match stream.poll_raw(wait) {
            Ok(messages) => {
                let at_ms = self.ms();
                for message in messages {
                    match parse_realtime_event(&message) {
                        Ok(Some(StreamEvent::Segment {
                            text,
                            speaker,
                            start,
                            end,
                        })) => self.segments.push(Segment {
                            text,
                            speaker,
                            start,
                            end,
                            sent,
                            at_ms,
                        }),
                        Ok(Some(StreamEvent::Done)) => self.done_ms = Some(at_ms),
                        Ok(None) => {}
                        Err(error) => {
                            self.error.get_or_insert(json!({"kind": error.kind, "message": error.message, "atMs": at_ms}));
                        }
                    }
                    self.log
                        .push(json!({"atMs": at_ms, "sentSamples": sent, "message": message}));
                }
            }
            Err(error) => {
                let at_ms = self.ms();
                self.error.get_or_insert(
                    json!({"kind": error.kind, "message": error.message, "atMs": at_ms}),
                );
            }
        }
    }
}

fn stream_wav(client: &MistralRealtime, args: &Args, url: &str) {
    let wav = args.wav.as_deref().unwrap();
    let mut pcm = read_wav(wav);
    if let Some(seconds) = args.seconds {
        pcm.truncate((seconds * RATE as f64) as usize);
    }
    let audio_s = pcm.len() as f64 / RATE as f64;
    let rttm = args
        .rttm
        .clone()
        .unwrap_or_else(|| wav.with_extension("rttm"));
    let turns = if rttm.exists() {
        read_rttm(&rttm, audio_s)
    } else {
        Vec::new()
    };
    let clips = if args.references {
        if turns.is_empty() {
            fail(format!(
                "--references needs the RTTM at {}.",
                rttm.display()
            ));
        }
        reference_clips(&turns)
    } else {
        Vec::new()
    };
    let session = StreamSession {
        diarize: args.diarize,
        language: args.language.clone(),
        context_bias: Vec::new(),
        delay_ms: args.delay,
        references: clips
            .iter()
            .map(|clip| {
                (
                    clip.name.clone(),
                    wav_bytes(slice(&pcm, clip.start, clip.end), RATE as u32),
                )
            })
            .collect(),
    };
    let delay_ms = streaming_delay_ms(args.delay);
    let mode = format!(
        "{}{}-x{}",
        if args.diarize { "diarize" } else { "plain" },
        if args.references { "-refs" } else { "" },
        args.speed
    );
    println!(
        "{url}: {audio_s:.1} s of {}, {mode}, delay {delay_ms} ms",
        wav.display()
    );
    for clip in &clips {
        println!(
            "  reference {} = {} from {:.2} s to {:.2} s",
            clip.name, clip.speaker, clip.start, clip.end
        );
    }

    let mut recorder = Recorder {
        t0: Instant::now(),
        log: Vec::new(),
        segments: Vec::new(),
        error: None,
        done_ms: None,
        push_start_ms: 0.0,
        push_ms: 0.0,
    };
    let mut report = json!({
        "startedAtUnixMs": unix_ms() as u64,
        "url": url,
        "model": args.model,
        "diarize": args.diarize,
        "references": clips.iter().map(|c| json!({"name": c.name, "rttmSpeaker": c.speaker, "start": c.start, "end": c.end})).collect::<Vec<_>>(),
        "speed": args.speed,
        "delayMs": delay_ms,
        "chunkMs": args.chunk_ms,
        "audioSeconds": audio_s,
    });
    let mut stream = match client.open(&session) {
        Ok(stream) => stream,
        Err(error) => {
            println!(
                "Connecting failed after {:.0} ms: {:?}: {}",
                recorder.ms(),
                error.kind,
                error.message
            );
            report["error"] = json!({"kind": error.kind, "message": error.message});
            report["answers"] = json!({"hostServesModel": false});
            write_report(args, &mode, &report);
            println!(
                "5. No session with {} on {}: {}",
                args.model, args.host, error.message
            );
            return;
        }
    };
    let connect_ms = recorder.ms();
    let chunk = (RATE * args.chunk_ms as usize / 1000).max(1);
    let push_start = Instant::now();
    recorder.push_start_ms = recorder.ms();
    let mut sent = 0;
    for (index, piece) in pcm.chunks(chunk).enumerate() {
        if recorder.error.is_some() {
            break;
        }
        if args.speed > 0.0 {
            let due = push_start
                + Duration::from_secs_f64(index as f64 * chunk as f64 / RATE as f64 / args.speed);
            loop {
                let now = Instant::now();
                if now >= due || recorder.error.is_some() {
                    break;
                }
                recorder.poll(&mut stream, due - now, sent);
            }
        } else if index % 10 == 0 {
            recorder.poll(&mut stream, Duration::ZERO, sent);
        }
        if let Err(error) = stream.push(piece) {
            recorder.error.get_or_insert(
                json!({"kind": error.kind, "message": error.message, "atMs": recorder.ms()}),
            );
            break;
        }
        sent += piece.len();
    }
    recorder.push_ms = push_start.elapsed().as_secs_f64() * 1000.0;
    let mut end_ms = None;
    if recorder.error.is_none() {
        match stream.end() {
            Ok(()) => end_ms = Some(recorder.ms()),
            Err(error) => {
                recorder.error.get_or_insert(
                    json!({"kind": error.kind, "message": error.message, "atMs": recorder.ms()}),
                );
            }
        }
    }
    let deadline = Instant::now() + Duration::from_secs_f64((audio_s * 2.0).max(60.0));
    while recorder.done_ms.is_none() && recorder.error.is_none() && Instant::now() < deadline {
        recorder.poll(&mut stream, Duration::from_millis(200), sent);
    }
    if recorder.done_ms.is_some() {
        recorder.poll(&mut stream, Duration::from_millis(300), sent);
    }
    drop(stream);

    let answers = answers(args, &recorder, &clips, &turns, delay_ms, audio_s);
    report["connectMs"] = json!(connect_ms);
    report["pushStartMs"] = json!(recorder.push_start_ms);
    report["pushMs"] = json!(recorder.push_ms);
    report["endSentAtMs"] = json!(end_ms);
    report["doneAtMs"] = json!(recorder.done_ms);
    report["error"] = recorder.error.clone().unwrap_or(Value::Null);
    report["answers"] = answers;
    report["events"] = Value::Array(std::mem::take(&mut recorder.log));
    write_report(args, &mode, &report);
}

#[derive(Clone, Debug)]
struct Span {
    start: f64,
    end: f64,
    speaker: Option<String>,
}

/// Segment times: Mistral's own when it sends them; otherwise the estimate the follower uses: the
/// stream position sent at arrival minus the delay, no earlier than the previous segment's end,
/// and a start from the word count.
fn segment_spans(segments: &[Segment], delay_s: f64) -> Vec<Span> {
    let mut previous_end = 0.0f64;
    segments
        .iter()
        .map(|segment| {
            let (start, end) = match (segment.start, segment.end) {
                (Some(start), Some(end)) => (start, end),
                _ => {
                    let end = (segment.sent as f64 / RATE as f64 - delay_s).max(previous_end);
                    let words = segment.text.split_whitespace().count() as f64;
                    let length = (words * 0.35).clamp(0.3, 6.0);
                    ((end - length).max(previous_end), end)
                }
            };
            previous_end = previous_end.max(end);
            Span {
                start,
                end,
                speaker: segment.speaker.clone(),
            }
        })
        .collect()
}

/// One passage per run of the same speaker, as the pipeline builds them.
fn passages(spans: &[Span]) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::new();
    for span in spans {
        match out.last_mut() {
            Some(last) if last.speaker == span.speaker => last.end = last.end.max(span.end),
            _ => out.push(span.clone()),
        }
    }
    out
}

struct Score {
    accuracy: f64,
    scored_s: f64,
    mapping: BTreeMap<String, String>,
}

/// The RUK-109 scorer: each passage's reference speaker is the one with the most overlap inside
/// it; ids map one to one to reference speakers, greedily by passage time; accuracy is the passage
/// time whose id maps to its reference speaker over all scored passage time. `null` is wrong.
fn score(passages: &[Span], turns: &[Turn]) -> Score {
    let mut scored = Vec::new();
    let mut matrix: BTreeMap<(String, String), f64> = BTreeMap::new();
    for passage in passages {
        let length = passage.end - passage.start;
        if length <= 0.0 {
            continue;
        }
        let mut overlap: BTreeMap<&str, f64> = BTreeMap::new();
        for turn in turns {
            let shared = passage.end.min(turn.end) - passage.start.max(turn.start);
            if shared > 0.0 {
                *overlap.entry(&turn.speaker).or_default() += shared;
            }
        }
        let Some((reference, _)) = overlap.into_iter().max_by(|a, b| a.1.total_cmp(&b.1)) else {
            continue;
        };
        if let Some(id) = &passage.speaker {
            *matrix
                .entry((id.clone(), reference.to_string()))
                .or_default() += length;
        }
        scored.push((passage, reference.to_string(), length));
    }
    let mut pairs: Vec<((String, String), f64)> = matrix.into_iter().collect();
    pairs.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut mapping = BTreeMap::new();
    let mut taken = BTreeSet::new();
    for ((id, reference), _) in pairs {
        if !mapping.contains_key(&id) && !taken.contains(&reference) {
            taken.insert(reference.clone());
            mapping.insert(id, reference);
        }
    }
    let total: f64 = scored.iter().map(|s| s.2).sum();
    let right: f64 = scored
        .iter()
        .filter(|(passage, reference, _)| {
            passage
                .speaker
                .as_ref()
                .and_then(|id| mapping.get(id))
                .is_some_and(|mapped| mapped == reference)
        })
        .map(|s| s.2)
        .sum();
    Score {
        accuracy: if total > 0.0 { right / total } else { 0.0 },
        scored_s: total,
        mapping,
    }
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    Some(values[values.len() / 2])
}

fn answers(
    args: &Args,
    recorder: &Recorder,
    clips: &[Clip],
    turns: &[Turn],
    delay_ms: u32,
    audio_s: f64,
) -> Value {
    let segments = &recorder.segments;
    let timed: Vec<&Segment> = segments
        .iter()
        .filter(|s| s.start.is_some() && s.end.is_some())
        .collect();
    let sent_minus_end = median(
        timed
            .iter()
            .map(|s| s.sent as f64 / RATE as f64 - s.end.unwrap())
            .collect(),
    );
    let wall_minus_end = median(
        timed
            .iter()
            .map(|s| (s.at_ms - recorder.push_start_ms) / 1000.0 - s.end.unwrap())
            .collect(),
    );
    println!();
    println!(
        "1. {} of {} segments carried numeric start and end.",
        timed.len(),
        segments.len()
    );
    if let (Some(stream), Some(wall)) = (sent_minus_end, wall_minus_end) {
        println!(
            "   Median of (stream seconds sent at arrival - end): {stream:.2} s; of (wall seconds since the first push - end): {wall:.2} s."
        );
    }

    let ids: BTreeSet<String> = segments.iter().filter_map(|s| s.speaker.clone()).collect();
    let names: BTreeSet<String> = clips.iter().map(|c| c.name.clone()).collect();
    let echoed: Vec<&String> = ids.intersection(&names).collect();
    let updated_references = recorder
        .log
        .iter()
        .find(|entry| entry["message"]["type"] == "session.updated")
        // Mistral echoes the names as a list; an object would hold them as keys.
        .and_then(
            |entry| match &entry["message"]["session"]["speaker_references"] {
                Value::Array(names) => Some(
                    names
                        .iter()
                        .map(|name| {
                            name.as_str()
                                .map_or_else(|| name.to_string(), str::to_string)
                        })
                        .collect::<Vec<_>>(),
                ),
                Value::Object(references) => Some(references.keys().cloned().collect()),
                _ => None,
            },
        );
    if clips.is_empty() {
        println!("2. No references sent in this run.");
    } else {
        println!(
            "2. Sent references {:?}; session.updated listed {:?}; speaker ids returned {:?}; reference names among them {:?}.",
            names, updated_references, ids, echoed
        );
    }

    let first_ms = segments.first().map(|s| s.at_ms);
    let pushed_s = recorder.push_ms / 1000.0;
    println!(
        "3. Pushed {audio_s:.1} s of audio in {pushed_s:.1} s ({:.1}x real time). Error: {}. First segment at {}, done at {}.",
        audio_s / pushed_s.max(0.001),
        recorder.error.as_ref().map_or("none".to_string(), |e| e["message"].to_string()),
        first_ms.map_or("-".into(), |ms| format!("{:.1} s", ms / 1000.0)),
        recorder.done_ms.map_or("-".into(), |ms| format!("{:.1} s", ms / 1000.0)),
    );

    let spans = segment_spans(segments, delay_ms as f64 / 1000.0);
    let passages = passages(&spans);
    let score = (!turns.is_empty() && args.diarize).then(|| score(&passages, turns));
    match &score {
        Some(score) => println!(
            "4. {} speaker ids; {} passages; accuracy {:.1}% over {:.1} s scored; ids to reference speakers {:?}{}.",
            ids.len(),
            passages.len(),
            score.accuracy * 100.0,
            score.scored_s,
            score.mapping,
            if timed.len() < segments.len() && args.speed != 1.0 {
                "; times were estimated from the stream position, which assumes real-time pushing"
            } else {
                ""
            }
        ),
        None => println!(
            "4. {} speaker ids; no score without diarization and an RTTM.",
            ids.len()
        ),
    }
    let served = recorder.error.is_none() && recorder.done_ms.is_some();
    println!(
        "5. {} served {}: {}.",
        args.host,
        args.model,
        if served {
            "yes"
        } else {
            "not to the end, see the error"
        }
    );

    json!({
        "segments": segments.len(),
        "timedSegments": timed.len(),
        "medianSentMinusEndS": sent_minus_end,
        "medianWallMinusEndS": wall_minus_end,
        "referencesSent": names,
        "referencesInSessionUpdated": updated_references,
        "speakerIds": ids,
        "referenceNamesReturned": echoed,
        "pushedRealTimeFactor": audio_s / pushed_s.max(0.001),
        "firstSegmentMs": first_ms,
        "passages": passages.iter().map(|p| json!({"start": p.start, "end": p.end, "speaker": p.speaker})).collect::<Vec<_>>(),
        "accuracy": score.as_ref().map(|s| s.accuracy),
        "scoredSeconds": score.as_ref().map(|s| s.scored_s),
        "idToReference": score.as_ref().map(|s| s.mapping.clone()),
        "hostServesModel": served,
    })
}
