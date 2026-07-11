"""Content-free e2e: build both test paks, check invariants, spec-validate.

Fixtures are synthesized by tools/build_test_pak.py (sine melody + drum
synthesis), so this runs anywhere ffmpeg is installed. The spec-validator
step runs when a feedpak-spec checkout is available — set FEEDPAK_SPEC_DIR,
or rely on the local sibling checkout.
"""
import importlib.util
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parent.parent
# Spec checkout for the validator step: env override, else a sibling checkout.
SPEC_DIR = Path(os.environ.get("FEEDPAK_SPEC_DIR") or REPO.parent / "feedpak-spec")

_spec = importlib.util.spec_from_file_location(
    "build_test_pak", REPO / "tools" / "build_test_pak.py")
btp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(btp)


def _ffmpeg_available() -> bool:
    try:
        subprocess.run([btp.FFMPEG, "-version"], capture_output=True, check=True)
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not available")


@pytest.fixture(scope="module")
def out_dir(tmp_path_factory):
    out = tmp_path_factory.mktemp("paks")
    saved = btp.OUT_DIR
    btp.OUT_DIR = out
    try:
        btp.build_pak(btp.VOCALS_PAK, btp.VOCALS_MANIFEST, {}, with_drums=False)
        btp.build_pak(btp.BAND_PAK, btp.BAND_MANIFEST, {
            "notation_keys.json": btp.notation(
                "piano", "G2", "Right Hand", btp.melody_events()),
            "notation_drums.json": btp.notation(
                "drums", "neutral", "Drums", btp.drum_events()),
            "drum_tab.json": btp.drum_tab(),
        }, with_drums=True)
        yield out
    finally:
        btp.OUT_DIR = saved


def _read_zip_json(pak: Path, name: str):
    with zipfile.ZipFile(pak) as zf:
        return json.loads(zf.read(name).decode("utf-8"))


def _read_zip_yaml(pak: Path, name: str):
    with zipfile.ZipFile(pak) as zf:
        return yaml.safe_load(zf.read(name).decode("utf-8"))


def test_vocals_pak_shape(out_dir):
    pak = out_dir / btp.VOCALS_PAK
    assert pak.exists()
    manifest = _read_zip_yaml(pak, "manifest.yaml")
    assert [a["id"] for a in manifest["arrangements"]] == ["vocals", "lead"]
    assert manifest["arrangements"][0].get("file") is None
    assert manifest["arrangements"][0]["notation"] == "notation_vocals.json"
    assert manifest["lyrics_source"] == "user"

    lyrics = _read_zip_json(pak, "lyrics.json")
    pitch = _read_zip_json(pak, "vocal_pitch.json")
    assert len(lyrics) == 16
    assert len(pitch["notes"]) == 16
    # Every syllable pairs with a pitch entry by exact t (the merge key).
    assert {n["t"] for n in pitch["notes"]} == {tok["t"] for tok in lyrics}
    # Suffix conventions present: one join, line-end markers.
    words = [tok["w"] for tok in lyrics]
    assert any(w.endswith("-") for w in words)
    assert sum(1 for w in words if w.endswith("+")) == 2

    lead = _read_zip_json(pak, "arrangements/lead.json")
    assert len(lead["notes"]) == 16
    assert lead["anchors"], "lead needs a fret anchor or highways zoom to 24 frets"


def test_band_pak_shape(out_dir):
    pak = out_dir / btp.BAND_PAK
    assert pak.exists()
    manifest = _read_zip_yaml(pak, "manifest.yaml")
    assert [a["id"] for a in manifest["arrangements"]] == ["vocals", "lead", "keys", "drums"]
    assert manifest["drum_tab"] == "drum_tab.json"

    for name, instrument in (("notation_vocals.json", "vocals"),
                             ("notation_keys.json", "piano"),
                             ("notation_drums.json", "drums")):
        nt = _read_zip_json(pak, name)
        assert nt["instrument"] == instrument
        assert isinstance(nt["staves"], list) and isinstance(nt["measures"], list)

    tab = _read_zip_json(pak, "drum_tab.json")
    hits = tab["hits"]
    assert hits, "drum tab must carry hits"
    kit_ids = {p["id"] for p in tab["kit"]}
    assert all(h["p"] in kit_ids for h in hits)
    assert all(b["t"] >= a["t"] for a, b in zip(hits, hits[1:])), "hits must be time-ordered"


@pytest.mark.skipif(not (SPEC_DIR / "tools" / "validate.py").exists(),
                    reason="feedpak-spec checkout not available")
def test_spec_validator_passes(out_dir):
    result = subprocess.run(
        [sys.executable, str(SPEC_DIR / "tools" / "validate.py"),
         str(out_dir / btp.VOCALS_PAK), str(out_dir / btp.BAND_PAK)],
        capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
