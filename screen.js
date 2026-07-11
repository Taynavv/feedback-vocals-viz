/* Karaoke Highway — SingStar-style pitch-ribbon renderer for Vocals arrangements.
 *
 * setRenderer visualization plugin (feedBack#36 contract): the factory on
 * window.feedBackViz_vocals_highway returns a fresh renderer instance per
 * call ({contextType, init, draw, destroy}), and Auto mode selects it via
 * the static matchesArrangement predicate.
 *
 * ONE look, with a silent fallback (no user mode toggle):
 *   - The 3D stage (the only offered look): an upright violet note "wall" over
 *     a thin horizon seam (the receding floor was retired for vertical space),
 *     a FULL-HEIGHT diatonic pitch scale on the left whose nearest key lights
 *     up as a live tuner (center-out white glow by how in-tune you are, ±cents
 *     in the corner), a scrolling sung-pitch trace, top score/streak/accuracy,
 *     dim guide bars for a duet's other parts, and karaoke lyrics.
 *   - `_drawSimple`: the classic flat ribbon, kept ONLY as the silent automatic
 *     fallback for a lyrics-only song with no pitch range (`draw()` uses it when
 *     `this._range` is absent) — not a user choice.
 * FeedBack discovers exactly one factory per plugin id (app.js
 * _populateVizPicker: `feedBackViz_<id>`), one renderer, not separate entries.
 *
 * Provenance: ribbon geometry, pitch-range logic, palette, and the mic/YIN/
 * scoring engine are adapted from feedBack-plugin-lyrics-karaoke screen.js
 * (AGPL-3.0), promoted from a 140px overlay strip to the full highway
 * surface; this plugin is licensed AGPL-3.0 accordingly (see LICENSE).
 *
 * Node-safety: every top-level window/navigator access is guarded so the file
 * can be `require`d in Node (it exports its pure helpers via module.exports at
 * the end) to unit-test the difficulty estimator without a browser.
 */
