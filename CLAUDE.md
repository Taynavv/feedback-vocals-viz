# feedback-vocals-viz — development guide

Karaoke Highway is a FeedBack **visualization plugin** (`type: "visualization"`,
plugin id `vocals_highway`): a SingStar-style pitch-ribbon highway for Vocals
arrangements with live mic pitch detection and per-syllable scoring. This file is
the map for contributors and coding agents.

## Architecture

| File | Role |
|---|---|
| [plugin.json](plugin.json) | Manifest: viz declaration, capability settings (feedBack#849), `feedback_target` advisory |
| [screen.js](screen.js) | Everything frontend: ribbon tunables → token cache/fetch → `estimateDifficulty` (pure) → lyric-line builder → mic+YIN+scoring engine (module-level singleton; + sung-pitch history, input RMS, voice metrics) → mic strip / settings popover DOM → renderer factory with **two draw modes** (`_drawSimple` / `_draw3D`) chosen by the `mode3d` setting → shortcut + `__vocalsHighwayTest` probe hook. Node-safe (guarded globals + CommonJS export) so the difficulty estimator is unit-testable. |
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
- **The mic timing offset is scoring-only, in wall-clock ms.** `prefs.micOffsetMs`
  (flyout "Mic timing", capability setting `micOffsetMs`, ±1000 ms; positive =
  attribute singing earlier) joins the capture-latency parenthesis at BOTH
  frame-stamp sites (bridge + browser), so it scales with playbackRate like every
  wall-latency term. It shifts frame attribution — and therefore the drawn trace —
  never the notes/lyrics; do NOT turn it into a visual offset (display latency is
  core's `av_offset_ms`). It exists because the singing loop (hear → sing →
  capture) carries latency the automatic terms can't see (browser input devices,
  audio *output*), and because core's A/V slider leaks into our bundle-time scoring
  clock on the main panel (the bundle exposes no panel-local chart clock; core's
  `getTime()` deliberately excludes the offset but is splitscreen-wrong).
  `_readPrefs` nudges `micLastCapturedAt` in step on a live change so a big
  backward move can't trip the −0.25 s seek-wipe mid-take.
- **No per-frame DOM queries** in `draw()` (core performance rule): layout derives
  from canvas dimensions; the mic strip is mounted once per init; the ownership
  takeover check throttles its `offsetParent` read.
- **The engine is a module-level singleton** (one physical microphone); renderer
  instances attach on init, and the last-init'd instance owns scoring unless its
  canvas leaves the DOM.
- **One look (3D), one picker entry.** Core discovers exactly one factory per plugin id
  (`app.js` `_populateVizPicker`: `window.feedBackViz_<id>`). The 3D stage is the only
  offered look — there is no `mode3d` toggle (it was removed; don't re-add a user-facing
  flat mode). `_drawSimple` is the unchanged classic ribbon, kept ONLY as the silent
  automatic fallback for a song with no pitch range: `draw()` uses `_draw3D`
  `if (this._range)`, else `_drawSimple` — not a user choice. Do not regress it.
- **3D geometry: wall + seam, not a reprojection.** `_draw3D` draws an upright note
  "wall" from the top-stats band down to a thin bright horizon seam at `seamY` (~82%);
  `_drawSeam` is just that glowing seam + a short lip fade. The old bounded-trapezoid
  floor was retired to give the wall + the left scale the full height — do not bring it
  back. Notes/trace still use the flat `xFor`/`yFor` mapping (scoring geometry stays 2D);
  the "3D" is staging only. Lyrics sit below the seam.
- **The 3D pitch axis is diatonic, not chromatic.** `yFor` maps `diaPosF(midi)` (naturals
  evenly spaced, sharps halfway) so the note wall reads like even piano rows. Do not "fix"
  the uneven-looking spacing back to raw semitones — even rows is the intent. The noteway
  range is tight (`computeDiatonicRange`, no padding) so notes fill top-to-seam (a duet
  widens it via `_sharedDiatonicRange`); its lanes are labeled with absolute note names
  (A3, B3…) since the left gauge no longer maps to them.
