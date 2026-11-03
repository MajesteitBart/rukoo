"""Writes voice/fixtures/binarizer-vectors.json: synthetic frame probabilities and the speaker
turn events Ownkey's LiveBinarizer reports for them, so voice-meetings' Rust port can prove it
reports the same events.

LiveBinarizer is copied verbatim from Ownkey for Windows (local_diarization.py:260-338), and
offline_segments from its test (tests/test_meetings_diarization.py:88-110), the port of
NeMo-Speech.cpp's batch postprocessing it must agree with. The timelines follow that test's
speech() generator with numpy.random.default_rng(7). Every number is synthetic.

Run from the repository root, with NumPy 2 installed:

    py -I voice/scripts/binarizer-vectors.py
"""

import json
import pathlib

import numpy as np

OUT = pathlib.Path(__file__).resolve().parent.parent / "fixtures" / "binarizer-vectors.json"
CASES = 5
SPEAKERS = 3
SPF = 0.01


class LiveBinarizer:
    """Causal version of the runtime's segment postprocessing: onset/offset
    hysteresis, edge padding, gap filling and a minimum duration. Emits
    ``(speaker index, seconds, starting)`` once a decision can no longer change,
    so persisted turns never need rewriting. Defaults match NeMo-Speech.cpp's
    DiarSegmentationCfg."""

    def __init__(self, speakers: int, seconds_per_frame: float, *, onset=0.641, offset=0.561, pad_onset=0.229,
                 pad_offset=0.079, min_on=0.511, min_off=0.296):
        self.spf = seconds_per_frame
        self.onset, self.offset = onset, offset
        self.pad_onset, self.pad_offset = pad_onset, pad_offset
        self.min_on, self.min_off = min_on, min_off
        self.frame = 0
        self._raw = [False] * speakers
        self._open: list[dict | None] = [None] * speakers  # {"start", "end" (None while active), "confirmed"}

    def _start(self, run) -> float:
        return max(0.0, run["start"] * self.spf - self.pad_onset)

    def _end(self, run) -> float:
        return run["end"] * self.spf + self.pad_offset

    def settled_seconds(self) -> float:
        """Every start and end before this time has been reported. A short run
        can still merge with later speech and be reported from its own start."""
        pending = [self._start(run) for run in self._open if run is not None and not run["confirmed"]]
        return max(0.0, min([self.frame * self.spf - max(self.min_on, self.pad_onset + self.min_off)] + pending))

    def _gap_closed(self, run, frame) -> bool:
        """No speech starting at ``frame`` or later can merge with this run."""
        return (frame * self.spf - self.pad_onset) - self._end(run) >= self.min_off

    def _confirm(self, run, speaker, end, events) -> None:
        if not run["confirmed"] and end - self._start(run) >= self.min_on:
            run["confirmed"] = True
            events.append((speaker, self._start(run), True))

    def feed(self, probs: np.ndarray) -> list[tuple[int, float, bool]]:
        events = []
        for row in probs:
            for speaker, p in enumerate(row):
                run = self._open[speaker]
                if not self._raw[speaker] and p > self.onset:
                    self._raw[speaker] = True
                    if run is not None:
                        run["end"] = None  # the gap is short enough to fill, as the runtime merges it
                    else:
                        run = self._open[speaker] = {"start": self.frame, "end": None, "confirmed": False}
                elif self._raw[speaker] and p < self.offset:
                    self._raw[speaker] = False
                    run["end"] = self.frame
                if run is None:
                    continue
                # The runtime ends a run at the stream end without padding, so only
                # audio seen so far counts toward the minimum duration.
                seen = (self.frame + 1) * self.spf
                self._confirm(run, speaker, min(seen, self._end(run)) if run["end"] is not None else seen, events)
                if run["end"] is not None and self._gap_closed(run, self.frame + 1):
                    if run["confirmed"]:
                        events.append((speaker, self._end(run), False))
                    self._open[speaker] = None
            self.frame += 1
        return events

    def close(self) -> list[tuple[int, float, bool]]:
        """End every open run at the last frame."""
        events = []
        last = self.frame * self.spf
        for speaker, run in enumerate(self._open):
            if run is None:
                continue
            end = min(last, self._end(run)) if run["end"] is not None else last
            self._confirm(run, speaker, end, events)
            if run["confirmed"]:
                events.append((speaker, end, False))
            self._open[speaker] = None
        self._raw = [False] * len(self._raw)
        return events


