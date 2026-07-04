"""Unit tests for the routes.py lyrics+pitch merge helpers.

FastAPI is stubbed so the module imports without a server venv; the pak
fixture comes from the builder's unzipped build directory, so the test is
content-free and exercises the same files the plugin serves in production.
"""
import importlib.util
import subprocess
import sys
import types
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent

# Stub fastapi before importing routes (the module only needs the names).
fastapi = types.ModuleType("fastapi")
fastapi.FastAPI = object
responses = types.ModuleType("fastapi.responses")
responses.JSONResponse = object
fastapi.responses = responses
sys.modules.setdefault("fastapi", fastapi)
sys.modules.setdefault("fastapi.responses", responses)

_rspec = importlib.util.spec_from_file_location("vocals_routes", REPO / "routes.py")
routes = importlib.util.module_from_spec(_rspec)
_rspec.loader.exec_module(routes)

_bspec = importlib.util.spec_from_file_location(
    "build_test_pak", REPO / "tools" / "build_test_pak.py")
btp = importlib.util.module_from_spec(_bspec)
_bspec.loader.exec_module(btp)


def _ffmpeg_available() -> bool:
    try:
        subprocess.run([btp.FFMPEG, "-version"], capture_output=True, check=True)
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not available")


@pytest.fixture(scope="module")
def source_dir(tmp_path_factory):
    out = tmp_path_factory.mktemp("paks")
    saved = btp.OUT_DIR
    btp.OUT_DIR = out
    try:
        btp.build_pak(btp.VOCALS_PAK, btp.VOCALS_MANIFEST, {}, with_drums=False)
    finally:
        btp.OUT_DIR = saved
    return out / "_build" / btp.VOCALS_PAK


def _merge(source_dir):
    """Replicates the /data endpoint's merge (endpoint itself needs FastAPI)."""
    manifest = routes._read_manifest(source_dir)
    tokens = routes._lyrics_tokens(source_dir, manifest)
    pitch = routes._read_pitch_file(source_dir, manifest)
    pitch_by_t = {repr(float(n["t"])): int(n["midi"]) for n in pitch["notes"]}
    merged = []
    for tok in tokens:
        entry = {"t": tok["t"], "d": tok["d"], "w": tok["w"]}
        mid = pitch_by_t.get(repr(float(tok["t"])))
        if mid is not None:
            entry["midi"] = mid
        merged.append(entry)
    return merged


def test_merge_pairs_every_syllable(source_dir):
    merged = _merge(source_dir)
    assert len(merged) == 16
    assert all("midi" in e for e in merged)
    assert merged[0] == {"t": 2.0, "d": 0.4, "w": "Do", "midi": 60}
    assert merged[7]["w"] == "Do+" and merged[7]["midi"] == 72
    assert merged[12]["w"] == "Fa-" and merged[12]["midi"] == 65


def test_lyrics_tokens_skips_malformed(tmp_path):
    (tmp_path / "manifest.yaml").write_text("lyrics: lyrics.json\n", encoding="utf-8")
    (tmp_path / "lyrics.json").write_text(
        '[{"t": 1.0, "d": 0.5, "w": "ok"},'
        ' {"t": "bad", "d": 0.5, "w": "skip"},'
        ' {"t": 2.0, "d": 0, "w": "zero-dur"},'
        ' "not-a-dict"]',
        encoding="utf-8")
    manifest = routes._read_manifest(tmp_path)
    tokens = routes._lyrics_tokens(tmp_path, manifest)
    assert tokens == [{"t": 1.0, "d": 0.5, "w": "ok"}]


def test_missing_pitch_file_is_none(tmp_path):
    (tmp_path / "manifest.yaml").write_text("lyrics: lyrics.json\n", encoding="utf-8")
    manifest = routes._read_manifest(tmp_path)
    assert routes._read_pitch_file(tmp_path, manifest) is None
