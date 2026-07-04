/* Karaoke Highway — SingStar-style pitch-ribbon renderer for Vocals arrangements.
 *
 * setRenderer visualization plugin (feedBack#36 contract): the factory on
 * window.feedBackViz_vocals_highway returns a fresh renderer instance per
 * call ({contextType, init, draw, destroy}), and Auto mode selects it via
 * the static matchesArrangement predicate.
 *
 * Provenance: ribbon geometry, pitch-range logic, palette, and the mic/YIN/
 * scoring engine are adapted from feedBack-plugin-lyrics-karaoke screen.js
 * (AGPL-3.0), promoted from a 140px overlay strip to the full highway
 * surface; this plugin is licensed AGPL-3.0 accordingly (see LICENSE).
 */
(function () {
    'use strict';

    // ── Ribbon tunables (adapted from lyrics-karaoke, rescaled) ──────────
    const VISIBLE_SECONDS = 6.0;   // horizontal time window
    const PLAYHEAD_FRAC = 0.18;    // playhead at 18% from the left edge
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

    // ── Shared token cache (read-only data; safe across instances) ───────
    // filename → tokens array. Keeps destroy()→init() cycles (every song
    // start does one) and splitscreen twins from refetching the same song.
    const _tokenCache = new Map();
    const _TOKEN_CACHE_CAP = 8;

    function _cacheTokens(filename, tokens) {
        if (_tokenCache.size >= _TOKEN_CACHE_CAP && !_tokenCache.has(filename)) {
            const oldest = _tokenCache.keys().next().value;
            _tokenCache.delete(oldest);
        }
        _tokenCache.set(filename, tokens);
    }

    async function _fetchTokens(filename) {
        const url = '/api/plugins/vocals_highway/data?filename=' + encodeURIComponent(filename);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('vocals_highway data: HTTP ' + resp.status);
        const data = await resp.json();
        if (!data || !Array.isArray(data.tokens)) throw new Error('vocals_highway data: malformed payload');
        return data.tokens;
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
        const cs = window.feedBack && window.feedBack.currentSong;
        return (cs && cs.filename) || '';
    }

    // ── Mic + YIN + scoring engine ────────────────────────────────────────
    //
    // Ported from feedBack-plugin-lyrics-karaoke screen.js (AGPL-3.0):
    // YIN detector, ScriptProcessor ring-buffer capture with midpoint
    // song-time tagging, transport-aware per-syllable scoring. Module-level
    // singleton — one physical mic, one scoring session; the active
    // renderer instance attaches on init and provides tokens + pitch range.
    // Additions over the karaoke original: an explicit input-device picker
    // (persisted deviceId — the mic is a different physical input than the
    // guitar interface channel) and optional octave-independent matching.
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
    const COL_TRACE = '#22d3ee';
    const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    let _yinWorkBuffer = new Float32Array(2048);

    function midiToName(midi) {
        const r = Math.round(midi);
        const pc = ((r % 12) + 12) % 12;
        return PITCH_NAMES[pc] + (Math.floor(r / 12) - 1);
    }

    function freqToMidi(freq) {
        return 12 * Math.log2(freq / 440) + 69;
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

    // Per-song scoring state.
    const userResults = new Map();    // tokenIndex → {samplesIn, samplesMatched, accuracy}
    let userLastMidi = null;          // latest raw detected midi
    let userDisplayMidi = null;       // smoothed value for the trace marker
    let userLastSampleWallAt = -Infinity;

    function _wallNow() {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
    }

    function _songNow() {
        return (window.highway && typeof window.highway.getTime === 'function')
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
    const prefs = { tolerance: 1.0, octaveFree: false, channel: 'mix' };

    function _readPrefs() {
        const t = parseFloat(_lsGet(KEY_TOLERANCE));
        prefs.tolerance = isFinite(t) ? Math.min(3, Math.max(0.25, t)) : 1.0;
        prefs.octaveFree = _lsGet(KEY_OCTAVE_FREE) === '1';
        const ch = _lsGet(KEY_MIC_CHANNEL);
        prefs.channel = (ch === '1' || ch === '2') ? ch : 'mix';
    }
    _readPrefs();

    function resetScoring() {
        userResults.clear();
        userLastMidi = null;
        userDisplayMidi = null;
        userLastSampleWallAt = -Infinity;
        micLastCapturedAt = -Infinity;
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

    function processYinFrame(buffer, sampleRate, capturedAt, sessionAtCapture) {
        if (sessionAtCapture !== micSessionGen) return;  // stop happened mid-frame

        // Transport awareness: a real seek-back wipes bookkeeping so old
        // scores don't resurrect; a stalled playhead (pause) drops the frame
        // so samplesIn can't inflate against the syllable under the cursor.
        // The threshold matters: the highway clock's AV-drift resync steps
        // backward by a few ms mid-song (observed live), and the karaoke
        // original resets on ANY negative delta — silently wiping scores
        // mid-take. Only treat sizeable jumps as transport rewinds; drop
        // micro-backstep frames like stalls. (Upstream-fix fodder for the
        // lyrics-karaoke overlay.)
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

        const inst = _activeInstance;
        const tokens = inst && inst._tokens;
        if (!tokens) return;
        const idx = findActiveTokenIndex(tokens, capturedAt);
        if (idx < 0) return;
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
        return { accuracy: acc, hits, pitched, bestStreak };
    }

    if (window.feedBack && typeof window.feedBack.on === 'function') {
        window.feedBack.on('song:ended', () => {
            if (!_activeInstance || userResults.size === 0) return;
            const s = computeSummary(_activeInstance._tokens);
            if (s) lastSummary = s;
        });
    }

    async function startMic() {
        if (micState === 'listening' || micState === 'requesting') return;
        micState = 'requesting';
        micErrorMsg = '';
        _refreshMicStrips();

        const session = ++micSessionGen;
        let pendingStream = null;
        let pendingCtx = null;
        try {
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
                ring.copyWithin(0, n);            // slide left in place
                ring.set(input, ringSize - n);    // new frame fills the tail
                ringCount += n;
                if (ringCount >= ringSize) {
                    pending.set(ring);
                    micPendingBufferAt = _scoreClockNow() - midpointWallSec * getPlaybackRate();
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
            }, 50);

            micState = 'listening';
            _lsSet(KEY_MIC_ON, '1');
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

    function buildMicStrip(parent) {
        const c = _stripColors();
        const wrap = document.createElement('div');
        wrap.className = 'vocals-highway-mic-strip';
        wrap.style.cssText = 'position:absolute;top:8px;right:8px;z-index:15;display:flex;'
            + 'gap:6px;align-items:center;pointer-events:auto;font:12px sans-serif;';

        const btnCss = `background:${c.bg};color:${c.text};border:${c.border};`
            + 'border-radius:4px;padding:2px 8px;cursor:pointer;';
        const rowCss = 'display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:6px;';
        const inputCss = `background:rgba(30,30,44,0.9);color:${c.text};border:${c.border};`
            + 'border-radius:4px;padding:2px 4px;max-width:170px;';

        // ── Settings popover ──
        const panel = document.createElement('div');
        panel.style.cssText = `position:absolute;top:28px;right:0;display:none;min-width:240px;`
            + `background:${c.bg};border:${c.border};border-radius:6px;padding:10px;color:${c.text};`;

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

        const sel = document.createElement('select');
        sel.title = 'Vocals microphone input (independent of the instrument input)';
        sel.style.cssText = inputCss;
        sel.addEventListener('change', () => {
            _lsSet(KEY_MIC_DEVICE, sel.value);
            if (micState === 'listening') {
                stopMic({ keepFlag: true });
                startMic();
            }
        });
        row('Mic device', sel);

        const chSel = document.createElement('select');
        chSel.title = 'Which capture channel carries the mic on a multi-input interface';
        chSel.style.cssText = inputCss;
        [['mix', 'Mix (L+R)'], ['1', 'Channel 1'], ['2', 'Channel 2']].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = t;
            chSel.appendChild(o);
        });
        chSel.addEventListener('change', () => {
            _lsSet(KEY_MIC_CHANNEL, chSel.value);
            _readPrefs();
        });
        row('Channel', chSel);

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
        oct.addEventListener('change', () => {
            _lsSet(KEY_OCTAVE_FREE, oct.checked ? '1' : '0');
            _readPrefs();
        });
        row('Octave-free', oct);

        function hydrate() {
            _readPrefs();
            chSel.value = prefs.channel;
            tol.value = String(prefs.tolerance);
            tolVal.textContent = prefs.tolerance.toFixed(2);
            oct.checked = prefs.octaveFree;
            sel.value = _lsGet(KEY_MIC_DEVICE) || '';
        }

        // ── Strip buttons ──
        const gear = document.createElement('button');
        gear.type = 'button';
        gear.textContent = '⚙';
        gear.title = 'Vocals mic settings';
        gear.setAttribute('aria-label', 'Vocals mic settings');
        gear.style.cssText = btnCss;
        gear.addEventListener('click', () => {
            const open = panel.style.display !== 'none';
            panel.style.display = open ? 'none' : 'block';
            if (!open) {
                hydrate();
                _populateDevicePickers();
            }
        });

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '🎤';
        btn.setAttribute('aria-label', 'Toggle live mic pitch feedback');
        btn.style.cssText = btnCss;
        btn.addEventListener('click', () => {
            if (micState === 'listening' || micState === 'requesting') stopMic({ keepFlag: false });
            else startMic();
        });

        wrap.appendChild(gear);
        wrap.appendChild(btn);
        wrap.appendChild(panel);
        if (parent && getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }
        (parent || document.body).appendChild(wrap);
        const strip = { wrap, btn, sel, hydrate };
        _micStrips.add(strip);
        _populateDevicePickers();
        _refreshMicStrips();
        return strip;
    }

    function removeMicStrip(strip) {
        if (!strip) return;
        _micStrips.delete(strip);
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

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', () => _populateDevicePickers());
    }

    function _refreshMicStrips() {
        const c = _stripColors();
        _micStrips.forEach(({ btn }) => {
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
    }

    function createRenderer() {
        return {
            contextType: '2d',

            _canvas: null,
            _ctx: null,
            _filename: undefined,   // undefined = never loaded; '' = no song
            _tokens: null,
            _range: null,
            _status: 'idle',        // idle | loading | ready | nodata
            _gen: 0,                // invalidates in-flight fetches on song change / destroy

            init(canvas, _bundle) {
                this._canvas = canvas;
                this._ctx = canvas.getContext('2d');
                // Force a (cache-friendly) reload on the first draw — init()
                // recurs on the same instance after destroy() per contract.
                this._filename = undefined;
                this._tokens = null;
                this._range = null;
                this._status = 'idle';
                // Mic engine: last-init'd instance owns scoring; a drawing
                // instance takes over if the owner's canvas dies (see draw()).
                _activeInstance = this;
                this._micStrip = buildMicStrip(canvas.parentElement);
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
                this._canvas = null;
                this._ctx = null;
                this._tokens = null;
                this._range = null;
                this._lines = null;
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
                _readPrefs();
            },

            getSetting(key) {
                if (key === 'octaveIndependent') return prefs.octaveFree;
                if (key === 'tolerance') return prefs.tolerance;
                return undefined;
            },

            _loadFor(filename, bundle) {
                this._filename = filename;
                this._tokens = null;
                this._range = null;
                this._lines = null;
                if (_activeInstance === this) { resetScoring(); lastSummary = null; }
                this._autoStarted = false;
                const gen = ++this._gen;
                if (!filename) {
                    // Non-pak song (or filename unresolvable): render the WS
                    // lyrics text-only rather than a dead surface.
                    const wsLyrics = Array.isArray(bundle.lyrics) ? bundle.lyrics : null;
                    if (wsLyrics && wsLyrics.length) {
                        this._tokens = wsLyrics;
                        this._status = 'ready';
                    } else {
                        this._status = 'idle';
                    }
                    return;
                }

                const cached = _tokenCache.get(filename);
                if (cached) {
                    this._tokens = cached;
                    this._range = computePitchRange(cached);
                    this._status = cached.length ? 'ready' : 'nodata';
                    return;
                }

                this._status = 'loading';
                // bundle.lyrics is safe to hold across the await: array fields
                // keep their identity until chart data changes (and gen guards
                // that), unlike the reused bundle object itself.
                const wsLyrics = Array.isArray(bundle.lyrics) ? bundle.lyrics : null;
                _fetchTokens(filename).then((tokens) => {
                    if (gen !== this._gen) return;
                    _cacheTokens(filename, tokens);
                    this._tokens = tokens;
                    this._range = computePitchRange(tokens);
                    this._status = tokens.length ? 'ready' : 'nodata';
                }).catch(() => {
                    if (gen !== this._gen) return;
                    // No pak-side data — fall back to the WebSocket lyrics so
                    // the words still flow, just without pitch bars.
                    if (wsLyrics && wsLyrics.length) {
                        this._tokens = wsLyrics;
                        this._range = null;
                        this._status = 'ready';
                    } else {
                        this._status = 'nodata';
                    }
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

                const si = bundle.songInfo || {};
                const filename = resolveFilename(si);
                if (filename !== this._filename) this._loadFor(filename, bundle);

                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.fillStyle = COL_BG;
                ctx.fillRect(0, 0, W, H);
                this._drawWatermark(ctx, W, H);

                const tokens = this._tokens;
                if (!tokens || !tokens.length) {
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

                const u = H / 480;  // scale unit: tuned at 480px reference height
                const now = bundle.currentTime || 0;

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

                // ── Pitch bars ────────────────────────────────────────────
                const pad = 2 * u;
                const radius = 4 * u;
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

    window.feedBackViz_vocals_highway = function () {
        return createRenderer();
    };
    window.feedBackViz_vocals_highway.contextType = '2d';

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
                summary: lastSummary,
                prefs: { ...prefs },
                songNow: _songNow(),
                lastCapturedAt: micLastCapturedAt,
            };
        },
    };
})();
