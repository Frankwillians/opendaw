/**
 * Tests for the Standard MIDI File codec - run with `npm test`.
 *
 * The promise here is round-trip honesty: a pattern written to .mid and read
 * back must land on the same steps, pitches, lengths and velocities, and the
 * parser must survive the quirks real files carry (running status, velocity-0
 * note-ons, multi-byte delta times, format-1 track splits). Files are built
 * byte-by-byte in these tests so the parser is proven against the spec, not
 * against the writer's own assumptions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi, writeMidi } from './smf.ts';
// ------------------------------------------------------------- byte helpers
const id = (text) => Array.from(text, (ch) => ch.charCodeAt(0));
const u16 = (value) => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value) => [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
];
/** Reference VLQ encoder, independent of the writer under test. */
function vlq(value) {
    const out = [value & 0x7f];
    let v = value >>> 7;
    while (v > 0) {
        out.unshift((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    return out;
}
const EOT = [0x00, 0xff, 0x2f, 0x00];
function mtrk(events) {
    return [...id('MTrk'), ...u32(events.length), ...events];
}
function smf(format, division, tracks) {
    return Uint8Array.from([
        ...id('MThd'),
        ...u32(6),
        ...u16(format),
        ...u16(tracks.length),
        ...u16(division),
        ...tracks.flat(),
    ]);
}
/** Set Tempo meta at delta 0. */
const tempo = (microsPerQuarter) => [
    0x00, 0xff, 0x51, 0x03,
    (microsPerQuarter >> 16) & 0xff,
    (microsPerQuarter >> 8) & 0xff,
    microsPerQuarter & 0xff,
];
const noteOn = (delta, pitch, velocity, channel = 0) => [...vlq(delta), 0x90 | channel, pitch, velocity];
const noteOff = (delta, pitch, channel = 0) => [...vlq(delta), 0x80 | channel, pitch, 0x40];
// --------------------------------------------------------------- round trip
test('writeMidi output starts with MThd and parses back', () => {
    const notes = [
        { step: 0, pitch: 60, length: 4, velocity: 0.8 },
        { step: 4, pitch: 64, length: 2, velocity: 0.5 },
        { step: 8, pitch: 67, length: 8, velocity: 1 },
    ];
    const bytes = writeMidi(notes);
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'MThd');
    const result = parseMidi(bytes);
    assert.equal(result.ppq, 480);
    assert.equal(result.bpm, 120);
    assert.equal(result.notes.length, 3);
    for (let i = 0; i < notes.length; i += 1) {
        const back = result.notes[i];
        assert.ok(Math.abs(back.step - notes[i].step) < 1e-9, `step ${i}`);
        assert.equal(back.pitch, notes[i].pitch);
        assert.ok(Math.abs(back.length - notes[i].length) < 1e-9, `length ${i}`);
        // Velocity is quantized to 1/127 by the file format itself.
        assert.ok(Math.abs(back.velocity - notes[i].velocity) <= 1 / 127 + 1e-9, `velocity ${i}`);
    }
});
test('round trip honors custom ppq and bpm, including fractional steps', () => {
    const notes = [
        { step: 0.5, pitch: 36, length: 2.5, velocity: 0.25 },
        { step: 3.25, pitch: 45, length: 0.75, velocity: 0.9 },
        { step: 16, pitch: 127, length: 16, velocity: 0.01 },
    ];
    const bytes = writeMidi(notes, { ppq: 960, bpm: 90 });
    const result = parseMidi(bytes);
    assert.equal(result.ppq, 960);
    assert.ok(Math.abs(result.bpm - 90) < 0.001);
    assert.equal(result.notes.length, notes.length);
    const sorted = [...notes].sort((a, b) => a.step - b.step);
    // 960 ppq = 240 ticks per 16th; the quantization error stays under half a tick.
    for (let i = 0; i < sorted.length; i += 1) {
        const back = result.notes[i];
        assert.ok(Math.abs(back.step - sorted[i].step) < 0.5 / 240, `step ${i}`);
        assert.equal(back.pitch, sorted[i].pitch);
        assert.ok(Math.abs(back.length - sorted[i].length) < 1 / 240, `length ${i}`);
        assert.ok(Math.abs(back.velocity - sorted[i].velocity) <= 1 / 127 + 1e-9, `velocity ${i}`);
    }
});
test('an empty pattern still writes a valid, parseable file', () => {
    const result = parseMidi(writeMidi([]));
    assert.equal(result.ppq, 480);
    assert.equal(result.bpm, 120);
    assert.deepEqual(result.notes, []);
});
test('the MTrk length field counts exactly the bytes that follow it', () => {
    const bytes = writeMidi([{ step: 2, pitch: 55, length: 3, velocity: 0.7 }], { bpm: 140 });
    // MThd is 14 bytes; then MTrk id (4) + length (4) + body.
    const declared = ((bytes[18] << 24) | (bytes[19] << 16) | (bytes[20] << 8) | bytes[21]) >>> 0;
    assert.equal(declared, bytes.length - 22);
    assert.equal(String.fromCharCode(...bytes.subarray(14, 18)), 'MTrk');
    // Header declares format 0 (u16 at offset 8), one track (u16 at offset 10).
    assert.equal(bytes[8], 0);
    assert.equal(bytes[9], 0);
    assert.equal(bytes[11], 1);
});
test('writeMidi clamps pitch and velocity into legal MIDI range', () => {
    const notes = [
        { step: 0, pitch: 200, length: 1, velocity: 5 },
        { step: 1, pitch: -4, length: 1, velocity: 0 },
        { step: 2, pitch: 60.4, length: 0.000001, velocity: 0.5 },
        { step: -3, pitch: 62, length: 1, velocity: 0.5 },
    ];
    const result = parseMidi(writeMidi(notes));
    assert.equal(result.notes.length, 4);
    const byPitch = new Map(result.notes.map((n) => [n.pitch, n]));
    assert.ok(byPitch.has(127), 'high pitch clamps to 127');
    assert.ok(byPitch.has(0), 'low pitch clamps to 0');
    assert.equal(byPitch.get(127)?.velocity, 1);
    // Velocity 0 must become at least 1, or the note reads back as an instant off.
    assert.ok(Math.abs((byPitch.get(0)?.velocity ?? 0) - 1 / 127) < 1e-9);
    const tiny = byPitch.get(60);
    assert.ok(tiny !== undefined && tiny.length >= 1 / 120, 'a tiny length keeps at least one tick');
    const negative = byPitch.get(62);
    assert.equal(negative?.step, 0, 'negative steps clamp to the arrangement start');
});
// --------------------------------------------------------------------- VLQ
test('VLQ delta times decode across 1, 2, 3 and 4 byte encodings', () => {
    // ppq 480 -> 120 ticks per 16th step.
    const events = [
        ...noteOn(0, 60, 100),
        ...noteOff(16384, 60), // 3-byte VLQ: 81 80 00
        ...noteOn(0x0fffffff, 62, 100), // maximum 4-byte VLQ: FF FF FF 7F
        ...noteOff(128, 62), // 2-byte VLQ: 81 00
        ...EOT,
    ];
    assert.deepEqual(vlq(16384), [0x81, 0x80, 0x00]);
    assert.deepEqual(vlq(0x0fffffff), [0xff, 0xff, 0xff, 0x7f]);
    assert.deepEqual(vlq(128), [0x81, 0x00]);
    assert.deepEqual(vlq(0), [0x00]);
    const result = parseMidi(smf(0, 480, [mtrk(events)]));
    assert.equal(result.notes.length, 2);
    const first = result.notes[0];
    assert.equal(first.pitch, 60);
    assert.equal(first.step, 0);
    assert.ok(Math.abs(first.length - 16384 / 120) < 1e-9);
    const second = result.notes[1];
    assert.equal(second.pitch, 62);
    assert.ok(Math.abs(second.step - (16384 + 0x0fffffff) / 120) < 1e-9);
    assert.ok(Math.abs(second.length - 128 / 120) < 1e-9);
});
test('the writer emits multi-byte VLQs for distant notes and they parse back', () => {
    // Step 10000 at ppq 480 is tick 1,200,000 - a 3-byte delta time.
    const notes = [{ step: 10000, pitch: 72, length: 4, velocity: 0.6 }];
    const result = parseMidi(writeMidi(notes));
    assert.equal(result.notes.length, 1);
    assert.ok(Math.abs(result.notes[0].step - 10000) < 1e-9);
    assert.ok(Math.abs(result.notes[0].length - 4) < 1e-9);
});
// -------------------------------------------------------------------- tempo
test('the first Set Tempo meta event sets the bpm', () => {
    const events = [
        ...tempo(500000), // 120 bpm
        ...noteOn(0, 60, 100),
        ...noteOff(480, 60),
        ...EOT,
    ];
    const result = parseMidi(smf(0, 480, [mtrk(events)]));
    assert.equal(result.bpm, 120);
    assert.equal(result.notes.length, 1);
    assert.equal(result.notes[0].length, 4);
});
test('a non-default tempo is read and later tempo changes are ignored', () => {
    const events = [
        ...tempo(600000), // 100 bpm - first one wins
        ...noteOn(0, 60, 100),
        ...tempo(250000), // 240 bpm mid-track must not replace the first
        ...noteOff(480, 60),
        ...EOT,
    ];
    const result = parseMidi(smf(0, 480, [mtrk(events)]));
    assert.equal(result.bpm, 100);
});
test('a file without a tempo meta defaults to 120 bpm', () => {
    const events = [...noteOn(0, 60, 100), ...noteOff(120, 60), ...EOT];
    const result = parseMidi(smf(0, 480, [mtrk(events)]));
    assert.equal(result.bpm, 120);
    assert.equal(result.notes[0].length, 1);
});
// -------------------------------------------------------------- note pairing
test('a note-on with velocity 0 is treated as a note-off', () => {
    const events = [
        ...noteOn(0, 60, 100),
        ...vlq(240), 0x90, 60, 0, // running-status note-on, velocity 0 = off
        ...EOT,
    ];
    const result = parseMidi(smf(0, 480, [mtrk(events)]));
    assert.equal(result.notes.length, 1);
    assert.equal(result.notes[0].pitch, 60);
    assert.equal(result.notes[0].length, 2);
    assert.ok(Math.abs(result.notes[0].velocity - 100 / 127) < 1e-9);
});
test('running status carries both note-ons and note-offs', () => {
    const events = [
        0x00, 0x90, 60, 100, // explicit status
        ...vlq(120), 60, 0, // running: off via velocity 0
        ...vlq(0), 62, 90, // running: new note-on
        ...vlq(120), 62, 0, // running: off
        ...EOT,
    ];
    const result = parseMidi(smf(0, 480, [mtrk(events)]));
    assert.equal(result.notes.length, 2);
    assert.equal(result.notes[0].pitch, 60);
    assert.equal(result.notes[0].step, 0);
    assert.equal(result.notes[0].length, 1);
    assert.equal(result.notes[1].pitch, 62);
    assert.equal(result.notes[1].step, 1);
    assert.equal(result.notes[1].length, 1);
});
test('explicit note-off status pairs with the note-on stack per channel and pitch', () => {
    const events = [
        ...noteOn(0, 60, 100, 0),
        ...noteOn(0, 60, 80, 1), // same pitch, different channel: independent
        ...noteOff(120, 60, 1),
        ...noteOff(120, 60, 0),
        ...noteOff(0, 99), // an off with no matching on is ignored gracefully
        ...EOT,
    ];
    const result = parseMidi(smf(0, 480, [mtrk(events)]));
    assert.equal(result.notes.length, 2);
    const velocities = result.notes.map((n) => n.velocity).sort();
    assert.ok(Math.abs(velocities[0] - 80 / 127) < 1e-9);
    assert.ok(Math.abs(velocities[1] - 100 / 127) < 1e-9);
    // Both start at step 0; the channel-1 note ended first (tick 120 vs 240).
    assert.equal(result.notes[0].length, 1);
    assert.equal(result.notes[1].length, 2);
});
// ---------------------------------------------------------------- format 1
test('format 1 merges notes from every track and sorts them by step', () => {
    const conductor = mtrk([...tempo(400000), ...EOT]); // 150 bpm
    const trackA = mtrk([...noteOn(480, 60, 100), ...noteOff(480, 60), ...EOT]);
    const trackB = mtrk([...noteOn(0, 36, 127), ...noteOff(240, 36), ...EOT]);
    const result = parseMidi(smf(1, 480, [conductor, trackA, trackB]));
    assert.equal(result.bpm, 150);
    assert.equal(result.ppq, 480);
    assert.equal(result.notes.length, 2);
    assert.equal(result.notes[0].pitch, 36);
    assert.equal(result.notes[0].step, 0);
    assert.equal(result.notes[0].length, 2);
    assert.equal(result.notes[1].pitch, 60);
    assert.equal(result.notes[1].step, 4);
    assert.equal(result.notes[1].length, 4);
});
// ------------------------------------------------------- junk and edge cases
test('non-note channel events, meta events and sysex are skipped gracefully', () => {
    const events = [
        0x00, 0xb0, 7, 100, // control change
        0x00, 0xc0, 5, // program change (1 data byte)
        0x00, 0xe0, 0, 64, // pitch bend
        0x00, 0xa0, 60, 50, // poly aftertouch
        0x00, 0xff, 0x01, 0x04, 0x68, 0x69, 0x21, 0x21, // meta text "hi!!"
        0x00, 0xf0, 0x03, 0x7e, 0x00, 0xf7, // sysex
        ...noteOn(0, 60, 100),
        ...noteOff(120, 60),
        ...EOT,
    ];
    const result = parseMidi(smf(0, 480, [mtrk(events)]));
    assert.equal(result.notes.length, 1);
    assert.equal(result.notes[0].pitch, 60);
    assert.equal(result.notes[0].length, 1);
});
test('SMPTE division throws a clear error instead of faking support', () => {
    // 0xE728 as a signed 16-bit is negative: SMPTE 25 fps, 40 ticks per frame.
    const bytes = smf(0, 0xe728, [mtrk([...EOT])]);
    assert.throws(() => parseMidi(bytes), /SMPTE/);
});
test('garbage and truncated headers are rejected', () => {
    assert.throws(() => parseMidi(Uint8Array.from([1, 2, 3])), /MThd/);
    assert.throws(() => parseMidi(Uint8Array.from([...id('NOPE'), ...u32(6), ...u16(0), ...u16(1), ...u16(480)])), /MThd/);
    const zeroPpq = smf(0, 0, [mtrk([...EOT])]);
    assert.throws(() => parseMidi(zeroPpq), /PPQ/);
});
test('a data byte with no running status is rejected', () => {
    const events = [0x00, 60, 100, ...EOT];
    assert.throws(() => parseMidi(smf(0, 480, [mtrk(events)])), /running status/);
});
