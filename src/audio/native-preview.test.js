/**
 * Tests for the native plugin preview rule - run with `npm test`.
 *
 * A native .dll or .vst3 lives in its own process, so the plugin cannot sit in
 * the live Web Audio graph: the app renders the lane's clip through it and the
 * engine plays and exports that pass. A lane can hold as many of them as the
 * producer wants, in a row, so the unit these rules work on is the chain. Three
 * questions are answered here, without a browser, a plugin, or a sound card:
 * which slots of a chain touch the audio at all, what counts as a change that
 * needs a fresh render, and which pass a lane actually hands to the output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeNativeSlots, nativePreviewKey, takeToPlay } from './native-preview.ts';
const slot = (path, values, bypass = false) => ({
    path,
    params: values.map((value, index) => ({ index, value })),
    bypass,
});
const lane = (over = {}) => ({
    kind: 'audio',
    bufferId: 'clip-1',
    clipDuration: 4,
    nativeChain: [slot('C:/VST/amp.dll', [0.5, 0.25])],
    ...over,
});
test('a lane with a plugin and a clip has a preview key', () => {
    const key = nativePreviewKey(lane(), 48000);
    assert.ok(key.includes('amp.dll'));
    assert.ok(key.includes('clip-1'));
    assert.ok(key.includes('48000'));
});
test('nothing to preview: no plugin, a bypass, no clip, or an instrument', () => {
    assert.equal(nativePreviewKey(lane({ nativeChain: [] }), 48000), '');
    assert.equal(nativePreviewKey(lane({ nativeChain: [slot('C:/VST/amp.dll', [0.5], true)] }), 48000), '');
    assert.equal(nativePreviewKey(lane({ bufferId: '' }), 48000), '');
    assert.equal(nativePreviewKey(lane({ clipDuration: 0 }), 48000), '');
    assert.equal(nativePreviewKey(lane({ kind: 'instrument' }), 48000), '');
});
test('the key follows the knobs, the clip, the plugin and the rate', () => {
    const base = nativePreviewKey(lane(), 48000);
    assert.notEqual(base, nativePreviewKey(lane(), 44100));
    assert.notEqual(base, nativePreviewKey(lane({ bufferId: 'clip-2' }), 48000));
    assert.notEqual(base, nativePreviewKey(lane({ nativeChain: [slot('C:/VST/other.dll', [0.5, 0.25])] }), 48000));
    assert.notEqual(base, nativePreviewKey(lane({ nativeChain: [slot('C:/VST/amp.dll', [0.5, 0.75])] }), 48000));
});
test('the same settings always give the same key, in any order', () => {
    const forward = nativePreviewKey(lane({ nativeChain: [slot('C:/VST/amp.dll', [0.5, 0.25])] }), 48000);
    // The same two parameters, listed the other way round: a slot rebuilt from a
    // saved project can arrive in a different order, and that must not cost a
    // render of a pass that is already in the lane.
    const shuffled = nativePreviewKey(lane({
        nativeChain: [{ path: 'C:/VST/amp.dll', params: [{ index: 1, value: 0.25 }, { index: 0, value: 0.5 }] }],
    }), 48000);
    assert.equal(forward, shuffled);
});
test('a knob moved by one hundredth is a new pass, a rounding error is not', () => {
    const base = nativePreviewKey(lane({ nativeChain: [slot('C:/VST/amp.dll', [0.5])] }), 48000);
    assert.notEqual(base, nativePreviewKey(lane({ nativeChain: [slot('C:/VST/amp.dll', [0.51])] }), 48000));
    assert.equal(base, nativePreviewKey(lane({ nativeChain: [slot('C:/VST/amp.dll', [0.500001])] }), 48000));
});
test('a chain is one pass: every plugin in it is in the key', () => {
    const chain = [slot('C:/VST/drive.dll', [0.2]), slot('C:/VST/amp.dll', [0.5]), slot('C:/VST/cab.dll', [0.7])];
    const key = nativePreviewKey(lane({ nativeChain: chain }), 48000);
    for (const name of ['drive.dll', 'amp.dll', 'cab.dll'])
        assert.ok(key.includes(name), name);
    // One plugin more is a different sound, so it must be a different pass.
    assert.notEqual(key, nativePreviewKey(lane({ nativeChain: chain.slice(0, 2) }), 48000));
});
test('the order of a chain is part of the pass, the way it is not for knobs', () => {
    const drive = slot('C:/VST/drive.dll', [0.2]);
    const amp = slot('C:/VST/amp.dll', [0.5]);
    // Drive into amp and amp into drive are two different sounds, and the second
    // must not be allowed to keep the first one's rendered pass.
    assert.notEqual(nativePreviewKey(lane({ nativeChain: [drive, amp] }), 48000), nativePreviewKey(lane({ nativeChain: [amp, drive] }), 48000));
    assert.equal(nativePreviewKey(lane({ nativeChain: [drive, amp] }), 48000), nativePreviewKey(lane({ nativeChain: [drive, amp] }), 48000));
});
test('a bypassed plugin leaves the pass but keeps its place in the panel', () => {
    const drive = slot('C:/VST/drive.dll', [0.2]);
    const amp = slot('C:/VST/amp.dll', [0.5]);
    const quiet = slot('C:/VST/noise.dll', [0.9], true);
    assert.deepEqual(activeNativeSlots([drive, quiet, amp]).map((item) => item.path), [
        'C:/VST/drive.dll',
        'C:/VST/amp.dll',
    ]);
    // The pass the lane plays is the one the live plugins make, so the row a
    // bypassed slot stays in must not change what the engine holds.
    assert.equal(nativePreviewKey(lane({ nativeChain: [drive, quiet, amp] }), 48000), nativePreviewKey(lane({ nativeChain: [drive, amp] }), 48000));
});
test('an empty or broken chain asks for nothing', () => {
    assert.deepEqual(activeNativeSlots([]), []);
    assert.deepEqual(activeNativeSlots(undefined), []);
    assert.deepEqual(activeNativeSlots([undefined, slot('', [0.5])]), []);
});
test('a lane plays the plugin pass while the engine holds one', () => {
    const dry = { name: 'seco' };
    const wet = { name: 'molhado' };
    assert.equal(takeToPlay({ monitor: { buffer: wet }, buffer: dry }), wet);
    assert.equal(takeToPlay({ monitor: null, buffer: dry }), dry);
    assert.equal(takeToPlay({ monitor: null, buffer: null }), null);
});
test('a stale pass is dropped before it can play: null clears the monitor', () => {
    // `setBuffer` is what a new take, a trim that replaced the file, or a cleared
    // lane calls, and it hands the monitor back to null. What the lane plays after
    // that is the clip itself, never the pass rendered from the file before it.
    const dry = { name: 'seco' };
    const wet = { name: 'molhado' };
    const track = {
        monitor: { buffer: wet },
        buffer: dry,
    };
    assert.equal(takeToPlay(track), wet);
    track.monitor = null;
    assert.equal(takeToPlay(track), dry);
});
