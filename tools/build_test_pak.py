#!/usr/bin/env python3
"""Build the hand-authored, content-free test feedpaks.

Two packages, both spec-validated:

- test-output/vocals_scale_test.feedpak — the everyday fixture: notation-only
  Vocals arrangement + guitar Lead, per-syllable lyrics + vocal pitch, and a
  sine-tone melody stem (so mic scoring can be exercised by playing the song
  audio at the microphone).
- test-output/band_scale_test.feedpak — the 4-panel splitscreen fixture:
  everything above plus notation-only Keys and Drums arrangements, a song-level
  drum_tab.json, and kick/snare synthesized into the stem. NOTE: carrying a
  drum tab makes the bundled 3D Drum Highway's Auto predicate (bare
  has_drum_tab, name-sorted first) claim EVERY arrangement — pick each panel's
  viz manually in this pak.

Usage:
    python tools/build_test_pak.py [--validate]

--validate runs the feedpak-spec reference validator on the results
(FEEDPAK_SPEC env var overrides the default spec repo location).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import shutil
import struct
import subprocess
import sys
import wave
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "test-output"
VOCALS_PAK = "vocals_scale_test.feedpak"
BAND_PAK = "band_scale_test.feedpak"
DUET_PAK = "duet_scale_test.feedpak"
# Spec checkout for --validate: env override, else a sibling checkout next to
# this repo (the layout CI and the docs assume). ffmpeg comes from $FFMPEG or
# PATH.
SPEC_REPO = Path(os.environ.get("FEEDPAK_SPEC_DIR")
                 or os.environ.get("FEEDPAK_SPEC")
                 or REPO_ROOT.parent / "feedpak-spec")
FFMPEG = os.environ.get("FFMPEG") or "ffmpeg"

SAMPLE_RATE = 44100
BPM = 120.0
BEAT = 60.0 / BPM          # 0.5 s quarter note
NOTE_D = 0.4               # sung duration inside each half-second slot
DURATION = 14.0

# Two solfège lines, one note per quarter beat. "Fa-"+"mi" exercises the
# §7.1 join suffix; each line ends with the '+' line-break suffix.
LINE1_START = 2.0
LINE2_START = 8.0
LINE1 = [("Do", 60), ("Re", 62), ("Mi", 64), ("Fa", 65),
         ("Sol", 67), ("La", 69), ("Ti", 71), ("Do+", 72)]
LINE2 = [("Do", 72), ("Ti", 71), ("La", 69), ("Sol", 67),
         ("Fa-", 65), ("mi", 64), ("Re", 62), ("Do+", 60)]


def tokens():
    out = []
    for start, line in ((LINE1_START, LINE1), (LINE2_START, LINE2)):
        for i, (w, midi) in enumerate(line):
            out.append({"t": round(start + i * BEAT, 3), "d": NOTE_D, "w": w, "midi": midi})
    return out


def tokens_p2():
    """Second duet voice: same rhythm, a perfect fourth below, sung on 'Ah' — a
    distinct melody + lyric so multi-voice routing is unambiguous in tests."""
    return [{"t": tok["t"], "d": tok["d"], "w": "Ah", "midi": tok["midi"] - 5}
            for tok in tokens()]


def midi_to_hz(midi: int) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


# Guitar mapping of the same melody (standard tuning, string 0 = low E),
# so the pak carries a real second arrangement for splitscreen testing
# (guitar highway panel + vocals ribbon panel on one song).
MIDI_TO_GUITAR = {
    60: (4, 1), 62: (4, 3), 64: (5, 0), 65: (5, 1),
    67: (5, 3), 69: (5, 5), 71: (5, 7), 72: (5, 8),
}


def lead_arrangement() -> dict:
    notes = []
    for tok in tokens():
        s, f = MIDI_TO_GUITAR[tok["midi"]]
        notes.append({"t": tok["t"], "s": s, "f": f, "sus": round(tok["d"] - 0.1, 3)})
    return {
        "name": "Lead",
        "tuning": [0, 0, 0, 0, 0, 0],
        "capo": 0,
        "notes": notes,
        "chords": [],
        # Anchors drive the highway's fret-window zoom; without one the
        # renderer spreads all 24 frets across the screen and the low-fret
        # melody renders as specks (observed live in the 3D highway).
        "anchors": [{"time": 0.0, "fret": 1, "width": 8}],
        "handshapes": [],
        "templates": [],
    }


# ── Drums (band pak) ────────────────────────────────────────────────────────
# Rock backbeat, measures 2 through 6 (t = 2.0 .. 11.75): kick on beats 1+3,
# snare on 2+4, closed hats on eighths.

def drum_hits():
    hits = []
    t = LINE1_START
    while t < 12.0 - 1e-9:
        rel = round((t - LINE1_START) % 2.0, 3)
        if rel in (0.0, 1.0):
            hits.append({"t": round(t, 3), "p": "kick", "v": 110})
        if rel in (0.5, 1.5):
            hits.append({"t": round(t, 3), "p": "snare", "v": 100})
        hits.append({"t": round(t, 3), "p": "hh_closed", "v": 70})
        t += 0.25
    hits.sort(key=lambda h: h["t"])
    return hits


def drum_tab() -> dict:
    return {
        "version": 1,
        "name": "Drums",
        "kit": [
            {"id": "kick", "name": "Kick"},
            {"id": "snare", "name": "Snare"},
            {"id": "hh_closed", "name": "Hi-hat (closed)"},
        ],
        "hits": drum_hits(),
    }


# ── Notation builders (spec §7.6) ───────────────────────────────────────────

def notation(instrument: str, clef: str, staff_label: str, events) -> dict:
    """Minimal §7.6 notation from [{t, midi, dur}] events, one staff.

    Core only needs this to pass lib/notation.py validation so has_notation
    flips true for the arrangement; renderers that really consume notation
    (keys highway) flatten measures back to timed notes.
    """
    measures = []
    measure_len = 4 * BEAT
    n_measures = math.ceil(DURATION / measure_len)
    for idx in range(1, n_measures + 1):
        t = round((idx - 1) * measure_len, 3)
        beats = [
            {"t": ev["t"], "dur": ev.get("dur", 4), "notes": [{"midi": ev["midi"]}]}
            for ev in events
            if t <= ev["t"] < t + measure_len
        ]
        if not beats:
            beats = [{"t": t, "dur": 1, "rest": True}]
        m = {"idx": idx, "t": t, "staves": {"s1": {"voices": [{"v": 1, "beats": beats}]}}}
        if idx == 1:
            m["ts"] = [4, 4]
            m["ks"] = 0
            m["tempo"] = BPM
        measures.append(m)
    return {
        "version": 1,
        "instrument": instrument,
        "staves": [{"id": "s1", "clef": clef, "label": staff_label}],
        "measures": measures,
    }


def melody_events():
    return [{"t": tok["t"], "midi": tok["midi"], "dur": 4} for tok in tokens()]


def drum_events():
    # GM percussion numbers for the notation mirror (kick 35, snare 38);
    # hats omitted to keep the neutral staff readable.
    gm = {"kick": 35, "snare": 38}
    return [{"t": h["t"], "midi": gm[h["p"]], "dur": 8}
            for h in drum_hits() if h["p"] in gm]


# ── Audio ───────────────────────────────────────────────────────────────────

def write_wav(path: Path, with_drums: bool) -> None:
    n_samples = int(DURATION * SAMPLE_RATE)
    samples = [0.0] * n_samples
    fade = int(0.012 * SAMPLE_RATE)  # 12 ms attack/release, no clicks
    for tok in tokens():
        hz = midi_to_hz(tok["midi"])
        i0 = int(tok["t"] * SAMPLE_RATE)
        i1 = min(n_samples, int((tok["t"] + tok["d"]) * SAMPLE_RATE))
        length = i1 - i0
        for i in range(length):
            env = min(1.0, i / fade, (length - i) / fade)
            samples[i0 + i] += 0.35 * env * math.sin(2 * math.pi * hz * i / SAMPLE_RATE)
    if with_drums:
        rng = random.Random(1234)  # deterministic builds
        for hit in drum_hits():
            i0 = int(hit["t"] * SAMPLE_RATE)
            if hit["p"] == "kick":
                length = int(0.12 * SAMPLE_RATE)
                for i in range(min(length, n_samples - i0)):
                    env = math.exp(-i / (0.03 * SAMPLE_RATE))
                    samples[i0 + i] += 0.5 * env * math.sin(2 * math.pi * 55 * i / SAMPLE_RATE)
            elif hit["p"] == "snare":
                length = int(0.08 * SAMPLE_RATE)
                for i in range(min(length, n_samples - i0)):
                    env = math.exp(-i / (0.02 * SAMPLE_RATE))
                    samples[i0 + i] += 0.25 * env * (rng.random() * 2 - 1)
            else:  # hi-hat tick
                length = int(0.02 * SAMPLE_RATE)
                for i in range(min(length, n_samples - i0)):
                    env = math.exp(-i / (0.005 * SAMPLE_RATE))
                    samples[i0 + i] += 0.08 * env * (rng.random() * 2 - 1)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(b"".join(
            struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in samples))


# ── Manifests ───────────────────────────────────────────────────────────────

COMMON_TAIL = """stems:
  - id: full
    file: stems/full.ogg
    default: true
