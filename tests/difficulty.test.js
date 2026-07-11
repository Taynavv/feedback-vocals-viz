/* Unit tests for the derived difficulty estimator (3D-mode readout).
 *
 * screen.js is a browser IIFE that guards every window/navigator access, so it
 * is require-able in Node and exports its pure helpers via module.exports. We
 * test the ACTUAL shipped estimateDifficulty (no duplicated logic).
 *
 * Run: node --test tests/difficulty.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateDifficulty } = require('../screen.js');

// The bundled solfège scale fixture (mirrors tools/build_test_pak.py): two
// stepwise lines spanning exactly one octave, C4→C5→C4, ~1.6 notes/s.
function scaleTokens() {
    const BEAT = 0.5, D = 0.4;
    const L1 = [60, 62, 64, 65, 67, 69, 71, 72];
    const L2 = [72, 71, 69, 67, 65, 64, 62, 60];
    const out = [];
    L1.forEach((midi, i) => out.push({ t: 2.0 + i * BEAT, d: D, w: 's', midi }));
    L2.forEach((midi, i) => out.push({ t: 8.0 + i * BEAT, d: D, w: 's', midi }));
    return out;
}

// Narrow, slow, stepwise, low → should read Easy.
function easyTokens() {
    return [60, 62, 60, 62, 60, 62].map((midi, i) => ({ t: i * 1.5, d: 0.6, w: 's', midi }));
}

// Two-octave range, fast, wide leaps, high tessitura → should read Expert.
function hardTokens() {
    return [55, 72, 60, 79, 64, 76, 58, 74].map((midi, i) => ({ t: i * 0.25, d: 0.2, w: 's', midi }));
}

test('returns null when fewer than two pitched notes', () => {
    assert.equal(estimateDifficulty([]), null);
    assert.equal(estimateDifficulty([{ t: 0, d: 1, w: 'x' }]), null);                 // no midi
    assert.equal(estimateDifficulty([{ t: 0, d: 1, w: 'x', midi: 60 }]), null);       // only one pitched
    assert.equal(estimateDifficulty('not an array'), null);
});

test('ignores unpitched tokens when counting the melody', () => {
    const mixed = [
        { t: 0, d: 0.4, w: 'a', midi: 60 },
        { t: 0.5, d: 0.4, w: 'b' },              // unpitched — ignored
        { t: 1.0, d: 0.4, w: 'c', midi: 64 },
    ];
    const d = estimateDifficulty(mixed);
    assert.equal(d.detail.lowMidi, 60);
    assert.equal(d.detail.highMidi, 64);
    assert.equal(d.detail.rangeSemitones, 4);
});

test('all factors and score stay within 0..1', () => {
    for (const toks of [scaleTokens(), easyTokens(), hardTokens()]) {
        const d = estimateDifficulty(toks);
        for (const k of ['range', 'pace', 'leaps', 'tessitura']) {
            assert.ok(d.factors[k] >= 0 && d.factors[k] <= 1, `${k} in range: ${d.factors[k]}`);
        }
        assert.ok(d.score >= 0 && d.score <= 1, `score in range: ${d.score}`);
    }
});

test('the solfège scale lands Easy/Medium with the expected shape', () => {
    const d = estimateDifficulty(scaleTokens());
    assert.equal(d.detail.rangeSemitones, 12);          // one octave
    assert.ok(Math.abs(d.detail.notesPerSec - 1.616) < 0.05, `pace ${d.detail.notesPerSec}`);
    assert.ok(d.detail.meanIntervalSemitones < 2, `stepwise: ${d.detail.meanIntervalSemitones}`);
    assert.ok(['Easy', 'Medium'].includes(d.band), `band ${d.band}`);
    assert.ok(d.score > 0.2 && d.score < 0.45, `score ${d.score}`);
});

test('narrow/slow/stepwise melody reads Easy', () => {
    const d = estimateDifficulty(easyTokens());
    assert.equal(d.band, 'Easy');
});

test('wide/fast/leaping/high melody reads Hard or Expert', () => {
    const d = estimateDifficulty(hardTokens());
    assert.ok(['Hard', 'Expert'].includes(d.band), `band ${d.band}`);
});

test('difficulty score is monotonic across easy < scale < hard', () => {
    const easy = estimateDifficulty(easyTokens()).score;
    const scale = estimateDifficulty(scaleTokens()).score;
    const hard = estimateDifficulty(hardTokens()).score;
    assert.ok(easy < scale, `easy(${easy}) < scale(${scale})`);
    assert.ok(scale < hard, `scale(${scale}) < hard(${hard})`);
});