def offline_segments(probs, spf, *, onset=0.641, offset=0.561, pad_onset=0.229, pad_offset=0.079,
                     min_on=0.511, min_off=0.296):
    """Port of NeMo-Speech.cpp diar_segments_from_probs, the batch reference."""
    out = []
    total = len(probs) * spf
    for s in range(probs.shape[1]):
        segs, active, start = [], False, 0
        for f, p in enumerate(probs[:, s]):
            if not active and p > onset:
                active, start = True, f
            elif active and p < offset:
                active = False
                segs.append([max(0.0, start * spf - pad_onset), min(total, f * spf + pad_offset)])
        if active:
            segs.append([max(0.0, start * spf - pad_onset), total])
        merged = []
        for seg in segs:
            if merged and seg[0] - merged[-1][1] < min_off:
                merged[-1][1] = max(merged[-1][1], seg[1])
            else:
                merged.append(seg)
        out.extend((round(a, 6), round(b, 6), s) for a, b in merged if b - a >= min_on)
    return sorted(out)


def causal_segments(events):
    open_at, out = {}, []
    for speaker, seconds, starting in events:
        if starting:
            assert speaker not in open_at, "a speaker started twice"
            open_at[speaker] = seconds
        else:
            out.append((round(open_at.pop(speaker), 6), round(seconds, 6), speaker))
    assert not open_at, "every start has an end"
    return sorted(out)


def speech(frames, speakers, rng):
    """Bursts, short gaps, blips and overlaps on a 10 ms grid."""
    probs = np.zeros((frames, speakers), dtype=np.float32)
    for s in range(speakers):
        f = int(rng.integers(0, 80))
        while f < frames:
            length = int(rng.choice([2, 8, 25, 60, 150]))
            probs[f:f + length, s] = rng.uniform(.62, 1.0)
            f += length + int(rng.choice([1, 5, 20, 35, 120]))
    noise = rng.uniform(-.08, .08, probs.shape).astype(np.float32)
    return np.clip(probs + noise, 0, 1)


def main():
    rng = np.random.default_rng(7)
    cases = []
    for number in range(CASES):
        frames = int(rng.integers(50, 900))
        # Rounded to 4 decimals for a small file; the events below come from the rounded
        # values as float32, exactly as the Rust test reads them.
        rows = [[round(float(p), 4) for p in row] for row in speech(frames, SPEAKERS, rng)]
        probs = np.array(rows, dtype=np.float32)
        slices, left = [], frames
        while left:
            n = min(left, int(rng.integers(1, 40)))
            slices.append(n)
            left -= n
        binarizer, events, first = LiveBinarizer(SPEAKERS, SPF), [], 0
        for n in slices:
            events += binarizer.feed(probs[first:first + n])
            first += n
        events += binarizer.close()
        assert causal_segments(events) == offline_segments(probs, SPF), f"case {number}"
        cases.append({
            "name": f"three speakers, {frames} frames, case {number + 1}",
            "speakers": SPEAKERS,
            "secondsPerFrame": SPF,
            "slices": slices,
            "events": [[int(s), float(t), bool(start)] for s, t, start in events],
            "probs": rows,
        })
    document = {
        "about": "Synthetic frame probabilities and the speaker turn events Ownkey's LiveBinarizer "
                 "reports for them, fed in the given slices. Written by "
                 "voice/scripts/binarizer-vectors.py; voice-meetings' binarizer test reads it.",
        "cases": cases,
    }
    text = json.dumps(document, separators=(",", ":"))
    # One case per line keeps diffs readable without making the file large.
    text = text.replace(',"cases":[', ',\n"cases":[\n').replace('},{"name"', '},\n{"name"')
    OUT.write_text(text + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT} with {len(cases)} cases")


if __name__ == "__main__":
    main()
