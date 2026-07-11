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


def _lyrics_tokens_rel(source_dir: Path, rel) -> list[dict]:
    """Syllable list ``[{t, d, w}, ...]`` from a lyrics.json relpath (empty on any problem)."""
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


def _lyrics_tokens(source_dir: Path, manifest: dict) -> list[dict]:
    """The primary lyrics track (manifest ``lyrics`` key). Retained for the routes test."""
    return _lyrics_tokens_rel(source_dir, manifest.get("lyrics"))


def _read_pitch_rel(source_dir: Path, rel) -> dict | None:
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


def _read_pitch_file(source_dir: Path, manifest: dict) -> dict | None:
    """The primary vocal_pitch file (manifest ``vocal_pitch`` key). Retained for the routes test."""
    return _read_pitch_rel(source_dir, manifest.get("vocal_pitch"))


def _merge_voice_tokens(source_dir: Path, lyrics_rel, pitch_rel) -> list[dict]:
    """Merge one voice's lyrics + vocal_pitch into ``[{t, d, w, midi?}]`` by exact ``t``.

    Mirrors how the importer writes both files (shared onset ``t``); a pitch note
    whose ``t`` matches no syllable is simply not attached, so a melisma-rich
    per-note stream rides along harmlessly (see the importer's
    docs/vocal-tracks.md §4.2)."""
    tokens = _lyrics_tokens_rel(source_dir, lyrics_rel)
    pitch = _read_pitch_rel(source_dir, pitch_rel)
    notes = pitch.get("notes") if isinstance(pitch, dict) else None
    pitch_by_t: dict[str, int] = {}
    if isinstance(notes, list):
        for n in notes:
            if isinstance(n, dict) and "t" in n and "midi" in n:
                try:
                    pitch_by_t[repr(float(n["t"]))] = int(n["midi"])
                except (TypeError, ValueError):
                    continue
    merged: list[dict] = []
    for tok in tokens:
        entry = {"t": tok["t"], "d": tok["d"], "w": tok["w"]}
        mid = pitch_by_t.get(repr(float(tok["t"])))
        if mid is not None:
            entry["midi"] = mid
        merged.append(entry)
    return merged


def _build_voices(source_dir: Path, manifest: dict) -> list[dict]:
    """Per-voice token streams: ``[{id, name, primary, tokens}]``.

    Reads the importer's ``vocal_tracks`` extension (one entry per singer); falls
    back to the singular ``lyrics``/``vocal_pitch`` keys as one primary voice for
    solo paks and any Reader predating the extension. Exactly one voice is primary
    (first flagged, else the first)."""
    voices: list[dict] = []
    vt = manifest.get("vocal_tracks")
    if isinstance(vt, list) and vt:
        for entry in vt:
            if not isinstance(entry, dict):
                continue
            tokens = _merge_voice_tokens(
                source_dir, entry.get("lyrics"), entry.get("vocal_pitch"))
            if not tokens:
                continue
            name = entry.get("name")
            voices.append({
                "id": str(entry.get("id") or f"v{len(voices) + 1}"),
                "name": name if isinstance(name, str) and name else None,
                "primary": bool(entry.get("primary")),
                "tokens": tokens,
            })
    if not voices:
        tokens = _merge_voice_tokens(
            source_dir, manifest.get("lyrics"), manifest.get("vocal_pitch"))
        if tokens:
            voices.append({"id": "vocals", "name": None, "primary": True, "tokens": tokens})
    primary_seen = False
    for v in voices:
        if v["primary"] and not primary_seen:
            primary_seen = True
        elif v["primary"]:
            v["primary"] = False
    if voices and not primary_seen:
        voices[0]["primary"] = True
    return voices


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
        """Merged per-voice lyrics + vocal pitch for one song.

        Returns ``{filename, tokens, voices}``. ``voices`` is one entry per singer
        — ``[{id, name, primary, tokens: [{t, d, w, midi?}]}]`` from the importer's
        ``vocal_tracks`` extension — and ``tokens`` mirrors the primary voice for
        Readers predating multi-voice. ``midi`` rides on syllables whose exact ``t``
        matches a ``vocal_pitch`` note. A solo pak returns one primary voice. 404
        when the song isn't a pak or carries no lyrics at all.
        """
        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse({"error": "Not a feedpak"}, 404)
        source_dir, manifest = resolved

        voices = _build_voices(source_dir, manifest)
        if not voices:
            return JSONResponse({"error": "No lyrics in this pak"}, 404)
        primary = next((v for v in voices if v["primary"]), voices[0])
        return {"filename": filename, "tokens": primary["tokens"], "voices": voices}