- **The left gauge is a FIXED chromatic octave, decoupled from the chart.** `_drawKeyRail`
  draws one octave C→B (C at the bottom), the SAME every song — a stable "what note am I on
  / how far off" tuner, NOT tied to `yFor`/the song range. Naturals are wide labeled keys,
  sharps thin keys between (none E–F or B–C). A **vertical** glow marks your exact pitch
  (via `diaPosF % 7`): tight & centered on a key = dead-on, riding up = sharp / down = flat,
  spreading + bleeding across a boundary = between two notes. The nearest-semitone key
  lights violet; a lit natural carries the octave # + ±cents. Keep the glow neutral/white
  (NOT the red/amber/green scoring signal) — "am I on this pitch" is a separate axis from
  "is it the right note." `PLAYHEAD_FRAC_3D` (0.30) is 3D-only — the simple fallback keeps
  `PLAYHEAD_FRAC` (0.18). The left bar is selectable (`prefs.leftPanel` ← the flyout "Left
  bar" picker): `scale` (this gauge), `voice` (`_drawVoicePanel`), or `off` (hidden — `railW`
  collapses so the highway spans nearly full width; the absolute lane labels stay).
- **Duet guides read as secondary — by design.** In both modes the non-scored voices
  draw as dim, color-coded guide bars (`VOICE_COLORS`) so you can see the other part;
  only the *selected* voice (`_scoredIdx`, chosen via the "Voice" picker → `_preferredVoiceId`)
  is scored and gets the lit/tinted treatment. 3D shares one diatonic axis across all
  voices (`_sharedDiatonicRange`) so the parts stay on-lane; solo is unchanged (shared ==
  scored). The 3D guides are deliberately flat, thin (`barH*0.4`), cool-colored, and drawn
  *behind* the lit, glowing scored slabs — do not promote them to lit/glossy notes or a scored
  treatment; they are reference, not targets. (True *simultaneous* two-part scoring needs
  multi-input/remote — an unbuilt seam; see the `_voices` comment.)
- **Voice metrics are honest by contract.** Stability (short-window pitch variance) and a
  coarse zero-crossing Vibrato estimate are computed by `updateVoiceMetrics` and drawn by
  `_drawVoicePanel` — the **`voice`** option of the left bar (a Stability fill bar + Vibrato
  rate). Kept honest: no value unless the sample is fresh, vibrato only when actually present
  (gated on `VIBRATO_MIN_CENTS`), no false precision, and NO breath support or technique
  "tips" (not measurable from a mono mic). Cool colors, deliberately NOT the red/amber/green
  accuracy scale — this axis is expression, not correctness. The old right-panel methods
  (`_drawStatsPanel`/`_drawRing`/`_drawCentsGauge`/`_drawHeaders`/`_drawSessionPill`) and
  `_drawCurrentNoteLeft` are superseded — retained but unused; prune when convenient.
- **Karaoke bouncing ball + gap countdown.** `_drawLyricBall` rides a ball UNDER the lyric
  line (words stay legible): it hops once per syllable while a line is sung — tracking the
  active-syllable x/phase that `_drawLyricLine3D` now returns — and during a silent lead-in
  (≥1.5s before a line) it bounces under a get-ready countdown at the line's front, at the
  line's median syllable tempo (`_lineBeat`). The preview line sits lower (`fontPx*1.4`) to
  leave room; don't move the ball back on top of the words.
- **Difficulty is a heuristic, not metadata — computed but not currently drawn.**
  `estimateDifficulty` derives an Easy→Expert band from range/pace/leaps/tessitura
  (weights in `DIFF_WEIGHTS`) and is kept on `inst._difficulty`; the feedpak format
  carries no vocals-difficulty field. The "Est." badge was dropped in the UI trim
  (`_drawDifficultyBadge` retained but unused); if re-added, keep the "Est." qualifier.
- **`screen.js` must stay Node-safe.** Every top-level `window`/`navigator` access is
  `typeof`-guarded and the pure helpers are exported via `module.exports`, so
  `require('./screen.js')` works for `node --test`. `node --check` will not catch an
  unguarded top-level browser global — it only fails the require.

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
node --test tests/difficulty.test.js         # difficulty estimator unit tests
python tools/build_test_pak.py --validate    # build + spec-validate test paks
```

The validator resolves a feedpak-spec checkout from `FEEDPAK_SPEC_DIR`, else a sibling
`../feedpak-spec` checkout (CI pins v1.14.0).
For manual testing: install the plugin into a FeedBack user-plugins directory, drop a
generated test pak into the song library, play the Vocals arrangement with the picker
on Auto. `window.__vocalsHighwayTest.getState()` exposes live engine state, and the
mic path can be exercised headlessly with Chromium fake-media flags plus a CDP
microphone permission grant.
