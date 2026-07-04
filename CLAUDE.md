# feedback-vocals-viz — development guide

Karaoke Highway is a FeedBack **visualization plugin** (`type: "visualization"`,
plugin id `vocals_highway`): a SingStar-style pitch-ribbon highway for Vocals
arrangements with live mic pitch detection and per-syllable scoring. This file is
the map for contributors and coding agents.

## Architecture

| File | Role |
|---|---|
| [plugin.json](plugin.json) | Manifest: viz declaration, capability settings (feedBack#849), `feedback_target` advisory |
| [screen.js](screen.js) | Everything frontend, in sections: ribbon tunables → token cache/fetch → lyric-line builder → mic+YIN+scoring engine (module-level singleton) → mic strip / settings popover DOM → renderer factory (`window.feedBackViz_vocals_highway`) → shortcut + `__vocalsHighwayTest` probe hook |
| [routes.py](routes.py) | One endpoint: `GET /api/plugins/vocals_highway/data?filename=` — merges the pak's `lyrics.json` + `vocal_pitch.json` into per-syllable `[{t,d,w,midi?}]` tokens server-side |
| [tools/build_test_pak.py](tools/build_test_pak.py) | Synthesizes the content-free test paks (solfège scale; vocals+lead, and a 4-instrument band variant) |
| [tests/](tests) | pytest: pak invariants + spec validation, routes merge helpers (FastAPI stubbed) |

Core contracts consumed (documented in FeedBack core's own CLAUDE.md): the
`setRenderer` factory lifecycle (fresh instance per call; init/draw/destroy cycles
repeat on the same instance), `matchesArrangement` Auto predicate, plugin backend
routes (`setup(app, context)`), the per-instance settings host
(`applySetting`/`getSetting`), and `window.feedBack` events
(`song:ended`, `highway:visibility`).

## Load-bearing subtleties — do not "clean up" casually

- **The display name "Karaoke Highway" is functional.** The viz picker sorts by
  plugin display name and Auto takes the first matching entry; this name sorts before
  "Keys Highway 3D", whose predicate also matches vocals paks (bare `has_notation`).
  Renaming can silently hand vocals songs to the keys highway.
- **`songInfo.filename` is null on the wire.** The renderer resolves the pak filename
  by parsing `bundle.songInfo.audio_url` (per-panel correct under splitscreen), falling
  back to `window.feedBack.currentSong`.
- **Scoring clock is panel-local.** Mic frames are timestamped against the active
  renderer instance's last drawn `bundle.currentTime` (wall-extrapolated, capped), NOT
  `window.highway.getTime()` — splitscreen panels have independent clocks. A hidden
  panel's frozen clock makes the stall-gate drop frames, which is intended.
- **Seek-back detection tolerates micro-backsteps.** The highway clock's AV-drift
  resync steps backward a few ms mid-song; only jumps beyond −0.25 s reset scoring.
- **No per-frame DOM queries** in `draw()` (core performance rule): layout derives
  from canvas dimensions; the mic strip is mounted once per init; the ownership
  takeover check throttles its `offsetParent` read.
- **The engine is a module-level singleton** (one physical microphone); renderer
  instances attach on init, and the last-init'd instance owns scoring unless its
  canvas leaves the DOM.

## Rules

- **License**: AGPL-3.0. The YIN/mic/ribbon engine is adapted from the AGPL-3.0
  `feedBack-plugin-lyrics-karaoke` plugin — keep the provenance comments on adapted
  code, and keep every contribution AGPL-compatible.
- **Renderer, not overlay**: this plugin replaces the highway via the setRenderer
  contract. The separate lyrics-karaoke *overlay* serves guitarists who sing along —
  do not absorb or break it.
- **Tests stay content-free**: fixtures are synthesized; never commit song content
  (`test-output/` and audio formats are gitignored).
- **Works against unmodified core**: no patches to FeedBack; quirks get worked around
  plugin-side and documented.

## Commands

```
pytest tests/ -v                             # full suite (needs ffmpeg on PATH)
node --check screen.js                       # syntax gate
python tools/build_test_pak.py --validate    # build + spec-validate test paks
```

The validator resolves a feedpak-spec checkout from `FEEDPAK_SPEC_DIR`, else a sibling
`../feedpak-spec` checkout (CI pins v1.14.0).
For manual testing: install the plugin into a FeedBack user-plugins directory, drop a
generated test pak into the song library, play the Vocals arrangement with the picker
on Auto. `window.__vocalsHighwayTest.getState()` exposes live engine state, and the
mic path can be exercised headlessly with Chromium fake-media flags plus a CDP
microphone permission grant.