lyrics: lyrics.json
# 'user' is the one lyrics_source value both the spec (authored|transcribed|user)
# and current FeedBack core (notechart|user|xml|whisperx) accept.
lyrics_source: user
vocal_pitch: vocal_pitch.json
"""

VOCALS_MANIFEST = f"""feedpak_version: "1.14.0"
title: "Vocals Scale Test"
artist: "vocals-viz fixtures"
duration: {DURATION}
language: en
arrangements:
  - id: vocals
    name: Vocals
    type: vocals
    notation: notation_vocals.json
  - id: lead
    name: Lead
    type: guitar
    file: arrangements/lead.json
    tuning: [0, 0, 0, 0, 0, 0]
    capo: 0
{COMMON_TAIL}"""

BAND_MANIFEST = f"""feedpak_version: "1.14.0"
title: "Band Scale Test"
artist: "vocals-viz fixtures"
duration: {DURATION}
language: en
arrangements:
  - id: vocals
    name: Vocals
    type: vocals
    notation: notation_vocals.json
  - id: lead
    name: Lead
    type: guitar
    file: arrangements/lead.json
    tuning: [0, 0, 0, 0, 0, 0]
    capo: 0
  - id: keys
    name: Keys
    type: piano
    notation: notation_keys.json
  - id: drums
    name: Drums
    type: drums
    notation: notation_drums.json
{COMMON_TAIL}drum_tab: drum_tab.json
"""

DUET_MANIFEST = f"""feedpak_version: "1.14.0"
title: "Duet Scale Test"
artist: "vocals-viz fixtures"
duration: {DURATION}
language: en
arrangements:
  - id: vocals
    name: Vocals
    type: vocals
    notation: notation_vocals.json
  - id: lead
    name: Lead
    type: guitar
    file: arrangements/lead.json
    tuning: [0, 0, 0, 0, 0, 0]
    capo: 0
{COMMON_TAIL}vocal_tracks:
  - id: p1
    name: Soprano
    primary: true
    lyrics: lyrics.json
    vocal_pitch: vocal_pitch.json
  - id: p2
    name: Alto
    lyrics: lyrics_p2.json
    vocal_pitch: vocal_pitch_p2.json