(function () {
    'use strict';

    // ── Ribbon tunables (adapted from lyrics-karaoke, rescaled) ──────────
    const VISIBLE_SECONDS = 6.0;   // horizontal time window
    const PLAYHEAD_FRAC = 0.18;    // playhead at 18% from the left edge (simple mode)
    const PLAYHEAD_FRAC_3D = 0.30; // 3D mode: further right, more "you sang" history room
    const MIN_PITCH_SPAN = 7;      // never flatten the lane range below a 5th
    const RANGE_PAD = 1.5;         // semitones of headroom past the percentile range

    const COL_BG = '#0b0b12';
    const COL_LANE = 'rgba(255,255,255,0.05)';
    const COL_BAR_DIM = 'rgba(120, 80, 230, 0.55)';
    const COL_BAR_FILL = '#e8c040';
    const COL_BAR_ACTIVE = '#ffe080';
    const COL_TEXT = '#f4f4ff';
    const COL_TEXT_PAST = 'rgba(160,170,200,0.9)';
    const COL_PLAYHEAD = 'rgba(255,255,255,0.85)';
    const COL_STATUS = 'rgba(200,205,225,0.8)';
    const COL_TRACE = '#22d3ee';

    // 3D-mode stats / gauges palette
    const COL_PANEL_BG = 'rgba(16,18,28,0.82)';
    const COL_PANEL_BORDER = 'rgba(150,160,200,0.22)';
    const COL_LABEL = 'rgba(200,205,225,0.62)';
    const COL_GREEN = '#34d399';
    const COL_AMBER = '#e8c040';
    const COL_RED = '#f87171';
    const COL_RAIL = 'rgba(200,205,225,0.55)';

    // Violet note ramp — the 3D-mode "lit slab" look. Deliberately NOT in the
    // red/amber/green accuracy family (COL_GREEN/COL_AMBER/COL_RED) nor the cool
    // teal/pink/lime duet guides — a distinct hue that pops on the navy wall.
    const COL_NOTE_TOP = '#f0e7ff';    // light lavender — active gradient top / key stroke
    const COL_NOTE_MID = '#c084fc';    // bright violet — past gradient top + the glow
    const COL_NOTE_DEEP = '#7c3aed';   // vivid violet — active gradient bottom / key fill
    const COL_NOTE_LOW = '#5b21b6';    // deep violet — past gradient bottom

    // 3D perspective floor — a subtle receding stage grid behind the ribbon
    // that gives the "3D" read without reprojecting the notes (which would put
    // the sung-trace, cents, and hit-mapping at risk for no functional gain).
    const FLOOR_VP_Y_FRAC = 0.30;

    // ── Difficulty estimate tunables (3D-mode readout) ───────────────────
    // A heuristic over the pitched tokens: the feedpak format has no vocals
    // difficulty field, so this is derived from the melody's range, pace, leap
    // content, and tessitura. Weights sum to 1 and live in one block.
    const DIFF_WEIGHTS = { range: 0.30, pace: 0.28, leaps: 0.24, tessitura: 0.18 };

    // ── Shared token cache (read-only data; safe across instances) ───────
    const _tokenCache = new Map();
    const _TOKEN_CACHE_CAP = 8;

    function _cacheTokens(filename, tokens) {
        if (_tokenCache.size >= _TOKEN_CACHE_CAP && !_tokenCache.has(filename)) {
            const oldest = _tokenCache.keys().next().value;
            _tokenCache.delete(oldest);
        }
        _tokenCache.set(filename, tokens);
    }

    // Fetch the per-voice token streams for one song. Returns a normalized
    // voices array [{id, name, primary, tokens}]; an older server (tokens only,
    // no `voices`) collapses to a single primary voice so nothing regresses.
    async function _fetchData(filename) {
        const url = '/api/plugins/vocals_highway/data?filename=' + encodeURIComponent(filename);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('vocals_highway data: HTTP ' + resp.status);
        const data = await resp.json();
        const rawVoices = data && Array.isArray(data.voices) ? data.voices : null;
        const rawTokens = data && Array.isArray(data.tokens) ? data.tokens : null;
        if (!rawVoices && !rawTokens) throw new Error('vocals_highway data: malformed payload');
        let voices = rawVoices
            ? rawVoices.map((v, i) => ({
                id: String((v && v.id) || ('v' + (i + 1))),
                name: (v && typeof v.name === 'string' && v.name) ? v.name : null,
                primary: !!(v && v.primary),
                tokens: (v && Array.isArray(v.tokens)) ? v.tokens : [],
            })).filter((v) => v.tokens.length)
            : [];
        if (!voices.length) voices = [{ id: 'vocals', name: null, primary: true, tokens: rawTokens || [] }];
        if (!voices.some((v) => v.primary)) voices[0].primary = true;
        return voices;
    }

    // 5th–95th percentile of pitched tokens, widened to at least
    // MIN_PITCH_SPAN and padded so bars never hug the ribbon edges.
    function computePitchRange(tokens) {
        const midis = [];
        for (const tok of tokens) {
            if (typeof tok.midi === 'number') midis.push(tok.midi);
        }
        if (!midis.length) return null;
        midis.sort((a, b) => a - b);
        const pct = (f) => midis[Math.max(0, Math.min(midis.length - 1, Math.floor(f * (midis.length - 1))))];
        let lo = pct(0.05);
        let hi = pct(0.95);
        if (hi - lo < MIN_PITCH_SPAN) {
            const c = (hi + lo) / 2;
            lo = c - MIN_PITCH_SPAN / 2;
            hi = c + MIN_PITCH_SPAN / 2;
        }
        return { lo: lo - RANGE_PAD, hi: hi + RANGE_PAD };
    }

    // ── Derived difficulty (pure; unit-tested in Node) ───────────────────
    // Returns {score 0..1, band, factors 0..1, detail} or null if the melody
    // carries fewer than two pitched notes. See DIFF_WEIGHTS above.
    function estimateDifficulty(tokens) {
        if (!Array.isArray(tokens)) return null;
        const pitched = tokens.filter((t) => t && typeof t.midi === 'number');
        if (pitched.length < 2) return null;

        const midis = pitched.map((t) => t.midi);
        let lo = midis[0], hi = midis[0];
        for (const m of midis) { if (m < lo) lo = m; if (m > hi) hi = m; }
        const rangeSemi = hi - lo;

        // Pace: pitched notes per second across the sung span.
        const first = pitched[0];
        const last = pitched[pitched.length - 1];
        const span = Math.max(0.5, (last.t + (last.d || 0)) - first.t);
        const pace = pitched.length / span;

        // Leaps: mean absolute interval between consecutive notes, plus how
        // often the motion is a leap (> 2 semitones) rather than a step.
        let intervalSum = 0, leaps = 0;
        for (let i = 1; i < pitched.length; i++) {
            const d = Math.abs(pitched[i].midi - pitched[i - 1].midi);
            intervalSum += d;
            if (d > 2) leaps++;
        }
        const meanInterval = intervalSum / (pitched.length - 1);
        const leapRate = leaps / (pitched.length - 1);

        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        const norm = (v, a, b) => clamp01((v - a) / (b - a));
        const factors = {
            range: norm(rangeSemi, 5, 24),      // 5 st → 0, ≥2 octaves → 1
            pace: norm(pace, 1, 5),             // 1/s → 0, ≥5/s → 1
            leaps: clamp01(0.6 * norm(meanInterval, 1, 7) + 0.4 * leapRate),
            tessitura: norm(hi, 60, 79),        // top note: C4 → 0, ~G5 → 1
        };
        const score = DIFF_WEIGHTS.range * factors.range
            + DIFF_WEIGHTS.pace * factors.pace
            + DIFF_WEIGHTS.leaps * factors.leaps
            + DIFF_WEIGHTS.tessitura * factors.tessitura;
        const band = score < 0.25 ? 'Easy'
            : score < 0.50 ? 'Medium'
            : score < 0.75 ? 'Hard' : 'Expert';
        return {
            score, band, factors,
            detail: {
                rangeSemitones: rangeSemi,
                notesPerSec: pace,
                meanIntervalSemitones: meanInterval,
                leapRate,
                lowMidi: lo, highMidi: hi,
            },
        };
    }

    // Strip the feedpak §7.1 suffixes: trailing '-' (joins to next syllable)
    // and '+' (last syllable of a line) are markup, not text.
    function syllableText(w) {
        let s = String(w || '');
        if (s.endsWith('+')) s = s.slice(0, -1);
        if (s.endsWith('-')) s = s.slice(0, -1);
        return s;
    }

    // Group tokens into lyric lines. Primary split: the '+' line-end suffix.
    // Content without '+' markers (some WS-lyrics sources) falls back to
    // splitting on inter-syllable gaps. Each part carries its display text
    // and whether it joins the next syllable ('-' suffix → no space).
    function buildLines(tokens) {
        const hasBreaks = tokens.some((tok) => String(tok.w || '').endsWith('+'));
        const lines = [];
        let cur = [];
        let lastEnd = -Infinity;
        for (let i = 0; i < tokens.length; i++) {
            const raw = String(tokens[i].w || '');
            if (cur.length && !hasBreaks && tokens[i].t - lastEnd > 1.2) {
                lines.push(cur);
                cur = [];
            }
            cur.push(i);
            lastEnd = tokens[i].t + (tokens[i].d || 0);
            if (raw.endsWith('+')) {
                lines.push(cur);
                cur = [];
            }
        }
        if (cur.length) lines.push(cur);
        return lines.map((idxs) => ({
            t0: tokens[idxs[0]].t,
            t1: tokens[idxs[idxs.length - 1]].t + (tokens[idxs[idxs.length - 1]].d || 0),
            parts: idxs.map((i) => {
                const raw = String(tokens[i].w || '');
                return { idx: i, text: syllableText(raw), join: raw.endsWith('-') };
            }),
        }));
    }

    // song_info carries filename: null (highway.js derives the name from the
    // WS URL instead — window.feedBack.currentSong). Prefer parsing the
    // bundle's own audio_url so each splitscreen panel resolves ITS song;
    // fall back to the shared currentSong global.
    function resolveFilename(songInfo) {
        const m = /^\/api\/sloppak\/(.+?)\/file\//.exec(String((songInfo && songInfo.audio_url) || ''));
        if (m) return decodeURIComponent(m[1]);
        const cs = (typeof window !== 'undefined' && window.feedBack && window.feedBack.currentSong) || null;
        return (cs && cs.filename) || '';
    }

    // ── Voices (multi-singer duets) ──────────────────────────────────────
    // A "voice" is {id, name, primary, tokens}. Every song has >=1; a duet has
    // one per singer (the importer's vocal_tracks extension). All voices are
    // DISPLAYED on a shared pitch axis; exactly one — the SCORED voice — is fed
    // to the mic/YIN engine at a time.
    //
    // Per-voice scoring is deliberately transport-agnostic. Today one local mic
    // scores the selected voice (the local single-audio ceiling — see the
    // desktop-bridge notes below). The seam is `_voices[i]` + a score source:
    // when the engine exposes source-indexed frames (local multi-input) OR a
    // remote player joins (the collaboration domain), a second voice's score
    // attaches to another source instead of the selected-voice scorer here — no
    // restructure. Which part YOU sing is `_preferredVoiceId`.
    const VOICE_COLORS = [
        'rgba(34,211,238,0.34)',   // teal — 2nd voice guide
        'rgba(244,114,182,0.34)',  // pink — 3rd
        'rgba(163,230,53,0.34)',   // lime — 4th
    ];
    let _preferredVoiceId = null;   // null → the primary voice; else a picked id

    function _pickVoiceIdx(voices) {
        if (!voices || !voices.length) return -1;
        if (_preferredVoiceId != null) {
            const i = voices.findIndex((v) => v.id === _preferredVoiceId);
            if (i >= 0) return i;
        }
        const p = voices.findIndex((v) => v.primary);
        return p >= 0 ? p : 0;
    }

    // Shared pitch axis spanning every voice, so no singer's bars clip off-lane.
    function _sharedRange(voices) {
        let all = [];
        for (const v of (voices || [])) all = all.concat(v.tokens);
        return computePitchRange(all);
    }

    // ── Mic + YIN + scoring engine ────────────────────────────────────────
    //
    // Ported from feedBack-plugin-lyrics-karaoke screen.js (AGPL-3.0):
    // YIN detector, ScriptProcessor ring-buffer capture with midpoint
    // song-time tagging, transport-aware per-syllable scoring. Module-level
    // singleton — one physical mic, one scoring session; the active renderer
    // instance attaches on init and provides tokens + pitch range. Additions:
    // an input-device picker (persisted deviceId), optional octave-independent
    // matching, and — for 3D mode — a sung-pitch history buffer, an input RMS,
    // and live voice metrics (stability + estimated vibrato).
    const YIN_FRAME_SIZE = 2048;
    const YIN_MIN_SAMPLES = 4096;
    const YIN_MIN_HZ = 50;        // human vocal floor — drops sub-bass artefacts
    const YIN_MAX_HZ = 1100;      // upper end of soprano range
    const YIN_CONFIDENCE = 0.5;   // YIN clarity score; below = unvoiced
    const SAMPLE_FRESH_MS = 200;  // stale samples don't draw the user marker
    const KEY_MIC_ON = 'vocals_highway.micOn';
    const KEY_MIC_DEVICE = 'vocals_highway.micDeviceId';
    const KEY_OCTAVE_FREE = 'vocals_highway.octaveIndependent';
    const KEY_TOLERANCE = 'vocals_highway.tolerance';    // semitones, default 1.0
    const KEY_MIC_CHANNEL = 'vocals_highway.micChannel'; // 'mix' | '1' | '2'
    const KEY_LEFT_PANEL = 'vocals_highway.leftPanel';   // 'scale' | 'off' — the left info bar
    const KEY_AUDIO_INPUT_MODE = 'vocals_highway.audioInputMode'; // '' (auto) | 'browser' = force getUserMedia
    const KEY_MIC_OFFSET = 'vocals_highway.micOffsetMs';          // signed wall-clock ms; positive = attribute singing earlier
    const KEY_LK_MIC = 'lyrics_karaoke.micFeedback';              // the lyrics-karaoke overlay's mic-on flag (read-only)
    const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // 3D-mode voice-metric windows / thresholds.
    const HISTORY_CAP = 400;          // ring cap for sung-pitch samples
    const STABILITY_WINDOW_S = 1.0;   // stddev window for the stability score
    const VIBRATO_WINDOW_S = 1.6;     // window for the vibrato-rate estimate
    const VIBRATO_MIN_CENTS = 18;     // peak modulation to call it vibrato at all

    let _yinWorkBuffer = new Float32Array(2048);

    function midiToName(midi) {
        const r = Math.round(midi);
        const pc = ((r % 12) + 12) % 12;
        return PITCH_NAMES[pc] + (Math.floor(r / 12) - 1);
    }

    function freqToMidi(freq) {
        return 12 * Math.log2(freq / 440) + 69;
    }

    // ── Diatonic (piano-key) axis helpers (3D mode) ───────────────────────
    // Naturals are evenly spaced (one row per white key); sharps sit halfway
    // between, so the pitch axis reads like piano keys rather than raw
    // semitone spacing. diaPosF interpolates for the fractional (mic) trace.
    const SEMI_TO_DIA = [0, 0.5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6];
    const isNat = (midi) => [0, 2, 4, 5, 7, 9, 11].indexOf((((Math.round(midi)) % 12) + 12) % 12) >= 0;
    function diaPos(midi) {
        const r = Math.round(midi);
        return Math.floor(r / 12) * 7 + SEMI_TO_DIA[((r % 12) + 12) % 12];
    }
    function diaPosF(midi) {
        const lo = Math.floor(midi);
        const f = midi - lo;
        return diaPos(lo) * (1 - f) + diaPos(lo + 1) * f;
    }
    // Tight diatonic range from the pitched tokens (min/max, widened to a
    // minimum span) so the 3D wall fills top-of-wall to floor.
    function computeDiatonicRange(tokens) {
        if (!Array.isArray(tokens)) return null;
        let lo = Infinity, hi = -Infinity;
        for (const t of tokens) {
            if (t && typeof t.midi === 'number') { if (t.midi < lo) lo = t.midi; if (t.midi > hi) hi = t.midi; }
        }
        if (!isFinite(lo)) return null;
        lo = Math.round(lo); hi = Math.round(hi);
        let guard = 0;
        while (diaPos(hi) - diaPos(lo) < 5 && guard++ < 24) { hi += 1; if (diaPos(hi) - diaPos(lo) < 5) lo -= 1; }
        return { midiLo: lo, midiHi: hi, dLo: diaPos(lo), dHi: diaPos(hi) };
    }

    // Shared diatonic axis spanning every voice (the diatonic twin of
    // _sharedRange), so a duet's guide bars land on the same lanes as the
    // scored voice. For a solo song this equals computeDiatonicRange(tokens).
    function _sharedDiatonicRange(voices) {
        let all = [];
        for (const v of (voices || [])) all = all.concat(v.tokens);
        return computeDiatonicRange(all);
    }

    function yinDetect(buffer, sampleRate, minFreqHz) {
        const threshold = 0.15;
        // Cap the search at the lag of the lowest pitch we care about —
        // O(tauMax²) instead of O(N²), ~5.4× cheaper at 44.1k/50Hz.
        const tauMax = Math.ceil(sampleRate / minFreqHz);
        const halfLen = Math.min(Math.floor(buffer.length / 2), tauMax + 1);
        if (halfLen < tauMax) return { freq: -1, confidence: 0 };
        if (_yinWorkBuffer.length < halfLen) _yinWorkBuffer = new Float32Array(halfLen);
        const yinBuffer = _yinWorkBuffer;
        let runningSum = 0;
        yinBuffer[0] = 1;
        for (let tau = 1; tau < halfLen; tau++) {
            let sum = 0;
            for (let i = 0; i < halfLen; i++) {
                const delta = buffer[i] - buffer[i + tau];
                sum += delta * delta;
            }
            yinBuffer[tau] = sum;
            runningSum += sum;
            yinBuffer[tau] = runningSum === 0 ? 1 : yinBuffer[tau] * (tau / runningSum);
        }
        let tau = 2;
        while (tau < halfLen) {
            if (yinBuffer[tau] < threshold) {
                while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
                break;
            }
            tau++;
        }
        if (tau === halfLen) return { freq: -1, confidence: 0 };
        const s0 = tau > 0 ? yinBuffer[tau - 1] : yinBuffer[tau];
        const s1 = yinBuffer[tau];
        const s2 = tau + 1 < halfLen ? yinBuffer[tau + 1] : yinBuffer[tau];
        const parabDenom = 2 * (s0 - 2 * s1 + s2);
        const betterTau = parabDenom !== 0 ? tau + (s0 - s2) / parabDenom : tau;
        return {
            freq: sampleRate / betterTau,
            confidence: Math.max(0, 1 - yinBuffer[tau]),
        };
    }

    // ── Mic engine state (module-level singleton) ─────────────────────────
    let _activeInstance = null;       // renderer instance providing tokens
    let micState = 'off';             // 'off' | 'requesting' | 'listening' | 'error'
    let micErrorMsg = '';
    let micStream = null;
    let micCtx = null;
    let micSourceNode = null;
    let micProcessor = null;
    let micTimer = null;
    let micSessionGen = 0;            // bumped on stop to invalidate stale frames
    let micPendingBufferAt = -Infinity;
    let micPendingSession = 0;
    let micPendingReady = false;
    let micLastCapturedAt = -Infinity;
    let _overlayStoodDown = false;    // paused because the lyrics-karaoke overlay is scoring
    let _lastOverlayCheckAt = -Infinity;
    let micInputLevel = 0;            // RMS of the most recent capture frame (3D meter)

    // Per-song scoring state.
    const userResults = new Map();    // tokenIndex → {samplesIn, samplesMatched, accuracy}
    let userLastMidi = null;          // latest raw detected midi
    let userDisplayMidi = null;       // smoothed value for the trace marker
    let userLastSampleWallAt = -Infinity;
    let _lastScoredIdx = -1;          // last syllable reported to note-detection

    // 3D-mode extras: sung-pitch history (for the scrolling trace + voice
    // metric windows) and the live score/streak accumulators.
    const pitchHistory = [];          // [{t, midi}] capped at HISTORY_CAP
    let voiceStability = null;        // 0..1 or null
    let voiceVibrato = null;          // {hz, present} or null
    const scoredFinal = new Set();
    let liveScore = 0;
    let liveStreak = 0;
    let liveBestStreak = 0;

    function _wallNow() {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
    }

    function _songNow() {
        return (typeof window !== 'undefined' && window.highway && typeof window.highway.getTime === 'function')
            ? (window.highway.getTime() || 0) : 0;
    }

    // Scoring clock. window.highway is the MAIN player's highway; splitscreen
    // panels run their own createHighway() instances with independent clocks,
    // so mic frames must be timestamped against the ACTIVE INSTANCE's panel
    // clock: the last bundle.currentTime it drew, extrapolated by wall time
    // (capped — a hidden panel stops drawing, its clock freezes, and the
    // stall-gate in processYinFrame then drops frames, which is exactly the
    // right behavior for a hidden vocals panel).
    function _scoreClockNow() {
        const inst = _activeInstance;
        if (inst && typeof inst._lastTime === 'number' && inst._lastTimeWallAt > 0) {
            const elapsed = Math.min(0.2, (_wallNow() - inst._lastTimeWallAt) / 1000);
            return inst._lastTime + elapsed * getPlaybackRate();
        }
        return _songNow();
    }

    function getPlaybackRate() {
        const a = (typeof document !== 'undefined') ? document.getElementById('audio') : null;
        if (a && typeof a.playbackRate === 'number' && a.playbackRate > 0) return a.playbackRate;
        return 1.0;
    }

    function _lsGet(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    }

    function _lsSet(key, val) {
        try { localStorage.setItem(key, val); } catch (_) { /* noop */ }
    }

    // Cached scoring/capture prefs — read once at load and re-read whenever a
    // settings surface (popover, applySetting, console) writes them, so the
    // hot paths never touch localStorage per frame.
    const prefs = { tolerance: 1.0, octaveFree: false, channel: 'mix', leftPanel: 'scale', micOffsetMs: 0 };

    function _readPrefs() {
        const t = parseFloat(_lsGet(KEY_TOLERANCE));
        prefs.tolerance = isFinite(t) ? Math.min(3, Math.max(0.25, t)) : 1.0;
        prefs.octaveFree = _lsGet(KEY_OCTAVE_FREE) === '1';
        const ch = _lsGet(KEY_MIC_CHANNEL);
        prefs.channel = (ch === '1' || ch === '2') ? ch : 'mix';
        const lp = _lsGet(KEY_LEFT_PANEL); prefs.leftPanel = (lp === 'off' || lp === 'voice') ? lp : 'scale';
        // Mic timing calibration (signed wall ms; positive = attribute singing
        // earlier). Compensates hear→sing→capture loop lag the automatic terms
        // can't see (browser input devices, audio output). A live change shifts
        // the next frame's stamp by the same amount — nudge the transport gate's
        // reference in step so a big backward move can't read as a seek-back
        // and wipe the take (processYinFrame's −0.25 s gate).
        const mo = parseFloat(_lsGet(KEY_MIC_OFFSET));
        const micOffsetMs = isFinite(mo) ? Math.min(1000, Math.max(-1000, mo)) : 0;
        if (micOffsetMs !== prefs.micOffsetMs && isFinite(micLastCapturedAt)) {
            micLastCapturedAt -= ((micOffsetMs - prefs.micOffsetMs) / 1000) * getPlaybackRate();
        }
        prefs.micOffsetMs = micOffsetMs;
    }
    _readPrefs();

    function resetScoring() {
        userResults.clear();
        userLastMidi = null;
        userDisplayMidi = null;
        userLastSampleWallAt = -Infinity;
        micLastCapturedAt = -Infinity;
        _lastScoredIdx = -1;
        pitchHistory.length = 0;
        voiceStability = null;
        voiceVibrato = null;
        scoredFinal.clear();
        liveScore = 0;
        liveStreak = 0;
        liveBestStreak = 0;
    }

    function _midiDelta(a, b) {
        let d = Math.abs(a - b);
        if (prefs.octaveFree) {
            d = d % 12;
            if (d > 6) d = 12 - d;
        }
        return d;
    }

    function findActiveTokenIndex(tokens, time) {
        // Latest-starting token whose [t, t+d) contains `time` wins, so an
        // overlapping next-syllable claim beats the previous one's tail.
        let bestIdx = -1;
        let bestStart = -Infinity;
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            if (!tok || typeof tok.t !== 'number' || typeof tok.midi !== 'number') continue;
            if (time < tok.t || time >= tok.t + (tok.d || 0)) continue;
            if (tok.t > bestStart) { bestStart = tok.t; bestIdx = i; }
        }
        return bestIdx;
    }

    // ── Capability-domain participation (EXPLORATION: explore/vocals-first-class) ──
    // Register the vocal YIN as a first-class note-detection PROVIDER and the mic
    // as a managed audio-input SOURCE, then mirror per-syllable outcomes into
    // note-detection as hit/miss events. This is how far "first class" reaches
    // WITHOUT a core PR:
    //   • note-detection is a CONTROL/observability plane — it never executes
    //     pitch.estimate for anyone (no dispatch path exists), so we keep running
    //     YIN in-plugin and REPORT results as events, exactly as guitar's
    //     note_detect does: register a provider, open our own binding, report it.
    //   • The domain's arrangement allow-list omits 'vocals'
    //     (note-detection.js _ARRANGEMENT_KINDS). Passing arrangement:'vocals' is
    //     accepted, but the field is silently dropped from the binding's
    //     diagnostic context — the ONLY thing a core PR fixes here (cosmetic).
    //   • audio-input mic selection is advisory in the web core (no real routing
    //     until a native engine); registering makes the mic a visible managed
    //     source, but we still capture frames ourselves (getUserMedia / bridge).
    //   • Persisting a vocal SCORE (song_stats / progression) is the real wall
    //     and stays core-PR territory — deliberately NOT attempted here.
    // Every call degrades to a silent no-op on a core without the capability graph.
    const ND_PROVIDER_ID = 'vocals-yin';
    const AUDIO_SOURCE_ID = 'vocals-yin:mic';
    const HIT_ACCURACY = 0.5;         // syllable = hit at >=50% matched frames
    let _ndProviderRegistered = false;
    let _inputSourceRegistered = false;
    let _ndBindingId = null;
    let _selectedInputKey = null;

    function _caps() {
        const fb = (typeof window !== 'undefined') ? window.feedBack : null;
        const c = fb && fb.capabilities;
        return (c && c.version === 1 && typeof c.command === 'function') ? c : null;
    }

    async function _capsCmd(domain, command, payload) {
        const c = _caps();
        if (!c) return null;
        try {
            return await c.command(domain, command, {
                requester: 'vocals_highway', source: 'vocals_highway',
                origin: 'system', reason: 'Karaoke Highway ' + domain + '/' + command,
                payload: payload || {},
            });
        } catch (e) {
            console.warn('vocals_highway: caps ' + domain + '/' + command + ' failed', e);
            return null;
        }
    }

    async function _ensureCapsRegistered() {
        if (!_caps()) return;
        if (!_ndProviderRegistered) {
            const r = await _capsCmd('note-detection', 'register-provider', {
                providerId: ND_PROVIDER_ID,
                label: 'Karaoke Highway YIN',
                kind: 'js',                       // detector TYPE; our YIN is JS either way
                primitives: ['pitch.estimate'],   // monophonic estimate
            });
            _ndProviderRegistered = !!(r && r.outcome === 'handled');
        }
        if (!_inputSourceRegistered) {
            // Passive/advisory source (no open/close handlers): makes the mic a
            // visible managed input. Wiring source.open→startMic is a natural
            // follow-on but risks colliding with input_setup's instrument picker.
            const r = await _capsCmd('audio-input', 'register-source', {
                version: 1,
                providerId: ND_PROVIDER_ID,
                ownerPluginId: 'vocals_highway',
                sourceId: AUDIO_SOURCE_ID,
                logicalSourceKey: AUDIO_SOURCE_ID,
                label: 'Karaoke microphone',
                labelSafe: true,
                kind: 'microphone',
                channelShape: 'mono',
                availability: 'available',
            });
            _inputSourceRegistered = !!(r && r.outcome === 'handled');
        }
        // Note the user's globally-selected input (advisory — we don't retarget
        // capture to it yet; the plugin keeps its own device picker).
        const r = await _capsCmd('audio-input', 'list-sources', {});
        const p = r && r.payload;
        const sel = p && (p.selected || (p.sources || []).find((s) => s && s.selected));
        _selectedInputKey = (sel && sel.logicalSourceKey) || null;
    }

    function _tokenMidiRange(tokens) {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < (tokens ? tokens.length : 0); i++) {
            const m = tokens[i] && tokens[i].midi;
            if (typeof m === 'number' && isFinite(m)) { if (m < lo) lo = m; if (m > hi) hi = m; }
        }
        return (lo <= hi) ? { lo, hi } : null;
    }

    // Open a note-detection binding for the current song while the mic listens;
    // session-guarded so a stop mid-open can't orphan a binding.
    async function _openNdBinding(session) {
        await _ensureCapsRegistered();
        if (session !== micSessionGen || _ndBindingId || !_ndProviderRegistered) return;
        const ctx = { arrangement: 'vocals' };   // dropped by the allow-list (cosmetic)
        const range = _tokenMidiRange(_activeInstance && _activeInstance._tokens);
        if (range) { ctx.midiLow = Math.round(range.lo); ctx.midiHigh = Math.round(range.hi); }
        const r = await _capsCmd('note-detection', 'open-binding', {
            providerId: ND_PROVIDER_ID, context: ctx,
        });
        const id = r && r.payload && r.payload.bindingId;
        if (session !== micSessionGen) {          // stopped mid-open — undo
            if (id) _capsCmd('note-detection', 'close-binding', { bindingId: id });
            return;
        }
        _ndBindingId = id || null;
    }

    function _closeNdBinding() {
        const id = _ndBindingId;
        _ndBindingId = null;
        _lastScoredIdx = -1;
        if (id) _capsCmd('note-detection', 'close-binding', { bindingId: id });
    }

    // Mirror a finished syllable's outcome into note-detection as a hit/miss
    // event (observability only; consumers own judgment). Guarded + cheap so the
    // scoring hot path never pays for an absent graph.
    function _reportSyllable(tokenIdx) {
        if (_ndBindingId == null || tokenIdx < 0) return;
        const fb = (typeof window !== 'undefined') ? window.feedBack : null;
        const nd = fb && fb.noteDetection;
        if (!nd) return;
        const inst = _activeInstance;
        const tok = inst && inst._tokens && inst._tokens[tokenIdx];
        const entry = userResults.get(tokenIdx);
        if (!tok || !entry || typeof tok.midi !== 'number') return;
        const hit = entry.accuracy >= HIT_ACCURACY;
        const detail = { bindingId: _ndBindingId, providerId: ND_PROVIDER_ID, midi: tok.midi, hit };
        try {
            if (hit && typeof nd.reportHit === 'function') nd.reportHit(detail);
            else if (!hit && typeof nd.reportMiss === 'function') nd.reportMiss(detail);
        } catch (_) { /* noop */ }
    }

    function _pushHistory(t, midi) {
        pitchHistory.push({ t, midi });
        if (pitchHistory.length > HISTORY_CAP) pitchHistory.shift();
    }

    // Voice metrics from the recent history (3D mode). Stability = 1 −
    // normalized pitch stddev over ~1 s (held tone → high). Vibrato =
    // zero-crossing rate of the mean-detrended pitch track over ~1.6 s, gated
    // on a minimum modulation amplitude; reported as an approximate rate,
    // never with false precision.
    function updateVoiceMetrics(nowT) {
        const win = [];
        for (let i = pitchHistory.length - 1; i >= 0; i--) {
            if (nowT - pitchHistory[i].t > VIBRATO_WINDOW_S) break;
            win.push(pitchHistory[i]);
        }
        win.reverse();
        if (win.length < 6) { voiceStability = null; voiceVibrato = null; return; }

        const sWin = win.filter((p) => nowT - p.t <= STABILITY_WINDOW_S);
        if (sWin.length >= 4) {
            let mean = 0;
            for (const p of sWin) mean += p.midi;
            mean /= sWin.length;
            let varc = 0;
            for (const p of sWin) { const d = p.midi - mean; varc += d * d; }
            const stdCents = Math.sqrt(varc / sWin.length) * 100;
            voiceStability = Math.max(0, Math.min(1, 1 - stdCents / 60));
        }

        let mean = 0;
        for (const p of win) mean += p.midi;
        mean /= win.length;
        let peak = 0, crossings = 0, prev = 0;
        for (let i = 0; i < win.length; i++) {
            const d = win[i].midi - mean;
            if (Math.abs(d) > peak) peak = Math.abs(d);
            if (i > 0 && ((prev <= 0 && d > 0) || (prev >= 0 && d < 0))) crossings++;
            prev = d;
        }
        const dur = win[win.length - 1].t - win[0].t;
        const rate = dur > 0 ? (crossings / 2) / dur : 0;
        const present = peak * 100 >= VIBRATO_MIN_CENTS && rate >= 3 && rate <= 9;
        voiceVibrato = { hz: rate, present };
    }

    function processYinFrame(buffer, sampleRate, capturedAt, sessionAtCapture) {
        if (sessionAtCapture !== micSessionGen) return;  // stop happened mid-frame

        // Transport awareness: a real seek-back wipes bookkeeping so old
        // scores don't resurrect; a stalled playhead (pause) drops the frame
        // so samplesIn can't inflate against the syllable under the cursor.
        // The threshold matters: the highway clock's AV-drift resync steps
        // backward by a few ms mid-song (observed live), and the karaoke
        // original resets on ANY negative delta — silently wiping scores
        // mid-take. Only treat sizeable jumps as transport rewinds; drop
        // micro-backstep frames like stalls.
        if (micLastCapturedAt > -Infinity) {
            const delta = capturedAt - micLastCapturedAt;
            if (delta < -0.25) resetScoring();
            else if (delta < 1e-3) return;
        }
        micLastCapturedAt = capturedAt;

        const r = yinDetect(buffer, sampleRate, YIN_MIN_HZ);
        if (!r || r.freq <= 0 || r.confidence < YIN_CONFIDENCE) return;
        if (r.freq < YIN_MIN_HZ || r.freq > YIN_MAX_HZ) return;
        const midi = freqToMidi(r.freq);
        if (!isFinite(midi)) return;

        userLastMidi = midi;
        userLastSampleWallAt = _wallNow();
        _pushHistory(capturedAt, midi);

        const inst = _activeInstance;
        const tokens = inst && inst._tokens;
        if (!tokens) return;
        const idx = findActiveTokenIndex(tokens, capturedAt);
        if (idx < 0) return;
        // Moved on to a new syllable → finalize the previous one into the domain.
        if (_lastScoredIdx >= 0 && _lastScoredIdx !== idx) _reportSyllable(_lastScoredIdx);
        _lastScoredIdx = idx;
        let entry = userResults.get(idx);
        if (!entry) {
            entry = { samplesIn: 0, samplesMatched: 0, accuracy: 0 };
            userResults.set(idx, entry);
        }
        entry.samplesIn += 1;
        if (_midiDelta(midi, tokens[idx].midi) <= prefs.tolerance) entry.samplesMatched += 1;
        entry.accuracy = entry.samplesMatched / entry.samplesIn;
    }

    function sessionAccuracy() {
        let inSum = 0;
        let matched = 0;
        userResults.forEach((e) => { inSum += e.samplesIn; matched += e.samplesMatched; });
        return inSum > 0 ? matched / inSum : null;
    }

    // Finalize scoring for pitched syllables the playhead has fully passed —
    // once each (3D mode's live Score/Streak). A hit (≥50% of its samples
    // matched) extends the combo and pays a streak-scaled bonus; a miss
    // (including a pitched syllable with no samples while listening) breaks it.
    function finalizeScores(tokens, now) {
        if (!tokens) return;
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            if (!tok || typeof tok.midi !== 'number') continue;
            if (tok.t + (tok.d || 0) > now) continue;
            if (scoredFinal.has(i)) continue;
            scoredFinal.add(i);
            const entry = userResults.get(i);
            const acc = entry ? entry.accuracy : 0;
            const hit = !!(entry && entry.samplesIn > 0 && acc >= 0.5);
            if (hit) {
                liveStreak += 1;
                if (liveStreak > liveBestStreak) liveBestStreak = liveStreak;
                const mult = 1 + Math.min(30, liveStreak) * 0.1;
                liveScore += Math.round(100 * acc * mult);
            } else {
                liveStreak = 0;
                liveScore += entry ? Math.round(50 * acc) : 0;
            }
        }
    }

    // ── End-of-song summary ───────────────────────────────────────────────
    // Computed when core emits song:ended and at least one syllable was
    // scored; drawn as a card until the next song (or replay) clears it.
    let lastSummary = null;

    function computeSummary(tokens) {
        const acc = sessionAccuracy();
        if (acc === null || !tokens) return null;
        let pitched = 0;
        let hits = 0;
        let streak = 0;
        let bestStreak = 0;
        for (let i = 0; i < tokens.length; i++) {
            if (typeof tokens[i].midi !== 'number') continue;
            pitched += 1;
            const entry = userResults.get(i);
            if (entry && entry.accuracy >= 0.5) {
                hits += 1;
                streak += 1;
                if (streak > bestStreak) bestStreak = streak;
            } else {
                streak = 0;
            }
        }
        return { accuracy: acc, hits, pitched, bestStreak, score: liveScore };
    }

    if (typeof window !== 'undefined' && window.feedBack && typeof window.feedBack.on === 'function') {
        window.feedBack.on('song:ended', () => {
            if (!_activeInstance || userResults.size === 0) return;
            const s = computeSummary(_activeInstance._tokens);
            if (s) lastSummary = s;
            // Finalize the last in-progress syllable into note-detection.
            if (_lastScoredIdx >= 0) { _reportSyllable(_lastScoredIdx); _lastScoredIdx = -1; }
        });
        window.feedBack.on('screen:changed', (e) => {
            // Re-assert the v3 flyout controls if the player chrome rebuilt its
            // slot while our renderer is active. Guarded by _activeInstance so we
            // never inject for a non-vocals arrangement (our renderer not mounted).
            if (e && e.detail && e.detail.id === 'player' && _activeInstance) _ensureV3Controls();
        });
    }

    // Point an instance's SCORED voice at the current `_preferredVoiceId` (else
    // its primary). `_tokens` stays the scored voice, so the whole mic/YIN engine
    // — findActiveTokenIndex, userResults, computeSummary, the note-detection
    // binding range — targets it unchanged; only the render iterates all voices.
    // resetScore=true (a live user switch on the active instance) wipes the old
    // voice's scores and re-scopes the binding; the per-frame render sync passes
    // false.
    function _applyVoiceSelection(inst, resetScore) {
        if (!inst) return;
        const idx = _pickVoiceIdx(inst._voices);
        if (idx < 0) { inst._scoredIdx = -1; inst._tokens = null; inst._lines = null; inst._difficulty = null; inst._dRange = null; return; }
        if (idx === inst._scoredIdx && inst._tokens) return;   // unchanged
        inst._scoredIdx = idx;
        inst._tokens = inst._voices[idx].tokens;
        inst._lines = null;                                    // rebuilt lazily in draw()
        inst._difficulty = estimateDifficulty(inst._tokens);   // 3D difficulty follows the scored voice
        inst._dRange = null;                                   // diatonic axis recomputed lazily in _draw3D
        if (resetScore && _activeInstance === inst) {
            resetScoring();
            lastSummary = null;
            if (micState === 'listening') { _closeNdBinding(); _openNdBinding(micSessionGen); }
        }
    }

    // ── Native desktop-engine capture (EXPLORATION / PROTOTYPE) ───────────
    // Branch: explore/vocals-first-class. Adapted from the bundled `tuner`
    // plugin's desktop-bridge path (feedBack core, AGPL-3.0): probe
    // window.feedBackDesktop.audio, poll getRawAudioFrame(), and run OUR
    // existing YIN + scoring over the native frame — so only the sample
    // SOURCE changes, not the pitch/scoring pipeline. This is the "vocals as a
    // real audio device" proof: on the desktop build vocals rides the same
    // JUCE engine (and thus ASIO) that guitar's note_detect already uses,
    // instead of opening a second browser getUserMedia stream.
    //
    // Known limits (prototype scope — captured for the follow-on RFC):
    //  • getRawAudioFrame reads the engine's SOURCE 0 (its primary input). On a
    //    single-interface rig that's the mic; true simultaneous guitar+vocals
    //    on separate sources needs a source-indexed frame API not yet exposed.
    //  • The browser channel picker (ch1/ch2/mix) doesn't apply — the engine
    //    already resolved the source's channel.
    //  • No monitoring/effects here (that's the vocal rig-builder follow-on).
    //  • We START the shared engine if idle but never STOP it (note_detect may
    //    be using it); teardown only clears our own poll timer.
    let micUsingBridge = false;
    let micBridgePolling = false;

    function _bridgeForced() {
        // True when the user has chosen the browser mic over the desktop engine
        // (the "Desktop audio engine" toggle, backed by this localStorage key;
        // also the headless A/B-latency escape hatch).
        return _lsGet(KEY_AUDIO_INPUT_MODE) === 'browser';
    }

    // Is the desktop JUCE bridge present to capture from (API exposed)?
    function _bridgePresent() {
        const d = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
        return !!(d && d.isDesktop && d.audio && typeof d.audio.getRawAudioFrame === 'function');
    }

    // Is the BROWSER getUserMedia path the one actually (or about to be)
    // capturing? While listening we know for certain (micUsingBridge); otherwise
    // honor the toggle, and it's always the browser on a build with no engine.
    // The device/channel pickers only matter when this is true.
    function _browserInputActive() {
        if (micState === 'listening') return !micUsingBridge;
        if (!_bridgePresent()) return true;
        return _bridgeForced();
    }

    async function _tryDesktopBridgeStart(session) {
        if (_bridgeForced()) return false;
        const desktop = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
        if (!desktop || !desktop.isDesktop || !desktop.audio
            || typeof desktop.audio.isAvailable !== 'function'
            || typeof desktop.audio.getRawAudioFrame !== 'function') return false;

        let available = false;
        try { available = await desktop.audio.isAvailable(); } catch (_) { /* noop */ }
        if (session !== micSessionGen || !available) return false;

        // Shared device: start it only if idle; never stop it on our teardown.
        try {
            const running = (typeof desktop.audio.isAudioRunning === 'function')
                ? await desktop.audio.isAudioRunning() : false;
            if (session !== micSessionGen) return false;
            if (!running && typeof desktop.audio.startAudio === 'function') {
                await desktop.audio.startAudio();
            }
        } catch (e) {
            console.warn('vocals_highway: desktop bridge startAudio failed', e);
            return false;
        }
        if (session !== micSessionGen) return false;

        let sampleRate = 48000;
        try {
            if (typeof desktop.audio.getSampleRate === 'function') {
                const sr = await desktop.audio.getSampleRate();
                if (typeof sr === 'number' && isFinite(sr) && sr > 0) sampleRate = sr;
            }
        } catch (_) { /* noop */ }
        if (session !== micSessionGen) return false;

        // Extra native input latency (buffer + device) so scoring lands on the
        // syllable actually sung. Read once — fine for a prototype.
        let latencySec = 0;
        try {
            if (typeof desktop.audio.getLatencyMs === 'function') {
                const ms = await desktop.audio.getLatencyMs();
                if (typeof ms === 'number' && isFinite(ms) && ms >= 0) latencySec = ms / 1000;
            }
        } catch (_) { /* noop */ }
        if (session !== micSessionGen) return false;

        const ringSize = Math.max(YIN_MIN_SAMPLES, 2 * Math.ceil(sampleRate / YIN_MIN_HZ));
        const midpointWallSec = (ringSize / 2) / sampleRate;

        micUsingBridge = true;
        micBridgePolling = false;
        console.log('vocals_highway: capturing via desktop JUCE bridge (native frame + YIN), sr=' + sampleRate);

        // Poll the newest `ringSize` samples ~every 30ms (mirrors tuner) and
        // feed the SAME processYinFrame the browser path uses. Consecutive
        // frames overlap (denser sampling); accuracy is a matched/in ratio so
        // cadence doesn't bias it. No await between the last session check and
        // arming the timer, so it can't go stale under us here.
        micTimer = setInterval(async () => {
            if (micBridgePolling || micState !== 'listening') return;
            micBridgePolling = true;
            try {
                const samples = await desktop.audio.getRawAudioFrame(ringSize);
                if (session !== micSessionGen) return;   // stopped mid-await
                if (!(samples instanceof Float32Array) || samples.length < ringSize) return;
                // Copy: the engine may hand back a view onto a buffer it reuses.
                const frame = samples.slice(0, ringSize);
                const at = _scoreClockNow() - (midpointWallSec + latencySec + prefs.micOffsetMs / 1000) * getPlaybackRate();
                processYinFrame(frame, sampleRate, at, session);
                updateVoiceMetrics(at);   // bridge path must feed the metrics too (the browser path does)
            } catch (e) {
                console.warn('vocals_highway: desktop bridge frame poll failed', e);
            } finally {
                micBridgePolling = false;
            }
        }, 30);

        return true;
    }

    // ── Karaoke coexistence (EXPLORATION: explore/vocals-first-class) ─────
    // If the native lyrics-karaoke overlay is the active scorer, we pause OUR
    // mic so two mics don't fight over one device. Read-only detection (its
    // ribbon canvas is visible, or its persisted mic flag is set) — we NEVER
    // touch the overlay's DOM/state or core; we change only our own capture and
    // show a notice, and resume automatically when the overlay stops.
    function _overlayActive() {
        try {
            const el = (typeof document !== 'undefined') ? document.getElementById('lyrics-karaoke-overlay') : null;
            if (el && el.offsetParent !== null) return true;   // its ribbon is showing
        } catch (_) { /* noop */ }
        return _lsGet(KEY_LK_MIC) === '1';                     // its mic is capturing
    }

    function _syncOverlayStandDown() {
        const active = _overlayActive();
        if (active && !_overlayStoodDown) {
            _overlayStoodDown = true;
            if (micState === 'listening' || micState === 'requesting') stopMic({ keepFlag: true });
            _refreshMicStrips();
        } else if (!active && _overlayStoodDown) {
            _overlayStoodDown = false;
            // Resume only if the user still wants the mic on (intent persisted).
            if (micState === 'off' && _lsGet(KEY_MIC_ON) === '1') startMic();
            _refreshMicStrips();
        }
    }

    async function startMic() {
        if (micState === 'listening' || micState === 'requesting') return;
        if (_overlayActive()) {
            // Stand down instead of opening a second mic; keep the on-intent so
            // we resume when the overlay closes (via _syncOverlayStandDown).
            _overlayStoodDown = true;
            _lsSet(KEY_MIC_ON, '1');
            _refreshMicStrips();
            return;
        }
        micState = 'requesting';
        micErrorMsg = '';
        _refreshMicStrips();

        const session = ++micSessionGen;
        let pendingStream = null;
        let pendingCtx = null;
        try {
            // Native low-latency path first: on the FeedBack desktop build, ride
            // the JUCE engine (same input guitar's note_detect uses, ASIO-capable)
            // instead of a browser mic. Falls through to getUserMedia otherwise.
            if (await _tryDesktopBridgeStart(session)) {
                if (session !== micSessionGen) return;   // superseded mid-probe
                micState = 'listening';
                _lsSet(KEY_MIC_ON, '1');
                _openNdBinding(session);
                _refreshMicStrips();
                return;
            }
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('Microphone access requires HTTPS or localhost.');
            }
            // Create + resume the AudioContext BEFORE awaiting getUserMedia
            // so the user activation is still valid (Safari/iOS resume rule).
            pendingCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (pendingCtx.state === 'suspended') {
                try { await pendingCtx.resume(); } catch (_) {
                    throw new Error('Audio context could not resume. Click 🎤 again.');
                }
            }
            // Ask for stereo so multi-input interfaces that present one
            // stereo device (e.g. ch1 guitar / ch2 mic) can be channel-
            // addressed instead of downmixed; mono devices still work.
            const audio = {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: { ideal: 2 },
            };
            const savedDevice = _lsGet(KEY_MIC_DEVICE);
            if (savedDevice) audio.deviceId = { exact: savedDevice };
            try {
                pendingStream = await navigator.mediaDevices.getUserMedia({ audio });
            } catch (e) {
                // Saved device unplugged/renumbered — retry with the default
                // input rather than failing the whole feature.
                if (savedDevice && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
                    delete audio.deviceId;
                    pendingStream = await navigator.mediaDevices.getUserMedia({ audio });
                } else {
                    throw e;
                }
            }
            if (session !== micSessionGen) {
                pendingStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* noop */ } });
                try { pendingCtx.close(); } catch (_) { /* noop */ }
                return;
            }
            micStream = pendingStream;
            micCtx = pendingCtx;
            micSourceNode = micCtx.createMediaStreamSource(micStream);
            micProcessor = micCtx.createScriptProcessor(YIN_FRAME_SIZE, 2, 1);
            // Ring must cover 2*tauMax samples so yinDetect can search down
            // to YIN_MIN_HZ at any sample rate (192 kHz needs 7680).
            const sampleRate = micCtx.sampleRate;
            const ringSize = Math.max(YIN_MIN_SAMPLES, 2 * Math.ceil(sampleRate / YIN_MIN_HZ));
            const ring = new Float32Array(ringSize);
            const pending = new Float32Array(ringSize);
            let ringCount = 0;
            // Tag each snapshot with the song time at the buffer MIDPOINT
            // (converted via playback rate) so scoring lands on the syllable
            // actually being sung, not the one under the cursor at wake-up.
            const midpointWallSec = (ringSize / 2) / sampleRate;

            const mixBuf = new Float32Array(YIN_FRAME_SIZE);
            micProcessor.onaudioprocess = (e) => {
                if (micState !== 'listening') return;
                const nCh = e.inputBuffer.numberOfChannels;
                let input;
                if (nCh >= 2 && prefs.channel === '2') {
                    input = e.inputBuffer.getChannelData(1);
                } else if (nCh >= 2 && prefs.channel === 'mix') {
                    const a = e.inputBuffer.getChannelData(0);
                    const b = e.inputBuffer.getChannelData(1);
                    for (let i = 0; i < a.length; i++) mixBuf[i] = (a[i] + b[i]) / 2;
                    input = mixBuf.length === a.length ? mixBuf : mixBuf.subarray(0, a.length);
                } else {
                    input = e.inputBuffer.getChannelData(0);
                }
                const n = input.length;
                // Input level (RMS) for the 3D-mode meter.
                let sumSq = 0;
                for (let i = 0; i < n; i++) { const s = input[i]; sumSq += s * s; }
                micInputLevel = Math.sqrt(sumSq / Math.max(1, n));
                ring.copyWithin(0, n);            // slide left in place
                ring.set(input, ringSize - n);    // new frame fills the tail
                ringCount += n;
                if (ringCount >= ringSize) {
                    pending.set(ring);
                    micPendingBufferAt = _scoreClockNow() - (midpointWallSec + prefs.micOffsetMs / 1000) * getPlaybackRate();
                    micPendingSession = session;
                    micPendingReady = true;
                }
            };

            micSourceNode.connect(micProcessor);
            // ScriptProcessor needs a sink to pump; a zero-gain node avoids
            // feeding the mic back to the speakers.
            const muteSink = micCtx.createGain();
            muteSink.gain.value = 0;
            micProcessor.connect(muteSink);
            muteSink.connect(micCtx.destination);

            micTimer = setInterval(() => {
                if (!micPendingReady) return;
                const at = micPendingBufferAt;
                const sessionAtCapture = micPendingSession;
                micPendingReady = false;
                processYinFrame(pending, sampleRate, at, sessionAtCapture);
                updateVoiceMetrics(at);
            }, 50);

            micState = 'listening';
            _lsSet(KEY_MIC_ON, '1');
            _openNdBinding(session);
            _populateDevicePickers();  // labels become available post-permission
            _refreshMicStrips();
        } catch (e) {
            console.warn('vocals_highway mic start failed', e);
            micErrorMsg = (e && e.message) || 'Microphone unavailable';
            if (pendingStream && pendingStream !== micStream) {
                try { pendingStream.getTracks().forEach((t) => t.stop()); } catch (_) { /* noop */ }
            }
            if (pendingCtx && pendingCtx !== micCtx) {
                try { pendingCtx.close(); } catch (_) { /* noop */ }
            }
            stopMic({ keepFlag: false });
            micState = 'error';
            _refreshMicStrips();
        }
    }

    function stopMic(opts) {
        const keepFlag = !!(opts && opts.keepFlag);
        micSessionGen += 1;
        if (micTimer) { clearInterval(micTimer); micTimer = null; }
        micUsingBridge = false;
        micBridgePolling = false;
        _closeNdBinding();
        if (micProcessor) {
            try { micProcessor.disconnect(); } catch (_) { /* noop */ }
            micProcessor.onaudioprocess = null;
            micProcessor = null;
        }
        if (micSourceNode) {
            try { micSourceNode.disconnect(); } catch (_) { /* noop */ }
            micSourceNode = null;
        }
        if (micStream) {
            try { micStream.getTracks().forEach((t) => t.stop()); } catch (_) { /* noop */ }
            micStream = null;
        }
        if (micCtx) {
            try { micCtx.close(); } catch (_) { /* noop */ }
            micCtx = null;
        }
        micPendingReady = false;
        micPendingBufferAt = -Infinity;
        micLastCapturedAt = -Infinity;
        micInputLevel = 0;
        if (!keepFlag) _lsSet(KEY_MIC_ON, '0');
        micState = 'off';
        _refreshMicStrips();
    }

    // ── Mic UI strip (per-instance DOM: 🎤 toggle + input-device picker) ──
    const _micStrips = new Set();

    function _stripColors() {
        return {
            bg: 'rgba(16,16,24,0.85)', border: '1px solid rgba(160,170,200,0.35)',
            text: '#c8cde1', active: '#e8c040', error: '#f87171',
        };
    }

    function _isV3() {
        return !!(typeof window !== 'undefined' && window.feedBack && window.feedBack.uiVersion === 'v3');
    }

    // The host's stable plugin-control slot (Plugins rail popover) in v3, else
    // null. This is the core-sanctioned mount point (docs/plugin-v3-ui.md).
    function _v3Slot() {
        if (!_isV3()) return null;
        const ui = window.feedBack.ui;
        if (!ui || typeof ui.playerControlSlot !== 'function') return null;
        try { const s = ui.playerControlSlot(); return (s instanceof Element) ? s : null; }
        catch (_) { return null; }
    }

    // Build the shared mic controls: 🎤 toggle + ⚙ + the settings panel (input
    // source, device, channel, duet voice, tolerance, octave). All wiring lives
    // here so v2 (canvas strip) and v3 (plugin-control slot) behave identically;
    // only mounting/positioning differs. `reposition` is a hook the v3 mount
    // sets to portal-place the panel on open.
    function _buildMicControls() {
        const c = _stripColors();
        const btnCss = `background:${c.bg};color:${c.text};border:${c.border};`
            + 'border-radius:4px;padding:2px 8px;cursor:pointer;';
        const rowCss = 'display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:6px;';
        const inputCss = `background:rgba(30,30,44,0.9);color:${c.text};border:${c.border};`
            + 'border-radius:4px;padding:2px 4px;max-width:170px;';

        const panel = document.createElement('div');
        panel.style.cssText = `display:none;min-width:240px;`
            + `background:${c.bg};border:${c.border};border-radius:6px;padding:10px;color:${c.text};`;
        // The panel is portalled to <body> (v3), OUTSIDE core's plugin-control
        // flyout, which auto-closes on any document click landing outside itself
        // (v3/player-chrome.js: a bubble-phase document 'click' listener). Stop
        // our in-panel clicks from bubbling up to it — otherwise interacting with
        // ANY control in here collapses the whole flyout behind us.
        panel.addEventListener('click', (e) => e.stopPropagation());

        function row(labelText, control) {
            const r = document.createElement('div');
            r.style.cssText = rowCss;
            const lab = document.createElement('span');
            lab.textContent = labelText;
            r.appendChild(lab);
            r.appendChild(control);
            panel.appendChild(r);
            return r;
        }

        // Input source toggle — desktop audio engine vs a browser mic picked below.
        const inputChk = document.createElement('input');
        inputChk.type = 'checkbox';
        inputChk.title = "Capture from the desktop audio engine (the app's primary input). "
            + 'Uncheck to use a browser microphone selected below.';
        inputChk.addEventListener('change', () => {
            _lsSet(KEY_AUDIO_INPUT_MODE, inputChk.checked ? '' : 'browser');
            if (micState === 'listening') { stopMic({ keepFlag: true }); startMic(); }
            _refreshMicStrips();
        });
        const inputRow = row('Desktop audio engine', inputChk);
        const engineNote = document.createElement('div');
        engineNote.style.cssText = 'margin-top:6px;font-size:11px;color:rgba(200,205,225,0.7);';
        engineNote.textContent = "Uses the app's primary audio device.";
        panel.appendChild(engineNote);

        const sel = document.createElement('select');
        sel.title = 'Vocals microphone input (independent of the instrument input)';
        sel.style.cssText = inputCss;
        sel.addEventListener('change', () => {
            _lsSet(KEY_MIC_DEVICE, sel.value);
            if (micState === 'listening') { stopMic({ keepFlag: true }); startMic(); }
        });
        const deviceRow = row('Mic device', sel);

        const chSel = document.createElement('select');
        chSel.title = 'Which capture channel carries the mic on a multi-input interface';
        chSel.style.cssText = inputCss;
        [['mix', 'Mix (L+R)'], ['1', 'Channel 1'], ['2', 'Channel 2']].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = t;
            chSel.appendChild(o);
        });
        chSel.addEventListener('change', () => { _lsSet(KEY_MIC_CHANNEL, chSel.value); _readPrefs(); });
        const channelRow = row('Channel', chSel);

        // Duet voice picker — which singer's part YOU sing (the scored voice).
        const voiceSel = document.createElement('select');
        voiceSel.title = 'Which vocal part you sing (scored); other parts show as guides';
        voiceSel.style.cssText = inputCss;
        voiceSel.addEventListener('change', () => {
            _preferredVoiceId = voiceSel.value;
            if (_activeInstance) _applyVoiceSelection(_activeInstance, true);
            _refreshVoiceSelectors();
            _refreshMicStrips();
        });
        const voiceRow = row('Voice', voiceSel);
        voiceRow.style.display = 'none';

        // Left info bar: the fixed pitch gauge, or off for a wider highway.
        const leftSel = document.createElement('select');
        leftSel.title = 'What the left info bar shows';
        leftSel.style.cssText = inputCss;
        [['scale', 'Absolute scale'], ['voice', 'Voice technique'], ['off', 'Off']].forEach(([v, t]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = t; leftSel.appendChild(o);
        });
        leftSel.addEventListener('change', () => { _lsSet(KEY_LEFT_PANEL, leftSel.value); _readPrefs(); });
        row('Left bar', leftSel);

        const tolWrap = document.createElement('span');
        tolWrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const tol = document.createElement('input');
        tol.type = 'range';
        tol.min = '0.5';
        tol.max = '2';
        tol.step = '0.25';
        tol.style.cssText = 'width:110px;';
        const tolVal = document.createElement('span');
        tolVal.style.cssText = 'min-width:28px;text-align:right;';
        tol.addEventListener('input', () => {
            _lsSet(KEY_TOLERANCE, tol.value);
            _readPrefs();
            tolVal.textContent = Number(tol.value).toFixed(2);
        });
        tolWrap.appendChild(tol);
        tolWrap.appendChild(tolVal);
        row('Tolerance ±st', tolWrap);

        const oct = document.createElement('input');
        oct.type = 'checkbox';
        oct.title = 'Score modulo octave (sing in any octave)';
        oct.addEventListener('change', () => { _lsSet(KEY_OCTAVE_FREE, oct.checked ? '1' : '0'); _readPrefs(); });
        row('Octave-free', oct);

        // Mic timing calibration — scoring attribution only (see _readPrefs).
        // The sung trace shifts with it, so it self-verifies: sing along and
        // raise it until your on-time notes sit on the bars.
        const offWrap = document.createElement('span');
        offWrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const offSlider = document.createElement('input');
        offSlider.type = 'range';
        offSlider.min = '-1000';
        offSlider.max = '1000';
        offSlider.step = '5';
        offSlider.style.cssText = 'width:110px;';
        offSlider.title = 'Scoring timing calibration (ms). Raise it if your hits register late '
            + '(wireless audio or mic adds delay). Double-click to reset.';
        const offVal = document.createElement('span');
        offVal.style.cssText = 'min-width:40px;text-align:right;';
        const fmtOff = (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`;
        offSlider.addEventListener('input', () => {
            _lsSet(KEY_MIC_OFFSET, offSlider.value);
            _readPrefs();
            offVal.textContent = fmtOff(prefs.micOffsetMs);
        });
        offSlider.addEventListener('dblclick', () => {
            offSlider.value = '0';
            _lsSet(KEY_MIC_OFFSET, '0');
            _readPrefs();
            offVal.textContent = fmtOff(prefs.micOffsetMs);
        });
        offWrap.appendChild(offSlider);
        offWrap.appendChild(offVal);
        row('Mic timing ms', offWrap);

        function hydrate() {
            _readPrefs();
            chSel.value = prefs.channel;
            tol.value = String(prefs.tolerance);
            tolVal.textContent = prefs.tolerance.toFixed(2);
            oct.checked = prefs.octaveFree;
            offSlider.value = String(prefs.micOffsetMs);
            offVal.textContent = fmtOff(prefs.micOffsetMs);
            leftSel.value = prefs.leftPanel;
            sel.value = _lsGet(KEY_MIC_DEVICE) || '';
            _refreshVoiceSelectors();
            _refreshInputRows();
        }

        const micBtn = document.createElement('button');
        micBtn.type = 'button';
        micBtn.textContent = '🎤';
        micBtn.setAttribute('aria-label', 'Toggle live mic pitch feedback');
        micBtn.style.cssText = btnCss;
        micBtn.addEventListener('click', () => {
            if (micState === 'listening' || micState === 'requesting') stopMic({ keepFlag: false });
            else startMic();
        });

        const gearBtn = document.createElement('button');
        gearBtn.type = 'button';
        gearBtn.textContent = '⚙';
        gearBtn.title = 'Vocals mic settings';
        gearBtn.setAttribute('aria-label', 'Vocals mic settings');
        gearBtn.style.cssText = btnCss;

        const controls = {
            panel, micBtn, gearBtn, hydrate, reposition: null, close: null, open: null,
            sel, chSel, voiceSel, voiceRow, inputChk, inputRow, deviceRow, channelRow, engineNote,
        };
        // Dismiss on click-outside / Esc so the panel closes when the plugin-
        // controls flyout does. In v3 the panel is portalled to <body>, so it
        // isn't inside the rail popover the host auto-closes — we mirror that
        // behavior here (capture phase, so nothing downstream can swallow it).
        function _onDocDown(e) {
            if (panel.contains(e.target) || gearBtn.contains(e.target)) return;
            // A native <select> dropdown (e.g. the Voice picker) renders its
            // options in an OS layer; picking one dispatches a document mousedown
            // whose target is OUTSIDE the panel, which would spuriously dismiss it.
            // Don't close while a panel <select> holds focus.
            const ae = document.activeElement;
            if (ae && ae.tagName === 'SELECT' && panel.contains(ae)) return;
            controls.close();
        }
        function _onKey(e) { if (e.key === 'Escape') controls.close(); }
        controls.close = () => {
            if (panel.style.display === 'none') return;
            panel.style.display = 'none';
            document.removeEventListener('mousedown', _onDocDown, true);
            document.removeEventListener('keydown', _onKey, true);
        };
        controls.open = () => {
            if (panel.style.display !== 'none') return;
            panel.style.display = 'block';
            hydrate();
            _populateDevicePickers();
            if (controls.reposition) controls.reposition();
            document.addEventListener('mousedown', _onDocDown, true);
            document.addEventListener('keydown', _onKey, true);
        };
        gearBtn.addEventListener('click', () => {
            if (panel.style.display !== 'none') controls.close(); else controls.open();
        });
        return controls;
    }

    // v2 fallback: a canvas-relative strip in the bottom-right clear band (below
    // the notes, above core's "?"), settings panel opening UPWARD. Used when the
    // v3 plugin-control slot isn't available.
    function buildMicStrip(parent) {
        const m = _buildMicControls();
        const wrap = document.createElement('div');
        wrap.className = 'vocals-highway-mic-strip';
        wrap.style.cssText = 'position:absolute;bottom:72px;right:8px;z-index:15;display:flex;'
            + 'gap:6px;align-items:center;pointer-events:auto;font:12px sans-serif;';
        m.panel.style.position = 'absolute';
        m.panel.style.bottom = '28px';
        m.panel.style.right = '0';
        wrap.appendChild(m.gearBtn);
        wrap.appendChild(m.micBtn);
        wrap.appendChild(m.panel);
        if (parent && getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }
        (parent || document.body).appendChild(wrap);
        const strip = {
            wrap, btn: m.micBtn, panel: m.panel, hydrate: m.hydrate, close: m.close,
            sel: m.sel, voiceSel: m.voiceSel, voiceRow: m.voiceRow,
            inputRow: m.inputRow, inputChk: m.inputChk, deviceRow: m.deviceRow,
            channelRow: m.channelRow, engineNote: m.engineNote,
        };
        _micStrips.add(strip);
        _populateDevicePickers();
        _refreshVoiceSelectors();
        _refreshMicStrips();
        return strip;
    }

    // Portal-position the v3 settings panel beside its ⚙, clamped to the viewport
    // (prefer opening to the right of the gear; fall back left if off-screen).
    function _positionV3Panel(panel, anchor) {
        const r = anchor.getBoundingClientRect();
        const GAP = 8, M = 8;
        const pw = panel.offsetWidth || 240;
        const ph = panel.offsetHeight || 0;
        let left = r.right + GAP;
        if (left + pw > window.innerWidth - M) left = Math.max(M, r.left - pw - GAP);
        let top = Math.min(r.top, window.innerHeight - ph - M);
        if (top < M) top = M;
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
    }

    // v3: inject the mic controls once into the core plugin-control slot (global
    // — one flyout per player, unlike the per-canvas v2 strip). Idempotent, and
    // re-appends if the slot was rebuilt. Returns false if the slot isn't ready.
    let _v3Controls = null;
    function _ensureV3Controls() {
        const slot = _v3Slot();
        if (!slot) return false;
        if (_v3Controls) {
            if (!slot.contains(_v3Controls.btn)) {
                slot.appendChild(_v3Controls.btn);
                slot.appendChild(_v3Controls.gearBtn);
            }
            _refreshMicStrips();
            return true;
        }
        const m = _buildMicControls();
        m.panel.style.position = 'fixed';
        // Above #player (a full-screen overlay at z-index 100); the tuner's
        // portal'd panel uses the same 1000 tier.
        m.panel.style.zIndex = '1000';
        m.reposition = () => _positionV3Panel(m.panel, m.gearBtn);
        document.body.appendChild(m.panel);
        // Core styles slot buttons via CSS; drop our canvas-look inline style and
        // give the mic button a text label like the other flyout controls.
        m.micBtn.id = 'btn-vocals-mic';
        m.micBtn.style.cssText = '';
        m.micBtn.textContent = 'Vocal Mic';
        m.gearBtn.id = 'btn-vocals-mic-gear';
        m.gearBtn.style.cssText = '';
        slot.appendChild(m.micBtn);
        slot.appendChild(m.gearBtn);
        const strip = {
            btn: m.micBtn, gearBtn: m.gearBtn, panel: m.panel, hydrate: m.hydrate, close: m.close, isV3: true,
            sel: m.sel, voiceSel: m.voiceSel, voiceRow: m.voiceRow,
            inputRow: m.inputRow, inputChk: m.inputChk, deviceRow: m.deviceRow,
            channelRow: m.channelRow, engineNote: m.engineNote,
        };
        _v3Controls = strip;
        _micStrips.add(strip);
        _populateDevicePickers();
        _refreshVoiceSelectors();
        _refreshMicStrips();
        return true;
    }

    function _removeV3Controls() {
        if (!_v3Controls) return;
        _micStrips.delete(_v3Controls);
        try { if (_v3Controls.close) _v3Controls.close(); } catch (_) { /* noop */ }
        try { _v3Controls.btn.remove(); } catch (_) { /* noop */ }
        try { _v3Controls.gearBtn.remove(); } catch (_) { /* noop */ }
        try { _v3Controls.panel.remove(); } catch (_) { /* noop */ }
        _v3Controls = null;
    }

    function removeMicStrip(strip) {
        if (!strip) return;
        _micStrips.delete(strip);
        try { if (strip.close) strip.close(); } catch (_) { /* noop */ }
        try { strip.wrap.remove(); } catch (_) { /* noop */ }
    }

    async function _populateDevicePickers() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        let devices = [];
        try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (_) { return; }
        const inputs = devices.filter((d) => d.kind === 'audioinput');
        const saved = _lsGet(KEY_MIC_DEVICE) || '';
        _micStrips.forEach(({ sel }) => {
            sel.innerHTML = '';
            const def = document.createElement('option');
            def.value = '';
            def.textContent = 'Default mic';
            sel.appendChild(def);
            inputs.forEach((d, i) => {
                if (!d.deviceId || d.deviceId === 'default') return;
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Microphone ${i + 1}`;
                sel.appendChild(opt);
            });
            sel.value = saved;
            if (sel.value !== saved) sel.value = '';
        });
    }

    if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', () => _populateDevicePickers());
    }

    function _refreshMicStrips() {
        const c = _stripColors();
        _micStrips.forEach((s) => {
            const btn = s.btn;
            if (!btn) return;
            if (_overlayStoodDown) {
                // Paused because the native Karaoke overlay is the active scorer.
                if (s.isV3) {
                    btn.textContent = 'Vocal Mic (overlay)';
                    btn.setAttribute('aria-pressed', 'false');
                } else {
                    btn.style.color = c.text;
                    btn.style.borderColor = 'rgba(160,170,200,0.35)';
                }
                btn.title = 'Paused — the native Karaoke overlay is the active scorer. '
                    + 'Turn it off to use the Highway mic here.';
                return;
            }
            if (s.isV3) {
                // Core styles the slot button; reflect state via a ✓ suffix +
                // title, matching the flyout's "Detect ✓" / "Karaoke ✓" convention.
                const on = micState === 'listening';
                btn.textContent = on ? 'Vocal Mic ✓' : 'Vocal Mic';
                btn.setAttribute('aria-pressed', on ? 'true' : 'false');
                btn.title = on ? 'Stop live mic feedback'
                    : micState === 'requesting' ? 'Requesting microphone…'
                    : micState === 'error' ? ('Mic error: ' + micErrorMsg + ' (click to retry)')
                    : 'Start live mic pitch feedback';
                return;
            }
            if (micState === 'listening') {
                btn.style.color = c.active;
                btn.style.borderColor = c.active;
                btn.title = 'Stop live mic feedback';
            } else if (micState === 'requesting') {
                btn.style.color = c.text;
                btn.style.borderColor = c.text;
                btn.title = 'Requesting microphone…';
            } else if (micState === 'error') {
                btn.style.color = c.error;
                btn.style.borderColor = c.error;
                btn.title = 'Mic error: ' + micErrorMsg + ' (click to retry)';
            } else {
                btn.style.color = c.text;
                btn.style.borderColor = 'rgba(160,170,200,0.35)';
                btn.title = 'Start live mic pitch feedback';
            }
        });
        _refreshInputRows();
    }

    // Show the browser device+channel pickers only when the browser mic is the
    // actual source; on a desktop build the "Desktop audio engine" toggle picks
    // the source and the engine note stands in for the (inapplicable) pickers.
    function _refreshInputRows() {
        const present = _bridgePresent();
        const browser = _browserInputActive();
        _micStrips.forEach((s) => {
            if (s.inputRow) s.inputRow.style.display = present ? '' : 'none';
            if (s.inputChk) s.inputChk.checked = !_bridgeForced();
            if (s.deviceRow) s.deviceRow.style.display = browser ? '' : 'none';
            if (s.channelRow) s.channelRow.style.display = browser ? '' : 'none';
            if (s.engineNote) s.engineNote.style.display = (present && !browser) ? '' : 'none';
        });
    }

    // Populate each strip's "Voice" picker from the active instance's voices;
    // hidden unless the song is a duet (>1 voice).
    function _refreshVoiceSelectors() {
        const voices = (_activeInstance && _activeInstance._voices) || [];
        const show = voices.length > 1;
        const curId = _preferredVoiceId != null ? _preferredVoiceId
            : ((voices.find((v) => v.primary) || voices[0] || {}).id);
        _micStrips.forEach(({ voiceSel, voiceRow }) => {
            if (!voiceSel || !voiceRow) return;
            voiceRow.style.display = show ? '' : 'none';
            if (!show) return;
            voiceSel.innerHTML = '';
            voices.forEach((v) => {
                const o = document.createElement('option');
                o.value = v.id;
                o.textContent = (v.name || v.id) + (v.primary ? ' (lead)' : '');
                voiceSel.appendChild(o);
            });
            if (curId != null) voiceSel.value = curId;
        });
    }

    function createRenderer() {
        return {
            contextType: '2d',

            _canvas: null,
            _ctx: null,
            _filename: undefined,   // undefined = never loaded; '' = no song
            _voices: null,          // [{id, name, primary, tokens}] — all singers
            _scoredIdx: -1,         // index into _voices of the mic-scored voice
            _tokens: null,          // the scored voice's tokens (engine reads this)
            _range: null,           // shared pitch axis across all voices
            _lines: null,
            _difficulty: null,      // {score, band, factors, detail} for 3D mode
            _dRange: null,          // {midiLo, midiHi, dLo, dHi} diatonic axis cache
            _status: 'idle',        // idle | loading | ready | nodata
            _gen: 0,                // invalidates in-flight fetches on song change / destroy

            init(canvas, _bundle) {
                this._canvas = canvas;
                this._ctx = canvas.getContext('2d');
                // Force a (cache-friendly) reload on the first draw — init()
                // recurs on the same instance after destroy() per contract.
                this._filename = undefined;
                this._voices = null;
                this._scoredIdx = -1;
                this._tokens = null;
                this._range = null;
                this._lines = null;
                this._difficulty = null;
                this._dRange = null;
                this._status = 'idle';
                // Mic engine: last-init'd instance owns scoring; a drawing
                // instance takes over if the owner's canvas dies (see draw()).
                _activeInstance = this;
                if (_isV3()) {
                    // v3: controls live in the global plugin-control slot (built
                    // once, shared across splitscreen panels) — no per-canvas strip.
                    _ensureV3Controls();
                    this._micStrip = null;
                } else {
                    this._micStrip = buildMicStrip(canvas.parentElement);
                }
                this._autoStarted = false;
                this._lastTime = undefined;
                this._lastTimeWallAt = 0;
                // Hide the strip in sync with this panel's canvas (splitscreen
                // hides inactive panels; events are per-canvas, so filter).
                this._visHandler = (e) => {
                    if (!e || !e.detail || e.detail.canvas !== this._canvas) return;
                    if (this._micStrip && this._micStrip.wrap) {
                        this._micStrip.wrap.style.display = e.detail.visible === false ? 'none' : 'flex';
                    }
                };
                if (window.feedBack && typeof window.feedBack.on === 'function') {
                    window.feedBack.on('highway:visibility', this._visHandler);
                }
            },

            destroy() {
                this._gen++;
                if (this._visHandler && window.feedBack && typeof window.feedBack.off === 'function') {
                    window.feedBack.off('highway:visibility', this._visHandler);
                }
                this._visHandler = null;
                if (_activeInstance === this) {
                    // keepFlag: persisted intent survives so the mic
                    // auto-restarts on the next song.
                    stopMic({ keepFlag: true });
                    resetScoring();
                    _activeInstance = null;
                }
                removeMicStrip(this._micStrip);
                this._micStrip = null;
                // v3: the flyout controls are global; retire them once no vocals
                // renderer remains active (e.g. moved to a non-vocals arrangement).
                if (_isV3() && !_activeInstance) _removeV3Controls();
                this._canvas = null;
                this._ctx = null;
                this._voices = null;
                this._scoredIdx = -1;
                this._tokens = null;
                this._range = null;
                this._lines = null;
                this._difficulty = null;
                this._dRange = null;
                this._filename = undefined;
                this._status = 'idle';
            },

            // Per-instance settings host contract (feedBack#849): a host (e.g.
            // splitscreen's per-panel popover) renders the settings declared in
            // plugin.json capabilities.visualization.settings and calls these.
            // Every surface (host, on-highway popover, console) converges on
            // the same localStorage keys + prefs cache.
            applySetting(key, value) {
                if (key === 'octaveIndependent') _lsSet(KEY_OCTAVE_FREE, value ? '1' : '0');
                else if (key === 'tolerance') _lsSet(KEY_TOLERANCE, String(value));
                else if (key === 'micOffsetMs') _lsSet(KEY_MIC_OFFSET, String(value));
                _readPrefs();
            },

            getSetting(key) {
                if (key === 'octaveIndependent') return prefs.octaveFree;
                if (key === 'tolerance') return prefs.tolerance;
                if (key === 'micOffsetMs') return prefs.micOffsetMs;
                return undefined;
            },

            _loadFor(filename, bundle) {
                this._filename = filename;
                this._voices = null;
                this._scoredIdx = -1;
                this._tokens = null;
                this._range = null;
                this._lines = null;
                this._difficulty = null;
                this._dRange = null;
                if (_activeInstance === this) { resetScoring(); lastSummary = null; }
                this._autoStarted = false;
                const gen = ++this._gen;

                const setVoices = (voices, withRange) => {
                    this._voices = voices;
                    _applyVoiceSelection(this, false);
                    this._range = withRange ? _sharedRange(voices) : null;
                    this._status = (this._tokens && this._tokens.length) ? 'ready' : 'nodata';
                    _refreshVoiceSelectors();
                };
                // bundle.lyrics is safe to hold across the await: array fields
                // keep their identity until chart data changes (gen guards that),
                // unlike the reused bundle object itself. WS lyrics are a single
                // text-only voice (no pitch).
                const wsLyrics = Array.isArray(bundle.lyrics) ? bundle.lyrics : null;
                const wsFallback = () => {
                    if (!(wsLyrics && wsLyrics.length)) return false;
                    setVoices([{ id: 'vocals', name: null, primary: true, tokens: wsLyrics }], false);
                    return true;
                };

                if (!filename) {
                    if (!wsFallback()) this._status = 'idle';
                    return;
                }

                const cached = _tokenCache.get(filename);
                if (cached) { setVoices(cached, true); return; }

                this._status = 'loading';
                _fetchData(filename).then((voices) => {
                    if (gen !== this._gen) return;
                    _cacheTokens(filename, voices);
                    setVoices(voices, true);
                }).catch(() => {
                    if (gen !== this._gen) return;
                    if (!wsFallback()) this._status = 'nodata';
                });
            },

            draw(bundle) {
                const canvas = this._canvas;
                const ctx = this._ctx;
                if (!canvas || !ctx) return;
                const W = canvas.width;
                const H = canvas.height;
                if (!W || !H) return;

                // Panel-local scoring clock (splitscreen: each panel highway
                // interpolates its own time; the engine timestamps mic frames
                // off the active instance's last drawn time).
                this._lastTime = bundle.currentTime || 0;
                this._lastTimeWallAt = _wallNow();

                // Mic-engine ownership: normally the last-init'd instance owns
                // scoring, but if that instance's canvas has left the DOM or
                // been hidden (splitscreen panel closed/hidden without a clean
                // destroy), a drawing instance takes over. Throttled — the
                // offsetParent read is a layout query and must stay off the
                // per-frame path.
                if (_activeInstance !== this && ((this._takeoverTick = (this._takeoverTick || 0) + 1) % 30 === 0)) {
                    const ai = _activeInstance;
                    const aiDead = !ai || !ai._canvas || !ai._canvas.isConnected
                        || ai._canvas.offsetParent === null;
                    if (aiDead) {
                        _activeInstance = this;
                        resetScoring();
                    }
                }

                // Karaoke coexistence: pause our mic while the native overlay is
                // the active scorer. Throttled — _overlayActive() does a layout
                // read (offsetParent), which must stay off the per-frame path.
                if (_activeInstance === this && (_wallNow() - _lastOverlayCheckAt) > 400) {
                    _lastOverlayCheckAt = _wallNow();
                    _syncOverlayStandDown();
                }

                const si = bundle.songInfo || {};
                const filename = resolveFilename(si);
                if (filename !== this._filename) this._loadFor(filename, bundle);

                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.fillStyle = COL_BG;
                ctx.fillRect(0, 0, W, H);
                this._drawWatermark(ctx, W, H);

                // Notice while stood down for the native Karaoke overlay.
                if (_overlayStoodDown && _activeInstance === this) {
                    ctx.save();
                    ctx.fillStyle = COL_STATUS;
                    ctx.font = Math.max(11, Math.round(H / 42)) + 'px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillText('🎤 paused — Karaoke overlay is active', W / 2, 8);
                    ctx.restore();
                }

                // Keep the scored voice in sync with the user's pick (cheap; a
                // no-op when unchanged) so every panel reflects the selection.
                _applyVoiceSelection(this, false);

                const tokens = this._tokens;
                const u = H / 480;  // scale unit: tuned at 480px reference height
                const now = bundle.currentTime || 0;

                if (!tokens || !tokens.length) {
                    // Stage the empty seam while loading/nodata, then the status.
                    this._drawSeam(ctx, W, Math.round(H * 0.82), u);
                    this._drawStatus(ctx, W, H);
                    return;
                }

                // Auto-restore the mic once per song when the persisted flag
                // is on and the song actually has pitch data to score.
                if (!this._autoStarted && _activeInstance === this) {
                    this._autoStarted = true;
                    if (micState === 'off' && _lsGet(KEY_MIC_ON) === '1'
                        && tokens.some((t) => typeof t.midi === 'number')) {
                        startMic();
                    }
                }

                // 3D is the only offered look; it needs a pitch range to place
                // the scale/notes. A lyrics-only song (no range) silently falls
                // back to the classic flat ribbon — not a user choice.
                if (this._range) {
                    this._draw3D(bundle, W, H, u, now);
                    return;
                }
                this._drawSimple(bundle, W, H, u, now);
            },

            // ── Simple mode (classic flat ribbon; unchanged behaviour) ────
            _drawSimple(bundle, W, H, u, now) {
                const ctx = this._ctx;
                const tokens = this._tokens;

                // Lefty/inverted (bundle.lefty / bundle.inverted) are
                // deliberately ignored: the ribbon's time axis follows reading
                // direction, not handedness, and pitch has a universal
                // up-is-higher convention — mirroring either would only confuse.

                // ── Layout ────────────────────────────────────────────────
                const textBand = Math.max(36, Math.min(72 * u, 96));
                const barTop = 16 * u;
                const barBand = H - textBand - barTop - 10 * u;
                const range = this._range;
                const span = range ? Math.max(1, range.hi - range.lo) : 1;
                const laneH = barBand / span;                       // px per semitone
                const barH = Math.max(8, Math.min(laneH * 1.6, 40 * u));
                const pxPerSec = W / VISIBLE_SECONDS;
                const playheadX = W * PLAYHEAD_FRAC;
                const xFor = (t) => playheadX + (t - now) * pxPerSec;
                const yFor = (midi) => barTop + ((range.hi - midi) / span) * (barBand - barH);
                const tMin = now - PLAYHEAD_FRAC * VISIBLE_SECONDS - 1;
                const tMax = now + (1 - PLAYHEAD_FRAC) * VISIBLE_SECONDS + 1;

                // ── Semitone lanes (only when a pitch range exists) ───────
                if (range && span <= 30) {
                    ctx.fillStyle = COL_LANE;
                    for (let m = Math.ceil(range.lo); m <= Math.floor(range.hi); m += 1) {
                        const y = yFor(m) + barH / 2;
                        ctx.fillRect(0, y, W, 1);
                    }
                }

                const pad = 2 * u;
                const radius = 4 * u;

                // ── Other voices (duet guides) ────────────────────────────
                // Every non-scored voice draws as flat, dim, color-coded bars so
                // you can see the other singer's line and time your entrances —
                // no fill or scoring tint (that's the scored voice's treatment).
                if (range && this._voices && this._voices.length > 1) {
                    const guideH = Math.max(4, barH * 0.5);
                    for (let vi = 0; vi < this._voices.length; vi++) {
                        if (vi === this._scoredIdx) continue;
                        const vt = this._voices[vi].tokens;
                        ctx.fillStyle = VOICE_COLORS[(vi > this._scoredIdx ? vi - 1 : vi) % VOICE_COLORS.length];
                        for (let gi = 0; gi < vt.length; gi++) {
                            const gt = vt[gi];
                            if (typeof gt.midi !== 'number') continue;
                            if (gt.t + gt.d < tMin) continue;
                            if (gt.t > tMax) break;
                            const gx0 = xFor(gt.t);
                            const gx = gx0 + pad;
                            const gw = Math.max(2, xFor(gt.t + gt.d) - gx0 - 2 * pad);
                            const gy = yFor(gt.midi) + (barH - guideH) / 2;
                            this._roundRect(ctx, gx, gy, gw, guideH, radius);
                        }
                    }
                }

                // ── Pitch bars ────────────────────────────────────────────
                for (let i = 0; i < tokens.length; i++) {
                    const tok = tokens[i];
                    if (tok.t + tok.d < tMin) continue;
                    if (tok.t > tMax) break;   // tokens are time-sorted
                    if (typeof tok.midi !== 'number' || !range) continue;

                    const x0 = xFor(tok.t);
                    const x1 = xFor(tok.t + tok.d);
                    const x = x0 + pad;
                    const w = Math.max(2, x1 - x0 - 2 * pad);
                    const y = yFor(tok.midi);
                    const isPast = tok.t + tok.d <= now;
                    const isActive = tok.t <= now && now < tok.t + tok.d;

                    ctx.fillStyle = COL_BAR_DIM;
                    this._roundRect(ctx, x, y, w, barH, radius);

                    if (isPast || isActive) {
                        const fillRight = Math.max(x, Math.min(x + w, playheadX));
                        const fillW = fillRight - x;
                        if (fillW > 0) {
                            ctx.fillStyle = isActive ? COL_BAR_ACTIVE : COL_BAR_FILL;
                            this._roundRect(ctx, x, y, fillW, barH, radius);
                        }
                    }

                    // Per-syllable scoring tint: red (0) → green (1) wash
                    // over the sung portion of the bar.
                    if (_activeInstance === this && (isPast || isActive)) {
                        const entry = userResults.get(i);
                        if (entry && entry.samplesIn > 0) {
                            const acc = entry.accuracy;
                            ctx.fillStyle = `rgba(${Math.round(255 * (1 - acc))}, ${Math.round(255 * acc)}, 64, 0.55)`;
                            const tintRight = Math.max(x, Math.min(x + w, playheadX));
                            if (tintRight - x > 0) this._roundRect(ctx, x, y, tintRight - x, barH, radius);
                        }
                    }
                }

                // ── Lyric line band ───────────────────────────────────────
                // Words render as an assembled, naturally-spaced line (classic
                // karaoke) instead of per-syllable time positioning — dense
                // fast-song lyrics were unreadable mush under their bars.
                if (!this._lines) this._lines = buildLines(tokens);
                const lines = this._lines;
                let li = 0;
                while (li < lines.length && now >= lines[li].t1 + 0.3) li++;
                const textY = barTop + barBand + 8 * u;
                const fontPx = Math.max(13, Math.round(Math.min(22 * u, 26)));
                if (li < lines.length) {
                    this._drawLyricLine(ctx, lines[li], now, W, fontPx, textY, true);
                    if (li + 1 < lines.length && textBand >= fontPx * 2.2) {
                        this._drawLyricLine(ctx, lines[li + 1], now, W,
                            Math.round(fontPx * 0.72), textY + fontPx * 1.35, false);
                    }
                }

                // ── Playhead ──────────────────────────────────────────────
                ctx.strokeStyle = COL_PLAYHEAD;
                ctx.lineWidth = Math.max(1, 1.5 * u);
                ctx.beginPath();
                ctx.moveTo(playheadX, 6 * u);
                ctx.lineTo(playheadX, H - 6 * u);
                ctx.stroke();

                if (_activeInstance !== this) return;

                // ── Live pitch trace (cyan marker at the playhead) ────────
                const fresh = (_wallNow() - userLastSampleWallAt) <= SAMPLE_FRESH_MS;
                if (fresh && userLastMidi !== null && range) {
                    if (userDisplayMidi === null) userDisplayMidi = userLastMidi;
                    userDisplayMidi += 0.4 * (userLastMidi - userDisplayMidi);
                    const drawMidi = Math.round(userDisplayMidi);
                    const yRaw = yFor(drawMidi);
                    const yClipped = Math.max(barTop, Math.min(barTop + barBand - barH, yRaw));
                    ctx.fillStyle = COL_TRACE;
                    ctx.fillRect(playheadX - 30 * u, yClipped + barH / 2 - 1.5 * u, 34 * u, 3 * u);
                }

                // ── Session accuracy pill ─────────────────────────────────
                if (micState !== 'off') {
                    const acc = sessionAccuracy();
                    let text;
                    if (micState === 'listening') {
                        text = '🎤 ' + (acc !== null ? Math.round(acc * 100) + '%' : '—');
                        if (fresh && userDisplayMidi !== null) text += ' · ' + midiToName(userDisplayMidi);
                    } else if (micState === 'requesting') {
                        text = '🎤 …';
                    } else {
                        text = '🎤 mic error — click 🎤 to retry';
                    }
                    const fontPx2 = Math.max(12, Math.round(16 * u));
                    ctx.font = fontPx2 + 'px sans-serif';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    const pad2 = 8 * u;
                    const tw = ctx.measureText(text).width;
                    const ph = fontPx2 + 12 * u;
                    // Core's song-title overlay owns the top-left corner
                    // (fixed-px DOM chrome, ~80px tall) — sit below it.
                    const pillY = Math.max(88, 60 * u);
                    ctx.fillStyle = 'rgba(16,16,24,0.75)';
                    this._roundRect(ctx, 8 * u, pillY, tw + pad2 * 2, ph, 6 * u);
                    ctx.fillStyle = micState === 'error' ? '#f87171' : COL_TEXT;
                    ctx.fillText(text, 8 * u + pad2, pillY + ph / 2);
                }

                // ── End-of-song summary card ──────────────────────────────
                if (lastSummary) {
                    const s = lastSummary;
                    const line1 = 'Vocals — ' + Math.round(s.accuracy * 100) + '%';
                    const line2 = s.hits + '/' + s.pitched + ' syllables · best streak ' + s.bestStreak;
                    const f1 = Math.max(18, Math.round(30 * u));
                    const f2 = Math.max(12, Math.round(16 * u));
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.font = 'bold ' + f1 + 'px sans-serif';
                    const w1 = ctx.measureText(line1).width;
                    ctx.font = f2 + 'px sans-serif';
                    const w2 = ctx.measureText(line2).width;
                    const cardW = Math.max(w1, w2) + 48 * u;
                    const cardH = f1 + f2 + 40 * u;
                    const cx2 = W / 2;
                    const cy2 = H / 2;
                    ctx.fillStyle = 'rgba(12,12,20,0.9)';
                    this._roundRect(ctx, cx2 - cardW / 2, cy2 - cardH / 2, cardW, cardH, 10 * u);
                    ctx.fillStyle = COL_BAR_ACTIVE;
                    ctx.font = 'bold ' + f1 + 'px sans-serif';
                    ctx.fillText(line1, cx2, cy2 - f2 / 2 - 4 * u);
                    ctx.fillStyle = COL_TEXT;
                    ctx.font = f2 + 'px sans-serif';
                    ctx.fillText(line2, cx2, cy2 + f1 / 2 + 2 * u);
                }
            },

            // ── 3D mode (perspective stage + scoring/voice panel) ─────────
            _draw3D(bundle, W, H, u, now) {
                const ctx = this._ctx;
                const tokens = this._tokens;
                const isOwner = _activeInstance === this;
                if (!this._dRange) {
                    // Duets share one diatonic axis across all voices so guide
                    // bars stay on-lane; solo is unchanged (shared == scored).
                    this._dRange = (this._voices && this._voices.length > 1)
                        ? _sharedDiatonicRange(this._voices)
                        : computeDiatonicRange(tokens);
                }
                const dR = this._dRange;
                if (!dR) { this._drawSimple(bundle, W, H, u, now); return; }

                // Full-width ribbon. Score/streak/accuracy ride the top band; the
                // floor was retired to a thin seam so the note wall + the left
                // pitch scale claim the full height down to the seam.
                const ribbonW = W;
                const wallTop = 8 * u;
                const topStatsH = 42 * u;            // score / streak / accuracy band
                const seamY = Math.round(H * 0.82);  // wall base / horizon seam (lyrics below)
                const showGauge = prefs.leftPanel !== 'off';
                const railW = showGauge ? Math.max(52, Math.round(64 * u)) : Math.round(10 * u);
                const noteTop = wallTop + topStatsH;
                const noteBottom = seamY;

                const dLo = dR.dLo, dHi = dR.dHi, dSpan = Math.max(1, dHi - dLo);
                const usable = noteBottom - noteTop;
                const barH = Math.max(8, Math.min((usable / dSpan) * 0.86, 40 * u));
                const pxPerSec = ribbonW / VISIBLE_SECONDS;
                const playheadX = railW + (ribbonW - railW) * PLAYHEAD_FRAC_3D;
                const xFor = (t) => playheadX + (t - now) * pxPerSec;
                const yFor = (m) => noteTop + ((dHi - diaPosF(m)) / dSpan) * (usable - barH);
                const tMin = now - PLAYHEAD_FRAC_3D * VISIBLE_SECONDS - 1;
                const tMax = now + (1 - PLAYHEAD_FRAC_3D) * VISIBLE_SECONDS + 1;

                if (isOwner) finalizeScores(tokens, now);

                ctx.save();
                ctx.beginPath();
                ctx.rect(0, 0, ribbonW, H);
                ctx.clip();

                // ── Wall backdrop + natural pitch lanes ──
                const wg = ctx.createLinearGradient(0, 0, 0, seamY);
                wg.addColorStop(0, '#0a0b14'); wg.addColorStop(1, '#0d1120');
                ctx.fillStyle = wg; ctx.fillRect(0, 0, ribbonW, seamY);
                ctx.lineWidth = 1;
                ctx.font = Math.max(8, Math.round(9 * u)) + 'px sans-serif';
                ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                for (let m = dR.midiLo; m <= dR.midiHi; m++) {
                    if (!isNat(m)) continue;
                    const y = yFor(m) + barH / 2;
                    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
                    ctx.beginPath(); ctx.moveTo(railW, y); ctx.lineTo(ribbonW, y); ctx.stroke();
                    // Absolute lane label (the gauge no longer maps to the chart).
                    ctx.fillStyle = 'rgba(160,170,200,0.4)';
                    ctx.fillText(midiToName(m), railW + 5 * u, y);
                }

                // ── Horizon seam (the floor was retired for vertical space) ──
                this._drawSeam(ctx, ribbonW, seamY, u);

                // ── Notes (violet lit slabs) ──
                const pad = 2 * u;
                const radius = 6 * u;

                // ── Other voices (duet guides) ──
                // Deliberately SECONDARY: flat, thin, cool-colored, dim bars with
                // no gradient / gloss / glow / scoring tint (all reserved for YOUR
                // scored voice), drawn behind it. They mark where the other part
                // goes for timing/orientation — never something to focus on. See
                // CLAUDE.md ("duet guides read as secondary").
                if (this._voices && this._voices.length > 1) {
                    const guideH = Math.max(3, barH * 0.4);
                    const guideR = Math.min(radius, guideH / 2);
                    for (let vi = 0; vi < this._voices.length; vi++) {
                        if (vi === this._scoredIdx) continue;
                        const vt = this._voices[vi].tokens;
                        ctx.fillStyle = VOICE_COLORS[(vi > this._scoredIdx ? vi - 1 : vi) % VOICE_COLORS.length];
                        for (let gi = 0; gi < vt.length; gi++) {
                            const gt = vt[gi];
                            if (typeof gt.midi !== 'number') continue;
                            if (gt.t + gt.d < tMin) continue;
                            if (gt.t > tMax) break;
                            const gx0 = xFor(gt.t);
                            const gw = Math.max(2, xFor(gt.t + gt.d) - gx0 - 2 * pad);
                            const gy = yFor(gt.midi) + (barH - guideH) / 2;
                            this._roundRect(ctx, gx0 + pad, gy, gw, guideH, guideR);
                        }
                    }
                }

                for (let i = 0; i < tokens.length; i++) {
                    const tok = tokens[i];
                    if (tok.t + tok.d < tMin) continue;
                    if (tok.t > tMax) break;
                    if (typeof tok.midi !== 'number') continue;

                    const x0 = xFor(tok.t);
                    const x1 = xFor(tok.t + tok.d);
                    const x = x0 + pad;
                    const w = Math.max(2, x1 - x0 - 2 * pad);
                    const y = yFor(tok.midi);
                    const isPast = tok.t + tok.d <= now;
                    const isActive = tok.t <= now && now < tok.t + tok.d;

                    const g = ctx.createLinearGradient(0, y, 0, y + barH);
                    if (isActive) {
                        g.addColorStop(0, COL_NOTE_TOP); g.addColorStop(1, COL_NOTE_DEEP);
                        ctx.shadowColor = COL_NOTE_MID; ctx.shadowBlur = 22 * u;
                    } else if (isPast) {
                        g.addColorStop(0, COL_NOTE_MID); g.addColorStop(1, COL_NOTE_LOW);
                    } else {
                        g.addColorStop(0, 'rgba(168,85,247,0.6)'); g.addColorStop(1, 'rgba(109,40,217,0.5)');
                    }
                    ctx.fillStyle = g;
                    this._roundRect(ctx, x, y, w, barH, radius);
                    ctx.shadowBlur = 0;

                    // Sung-portion accuracy fill (left of the playhead): clean
                    // red→yellow→green from the shared COL_RED/AMBER/GREEN palette,
                    // drawn as a top-lit → saturated gradient (the same texturing as
                    // the note, so it doesn't read flat) and opaque (the violet must
                    // not bleed through and muddy red/yellow to purple).
                    if (isOwner && (isPast || isActive)) {
                        const entry = userResults.get(i);
                        if (entry && entry.samplesIn > 0) {
                            const acc = entry.accuracy;
                            let cr, cg, cb;
                            if (acc < 0.5) { const k = acc / 0.5; cr = 248 - 16 * k; cg = 113 + 79 * k; cb = 113 - 49 * k; }
                            else { const k = (acc - 0.5) / 0.5; cr = 232 - 180 * k; cg = 192 + 19 * k; cb = 64 + 89 * k; }
                            const tintRight = Math.max(x, Math.min(x + w, playheadX));
                            if (tintRight - x > 0) {
                                const lift = (v) => Math.round(v + (255 - v) * 0.5);
                                const ag = ctx.createLinearGradient(0, y, 0, y + barH);
                                ag.addColorStop(0, `rgb(${lift(cr)}, ${lift(cg)}, ${lift(cb)})`);
                                ag.addColorStop(1, `rgb(${Math.round(cr * 0.8)}, ${Math.round(cg * 0.8)}, ${Math.round(cb * 0.8)})`);
                                ctx.fillStyle = ag;
                                this._roundRect(ctx, x, y, tintRight - x, barH, radius);
                            }
                        }
                    }

                    // Gloss highlight last, so it rides over BOTH the violet note
                    // and the accuracy fill — the sung portion stays lit, not flat.
                    ctx.fillStyle = isActive ? 'rgba(255,255,255,0.85)' : 'rgba(235,230,255,0.30)';
                    this._roundRect(ctx, x + 2 * u, y + 1.5 * u, Math.max(1, w - 4 * u), 2.5 * u, 1.5 * u);
                }

                // ── Sung-pitch history trail ──
                if (isOwner) this._drawTrace(ctx, now, xFor, yFor, railW, playheadX, barH, noteTop, noteBottom, u);

                // ── Playhead (cyan "now" line) ──
                ctx.strokeStyle = 'rgba(56,189,248,0.95)';
                ctx.lineWidth = Math.max(1.5, 2 * u);
                ctx.beginPath();
                ctx.moveTo(playheadX, noteTop - 6 * u);
                ctx.lineTo(playheadX, seamY);
                ctx.stroke();

                // ── Full-height pitch scale (doubles as the live tuner) ──
                const fresh3d = isOwner && (_wallNow() - userLastSampleWallAt) <= SAMPLE_FRESH_MS && userLastMidi !== null;
                if (prefs.leftPanel === 'voice') this._drawVoicePanel(ctx, railW, noteTop, noteBottom, u, fresh3d);
                else if (showGauge) this._drawKeyRail(ctx, railW, noteTop, noteBottom, u, fresh3d);

                // ── Top stats band (score / streak / accuracy) ──
                this._drawTopStats(ctx, ribbonW, wallTop, topStatsH, railW, u, isOwner);

                // ── Lyric band ──
                this._draw3DLyrics(ctx, now, railW, ribbonW, H, seamY, u);

                ctx.restore();  // end ribbon clip

                this._drawWatermark(ctx, W, H);
                if (lastSummary) this._drawSummaryCard(ctx, ribbonW, H, u);
            },

            // Score / streak / accuracy across the top band — replaces the
            // RECENT / SING NOW / UPCOMING headers and the retired right panel.
            _drawTopStats(ctx, ribbonW, top, bandH, railW, u, isOwner) {
                const acc = sessionAccuracy();
                const live = isOwner && micState !== 'off';
                const accColor = acc !== null ? (acc >= 0.8 ? COL_GREEN : acc >= 0.5 ? COL_AMBER : COL_RED) : COL_TEXT;
                const cells = [
                    { label: 'SCORE', val: live ? liveScore.toLocaleString() : '—', color: COL_TEXT },
                    { label: 'STREAK', val: live ? String(liveStreak) : '—', color: COL_AMBER },
                    { label: 'ACCURACY', val: (live && acc !== null) ? Math.round(acc * 100) + '%' : '—', color: accColor },
                ];
                const gap = 34 * u;
                const valFont = 'bold ' + Math.max(15, Math.round(20 * u)) + 'px sans-serif';
                ctx.font = valFont;
                const cw = cells.map((c) => Math.max(ctx.measureText(c.val).width, 52 * u));
                let totalW = cw.reduce((a, b) => a + b, 0) + gap * (cells.length - 1);
                // centre the trio within the ribbon area right of the key gutter
                let x = railW + (ribbonW - railW - totalW) / 2;
                const labY = top + 5 * u, valY = top + 18 * u;
                for (let i = 0; i < cells.length; i++) {
                    const midX = x + cw[i] / 2;
                    ctx.fillStyle = COL_LABEL; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
                    ctx.font = Math.max(9, Math.round(10 * u)) + 'px sans-serif';
                    ctx.fillText(cells[i].label, midX, labY);
                    ctx.fillStyle = cells[i].color; ctx.font = valFont; ctx.textBaseline = 'alphabetic';
                    ctx.fillText(cells[i].val, midX, valY + Math.round(20 * u));
                    x += cw[i] + gap;
                }
            },

            // Thin horizon seam where the wall meets its base. The receding floor
            // was retired to give the note wall + the left pitch scale the full
            // height; this is just a glowing seam + a short lip fade below.
            _drawSeam(ctx, w, seamY, u) {
                const hg = ctx.createLinearGradient(0, seamY - 14 * u, 0, seamY + 14 * u);
                hg.addColorStop(0, 'rgba(150,180,255,0)'); hg.addColorStop(0.5, 'rgba(150,180,255,0.30)'); hg.addColorStop(1, 'rgba(150,180,255,0)');
                ctx.fillStyle = hg; ctx.fillRect(0, seamY - 14 * u, w, 28 * u);
                const lip = ctx.createLinearGradient(0, seamY, 0, seamY + 44 * u);
                lip.addColorStop(0, 'rgba(40,60,140,0.10)'); lip.addColorStop(1, 'rgba(5,6,12,0)');
                ctx.fillStyle = lip; ctx.fillRect(0, seamY, w, 44 * u);
                ctx.strokeStyle = 'rgba(200,220,255,0.6)'; ctx.lineWidth = Math.max(1, 1.5 * u);
                ctx.beginPath(); ctx.moveTo(0, seamY); ctx.lineTo(w, seamY); ctx.stroke();
            },

            _drawTrace(ctx, now, xFor, yFor, railW, playheadX, barH, noteTop, noteBottom, u) {
                const cl = (v) => Math.max(noteTop + 3, Math.min(noteBottom - 3, v));
                ctx.strokeStyle = 'rgba(240,246,255,0.95)';
                ctx.lineWidth = Math.max(1.5, 3 * u);
                ctx.lineJoin = 'round';
                ctx.shadowColor = 'rgba(150,210,255,0.7)';
                ctx.shadowBlur = 8 * u;
                ctx.beginPath();
                let started = false;
                for (let i = 0; i < pitchHistory.length; i++) {
                    const p = pitchHistory[i];
                    const x = Math.min(playheadX, xFor(p.t));
                    if (x < railW) continue;
                    const y = cl(yFor(p.midi) + barH / 2);
                    if (!started) { ctx.moveTo(x, y); started = true; }
                    else ctx.lineTo(x, y);
                }
                if (started) ctx.stroke();
                ctx.shadowBlur = 0;

                const fresh = (_wallNow() - userLastSampleWallAt) <= SAMPLE_FRESH_MS;
                if (fresh && userLastMidi !== null) {
                    if (userDisplayMidi === null) userDisplayMidi = userLastMidi;
                    userDisplayMidi += 0.4 * (userLastMidi - userDisplayMidi);
                    const y = cl(yFor(userDisplayMidi) + barH / 2);
                    ctx.fillStyle = COL_TRACE;
                    ctx.shadowColor = COL_TRACE;
                    ctx.shadowBlur = 10 * u;
                    ctx.beginPath();
                    ctx.arc(playheadX, y, 5 * u, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.shadowBlur = 0;
                }
            },

            _drawHeaders(ctx, railW, ribbonW, playheadX, u) {
                ctx.textBaseline = 'top';
                ctx.textAlign = 'center';
                const midL = railW + (playheadX - railW) / 2;
                const midR = playheadX + (ribbonW - playheadX) / 2;
                ctx.fillStyle = 'rgba(170,180,205,0.7)';
                ctx.font = Math.max(10, Math.round(12 * u)) + 'px sans-serif';
                ctx.fillText('RECENT', midL, 6 * u);
                ctx.fillText('UPCOMING', midR, 6 * u);
                ctx.fillStyle = 'rgba(150,160,190,0.5)';
                ctx.font = Math.max(9, Math.round(10 * u)) + 'px sans-serif';
                ctx.fillText('You sang', midL, 6 * u + Math.max(13, 15 * u));
                ctx.fillText('Follow the notes', midR, 6 * u + Math.max(13, 15 * u));
            },

            // Fixed one-octave chromatic gauge (C→B, C at the bottom) — the SAME
            // every song, so it reads as a stable "what note am I on / how far off"
            // reference, decoupled from the chart's dynamic range. Naturals are the
            // wide labeled keys; sharps the thin keys between (none E–F or B–C). A
            // vertical glow marks your exact pitch: tight & centered on a key =
            // dead-on; riding up = sharp, down = flat; spreading + bleeding across a
            // boundary = between two notes. The nearest-semitone key lights violet;
            // a lit natural carries the octave # + ±cents. See CLAUDE.md.
            _drawKeyRail(ctx, railW, gTop, gBot, u, fresh) {
                const P = Math.max(4, Math.round(6 * u));
                const rad = Math.max(2, Math.round(2 * u));
                const span = gBot - gTop;
                const slot = span / 7;                            // 7 white-key slots over the height
                const yAt = (dia) => gBot - ((dia + 0.5) / 7) * span;   // dia 0=C (bottom) … 6=B (top)
                const bw = railW - 2 * P;
                const natH = Math.max(9, slot * 0.8);
                const shH = Math.max(6, slot * 0.42);
                const shW = Math.max(10, bw * 0.62);
                const fontPx = Math.max(9, Math.round(12 * u));

                ctx.fillStyle = '#080910'; ctx.fillRect(0, gTop, railW, span);
                ctx.strokeStyle = 'rgba(150,160,200,0.15)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(railW + 0.5, gTop); ctx.lineTo(railW + 0.5, gBot); ctx.stroke();

                // Current pitch → nearest semitone (the lit key), octave, cents,
                // and the exact continuous position for the glow.
                let curSemi = -1, octave = 0, cents = 0, pcDia = null, litYc = null, litWide = false;
                if (fresh && userLastMidi !== null) {
                    const semi = Math.round(userLastMidi);
                    curSemi = ((semi % 12) + 12) % 12;
                    octave = Math.floor(semi / 12) - 1;
                    cents = Math.round((userLastMidi - semi) * 100);
                    pcDia = ((diaPosF(userLastMidi) % 7) + 7) % 7;
                    const litDiaPc = ((diaPos(semi) % 7) + 7) % 7;
                    // Keep the glow on its lit key across the B↔C wrap: a pitch a few
                    // cents flat of C must glow at C (bottom), not jump to B (top).
                    if (pcDia - litDiaPc > 3.5) pcDia -= 7;
                    else if (litDiaPc - pcDia > 3.5) pcDia += 7;
                    pcDia = Math.max(0, Math.min(6, pcDia));
                }

                const key = (dia, name, semi, wide) => {
                    const yc = yAt(dia), h = wide ? natH : shH, w = wide ? bw : shW;
                    const on = (semi === curSemi);
                    if (on) { litYc = yc; litWide = wide; }
                    const kg = ctx.createLinearGradient(0, yc - h / 2, 0, yc + h / 2);
                    if (on) { kg.addColorStop(0, COL_NOTE_MID); kg.addColorStop(1, COL_NOTE_DEEP); }
                    else if (wide) { kg.addColorStop(0, '#2a3350'); kg.addColorStop(1, '#10131e'); }
                    else { kg.addColorStop(0, '#171d2e'); kg.addColorStop(1, '#0a0d16'); }
                    ctx.fillStyle = kg;
                    this._rrPath(ctx, P, yc - h / 2, w, h, rad); ctx.fill();
                    if (wide) {
                        ctx.fillStyle = on ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.12)';
                        ctx.fillRect(P + 2 * u, yc - h / 2 + 1.5 * u, Math.max(1, bw - 4 * u), Math.max(1, 1.5 * u));
                    }
                    ctx.strokeStyle = on ? 'rgba(240,231,255,0.9)' : 'rgba(150,160,200,0.22)'; ctx.lineWidth = 1;
                    this._rrPath(ctx, P, yc - h / 2, w, h, rad); ctx.stroke();
                    if (wide) {
                        ctx.fillStyle = on ? '#1e1040' : 'rgba(214,220,238,0.92)';
                        ctx.font = (on ? 'bold ' : '') + fontPx + 'px sans-serif';
                        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                        ctx.fillText(name, P + 5 * u, yc);
                    }
                };
                // Naturals (wide) first, then sharps (thin) on top like black keys.
                [[0, 'C', 0], [1, 'D', 2], [2, 'E', 4], [3, 'F', 5], [4, 'G', 7], [5, 'A', 9], [6, 'B', 11]]
                    .forEach((k) => key(k[0], k[1], k[2], true));
                [[0.5, '', 1], [1.5, '', 3], [3.5, '', 6], [4.5, '', 8], [5.5, '', 10]]
                    .forEach((k) => key(k[0], k[1], k[2], false));

                // Vertical glow at the exact pitch: tight & bright when dead-on,
                // taller/softer + bleeding across boundaries as you drift off.
                if (pcDia !== null) {
                    const closeness = Math.max(0, 1 - Math.min(Math.abs(cents), 50) / 50);
                    const gy = yAt(pcDia), gh = natH * (0.26 + (1 - closeness) * 0.55);
                    ctx.save();
                    ctx.shadowColor = 'rgba(255,255,255,0.9)'; ctx.shadowBlur = (4 + (1 - closeness) * 8) * u;
                    ctx.fillStyle = `rgba(255,255,255,${(0.55 + 0.4 * closeness).toFixed(3)})`;
                    this._rrPath(ctx, P + 3 * u, gy - gh / 2, bw - 6 * u, Math.max(2, gh), rad); ctx.fill();
                    ctx.restore();
                    // Octave # + ±cents in the lit natural's corner (skip on a thin sharp).
                    if (litWide && litYc !== null) {
                        ctx.fillStyle = '#1e1040'; ctx.textAlign = 'right';
                        ctx.textBaseline = 'alphabetic'; ctx.font = 'bold ' + Math.max(9, Math.round(11 * u)) + 'px sans-serif';
                        ctx.fillText(String(octave), P + bw - 4 * u, litYc - 2 * u);
                        ctx.textBaseline = 'top'; ctx.font = Math.max(7, Math.round(8 * u)) + 'px sans-serif';
                        ctx.fillText((cents > 0 ? '+' : '') + cents, P + bw - 4 * u, litYc + 2 * u);
                    }
                }
            },

            // "Voice technique" left-bar option: Stability (short-window pitch
            // steadiness) + Vibrato (rate when a real modulation is present) — both
            // from updateVoiceMetrics, kept honest (no value unless fresh; vibrato
            // only when actually detected). Cool colors, NOT the red/amber/green
            // accuracy scale — this is expression, not correctness. See CLAUDE.md.
            _drawVoicePanel(ctx, railW, gTop, gBot, u, fresh) {
                const span = gBot - gTop, cx = railW / 2;
                ctx.fillStyle = '#080910'; ctx.fillRect(0, gTop, railW, span);
                ctx.strokeStyle = 'rgba(150,160,200,0.15)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(railW + 0.5, gTop); ctx.lineTo(railW + 0.5, gBot); ctx.stroke();
                const stab = (fresh && voiceStability !== null) ? voiceStability : null;
                const vib = (fresh && voiceVibrato && voiceVibrato.present) ? voiceVibrato : null;
                const label = (t, y) => {
                    ctx.fillStyle = 'rgba(150,160,190,0.7)'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
                    ctx.font = Math.max(8, Math.round(9 * u)) + 'px sans-serif'; ctx.fillText(t, cx, y);
                };
                const value = (t, y, on) => {
                    ctx.fillStyle = on ? '#e7ecf7' : 'rgba(200,205,225,0.35)'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
                    ctx.font = 'bold ' + Math.max(11, Math.round(14 * u)) + 'px sans-serif'; ctx.fillText(t, cx, y);
                };
                const midY = gTop + span * 0.5;
                // ── Steadiness (vertical fill bar) ──
                label('STEADY', gTop + 8 * u);
                const barW = Math.max(12, Math.round(18 * u)), barX = cx - barW / 2;
                const barTop = gTop + 26 * u, barBot = midY - 28 * u;
                ctx.fillStyle = 'rgba(255,255,255,0.06)'; this._rrPath(ctx, barX, barTop, barW, Math.max(2, barBot - barTop), 4 * u); ctx.fill();
                if (stab !== null && barBot > barTop) {
                    const fh = (barBot - barTop) * stab;
                    ctx.fillStyle = 'rgba(120,210,255,0.85)';
                    this._rrPath(ctx, barX, barBot - fh, barW, Math.max(2, fh), 4 * u); ctx.fill();
                }
                value(stab !== null ? String(Math.round(stab * 100)) : '—', barBot + 5 * u, stab !== null);
                // ── Vibrato (wave glyph + rate) ──
                label('VIBRATO', midY + 6 * u);
                const wy = midY + 32 * u, ww = Math.min(railW - 14 * u, Math.round(44 * u)), wx = cx - ww / 2, amp = vib ? 5 * u : 1.5 * u;
                ctx.strokeStyle = vib ? 'rgba(192,132,252,0.9)' : 'rgba(150,160,200,0.25)'; ctx.lineWidth = Math.max(1.5, 2 * u);
                ctx.beginPath();
                for (let i = 0; i <= 20; i++) { const t = i / 20, xx = wx + t * ww, yy = wy + Math.sin(t * Math.PI * 4) * amp; if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); }
                ctx.stroke();
                value(vib ? vib.hz.toFixed(1) + 'Hz' : '—', wy + 14 * u, !!vib);
            },

            _draw3DLyrics(ctx, now, railW, ribbonW, H, seamY, u) {
                if (!this._lines) { this._lines = buildLines(this._tokens); this._beat = this._computeBeat(); this._ballX = null; }
                const lines = this._lines;
                let li = 0;
                while (li < lines.length && now >= lines[li].t1 + 0.3) li++;
                if (li >= lines.length) return;
                const cy = seamY + (H - seamY) * 0.20;
                const fontPx = Math.max(16, Math.round(Math.min(36 * u, 44)));
                const info = this._drawLyricLine3D(ctx, lines[li], now, railW, ribbonW, fontPx, cy, true);
                if (li + 1 < lines.length) {
                    this._drawLyricLine3D(ctx, lines[li + 1], now, railW, ribbonW,
                        Math.max(12, Math.round(fontPx * 0.55)), cy + fontPx * 1.4, false);
                }
                // Karaoke bouncing ball + silent-lead-in countdown, under the words.
                this._drawLyricBall(ctx, lines[li], li, lines, now, info, fontPx, cy, railW, u);
            },

            // Bouncing ball rides UNDER the lyric line: it hops once per syllable
            // while the line is being sung, and during a silent lead-in (>=1.5s
            // gap) it bounces under a get-ready countdown to the first word.
            _drawLyricBall(ctx, line, li, lines, now, info, fontPx, cy, railW, u) {
                const ballY = cy + fontPx * 0.8;      // resting line, below the words
                const amp = fontPx * 0.28;
                const r = Math.max(3, fontPx * 0.16);
                // Steady metronome bounce — one arc per beat, independent of the
                // (uneven) syllable rhythm, so it doesn't jump around.
                const beat = this._beat || 0.5;
                // Anchor the phase to the line start so a landing coincides with the
                // first word (and the countdown lands exactly when singing begins).
                const bounce = Math.abs(Math.sin(Math.PI * (now - line.t0) / beat));
                const gapStart = li > 0 ? lines[li - 1].t1 : 0;
                const leadIn = line.t0 - gapStart, remain = line.t0 - now;
                let target = null, numX = 0, showNum = false;
                if (now < line.t0 && leadIn >= 2 && remain > 0 && remain <= 20) {
                    numX = Math.max(railW + fontPx * 0.8, info.x0 - fontPx * 1.3);
                    target = numX; showNum = true;    // silent lead-in: countdown to the line
                } else if (info.activeX !== null) {
                    target = info.activeX;            // singing: follow the words
                }
                if (target === null) { this._ballX = null; return; }
                // Glide the ball horizontally (ease toward the target) so it tracks
                // the words smoothly instead of snapping per syllable.
                this._ballX = (this._ballX == null) ? target : this._ballX + (target - this._ballX) * 0.18;
                if (showNum) {
                    ctx.fillStyle = 'rgba(120,210,255,0.95)';
                    ctx.font = 'bold ' + Math.round(fontPx * 1.1) + 'px sans-serif';
                    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    ctx.fillText(remain.toFixed(1), numX, cy);
                }
                this._ball(ctx, this._ballX, ballY - amp * bounce, r, u);
            },
            // A steady bounce period (~one beat) for the ball — the song's median
            // syllable spacing folded into a musical range, so the ball ticks like a
            // metronome regardless of the syllable rhythm. (No BPM is on the wire.)
            _computeBeat() {
                const ts = (this._tokens || []).map((t) => t.t).filter((x) => typeof x === 'number');
                const diffs = [];
                for (let i = 1; i < ts.length; i++) { const d = ts[i] - ts[i - 1]; if (d > 0.08 && d < 3) diffs.push(d); }
                let beat = 0.5;
                if (diffs.length) { diffs.sort((a, b) => a - b); beat = diffs[Math.floor(diffs.length / 2)]; }
                while (beat < 0.4) beat *= 2;      // sub-beat → beat
                while (beat > 0.9) beat /= 2;
                return Math.max(0.35, Math.min(0.95, beat));
            },
            _ball(ctx, x, y, r, u) {
                ctx.save();
                ctx.shadowColor = 'rgba(150,210,255,0.85)'; ctx.shadowBlur = 6 * u;
                ctx.fillStyle = '#eaf4ff';
                ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
                ctx.restore();
            },

            // One assembled lyric line, centered vertically at `y` in the
            // bottom band. Primary lines are bold with per-syllable coloring;
            // the preview line is smaller and uniformly dim.
            _drawLyricLine3D(ctx, line, now, railW, ribbonW, fontPx, y, primary) {
                const tokens = this._tokens;
                const areaX = railW;
                const areaW = ribbonW - railW;
                const maxW = areaW * 0.96;
                const weight = primary ? 'bold ' : '';
                // Open the line up horizontally — extra letter/word spacing reads
                // easier and uses the wide stage. (No-op on canvases lacking
                // letterSpacing/wordSpacing; where supported, measureText accounts
                // for it, so re-measuring keeps the centering correct.)
                const ls = Math.max(1, Math.round(fontPx * 0.04));
                const ws = Math.max(2, Math.round(fontPx * 0.32));
                let font = fontPx;
                ctx.font = weight + font + 'px sans-serif';
                ctx.letterSpacing = ls + 'px'; ctx.wordSpacing = ws + 'px';
                const measure = () => {
                    let t = 0;
                    for (let p = 0; p < line.parts.length; p++) {
                        const part = line.parts[p];
                        t += ctx.measureText(part.text + (part.join || p === line.parts.length - 1 ? '' : ' ')).width;
                    }
                    return t;
                };
                let total = measure();
                if (total > maxW && total > 0) {
                    font = Math.max(11, Math.floor(font * (maxW / total)));
                    ctx.font = weight + font + 'px sans-serif';
                    total = measure();
                }
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                const x0 = areaX + (areaW - total) / 2;
                let x = x0, activeX = null, phase = 0, lastX = null;
                for (let p = 0; p < line.parts.length; p++) {
                    const part = line.parts[p];
                    const tok = tokens[part.idx];
                    const piece = part.text + (part.join || p === line.parts.length - 1 ? '' : ' ');
                    const w = ctx.measureText(piece).width;
                    if (!primary) {
                        ctx.fillStyle = 'rgba(150,160,190,0.55)';
                    } else if (tok.t + (tok.d || 0) <= now) {
                        ctx.fillStyle = COL_BAR_FILL;
                    } else if (tok.t <= now) {
                        ctx.fillStyle = '#ffffff';
                    } else {
                        ctx.fillStyle = COL_TEXT_PAST;
                    }
                    ctx.fillText(piece, x, y);
                    if (primary && tok) {           // track where the ball should ride
                        const c = x + w / 2;
                        if (tok.t <= now) lastX = c;
                        if (tok.t <= now && now < tok.t + (tok.d || 0)) { activeX = c; phase = (now - tok.t) / (tok.d || 0.25); }
                    }
                    x += w;
                }
                ctx.letterSpacing = '0px'; ctx.wordSpacing = '0px';   // reset — don't leak to other text
                if (activeX === null && lastX !== null) { activeX = lastX; phase = 1; }
                return { x0, x1: x, activeX, phase };
            },

            _drawStatsPanel(ctx, x0, w, H, u, isOwner) {
                ctx.fillStyle = COL_PANEL_BG;
                ctx.fillRect(x0, 0, w, H);
                ctx.strokeStyle = COL_PANEL_BORDER; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, H); ctx.stroke();

                const pad = 26 * u, cx = x0 + pad, rightX = x0 + w - pad;
                const acc = sessionAccuracy();
                const live = isOwner && micState !== 'off';
                const fresh = isOwner && (_wallNow() - userLastSampleWallAt) <= SAMPLE_FRESH_MS && userLastMidi !== null;
                const lab = (t, yy) => { ctx.fillStyle = COL_LABEL; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = Math.max(9, Math.round(11 * u)) + 'px sans-serif'; ctx.fillText(t, cx, yy); };
                const num = (t, px, c, yy) => { ctx.fillStyle = c; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.font = 'bold ' + Math.round(px * u) + 'px sans-serif'; ctx.fillText(t, cx, yy); };
                const divider = (yy) => { ctx.strokeStyle = COL_PANEL_BORDER; ctx.beginPath(); ctx.moveTo(cx, yy); ctx.lineTo(rightX, yy); ctx.stroke(); };

                // Start below the floating DOM mic strip (⚙ 🎤) at top-right.
                let y = Math.max(30 * u, 32);
                lab('SCORE', y); num(live ? liveScore.toLocaleString() : '—', 34, COL_TEXT, y + 52 * u); y += 78 * u;
                lab('STREAK', y); num(live ? (liveStreak + (liveStreak >= 8 ? '  🔥' : '')) : '—', 24, COL_AMBER, y + 44 * u); y += 62 * u;
                lab('ACCURACY', y); num((live && acc !== null) ? Math.round(acc * 100) + '%' : '—', 24, acc !== null ? (acc >= 0.8 ? COL_GREEN : acc >= 0.5 ? COL_AMBER : COL_RED) : COL_TEXT, y + 44 * u); y += 66 * u;
                divider(y); y += 26 * u;
                lab('CURRENT NOTE', y);
                ctx.fillStyle = fresh ? COL_AMBER : 'rgba(200,205,225,0.35)';
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.font = 'bold ' + Math.round(40 * u) + 'px sans-serif';
                ctx.fillText(fresh ? midiToName(userLastMidi) : '—', cx, y + 50 * u);
                const cents = fresh ? Math.round((userLastMidi - Math.round(userLastMidi)) * 100) : null;
                this._drawCentsGauge(ctx, rightX - 104 * u, y + 2 * u, 100 * u, u, cents);
                y += 100 * u;
                divider(y); y += 26 * u;
                lab('VOICE', y); y += 52 * u;
                const half = (rightX - cx) / 2;
                const stab = (fresh && voiceStability !== null) ? voiceStability : null;
                this._drawRing(ctx, cx + half * 0.5, y, 28 * u, u,
                    stab !== null ? stab : 0,
                    stab !== null ? Math.round(stab * 100) + '%' : '—',
                    stab !== null ? (stab >= 0.66 ? COL_GREEN : stab >= 0.33 ? COL_AMBER : COL_RED) : 'rgba(200,205,225,0.3)',
                    'Stability');
                const vib = (fresh && voiceVibrato && voiceVibrato.present) ? voiceVibrato : null;
                this._drawRing(ctx, cx + half * 1.5, y, 28 * u, u,
                    vib ? Math.min(1, vib.hz / 8) : 0,
                    vib ? '≈' + Math.round(vib.hz) + 'Hz' : '—',
                    vib ? '#a78bfa' : 'rgba(200,205,225,0.3)',
                    'Vibrato');
                y += 88 * u;
                if (isOwner) {
                    lab('INPUT', y + 2 * u);
                    const barX = cx + 46 * u, barW = rightX - barX, bh = 9 * u;
                    ctx.fillStyle = 'rgba(255,255,255,0.08)'; this._roundRect(ctx, barX, y, barW, bh, 4 * u);
                    const lvl = Math.max(0, Math.min(1, micInputLevel * 4));
                    if (micState === 'listening' && lvl > 0.001) {
                        ctx.fillStyle = lvl > 0.9 ? COL_RED : COL_GREEN;
                        this._roundRect(ctx, barX, y, Math.max(2, barW * lvl), bh, 4 * u);
                    }
                }
            },

            // Rounded-rect path only (caller fills or strokes) — for key tiles.
            _rrPath(ctx, x, y, w, h, r) {
                const rr = Math.min(r, w / 2, h / 2);
                ctx.beginPath();
                ctx.moveTo(x + rr, y);
                ctx.arcTo(x + w, y, x + w, y + h, rr);
                ctx.arcTo(x + w, y + h, x, y + h, rr);
                ctx.arcTo(x, y + h, x, y, rr);
                ctx.arcTo(x, y, x + w, y, rr);
                ctx.closePath();
            },

            _drawCentsGauge(ctx, x, y, size, u, cents) {
                const cxg = x + size / 2;
                const cyg = y + size * 0.70;
                const r = size * 0.44;
                ctx.lineWidth = Math.max(3, 5 * u);
                // Colored scale zones (green in-tune → amber → red), always shown.
                const seg = (c0, c1, color) => {
                    ctx.strokeStyle = color;
                    ctx.beginPath();
                    ctx.arc(cxg, cyg, r, Math.PI + (c0 + 50) / 100 * Math.PI, Math.PI + (c1 + 50) / 100 * Math.PI);
                    ctx.stroke();
                };
                seg(-50, -25, COL_RED); seg(-25, -10, COL_AMBER); seg(-10, 10, COL_GREEN);
                seg(10, 25, COL_AMBER); seg(25, 50, COL_RED);
                if (cents === null) {
                    ctx.fillStyle = COL_LABEL; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
                    ctx.font = Math.max(9, Math.round(10 * u)) + 'px sans-serif';
                    ctx.fillText('CENTS', cxg, cyg + 6 * u);
                    return;
                }
                const clamped = Math.max(-50, Math.min(50, cents));
                const ang = Math.PI + (clamped + 50) / 100 * Math.PI;
                const near = Math.abs(cents) <= 10;
                const nc = near ? COL_GREEN : (Math.abs(cents) <= 25 ? COL_AMBER : COL_RED);
                // Needle as a rim tick (does not cross the readout at the center).
                ctx.strokeStyle = nc; ctx.lineWidth = Math.max(2, 3.5 * u);
                ctx.beginPath();
                ctx.moveTo(cxg + 0.80 * r * Math.cos(ang), cyg + 0.80 * r * Math.sin(ang));
                ctx.lineTo(cxg + 1.08 * r * Math.cos(ang), cyg + 1.08 * r * Math.sin(ang));
                ctx.stroke();
                ctx.fillStyle = nc; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.font = 'bold ' + Math.max(14, Math.round(19 * u)) + 'px sans-serif';
                ctx.fillText((cents > 0 ? '+' : '') + cents, cxg, cyg - r * 0.20);
                ctx.fillStyle = COL_LABEL; ctx.textBaseline = 'top';
                ctx.font = Math.max(9, Math.round(10 * u)) + 'px sans-serif';
                ctx.fillText('CENTS', cxg, cyg + 6 * u);
            },

            _drawRing(ctx, cx, cy, r, u, frac, label, color, sub) {
                ctx.lineWidth = Math.max(3, 5 * u);
                ctx.strokeStyle = 'rgba(255,255,255,0.10)';
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.stroke();
                if (frac > 0) {
                    ctx.strokeStyle = color;
                    ctx.beginPath();
                    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, frac)));
                    ctx.stroke();
                }
                ctx.fillStyle = color;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.font = 'bold ' + Math.max(11, Math.round(14 * u)) + 'px sans-serif';
                ctx.fillText(label, cx, cy + 2 * u);
                if (sub) {
                    ctx.fillStyle = COL_LABEL;
                    ctx.textBaseline = 'top';
                    ctx.font = Math.max(9, Math.round(12 * u)) + 'px sans-serif';
                    ctx.fillText(sub, cx, cy + r + 10 * u);
                }
            },

            _drawDifficultyBadge(ctx, x0, wantStats, u) {
                const d = this._difficulty;
                if (!d) return;
                const bandColor = d.band === 'Easy' ? COL_GREEN
                    : d.band === 'Medium' ? COL_AMBER
                    : d.band === 'Hard' ? '#fb923c' : COL_RED;
                const label = 'EST. DIFFICULTY';
                const px = Math.max(10, Math.round(11 * u));
                ctx.font = 'bold ' + px + 'px sans-serif';
                const bandW = ctx.measureText(d.band.toUpperCase()).width;
                ctx.font = Math.max(9, Math.round(9 * u)) + 'px sans-serif';
                const labW = ctx.measureText(label).width;
                const boxW = Math.max(bandW, labW) + 20 * u;
                const boxH = 34 * u;
                const bx = wantStats ? (x0 - boxW - 10 * u) : (10 * u);
                const by = 8 * u;
                ctx.fillStyle = 'rgba(12,14,22,0.8)';
                this._roundRect(ctx, bx, by, boxW, boxH, 6 * u);
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillStyle = COL_LABEL;
                ctx.font = Math.max(9, Math.round(9 * u)) + 'px sans-serif';
                ctx.fillText(label, bx + 10 * u, by + 5 * u);
                ctx.fillStyle = bandColor;
                ctx.font = 'bold ' + px + 'px sans-serif';
                ctx.fillText(d.band.toUpperCase(), bx + 10 * u, by + 17 * u);
            },

            _drawSessionPill(ctx, W, H, u) {
                const acc = sessionAccuracy();
                let text;
                const fresh = (_wallNow() - userLastSampleWallAt) <= SAMPLE_FRESH_MS;
                if (micState === 'listening') {
                    text = '🎤 ' + (acc !== null ? Math.round(acc * 100) + '%' : '—');
                    if (fresh && userDisplayMidi !== null) text += ' · ' + midiToName(userDisplayMidi);
                } else if (micState === 'requesting') {
                    text = '🎤 …';
                } else {
                    text = '🎤 mic error — click 🎤 to retry';
                }
                const fontPx2 = Math.max(12, Math.round(16 * u));
                ctx.font = fontPx2 + 'px sans-serif';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                const pad2 = 8 * u;
                const tw = ctx.measureText(text).width;
                const ph = fontPx2 + 12 * u;
                const pillY = Math.max(88, 60 * u);
                ctx.fillStyle = 'rgba(16,16,24,0.75)';
                this._roundRect(ctx, 8 * u, pillY, tw + pad2 * 2, ph, 6 * u);
                ctx.fillStyle = micState === 'error' ? COL_RED : COL_TEXT;
                ctx.fillText(text, 8 * u + pad2, pillY + ph / 2);
            },

            _drawSummaryCard(ctx, ribbonW, H, u) {
                const s = lastSummary;
                const line1 = 'Vocals — ' + Math.round(s.accuracy * 100) + '%';
                const line2 = s.hits + '/' + s.pitched + ' syllables · best streak ' + s.bestStreak;
                const line3 = 'Score ' + (s.score || 0).toLocaleString();
                const f1 = Math.max(18, Math.round(30 * u));
                const f2 = Math.max(12, Math.round(16 * u));
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.font = 'bold ' + f1 + 'px sans-serif';
                const w1 = ctx.measureText(line1).width;
                ctx.font = f2 + 'px sans-serif';
                const w2 = Math.max(ctx.measureText(line2).width, ctx.measureText(line3).width);
                const cardW = Math.max(w1, w2) + 48 * u;
                const cardH = f1 + f2 * 2 + 48 * u;
                const cx2 = ribbonW / 2;
                const cy2 = H / 2;
                ctx.fillStyle = 'rgba(12,12,20,0.92)';
                this._roundRect(ctx, cx2 - cardW / 2, cy2 - cardH / 2, cardW, cardH, 10 * u);
                ctx.fillStyle = COL_BAR_ACTIVE;
                ctx.font = 'bold ' + f1 + 'px sans-serif';
                ctx.fillText(line1, cx2, cy2 - f2 - 6 * u);
                ctx.fillStyle = COL_TEXT;
                ctx.font = f2 + 'px sans-serif';
                ctx.fillText(line2, cx2, cy2 + 4 * u);
                ctx.fillStyle = COL_AMBER;
                ctx.fillText(line3, cx2, cy2 + f2 + 8 * u);
            },

            // One assembled lyric line, centered. `primary` lines get sung /
            // active / upcoming coloring per syllable; preview lines render
            // uniformly dim. Font shrinks (to a floor) when the line would
            // overflow the canvas.
            _drawLyricLine(ctx, line, now, W, fontPx, y, primary) {
                const tokens = this._tokens;
                const maxW = W * 0.94;
                let font = fontPx;
                ctx.font = font + 'px sans-serif';
                let total = 0;
                for (let p = 0; p < line.parts.length; p++) {
                    const part = line.parts[p];
                    const piece = part.text + (part.join || p === line.parts.length - 1 ? '' : ' ');
                    total += ctx.measureText(piece).width;
                }
                if (total > maxW && total > 0) {
                    font = Math.max(11, Math.floor(font * (maxW / total)));
                    ctx.font = font + 'px sans-serif';
                    total = total * (font / fontPx);
                }
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                let x = (W - total) / 2;
                for (let p = 0; p < line.parts.length; p++) {
                    const part = line.parts[p];
                    const tok = tokens[part.idx];
                    const piece = part.text + (part.join || p === line.parts.length - 1 ? '' : ' ');
                    if (!primary) {
                        ctx.fillStyle = 'rgba(160,170,200,0.55)';
                    } else if (tok.t + (tok.d || 0) <= now) {
                        ctx.fillStyle = COL_BAR_FILL;       // sung — gold
                    } else if (tok.t <= now) {
                        ctx.fillStyle = '#ffffff';          // active syllable
                    } else {
                        ctx.fillStyle = COL_TEXT_PAST;      // upcoming — dim
                    }
                    ctx.fillText(piece, x, y);
                    x += ctx.measureText(piece).width;
                }
            },

            _roundRect(ctx, x, y, w, h, r) {
                const rr = Math.min(r, w / 2, h / 2);
                ctx.beginPath();
                ctx.moveTo(x + rr, y);
                ctx.arcTo(x + w, y, x + w, y + h, rr);
                ctx.arcTo(x + w, y + h, x, y + h, rr);
                ctx.arcTo(x, y + h, x, y, rr);
                ctx.arcTo(x, y, x + w, y, rr);
                ctx.closePath();
                ctx.fill();
            },

            _drawStatus(ctx, W, H) {
                const msg = this._status === 'loading' ? 'Loading vocals data…'
                    : this._status === 'nodata' ? 'No vocal data in this song'
                    : 'Waiting for song data…';
                ctx.fillStyle = COL_STATUS;
                ctx.font = Math.max(14, Math.round(H / 26)) + 'px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(msg, W / 2, H / 2);
            },

            // Corner tag so an active-but-empty state is never mistaken for
            // "no renderer selected" (that ambiguity cost a debugging round).
            _drawWatermark(ctx, W, H) {
                ctx.fillStyle = 'rgba(160,170,200,0.35)';
                ctx.font = Math.max(10, Math.round(H / 40)) + 'px sans-serif';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'bottom';
                ctx.fillText('Karaoke Highway', W - 8, H - 6);
            },
        };
    }

    function _fmtTime(sec) {
        const s = Math.max(0, Math.floor(sec));
        const m = Math.floor(s / 60);
        return m + ':' + String(s % 60).padStart(2, '0');
    }

    // ── Browser registration (guarded so the file is require-able in Node) ──
    if (typeof window !== 'undefined') {
        window.feedBackViz_vocals_highway = function () {
            return createRenderer();
        };
        window.feedBackViz_vocals_highway.contextType = '2d';

        // Announce vocals into the capability graph at load: note-detection
        // provider + audio-input mic source. Guarded (silent no-op without the
        // graph) and idempotent (startMic re-checks the flags via _openNdBinding).
        _ensureCapsRegistered();

        // Narrow on purpose (first match wins in picker order): only claim
        // arrangements that BOTH carry notation and are named like vocals, so
        // keys/piano notation songs stay with their own highways. songInfo
        // exposes no arrangement `type`, so the name is the discriminator.
        //
        // Auto-priority note: the picker is sorted by plugin DISPLAY NAME
        // (app.js loadPlugins sorts by name before _populateVizPicker — its
        // "discovery order" comment is stale), and the bundled keys highway
        // matches bare has_notation. Our manifest name "Karaoke Highway"
        // deliberately sorts before "Keys Highway 3D" so Auto resolves vocals
        // arrangements to us. Do not rename without re-checking that sort.
        window.feedBackViz_vocals_highway.matchesArrangement = function (songInfo) {
            const si = songInfo || {};
            const hasNotation = !!(si.hasNotation || si.has_notation);
            return hasNotation && /vocal|sing/i.test(String(si.arrangement || ''));
        };

        if (typeof window.registerShortcut === 'function') {
            window.registerShortcut({
                key: 'm',
                scope: 'player',
                description: 'Toggle vocals mic (Karaoke Highway)',
                condition: () => !!_activeInstance,
                handler: () => {
                    if (micState === 'listening' || micState === 'requesting') stopMic({ keepFlag: false });
                    else startMic();
                },
            });
        }

        // Headless verification hook (same pattern as keys_highway_3d's
        // __keysHwTest): lets an automated probe drive the mic engine and read
        // scoring state without a physical microphone or human in the loop.
        window.__vocalsHighwayTest = {
            startMic,
            stopMic,
            estimateDifficulty,
            getState() {
                let samplesIn = 0;
                let matched = 0;
                userResults.forEach((e) => { samplesIn += e.samplesIn; matched += e.samplesMatched; });
                return {
                    micState,
                    micErrorMsg,
                    scoredTokens: userResults.size,
                    samplesIn,
                    samplesMatched: matched,
                    sessionAccuracy: sessionAccuracy(),
                    lastMidi: userLastMidi,
                    hasActiveInstance: !!_activeInstance,
                    tokensLoaded: !!(_activeInstance && _activeInstance._tokens && _activeInstance._tokens.length),
                    difficulty: _activeInstance ? _activeInstance._difficulty : null,
                    liveScore,
                    liveStreak,
                    liveBestStreak,
                    voiceStability,
                    voiceVibrato,
                    micInputLevel,
                    historyLen: pitchHistory.length,
                    summary: lastSummary,
                    prefs: { ...prefs },
                    songNow: _songNow(),
                    lastCapturedAt: micLastCapturedAt,
                    usingBridge: micUsingBridge,
                    audioInputMode: _lsGet(KEY_AUDIO_INPUT_MODE) || 'auto',
                    overlayStoodDown: _overlayStoodDown,
                    overlayActive: _overlayActive(),
                    voices: (_activeInstance && Array.isArray(_activeInstance._voices))
                        ? _activeInstance._voices.map((v) => ({ id: v.id, name: v.name, primary: v.primary, tokens: v.tokens.length }))
                        : [],
                    scoredVoiceId: (_activeInstance && _activeInstance._voices && _activeInstance._scoredIdx >= 0)
                        ? _activeInstance._voices[_activeInstance._scoredIdx].id : null,
                    preferredVoiceId: _preferredVoiceId,
                    caps: {
                        providerRegistered: _ndProviderRegistered,
                        sourceRegistered: _inputSourceRegistered,
                        bindingId: _ndBindingId,
                        selectedInput: _selectedInputKey,
                    },
                };
            },
        };
    }

    // ── Node/CommonJS export for unit tests (pure helpers only) ─────────────
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            estimateDifficulty,
            computePitchRange,
            buildLines,
            syllableText,
            freqToMidi,
            midiToName,
        };
    }
})();
