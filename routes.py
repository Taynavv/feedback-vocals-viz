"""Vocals Highway plugin backend.

One job: serve the merged per-syllable ``[{t, d, w, midi?}]`` token list the
ribbon renderer draws. Lyrics come from the pak's ``lyrics.json`` and pitch
from ``vocal_pitch.json`` (feedpak v1 §7.1/§7.2); they are merged server-side
so the renderer never has to match floats across the Python/JS boundary.

Provenance: the sloppak-resolution and lyrics/pitch merge logic is adapted
from feedBack-plugin-lyrics-karaoke ``routes.py`` (AGPL-3.0); this plugin is
licensed AGPL-3.0 accordingly (see LICENSE).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import yaml
from fastapi import FastAPI
from fastapi.responses import JSONResponse

_get_dlc_dir = None
SLOPPAK_CACHE_DIR: Path | None = None
log = None


def _manifest_path(source_dir: Path) -> Path:
    p = source_dir / "manifest.yaml"
    if not p.exists():
        alt = source_dir / "manifest.yml"
        if alt.exists():
            return alt
    return p


def _read_manifest(source_dir: Path) -> dict:
    """Parse the pak manifest, or ``{}`` on any read/parse problem or non-mapping
    document — so a malformed manifest degrades to a clean 404, mirroring the
    error-swallowing in ``_lyrics_tokens``/``_read_pitch_file`` rather than
    surfacing an unhandled 500."""
    mp = _manifest_path(source_dir)
    try:
        data = yaml.safe_load(mp.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _lyrics_tokens(source_dir: Path, manifest: dict) -> list[dict]:
    """Return the pak's syllable list as ``[{t, d, w}, ...]`` (empty on any problem)."""
    rel = manifest.get("lyrics")
    if not rel:
        return []
    p = source_dir / str(rel)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            t = float(item.get("t", 0.0))
            d = float(item.get("d", 0.0))
        except (TypeError, ValueError):
            continue
        w = str(item.get("w", ""))
        if d <= 0:
            continue
        out.append({"t": t, "d": d, "w": w})
    return out


def _read_pitch_file(source_dir: Path, manifest: dict) -> dict | None:
    rel = manifest.get("vocal_pitch")
    if not rel:
        return None
    p = source_dir / str(rel)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _resolve_sloppak(filename: str):
    """Resolve a pak filename to ``(source_dir, manifest)`` or ``None``.

    Zip paks are unpacked into the shared sloppak cache on first resolve, so
    the side-files are always readable as plain files afterwards.
    """
    import sloppak as sloppak_mod

    if not filename:
        return None
    dlc = _get_dlc_dir() if _get_dlc_dir else None
    if not dlc:
        return None
    # Confine resolution to the DLC dir: `filename` is an unvalidated query
    # param, so an absolute path or '../' escape would otherwise let the
    # resolver reach (and unpack) any sloppak-shaped file on disk.
    dlc_root = Path(dlc).resolve()
    dlc_path = (dlc_root / filename).resolve()
    if not dlc_path.is_relative_to(dlc_root):
        return None
    if not dlc_path.exists():
        return None
    if not sloppak_mod.is_sloppak(dlc_path):
        return None
    source_dir = sloppak_mod.resolve_source_dir(filename, dlc, SLOPPAK_CACHE_DIR)
    manifest = _read_manifest(source_dir)
    return source_dir, manifest


def setup(app: FastAPI, context: dict):
    global _get_dlc_dir, SLOPPAK_CACHE_DIR, log

    log = context["log"]
    _get_dlc_dir = context["get_dlc_dir"]
    get_cache = context.get("get_sloppak_cache_dir", lambda: None)
    SLOPPAK_CACHE_DIR = get_cache()
    if SLOPPAK_CACHE_DIR is None:
        static_dir = Path(os.environ.get("STATIC_DIR", "/app/static"))
        SLOPPAK_CACHE_DIR = static_dir / "sloppak_cache"

    @app.get("/api/plugins/vocals_highway/data")
    def vocals_highway_data(filename: str = ""):
        """Merged lyrics + vocal pitch for one song.

        Returns ``{filename, tokens: [{t, d, w, midi?}]}``. ``midi`` is present
        only on syllables that have a matching ``vocal_pitch.json`` entry
        (matched by exact ``t``, mirroring how the importer writes both files).
        404 when the song isn't a pak or carries no lyrics at all.
        """
        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse({"error": "Not a feedpak"}, 404)
        source_dir, manifest = resolved

        tokens = _lyrics_tokens(source_dir, manifest)
        if not tokens:
            return JSONResponse({"error": "No lyrics in this pak"}, 404)

        pitch_by_t: dict[str, int] = {}
        pitch = _read_pitch_file(source_dir, manifest)
        notes = pitch.get("notes") if isinstance(pitch, dict) else None
        if isinstance(notes, list):
            for n in notes:
                if isinstance(n, dict) and "t" in n and "midi" in n:
                    try:
                        pitch_by_t[repr(float(n["t"]))] = int(n["midi"])
                    except (TypeError, ValueError):
                        continue

        merged = []
        for tok in tokens:
            entry = {"t": tok["t"], "d": tok["d"], "w": tok["w"]}
            mid = pitch_by_t.get(repr(float(tok["t"])))
            if mid is not None:
                entry["midi"] = mid
            merged.append(entry)
        return {"filename": filename, "tokens": merged}