"""


# ── Assembly ────────────────────────────────────────────────────────────────

def build_pak(pak_name: str, manifest: str, extra_files: dict, with_drums: bool) -> Path:
    build = OUT_DIR / "_build" / pak_name
    if build.exists():
        shutil.rmtree(build)
    (build / "stems").mkdir(parents=True)
    (build / "arrangements").mkdir()

    (build / "manifest.yaml").write_text(manifest, encoding="utf-8")
    (build / "arrangements" / "lead.json").write_text(
        json.dumps(lead_arrangement(), indent=1), encoding="utf-8")
    (build / "lyrics.json").write_text(json.dumps(
        [{"t": tok["t"], "d": tok["d"], "w": tok["w"]} for tok in tokens()],
        indent=1), encoding="utf-8")
    (build / "vocal_pitch.json").write_text(json.dumps(
        {"version": 1,
         "notes": [{"t": tok["t"], "d": tok["d"], "midi": tok["midi"]} for tok in tokens()]},
        indent=1), encoding="utf-8")
    (build / "notation_vocals.json").write_text(
        json.dumps(notation("vocals", "G2", "Vocals", melody_events()), indent=1),
        encoding="utf-8")
    for rel, payload in extra_files.items():
        (build / rel).write_text(json.dumps(payload, indent=1), encoding="utf-8")

    wav = OUT_DIR / "_build" / f"{pak_name}.wav"
    write_wav(wav, with_drums=with_drums)
    subprocess.run(
        [FFMPEG, "-y", "-loglevel", "error", "-i", str(wav),
         "-c:a", "libvorbis", "-qscale:a", "3", str(build / "stems" / "full.ogg")],
        check=True)
    wav.unlink()

    pak = OUT_DIR / pak_name
    if pak.exists():
        pak.unlink()
    with zipfile.ZipFile(pak, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(build.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(build))
    print(f"built {pak}")
    return pak


def build_duet_pak() -> Path:
    """Duet fixture: P1 (solfège) as the primary voice + P2 (a fourth below, on
    'Ah') via the importer's vocal_tracks extension, so the multi-voice route and
    the N-lane reader have a real two-voice pak to exercise."""
    return build_pak(DUET_PAK, DUET_MANIFEST, {
        "lyrics_p2.json": [
            {"t": t["t"], "d": t["d"], "w": t["w"]} for t in tokens_p2()],
        "vocal_pitch_p2.json": {"version": 1, "notes": [
            {"t": t["t"], "d": t["d"], "midi": t["midi"]} for t in tokens_p2()]},
    }, with_drums=False)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", action="store_true",
                    help="run the feedpak-spec reference validator on the results")
    args = ap.parse_args()

    paks = [
        build_pak(VOCALS_PAK, VOCALS_MANIFEST, {}, with_drums=False),
        build_pak(BAND_PAK, BAND_MANIFEST, {
            "notation_keys.json": notation("piano", "G2", "Right Hand", melody_events()),
            "notation_drums.json": notation("drums", "neutral", "Drums", drum_events()),
            "drum_tab.json": drum_tab(),
        }, with_drums=True),
        build_duet_pak(),
    ]

    if args.validate:
        validator = SPEC_REPO / "tools" / "validate.py"
        if not validator.exists():
            print(f"validator not found at {validator}", file=sys.stderr)
            return 1
        return subprocess.run(
            [sys.executable, str(validator)] + [str(p) for p in paks]).returncode
    return 0


if __name__ == "__main__":
    sys.exit(main())
