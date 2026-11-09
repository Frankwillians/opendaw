/**
 * Audio Engine - Web Audio API
 *
 * Per track signal path:
 *   input device ─┐
 *   recorded clip ─┼─> panner -> fxInput -> shaper -> filter -> [signal chain]
 *                  │    -> gain -> mono fold-down -> duck -> master or sub-group
 *
 * Master bus: every track (or sub-group) sums into `masterSum`, passes through
 * a full built-in FX rack (glue EQ / compressor / limiter live there), then the
 * master volume. Two shared send buses (reverb + delay) are fed by a tap on
 * each track and return into the same sum, so the master FX processes them.
 *
 * Sub-groups are a second, smaller version of the master: member tracks land on
 * the group's sum, and the group's fader, pan and mute sit between them and
 * `masterSum`. The duck that a sidechain source applies is computed by an
 * AudioWorklet on the audio thread, so it never depends on a JavaScript timer.
 *
 * Plugin chain supports:
 *   - IR / cabinet convolution (ConvolverNode)
 *   - external AudioWorklet plugins (.js files registering a processor)
 *   - Neural Amp Modeler models (.nam) running through the TONE3000 WASM engine
 *
 * NAM models are wired in parallel and summed back into the chain, so multiple
 * amps play at the same time and can be panned independently.
 *
 * The same chain can be rebuilt inside an OfflineAudioContext to export audio.
 */
import { NamEngine } from 'neural-amp-modeler-wasm/engine';
import { scheduleVoice } from './instruments';
import { automationGainAt, automationNodeGain, clampRange, dbToGain, fadeGainAt, gateCurve, normalizeDuckSources, overdriveCurve, sameIdList, saturationCurve, sortedAutomation, } from './mix-math';
import { clipEnd as clipEndOf } from './mix-math';
import { measureLoudness } from './loudness';
import { SIDECHAIN_PROCESSOR_NAME, SIDECHAIN_WORKLET_SOURCE } from './sidechain-worklet';
import { LOUDNESS_PROCESSOR_NAME, LOUDNESS_WORKLET_SOURCE } from './loudness-worklet';
import { MASTER_TAP_NAME, MASTER_TAP_SOURCE } from './master-tap';
import { isPatterned, patternContentEnd } from './step-pattern';
import { takeToPlay } from './native-preview';
// ASIO Input worklet constants
const ASIO_INPUT_NAME = 'asio-input';
const ASIO_INPUT_SOURCE = `
class AsioInputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sink = null;
    this.batch = 256;
    this.channels = 2;
    this.acc = null;
    this.fill = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && 'attachPort' in data) {
        this.sink = data.attachPort;
        if (this.sink && this.sink.start) this.sink.start();
        // Set up handler for incoming PCM data on the sink port
        if (this.sink) {
          this.sink.onmessage = (ev) => {
            const msg = ev.data;
            if (msg && msg.kind === 'pcm' && msg.samples) {
              this.pushSamples(msg.samples);
            }
          };
        }
      }
      if (data && typeof data.batchFrames === 'number' && data.batchFrames > 0) {
        this.batch = data.batchFrames;
        this.acc = null;
        this.fill = 0;
      }
      if (data && typeof data.channels === 'number' && data.channels > 0) {
        this.channels = data.channels;
        this.acc = null;
        this.fill = 0;
      }
    };
  }

  pushSamples(samples) {
    const channels = this.channels;
    const framesPerChannel = samples.length / channels;
    const need = this.batch * channels;
    if (!this.acc || this.acc.length !== need) {
      this.acc = new Float32Array(need);
      this.fill = 0;
    }
    // Interleaved samples come in, we need to deinterleave into per-channel arrays
    // For simplicity, assume the worklet output is single stream with multiple channels
    // and the incoming samples are interleaved
    let srcIdx = 0;
    while (srcIdx < samples.length && this.fill < this.acc.length) {
      this.acc[this.fill] = samples[srcIdx];
      this.fill++;
      srcIdx++;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channels = output.length;
    const frames = output[0].length;

    if (this.acc && this.fill > 0) {
      const need = frames * channels;
      const available = this.fill;
      const toCopy = Math.min(need, available);

      // Copy from accumulator to output (deinterleave)
      for (let c = 0; c < channels; c++) {
        const outChannel = output[c];
        for (let f = 0; f < frames; f++) {
          const accIdx = f * channels + c;
          if (accIdx < toCopy) {
            outChannel[f] = this.acc[accIdx];
          } else {
            outChannel[f] = 0;
          }
        }
      }

      // Shift remaining samples in accumulator
      if (toCopy < this.fill) {
        this.acc.copyWithin(0, toCopy, this.fill);
        this.fill -= toCopy;
      } else {
        this.fill = 0;
      }
    } else {
      for (let c = 0; c < channels; c += 1) {
        output[c].fill(0);
      }
    }
    return true;
  }
}
registerProcessor('${ASIO_INPUT_NAME}', AsioInputProcessor);
`;
export { DRUM_PIECES, PIANO_VOICES, DRUM_KITS, BASS_VOICES, INSTRUMENT_KINDS, defaultVoice, instrumentLabel, voicesFor, } from './instruments';
// ------------------------------------------------------------ native FX rack
// Default serial order, from the source end of the chain to the speaker:
// tuner/dynamics/level first, then tone, then modulation, then space, limiter last.
export const BUILTIN_FX_IDS = [
    'tuner', 'gate', 'sat', 'dist', 'eq', 'comp', 'deess', 'trem',
    'chorus', 'delay', 'reverb', 'limiter'
];
export function defaultBuiltinFx() {
    const params = () => ({
        // Tuner
        tunerRef: 440,
        tunerMute: 0,
        // Distortion
        drive: 0.45,
        tone: 3800,
        // Chorus
        rate: 1.1,
        depth: 3.5,
        // Reverb
        decay: 2.4,
        // Delay
        time: 320,
        feedback: 0.32,
        // EQ
        eqLowFreq: 100,
        eqLowGain: 0,
        eqMidFreq: 1000,
        eqMidGain: 0,
        eqMidQ: 1,
        eqHighFreq: 5000,
        eqHighGain: 0,
        // Compressor
        compThreshold: -18,
        compRatio: 4,
        compAttack: 10,
        compRelease: 100,
        compKnee: 6,
        compMakeup: 0,
        // Gate
        gateThreshold: -40,
        gateRange: 40,
        // Saturator
        satDrive: 0.3,
        satTone: 12000,
        satTrim: -3,
        // Tremolo
        tremRate: 4.5,
        tremDepth: 0.5,
        // De-esser
        deessFreq: 6500,
        deessThreshold: -22,
        deessRatio: 6,
        deessAttack: 2,
        deessRelease: 60,
        // Limiter
        limThreshold: -1,
        limRelease: 50,
        limCeiling: -0.5,
    });
    return {
        tuner: { enabled: false, mix: 1, params: params() },
        gate: { enabled: false, mix: 1, params: params() },
        sat: { enabled: false, mix: 1, params: params() },
        dist: { enabled: false, mix: 0.5, params: params() },
        eq: { enabled: false, mix: 1, params: params() },
        comp: { enabled: false, mix: 1, params: params() },
        deess: { enabled: false, mix: 1, params: params() },
        trem: { enabled: false, mix: 1, params: params() },
        chorus: { enabled: false, mix: 0.4, params: params() },
        delay: { enabled: false, mix: 0.25, params: params() },
        reverb: { enabled: false, mix: 0.28, params: params() },
        limiter: { enabled: false, mix: 1, params: params() },
    };
}
export function defaultSendConfig() {
    return { rvDecay: 2.4, dlTime: 380, dlFeedback: 0.35, rvReturn: 1, dlReturn: 1 };
}
/** The most channels any lane has needed from one interface. */
export const MAX_INPUT_CHANNELS = 8;
/**
 * A producer asked for the master to be selectable as a microphone — the way a
 * desk's "mix" jack patched back into a channel returns the whole show to tape.
 * It cannot be a real `MediaDeviceInfo`: the browser only lists what the machine
 * exposes, and an in-app loopback is not a sound card. So it is an id this engine
 * answers for, stereo, always at unity, and nothing else on the computer can see
 * it. A system-wide cable — the kind SALA or any other program could pick — needs
 * a driver nobody here installs, so the honest split is: inside this app the cable
 * is a device, outside it the producer picks a real one and this list shows it.
 */
export const MASTER_CABLE_ID = 'opdaw:master-cable';
/** The label that cable carries on screen, in the producer's own words. */
export const MASTER_CABLE_LABEL = 'Cabo virtual · Master do OpenDAW';
/**
 * The room's return, offered the same way: an input any lane can patch.
 *
 * The master cable above carries what the desk sends out; this one carries what
 * the room sends back — every remote channel summed at unity, before the
 * listening gains, so a lane records what the musicians are actually playing
 * even when their monitor lamps are shut. It is silent while no room is
 * connected, and it does not dial anything: the producer opens the cable window
 * (Mix menu) when they want a room, exactly as before.
 */
export const SALA_CABLE_ID = 'opdaw:sala-return';
/** The label the room return carries in the input list. */
export const SALA_CABLE_LABEL = 'Cabo virtual · Retorno da sala';
/**
 * The name a playback device gives itself, for the report that goes back to the
 * screen. The browser only shows labels once a device has been allowed, so the
 * label can legitimately be missing; the id's own tail is better than a blank.
 *
 * The kind filter is not decoration. A driver is allowed to answer with the same
 * id for its capture and its render endpoint — the fake device Chromium uses does
 * exactly that — and then the first row that matches is the microphone, which
 * makes the mix claim to be leaving through an input.
 */
async function outputLabelFor(deviceId) {
    try {
        const listed = await navigator.mediaDevices.enumerateDevices();
        const found = listed.find((item) => item.kind === 'audiooutput' && item.deviceId === deviceId);
        if (found?.label)
            return found.label;
    }
    catch {
        /* the device list is not the point of this call */
    }
    return `Saída ${deviceId.slice(0, 6)}`;
}
const NAM_ASSET_BASE = '/nam/';
function newId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `p-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function getAudioContextCtor() {
    const withWebkit = window;
    const ctor = withWebkit.AudioContext ?? withWebkit.webkitAudioContext;
    if (!ctor) {
        throw new Error('Web Audio API não é suportada neste navegador.');
    }
    return ctor;
}
function makeDriveCurve(amount) {
    const samples = 1024;
    const curve = new Float32Array(samples);
    const k = Math.max(1, amount);
    const deg = Math.PI / 180;
    for (let i = 0; i < samples; i += 1) {
        const x = (i * 2) / samples - 1;
        curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
}
function toInfo(plugin) {
    return {
        id: plugin.id,
        name: plugin.name,
        kind: plugin.kind,
        params: plugin.params.map((param) => ({ ...param })),
        detail: plugin.detail,
    };
}
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(label)), ms);
        promise.then((value) => {
            window.clearTimeout(timer);
            resolve(value);
        }, (error) => {
            window.clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
}
// ------------------------------------------------------------ sound design
function scheduleClick(ctx, destination, time, accent = false) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(accent ? 1600 : 1000, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.22, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(time);
    osc.stop(time + 0.06);
}
/**
 * Deterministic white noise (xorshift32). Math.random() here would give every
 * render a different impulse, so exporting the same project twice would not
 * match the monitors - a fixed seed makes it the same room every time.
 */
function seededNoise(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 0x80000000 - 1;
    };
}
function makeImpulse(ctx, seconds) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(Math.max(0.15, seconds) * rate));
    const buffer = ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel += 1) {
        const data = buffer.getChannelData(channel);
        // Two decorrelated channels, but the same pair on every render.
        const rand = seededNoise(0x9e37 + Math.round(seconds * 1000) + channel * 7919);
        let low = 0;
        for (let i = 0; i < length; i += 1) {
            const decay = Math.pow(1 - i / length, 2.4);
            const noise = rand();
            // Slight low-pass on the tail keeps the reverb from sounding fizzy.
            low += (noise - low) * 0.35;
            data[i] = low * decay * (i < 120 ? 0.4 : 1);
        }
    }
    return buffer;
}
function createUnitShell(ctx) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    input.connect(dry);
    dry.connect(output);
    wet.connect(output);
    return { input, output, dry, wet, extra: [input, output, dry, wet] };
}
/** Registers a unit's internal nodes so removing the track can tear them all down. */
function keep(unit, ...nodes) {
    unit.extra.push(...nodes);
}
function createBuiltinChain(ctx, rack) {
    const tuner = createUnitShell(ctx);
    const tunerAnalyser = ctx.createAnalyser();
    tunerAnalyser.fftSize = 2048;
    tunerAnalyser.smoothingTimeConstant = 0.2;
    const tunerMuteGain = ctx.createGain();
    tunerMuteGain.gain.value = rack.tuner.params.tunerMute ? 0 : 1;
    tuner.input.connect(tunerAnalyser);
    tuner.input.connect(tunerMuteGain);
    tunerMuteGain.connect(tuner.wet);
    tuner.tunerAnalyser = tunerAnalyser;
    tuner.tunerMuteGain = tunerMuteGain;
    keep(tuner, tunerAnalyser, tunerMuteGain);
    const dist = createUnitShell(ctx);
    const shaper = ctx.createWaveShaper();
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = rack.dist.params.tone;
    shaper.connect(tone);
    tone.connect(dist.wet);
    dist.input.connect(shaper);
    dist.shaper = shaper;
    dist.tone = tone;
    keep(dist, shaper, tone);
    const chorus = createUnitShell(ctx);
    const chorusDelay = ctx.createDelay(0.08);
    chorusDelay.delayTime.value = 0.02;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rack.chorus.params.rate;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = rack.chorus.params.depth / 1000;
    lfo.connect(lfoDepth);
    lfoDepth.connect(chorusDelay.delayTime);
    lfo.start(0);
    chorus.input.connect(chorusDelay);
    chorusDelay.connect(chorus.wet);
    chorus.lfo = lfo;
    chorus.lfoDepth = lfoDepth;
    chorus.delayNode = chorusDelay;
    keep(chorus, chorusDelay, lfo, lfoDepth);
    const reverb = createUnitShell(ctx);
    const convolver = ctx.createConvolver();
    convolver.normalize = true;
    convolver.buffer = makeImpulse(ctx, rack.reverb.params.decay);
    reverb.input.connect(convolver);
    convolver.connect(reverb.wet);
    reverb.convolver = convolver;
    reverb.decay = rack.reverb.params.decay;
    keep(reverb, convolver);
    const delay = createUnitShell(ctx);
    const delayNode = ctx.createDelay(2);
    delayNode.delayTime.value = rack.delay.params.time / 1000;
    const feedback = ctx.createGain();
    feedback.gain.value = rack.delay.params.feedback;
    delay.input.connect(delayNode);
    delayNode.connect(feedback);
    feedback.connect(delayNode);
    delayNode.connect(delay.wet);
    delay.delay = delayNode;
    delay.feedback = feedback;
    keep(delay, delayNode, feedback);
    const eq = createUnitShell(ctx);
    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf';
    eqLow.frequency.value = rack.eq.params.eqLowFreq;
    eqLow.gain.value = rack.eq.params.eqLowGain;
    const eqMid = ctx.createBiquadFilter();
    eqMid.type = 'peaking';
    eqMid.frequency.value = rack.eq.params.eqMidFreq;
    eqMid.gain.value = rack.eq.params.eqMidGain;
    eqMid.Q.value = rack.eq.params.eqMidQ;
    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = 'highshelf';
    eqHigh.frequency.value = rack.eq.params.eqHighFreq;
    eqHigh.gain.value = rack.eq.params.eqHighGain;
    eq.input.connect(eqLow);
    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(eq.wet);
    eq.eqLow = eqLow;
    eq.eqMid = eqMid;
    eq.eqHigh = eqHigh;
    keep(eq, eqLow, eqMid, eqHigh);
    const comp = createUnitShell(ctx);
    const compNode = ctx.createDynamicsCompressor();
    compNode.threshold.value = rack.comp.params.compThreshold;
    compNode.ratio.value = rack.comp.params.compRatio;
    compNode.attack.value = rack.comp.params.compAttack / 1000;
    compNode.release.value = rack.comp.params.compRelease / 1000;
    compNode.knee.value = rack.comp.params.compKnee;
    const compMakeup = ctx.createGain();
    comp.input.connect(compNode);
    compNode.connect(compMakeup);
    compMakeup.connect(comp.wet);
    comp.compNode = compNode;
    comp.compMakeup = compMakeup;
    keep(comp, compNode, compMakeup);
    // Gate: a static downward expander drawn as a curve, so it behaves the same
    // whether it is running live or inside the offline mixdown.
    const gate = createUnitShell(ctx);
    const gateShaper = ctx.createWaveShaper();
    gateShaper.oversample = 'none';
    gateShaper.curve = gateCurve(rack.gate.params.gateThreshold, rack.gate.params.gateRange);
    gate.input.connect(gateShaper);
    gateShaper.connect(gate.wet);
    gate.gateShaper = gateShaper;
    gate.gateThreshold = rack.gate.params.gateThreshold;
    keep(gate, gateShaper);
    // Saturator: soft clip, then a tone filter, then a make-up trim.
    const sat = createUnitShell(ctx);
    const satShaper = ctx.createWaveShaper();
    satShaper.oversample = '2x';
    satShaper.curve = saturationCurve(rack.sat.params.satDrive);
    const satTone = ctx.createBiquadFilter();
    satTone.type = 'lowpass';
    satTone.frequency.value = rack.sat.params.satTone;
    const satTrimNode = ctx.createGain();
    satTrimNode.gain.value = dbToGain(rack.sat.params.satTrim);
    sat.input.connect(satShaper);
    satShaper.connect(satTone);
    satTone.connect(satTrimNode);
    satTrimNode.connect(sat.wet);
    sat.satShaper = satShaper;
    sat.satTone = satTone;
    sat.satTrim = satTrimNode;
    keep(sat, satShaper, satTone, satTrimNode);
    // Tremolo: the LFO rides the wet path's own gain param.
    const trem = createUnitShell(ctx);
    const tremGain = ctx.createGain();
    const tremLfo = ctx.createOscillator();
    tremLfo.type = 'sine';
    tremLfo.frequency.value = rack.trem.params.tremRate;
    const tremLfoDepth = ctx.createGain();
    const tremDepth = clampRange(rack.trem.params.tremDepth, 0, 1);
    tremGain.gain.value = 1 - tremDepth / 2;
    tremLfoDepth.gain.value = tremDepth / 2;
    tremLfo.connect(tremLfoDepth);
    tremLfoDepth.connect(tremGain.gain);
    tremLfo.start(0);
    trem.input.connect(tremGain);
    tremGain.connect(trem.wet);
    trem.tremGain = tremGain;
    trem.tremLfo = tremLfo;
    trem.tremLfoDepth = tremLfoDepth;
    keep(trem, tremGain, tremLfo, tremLfoDepth);
    // De-esser: an honest split-band. The low part passes untouched; the band
    // above the crossover is rebuilt by subtracting that low-passed copy from the
    // input and only that band sees the compressor, so plosives and sibilants get
    // pulled down without dulling the rest of the voice.
    const deess = createUnitShell(ctx);
    const deessLow = ctx.createBiquadFilter();
    deessLow.type = 'lowpass';
    deessLow.frequency.value = rack.deess.params.deessFreq;
    const deessBandSum = ctx.createGain();
    const deessInvert = ctx.createGain();
    deessInvert.gain.value = -1;
    const deessComp = ctx.createDynamicsCompressor();
    deessComp.threshold.value = rack.deess.params.deessThreshold;
    deessComp.ratio.value = rack.deess.params.deessRatio;
    deessComp.attack.value = rack.deess.params.deessAttack / 1000;
    deessComp.release.value = rack.deess.params.deessRelease / 1000;
    deessComp.knee.value = 6;
    const deessOut = ctx.createGain();
    deess.input.connect(deessLow);
    deess.input.connect(deessBandSum);
    deessLow.connect(deessInvert);
    deessInvert.connect(deessBandSum);
    deessBandSum.connect(deessComp);
    deessComp.connect(deessOut);
    deessLow.connect(deessOut);
    deessOut.connect(deess.wet);
    deess.deessLow = deessLow;
    deess.deessBandSum = deessBandSum;
    deess.deessComp = deessComp;
    deess.deessOut = deessOut;
    keep(deess, deessLow, deessInvert, deessBandSum, deessComp, deessOut);
    const limiter = createUnitShell(ctx);
    const limNode = ctx.createDynamicsCompressor();
    limNode.threshold.value = rack.limiter.params.limThreshold;
    limNode.ratio.value = 20; // Brick wall
    limNode.attack.value = 0.001;
    limNode.release.value = rack.limiter.params.limRelease / 1000;
    limNode.knee.value = 0;
    const limCeil = ctx.createGain();
    limCeil.gain.value = dbToGain(rack.limiter.params.limCeiling);
    limiter.input.connect(limNode);
    limNode.connect(limCeil);
    limCeil.connect(limiter.wet);
    limiter.limNode = limNode;
    limiter.limCeil = limCeil;
    keep(limiter, limNode, limCeil);
    // Units are self-contained; the signal order is wired dynamically so the
    // built-in effects can share the same reorderable chain as external plugins.
    // The ends of the chain follow BUILTIN_FX_IDS, so re-ordering the rack moves
    // the input and output with it.
    const units = { tuner, gate, sat, dist, eq, comp, deess, trem, chorus, delay, reverb, limiter };
    const chain = {
        units,
        input: units[BUILTIN_FX_IDS[0]].input,
        output: units[BUILTIN_FX_IDS[BUILTIN_FX_IDS.length - 1]].output,
        state: rack,
    };
    for (const id of BUILTIN_FX_IDS)
        applyBuiltinUnit(chain.units[id], rack[id]);
    return chain;
}
/**
 * Connects the built-in units in series (default stompbox order). Track
 * chains get rewired dynamically per stage list; the master bus uses the
 * plain serial form. Safe to call on live and offline contexts.
 */
function wireBuiltinSerial(fx) {
    let cursor = fx.units[BUILTIN_FX_IDS[0]].input;
    for (const id of BUILTIN_FX_IDS) {
        const unit = fx.units[id];
        if (cursor !== unit.input)
            cursor.connect(unit.input);
        cursor = unit.output;
    }
}
function applyMonoGains(gains, mono, when) {
    const [lToL, lToR, rToL, rToR] = gains;
    const direct = mono ? 0.5 : 1;
    const cross = mono ? 0.5 : 0;
    lToL.gain.setTargetAtTime(direct, when, 0.01);
    rToR.gain.setTargetAtTime(direct, when, 0.01);
    lToR.gain.setTargetAtTime(cross, when, 0.01);
    rToL.gain.setTargetAtTime(cross, when, 0.01);
}
export function applyBuiltinUnit(nodes, unit) {
    const mix = unit.enabled ? Math.max(0, Math.min(1, unit.mix)) : 0;
    nodes.dry.gain.value = 1 - mix;
    nodes.wet.gain.value = mix;
    const p = unit.params;
    // Tuner
    if (nodes.tunerMuteGain) {
        nodes.tunerMuteGain.gain.value = p.tunerMute ? 0 : 1;
    }
    // Distortion
    if (nodes.shaper)
        nodes.shaper.curve = overdriveCurve(p.drive);
    if (nodes.tone)
        nodes.tone.frequency.value = p.tone;
    // Chorus
    if (nodes.lfo)
        nodes.lfo.frequency.value = p.rate;
    if (nodes.lfoDepth)
        nodes.lfoDepth.gain.value = p.depth / 1000;
    // Reverb
    if (nodes.convolver && nodes.decay !== p.decay) {
        void nodes.convolver.context;
        nodes.convolver.buffer = makeImpulse(nodes.convolver.context, p.decay);
        nodes.decay = p.decay;
    }
    // Delay
    if (nodes.delay)
        nodes.delay.delayTime.value = Math.max(0.01, p.time / 1000);
    if (nodes.feedback)
        nodes.feedback.gain.value = Math.min(0.92, Math.max(0, p.feedback));
    // EQ
    if (nodes.eqLow) {
        nodes.eqLow.frequency.value = p.eqLowFreq;
        nodes.eqLow.gain.value = p.eqLowGain;
    }
    if (nodes.eqMid) {
        nodes.eqMid.frequency.value = p.eqMidFreq;
        nodes.eqMid.gain.value = p.eqMidGain;
        nodes.eqMid.Q.value = p.eqMidQ;
    }
    if (nodes.eqHigh) {
        nodes.eqHigh.frequency.value = p.eqHighFreq;
        nodes.eqHigh.gain.value = p.eqHighGain;
    }
    // Compressor
    if (nodes.compNode) {
        nodes.compNode.threshold.value = p.compThreshold;
        nodes.compNode.ratio.value = p.compRatio;
        nodes.compNode.attack.value = p.compAttack / 1000;
        nodes.compNode.release.value = p.compRelease / 1000;
        nodes.compNode.knee.value = p.compKnee;
    }
    // Output gain the UI promises as "makeup".
    if (nodes.compMakeup)
        nodes.compMakeup.gain.value = dbToGain(p.compMakeup);
    // Gate: static downward expander, rebuilt whenever the threshold or the
    // reduction range move. No attack/release because this curve has no memory.
    if (nodes.gateShaper) {
        nodes.gateShaper.curve = gateCurve(p.gateThreshold, p.gateRange);
        nodes.gateThreshold = p.gateThreshold;
    }
    // Saturator
    if (nodes.satShaper)
        nodes.satShaper.curve = saturationCurve(p.satDrive);
    if (nodes.satTone)
        nodes.satTone.frequency.value = p.satTone;
    if (nodes.satTrim)
        nodes.satTrim.gain.value = dbToGain(p.satTrim);
    // Tremolo: LfoDepth offsets the carrier gain so depth 1 reaches silence.
    if (nodes.tremLfo)
        nodes.tremLfo.frequency.value = p.tremRate;
    if (nodes.tremGain && nodes.tremLfoDepth) {
        const depth = clampRange(p.tremDepth, 0, 1);
        nodes.tremGain.gain.value = 1 - depth / 2;
        nodes.tremLfoDepth.gain.value = depth / 2;
    }
    // De-esser: only the band above `deessFreq` is compressed.
    if (nodes.deessLow)
        nodes.deessLow.frequency.value = p.deessFreq;
    if (nodes.deessComp) {
        nodes.deessComp.threshold.value = p.deessThreshold;
        nodes.deessComp.ratio.value = p.deessRatio;
        nodes.deessComp.attack.value = p.deessAttack / 1000;
        nodes.deessComp.release.value = p.deessRelease / 1000;
    }
    // Limiter
    if (nodes.limNode) {
        nodes.limNode.threshold.value = p.limThreshold;
        nodes.limNode.release.value = p.limRelease / 1000;
    }
    if (nodes.limCeil)
        nodes.limCeil.gain.value = dbToGain(p.limCeiling);
}
/**
 * Schedules a clip's edge fades on a per-playback gain node. `playOffset` is
 * how far into the buffer this playback starts, so a loop point that lands
 * inside the fade region picks the ramp up where it should be instead of
 * restarting it.
 *
 * The envelope itself is `fadeGainAt` - the same definition the offline render
 * and the mix-math tests use. This function only translates it into WebAudio
 * events, which is what makes a fade you drew in the timeline the fade that
 * reaches the exported file.
 */
function scheduleClipFade(shape, t0, playOffset, clipEndSeconds, fadeIn, fadeOut) {
    // A clip with nothing to play keeps its node transparent.
    if (!(clipEndSeconds > 0)) {
        shape.gain.setValueAtTime(1, t0);
        return;
    }
    // Maps a clip time to context time; clamps because a playback that starts
    // past a point must not schedule events in the past.
    const at = (clipTime) => t0 + Math.max(0, clipTime - playOffset);
    const g = (clipTime) => fadeGainAt(clipTime, clipEndSeconds, fadeIn, fadeOut);
    const fin = clampRange(fadeIn, 0, clipEndSeconds);
    const fout = clampRange(fadeOut, 0, Math.max(0, clipEndSeconds - fin));
    shape.gain.setValueAtTime(g(playOffset), t0);
    if (fin > 0.0005 && playOffset < fin)
        shape.gain.linearRampToValueAtTime(g(fin), at(fin));
    if (fout > 0.0005) {
        const start = Math.max(playOffset, clipEndSeconds - fout);
        shape.gain.setValueAtTime(g(start), at(start));
        shape.gain.linearRampToValueAtTime(g(clipEndSeconds), at(clipEndSeconds));
    }
}
/**
 * Writes a volume-automation lane onto a gain param.
 *
 * Both the live graph and the offline render call this one function, which is
 * what guarantees that the ramp you drew is the ramp in the exported WAV.
 * Distances use `exponentialRampToValueAtTime`: equal ratios per equal time are
 * equal dB per second, so a straight line on the lane behaves like a straight
 * console fader move. The gain floor in `automationNodeGain` keeps a ramp away
 * from exactly zero, which WebAudio refuses to interpolate exponentially.
 *
 * `stepZeroTime` is the context time of step 0 (`fromStep` may be mid-lane when
 * playback resumed inside it) and `notBefore` is the earliest time an event may
 * land on - the current clock while rolling, zero for an offline render.
 */
function scheduleAutomationEnvelope(param, points, stepZeroTime, stepDuration, fromStep, notBefore) {
    const timeOf = (step) => stepZeroTime + step * stepDuration;
    const seedTime = Math.max(notBefore, timeOf(fromStep));
    param.cancelScheduledValues(seedTime);
    if (points.length === 0) {
        param.setValueAtTime(1, seedTime);
        return;
    }
    param.setValueAtTime(Math.max(0.0001, automationGainAt(points, fromStep)), seedTime);
    for (const point of points) {
        if (point.step <= fromStep + 1e-6)
            continue;
        const at = timeOf(point.step);
        if (at <= seedTime)
            continue;
        param.exponentialRampToValueAtTime(automationNodeGain(point.value), at);
    }
}
export class AudioEngine {
    ctx;
    masterGain;
    // Mix bus: tracks sum here, then pass through a full built-in FX rack
    // (glue EQ / compressor / limiter live here) before master volume.
    masterSum;
    masterFx;
    reverbBus;
    delayBus;
    monitorBus;
    salaBus;
    /**
     * Alimenta só a segunda saída. Cada entrada ao vivo tem um `secondGain` com
     * porta invertida à do monitor: quando o monitor está DESLIGADO a entrada
     * chega aqui (e portanto à segunda saída); quando LIGADO ela já viaja no master,
     * e este caminho fecha para não somar duas vezes. Assim o monitor decide
     * apenas o que o produtor ouve na saída principal — a segunda saída recebe
     * a entrada sempre.
     */
    secondBus;
    sendConfig = defaultSendConfig();
    masterAnalyser;
    /**
     * The exit of the whole mix: the master analyser and the monitor bus both
     * feed it, and it is the only node that reaches the speakers or the output
     * stream. Keeping one exit is what makes Dummy Audio possible — the clock and
     * every meter keep running while the door to the card is closed.
     */
    outputGain;
    /**
     * A porta de saída que o ASIO nativo silencia. Fica depois do tap do master:
     * com o sink ASIO ativo, o tap continua recebendo o mix inteiro (e mandando
     * para o driver da interface) enquanto este ganho zera só o caminho WASAPI,
     * para o mix não sair duas vezes. Fora do modo ASIO vale 1 e nada muda.
     */
    speakerGain;
    /** O worklet que copia o master para o processo ASIO; null quando não anexado. */
    masterTap = null;
    nativeSinkActive = false;
    /** Worklet node for ASIO input (receives PCM from native worker). */
    asioInputNode = null;
    /** MediaStream from ASIO input for use as track input. */
    asioInputStream = null;
    /** Number of ASIO input channels when active. */
    asioInputChannels = 0;
    /** True while the producer chose Dummy Audio: silent, but still rolling. */
    dummyAudio = false;
    /** Called when native sink is detached externally (e.g., worker crash). */
    onNativeSinkDetached = null;
    /**
     * The chosen playback device, when there is one. A Web Audio graph cannot name
     * a card, so the mix is handed to a stream and a hidden media element plays that
     * stream on the device the producer picked; `null` on both means the mix still
     * leaves through the context's own destination.
     */
    outputSink = null;
    outputElement = null;
    outputDevice = '';
    /** Secondary output (e.g., virtual cable) — same pattern, independent device. */
    outputSink2 = null;
    outputElement2 = null;
    outputDevice2 = '';
    /**
     * The virtual cable to the call room, and the two nodes that make it a mix-minus.
     *
     * `callSend` hangs off the master fader and drains into a stream, so the fader
     * the producer rides really is the level the room gets. `callReturn` is where
     * the room comes back in: it joins the graph *after* that tap, on the way to the
     * speakers only. A hardware desk needs a second master bus to do this; here it
     * is one extra connect, and it is the reason a remote musician does not hear
     * their own drum kit come back a hundred milliseconds late.
     */
    callSendNode = null;
    callAnalyserNode = null;
    callSinkNode = null;
    callReturnNode = null;
    callReturnAnalyser = null;
    /** Um por canal remoto: o retorno que entra pelos alto-falantes sem voltar pelo cabo. */
    callReturnFeeds = new Map();
    /**
     * O que o ganho do envio deveria ser, separado em duas causas. O fader do cabo
     * e o botão de mudo mexem no mesmo parâmetro do mesmo nó, e quem gravasse só um
     * deles esqueceria o outro ao mexer no primeiro — em uma mesa isso não acontece
     * porque o trim é um atenuador e o mudo é uma porta; aqui são dois campos e um
     * único `applyCallSendGain()` que os multiplica.
     */
    callSendDb = 0;
    callSendMuted = false;
    /**
     * O cabo virtual do próprio app: a master saindo do fader e entrando de novo
     * por uma faixa, como um retorno de mesa que se patcheia no canal.
     *
     * São nós separados do cabo da sala de propósito: o envio para a sala tem trim
     * e mudo próprios, e um produtor que corta a ida da sala não pode perder o
     * retorno que está gravando na faixa. Este aqui é unity, sempre — o que entra
     * é exatamente o que os alto-falantes estão ouvindo naquele instante.
     */
    masterCableAnalyser = null;
    masterCableSink = null;
    /**
     * O cabo do retorno da sala, montado só quando uma faixa o patcheia.
     *
     * A soma é um barramento próprio, em unity, ligado direto às fontes dos
     * canais remotos — antes dos ganhos de escuta. Fechar a lâmpada IN de um
     * participante silencia o que o producer ouve, não o que a faixa grava: o
     * cabo é um dispositivo de entrada, e um dispositivo não sabe se alguém
     * está monitorando. O analyser alimenta a linha dele na janela de
     * Dispositivos, e o sink é o stream que a machinery de entrada já sabe
     * gravar sem nenhuma cópia nova.
     */
    salaCableSum = null;
    salaCableAnalyser = null;
    salaCableSink = null;
    /**
   * Live BS.1770 meter on the master bus, attached when the app asks for it.
   * It runs on the audio thread and posts one reading per 100 ms window, so the
   * number on screen is the same measurement the exported file gets - not a
   * sample of a sample taken whenever a frame happened to arrive.
   */
    loudnessNode = null;
    loudnessSink = null;
    loudnessReading = null;
    /**
     * Called with every reading the meter closes - ten times a second while the
     * audio thread runs. Message driven rather than polled, because a poll only
     * sees whatever was last posted, and a frame that arrived late in a hidden tab
     * would otherwise freeze the number on screen at a moment that already passed.
     */
    onLoudness = null;
    /** One registration attempt at a time, shared by whoever asks first. */
    loudnessPatch = null;
    tracks = new Map();
    /** Sub-group buses, keyed by group id. */
    groups = new Map();
    /** Producer-created aux send buses, keyed by aux id. */
    auxes = new Map();
    sources = [];
    // Live instrument voices share a per-note gate; disconnecting the gate
    // silences every node of the voice at once (seek, stop, loop restart).
    voiceGates = [];
    inputs = new Map();
    /** Capture streams shared by every lane reading the same device. */
    sharedStreams = new Map();
    recorders = new Map();
    // Peak-per-chunk of each running take, handed to its lane so the waveform
    // grows while the producer plays instead of only after the take stops.
    takePeaks = new Map();
    /** Called (throttled) while a take is running: peaks so far, seconds so far. */
    onTakeProgress = null;
    /**
     * A worklet name is only registered inside the context it was added to, so the
     * set lives per context: a second export builds a fresh OfflineAudioContext and
     * has to run `addModule` again, or its plugin nodes would fail to be created.
     */
    loadedWorklets = new WeakMap();
    /** In-flight `addModule` calls, so two tracks asking at once share one. */
    workletLoads = new WeakMap();
    namEnginePromise = null;
    /**
     * Context time of step 0 for the current playback pass, and the length of a
     * 16th. Automation is written in steps but scheduled in seconds, so the graph
     * needs this translation while the song rolls.
     */
    songOriginTime = null;
    songStepDuration = 0.125;
    masterVolume = 0.9;
    masterMuted = false;
    constructor(options) {
        const Ctor = getAudioContextCtor();
        // The engine is the thing the chosen audio system configures: the sample
        // rate and the buffer hint are decided when the context is born, so the
        // device window persists them and asks for a fresh engine to apply them.
        // A host that refuses the rate falls back to the card's own instead of
        // leaving the producer without a context.
        try {
            this.ctx = new Ctor({
                latencyHint: options?.latencyHint ?? 'interactive',
                sampleRate: options?.sampleRate || undefined,
            });
        }
        catch {
            this.ctx = new Ctor({ latencyHint: options?.latencyHint ?? 'interactive' });
        }
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.masterVolume;
        this.masterAnalyser = this.ctx.createAnalyser();
        this.masterAnalyser.fftSize = 256;
        this.masterSum = this.ctx.createGain();
        this.masterFx = createBuiltinChain(this.ctx, defaultBuiltinFx());
        wireBuiltinSerial(this.masterFx);
        this.masterSum.connect(this.masterFx.input);
        this.masterFx.output.connect(this.masterGain);
        this.reverbBus = this.createSendBus('reverb');
        this.delayBus = this.createSendBus('delay');
        // Monitor bus: receives live input for user listening via headphones.
        // This is separate from the master output which goes to speakers.
        this.monitorBus = this.ctx.createGain();
        this.monitorBus.gain.value = 1;
        // Sala bus: receives live input from tracks for the call room.
        // This allows the signal to reach Sala even when monitor is OFF.
        // Taps the live input post-VST (live insert chain) but pre-track-FX.
        this.salaBus = this.ctx.createGain();
        this.salaBus.gain.value = 1;
        // Bus da segunda saída: recebe a entrada ao vivo mesmo com monitor OFF.
        // Só é ligado a outputSink2 quando uma segunda saída existe.
        this.secondBus = this.ctx.createGain();
        this.secondBus.gain.value = 1;
        // One door to the card: the master and the monitor both leave through it,
        // so Dummy Audio closes a single node instead of chasing every connection.
        this.outputGain = this.ctx.createGain();
        this.outputGain.gain.value = 1;
        this.speakerGain = this.ctx.createGain();
        this.speakerGain.gain.value = 1;
        this.masterGain.connect(this.masterAnalyser);
        this.masterAnalyser.connect(this.outputGain);
        this.monitorBus.connect(this.outputGain);
        this.outputGain.connect(this.speakerGain);
        this.speakerGain.connect(this.ctx.destination);
    }
    createSendBus(kind, ctx = this.ctx, destination) {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dest = destination ?? this.masterSum;
        if (kind === 'reverb') {
            const convolver = ctx.createConvolver();
            convolver.normalize = true;
            convolver.buffer = makeImpulse(ctx, this.sendConfig.rvDecay);
            input.connect(convolver);
            convolver.connect(output);
            output.gain.value = this.sendConfig.rvReturn;
            const bus = { input, output, convolver, decay: this.sendConfig.rvDecay };
            output.connect(dest);
            return bus;
        }
        const delayNode = ctx.createDelay(2);
        delayNode.delayTime.value = this.sendConfig.dlTime / 1000;
        const feedback = ctx.createGain();
        feedback.gain.value = Math.min(0.92, this.sendConfig.dlFeedback);
        input.connect(delayNode);
        delayNode.connect(feedback);
        feedback.connect(delayNode);
        delayNode.connect(output);
        output.gain.value = this.sendConfig.dlReturn;
        const bus = { input, output, delayNode, feedback };
        output.connect(dest);
        return bus;
    }
    /**
     * Ask the browser to start the clock.
     *
     * A page that has not seen a gesture yet can keep `resume()` waiting, and a
     * plugin restore that waits on it never builds its graph — the producer would
     * open the project and find no amps at all. So the wait is bounded: the nodes
     * are created either way, and the audio starts the moment the producer plays.
     */
    async resume() {
        if (this.ctx.state !== 'suspended')
            return;
        await Promise.race([
            this.ctx.resume().catch(() => undefined),
            new Promise((resolve) => {
                window.setTimeout(resolve, 300);
            }),
        ]);
    }
    // ---------------------------------------------------------------- master
    setMasterVolume(value) {
        this.masterVolume = value;
        if (!this.masterMuted) {
            this.masterGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
        }
    }
    setMasterMuted(muted) {
        this.masterMuted = muted;
        this.masterGain.gain.setTargetAtTime(muted ? 0 : this.masterVolume, this.ctx.currentTime, 0.01);
    }
    getMasterLevel() {
        return measurePeak(this.masterAnalyser);
    }
    // ------------------------------------------------------- cabo virtual (chamada)
    /**
     * Build, once, the cable that carries the mix out to a call room.
     *
     * It is lazy because the nodes belong to this context and a producer who never
     * opens a call should not pay for a stream destination and a meter they will not
     * read. Everything hangs off `masterGain`, which is the master fader: pull it
     * down and the room gets quieter, exactly like unpluging a send cable halfway.
     */
    ensureCallCable() {
        if (this.callSendNode && this.callSinkNode) {
            return { send: this.callSendNode, stream: this.callSinkNode.stream };
        }
        const send = this.ctx.createGain();
        // A cable rebuilt after a release starts from the settings the window still
        // shows, not from unity — otherwise the trim on screen would be a lie.
        send.gain.value = this.callSendMuted ? 0 : 10 ** (this.callSendDb / 20);
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0;
        const sink = this.ctx.createMediaStreamDestination();
        // Master mix (post-fader) goes to the call room
        this.masterGain.connect(send);
        // Also include direct Sala sends from tracks (pre-monitor, so signal reaches
        // the room even when local monitoring is OFF)
        this.salaBus.connect(send);
        send.connect(analyser);
        analyser.connect(sink);
        this.callSendNode = send;
        this.callAnalyserNode = analyser;
        this.callSinkNode = sink;
        return { send, stream: sink.stream };
    }
    /** O que sai pelo cabo, em pico 0..1 — o medidor do jack, não o do master. */
    getCallSendLevel() {
        return this.callAnalyserNode ? measurePeak(this.callAnalyserNode) : 0;
    }
    /**
     * O cabo virtual do app, montado uma vez: a master depois do fader, entrando de
     * novo por uma faixa.
     *
     * Lazy como o cabo da sala — quem nunca patcheia o retorno não paga por um
     * `MediaStreamAudioDestinationNode`. Depois do `masterGain` é de propósito: o
     * que a faixa grava tem que ser o que sai da mesa, FX do master, limiter e
     * fader incluídos, senão o "cabo" seria uma segunda mixagem paralela. O medidor
     * separado existe para a janela de Dispositivos poder mostrar o que está
     * passando pelo plug, e não o que o master mostra — os dois são iguais enquanto
     * ninguém mexer no envio da sala, e deixam de ser se ela for cortada.
     */
    ensureMasterCable() {
        if (this.masterCableSink)
            return this.masterCableSink.stream;
        const tap = this.ctx.createGain();
        tap.gain.value = 1;
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0;
        const sink = this.ctx.createMediaStreamDestination();
        this.masterGain.connect(tap);
        tap.connect(analyser);
        analyser.connect(sink);
        this.masterCableAnalyser = analyser;
        this.masterCableSink = sink;
        return sink.stream;
    }
    /** O que está passando pelo cabo agora, em pico 0..1 (0 enquanto ninguém abriu). */
    getMasterCableLevel() {
        return this.masterCableAnalyser ? measurePeak(this.masterCableAnalyser) : 0;
    }
    /** Se este id de entrada é o cabo do próprio app, e não um hardware. */
    static isMasterCable(deviceId) {
        return deviceId === MASTER_CABLE_ID;
    }
    /**
     * O retorno da sala como stream de entrada, montado uma vez.
     *
     * A soma nasce em unity e recebe as fontes dos canais remotos direto (sem o
     * ganho de escuta de cada um), então o que a faixa grava é o que a sala está
     * mandando, mesmo com todos os monitors fechados. Os feeds que já existiam
     * quando o cabo abre são ligados aqui; os que chegarem depois são ligados em
     * `connectCallReturn`. Sem sala ligada o barramento fica mudo — o cabo não
     * disca nada, não cria sala nenhuma, só espera o produtor ligar a janela.
     */
    ensureSalaCable() {
        if (this.salaCableSink)
            return this.salaCableSink.stream;
        const sum = this.ctx.createGain();
        sum.gain.value = 1;
        for (const feed of this.callReturnFeeds.values()) {
            feed.source.connect(sum);
        }
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0;
        const sink = this.ctx.createMediaStreamDestination();
        sum.connect(analyser);
        analyser.connect(sink);
        this.salaCableSum = sum;
        this.salaCableAnalyser = analyser;
        this.salaCableSink = sink;
        return sink.stream;
    }
    /** O que a sala está mandando agora, em pico 0..1 (0 sem sala ou sem cabo aberto). */
    getSalaCableLevel() {
        return this.salaCableAnalyser ? measurePeak(this.salaCableAnalyser) : 0;
    }
    /** Se este id de entrada é o retorno da sala, e não um hardware. */
    static isSalaCable(deviceId) {
        return deviceId === SALA_CABLE_ID;
    }
    /** Nível do que chega da sala (só existe enquanto houver retorno patcheado). */
    getCallReturnLevel() {
        if (!this.callReturnNode)
            return 0;
        if (!this.callReturnAnalyser) {
            const analyser = this.ctx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0;
            this.callReturnNode.connect(analyser);
            this.callReturnAnalyser = analyser;
        }
        return measurePeak(this.callReturnAnalyser);
    }
    setCallSendDb(value) {
        this.callSendDb = Number.isFinite(value) ? Math.max(-90, Math.min(12, value)) : 0;
        this.applyCallSendGain();
    }
    get callSendTrimDb() {
        return this.callSendDb;
    }
    /**
     * Mudo do cabo: a sala deixa de ouvir a DAW, e a DAW continua ouvindo a sala.
     * É o botão "mix minus" de uma mesa, não o mute do canal — nada aqui toca o
     * master fader, então os alto-falantes seguem fazendo o que fazem.
     */
    setCallSendMuted(muted) {
        this.callSendMuted = muted;
        this.applyCallSendGain();
    }
    get isCallSendMuted() {
        return this.callSendMuted;
    }
    applyCallSendGain() {
        if (!this.callSendNode)
            return;
        const gain = this.callSendMuted ? 0 : 10 ** (this.callSendDb / 20);
        this.callSendNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
    }
    /**
     * O ponto de entrada do retorno da sala. Ele se liga ao `masterAnalyser`, que é
     * justamente o nó que a janela de saída já escolhe como caminho para a caixa de
     * som: assim o retorno obedece ao dispositivo roteado sem que o roteamento
     * precise saber que a chamada existe.
     */
    get callReturn() {
        if (!this.callReturnNode) {
            const node = this.ctx.createGain();
            node.gain.value = 1;
            node.connect(this.masterAnalyser);
            this.callReturnNode = node;
        }
        return this.callReturnNode;
    }
    /**
     * Põe o retorno da sala no caminho dos alto-falantes sem voltar pelo cabo.
     *
     * A faixa gravável do participante já imprime o que chega (`connectCallInput`),
     * mas o monitor dele entra por aqui, depois do ponto de envio: é o que evita que
     * o outro músico escute a própria bateria atrasada. Um `key` por canal, para o
     * app poder desligar exatamente o que apagou.
     */
    connectCallReturn(key, stream, listen = true) {
        const existing = this.callReturnFeeds.get(key);
        if (existing) {
            try {
                existing.source.disconnect();
                existing.gain.disconnect();
            }
            catch {
                /* re-patch do mesmo canal */
            }
        }
        const source = this.ctx.createMediaStreamSource(stream);
        const gain = this.ctx.createGain();
        gain.gain.value = listen ? 1 : 0;
        source.connect(gain);
        gain.connect(this.callReturn);
        // O cabo de entrada da sala lê a fonte antes do ganho de escuta: a faixa
        // que o patcheia grava o participante mesmo com o monitor dele fechado.
        if (this.salaCableSum)
            source.connect(this.salaCableSum);
        this.callReturnFeeds.set(key, { source, gain });
    }
    /**
     * O nível de escuta de um canal da sala — a lâmpada IN da faixa dele.
     *
     * Fica no retorno, e não na mixagem da faixa, por um motivo: o fader da faixa
     * alimenta o master, e o master é o que sai pelo cabo. Abrir a escuta por ali
     * faria o músico do outro lado ouvir a si mesmo com o atraso da rede, que é o
     * eco que quebra qualquer jam. Por aqui ele some dos seus alto-falantes sem
     * mudar nada do que a sala recebe.
     */
    setCallReturnGain(key, value) {
        const feed = this.callReturnFeeds.get(key);
        if (!feed)
            return;
        const gain = Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 0;
        feed.gain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
    }
    getCallReturnGain(key) {
        return this.callReturnFeeds.get(key)?.gain.gain.value ?? 0;
    }
    /** As chaves de retorno ligadas agora, para quem desmonta o cabo por completo. */
    callReturnKeys() {
        return [...this.callReturnFeeds.keys()];
    }
    disconnectCallReturn(key) {
        const feed = this.callReturnFeeds.get(key);
        if (!feed)
            return;
        try {
            feed.source.disconnect();
            feed.gain.disconnect();
        }
        catch {
            /* já solto */
        }
        this.callReturnFeeds.delete(key);
    }
    /** Solta o cabo de vez: a faixa do stream morre e os nós saem da cadeia. */
    releaseCallCable() {
        try {
            this.callSendNode?.disconnect();
            this.callAnalyserNode?.disconnect();
            this.callSinkNode?.stream.getTracks().forEach((track) => track.stop());
        }
        catch {
            /* já solto */
        }
        this.callSendNode = null;
        this.callAnalyserNode = null;
        this.callSinkNode = null;
    }
    /**
     * How much the master compressor and limiter are squeezing, in dB of gain
     * reduction (0 means neither is working). `reduction` is the browser's own
     * audio-thread measurement, so the meter shows what the master is really doing
     * rather than what the knobs suggest it should do.
     */
    getMasterReduction() {
        const comp = this.masterFx.units.comp;
        const limiter = this.masterFx.units.limiter;
        const working = (unit, active) => {
            if (!active)
                return 0;
            const node = unit.compNode ?? unit.limNode;
            return node ? node.reduction : 0;
        };
        return (working(comp, this.masterFx.state.comp.enabled) +
            working(limiter, this.masterFx.state.limiter.enabled));
    }
    /**
     * Attach the live loudness meter to the master bus.
     *
     * It taps the signal after the master fader and after the master FX, which is
     * the same place the export measures, and it is only ever created on the live
     * context: the offline render computes its own loudness from the bytes it
     * wrote, so it has no use for a meter and no reason to pay for one.
     */
    async enableLoudnessMeter() {
        if (this.loudnessNode)
            return;
        if (!this.loudnessPatch) {
            this.loudnessPatch = this.patchLoudnessMeter().catch((error) => {
                // A worklet that failed to register must not fail forever: forget the
                // attempt so the next call can try again after a reload of the page.
                this.loudnessPatch = null;
                throw error;
            });
        }
        await this.loudnessPatch;
    }
    async patchLoudnessMeter() {
        await this.ensureWorkletModule(this.ctx, LOUDNESS_PROCESSOR_NAME, LOUDNESS_WORKLET_SOURCE);
        if (this.loudnessNode && this.loudnessSink)
            return;
        const node = new AudioWorkletNode(this.ctx, LOUDNESS_PROCESSOR_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });
        node.port.onmessage = (event) => {
            this.loudnessReading = event.data;
            // Only while the thread is actually running: a reading posted the moment
            // before a pause is not a measurement of anything happening now.
            if (this.ctx.state === 'running')
                this.onLoudness?.(event.data);
        };
        // A processor whose output goes nowhere is not pulled, and a meter that is
        // never pulled never closes a window. Give it a silent way out of the graph.
        const sink = this.ctx.createGain();
        sink.gain.value = 0;
        node.connect(sink);
        sink.connect(this.ctx.destination);
        this.masterGain.connect(node);
        this.loudnessNode = node;
        this.loudnessSink = sink;
    }
    /**
     * The last reading the master produced, or null when there is nothing honest
     * to show: the meter is not attached, the audio thread is paused - and a
     * number from before the pause describes a moment that is not happening - or
     * the first 400 ms window has not closed yet.
     */
    getMasterLoudness() {
        if (!this.loudnessNode || this.ctx.state !== 'running')
            return null;
        return this.loudnessReading;
    }
    /**
     * Forget the window. A new project is not the tail of the one that was just
     * on screen, and a three second mean that still carries the old mix would be
     * the first dishonest number in the app.
     */
    resetLoudnessMeter() {
        this.loudnessNode?.port.postMessage('reset');
        this.loudnessReading = null;
    }
    // ------------------------------------------------------------ sub-groups
    /**
     * Create a sub-group bus. Members are tracks whose `groupId` names it; their
     * output lands on `input` and leaves through the group fader, so one move of
     * this fader moves every member - which is exactly what the export does too.
     */
    addGroup(id, volume = 1, pan = 0) {
        if (this.groups.has(id))
            return;
        const input = this.ctx.createGain();
        const fx = createBuiltinChain(this.ctx, defaultBuiltinFx());
        wireBuiltinSerial(fx);
        const panner = this.ctx.createStereoPanner();
        const analyser = this.ctx.createAnalyser();
        const output = this.ctx.createGain();
        const autoGain = this.ctx.createGain();
        autoGain.gain.value = 1;
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.55;
        panner.pan.value = pan;
        output.gain.value = this.groupsGain(volume, false);
        input.connect(fx.input);
        fx.output.connect(panner);
        panner.connect(output);
        output.connect(autoGain);
        autoGain.connect(analyser);
        analyser.connect(this.masterSum);
        this.groups.set(id, {
            input, fx, panner, analyser, output, autoGain, automation: [], volume, pan, muted: false,
        });
    }
    hasGroup(id) {
        return this.groups.has(id);
    }
    listGroups() {
        return [...this.groups.keys()];
    }
    /** Every member is rewired to the master before the bus disappears. */
    removeGroup(id) {
        const group = this.groups.get(id);
        if (!group)
            return;
        for (const [trackId, track] of this.tracks) {
            if (track.groupId === id)
                this.setTrackGroup(trackId, '');
        }
        group.input.disconnect();
        for (const unit of Object.values(group.fx.units)) {
            unit.lfo?.stop();
            unit.tremLfo?.stop();
            for (const node of unit.extra)
                node.disconnect();
        }
        group.fx.input.disconnect();
        group.fx.output.disconnect();
        group.panner.disconnect();
        group.analyser.disconnect();
        group.output.disconnect();
        group.autoGain.disconnect();
        this.groups.delete(id);
    }
    /**
     * Route a track's post-fader output to a group ('' = straight to master).
     * Only that one edge moves: the buffer, plugins and sends of the track stay
     * exactly as they were.
     */
    setTrackGroup(trackId, groupId) {
        const track = this.tracks.get(trackId);
        if (!track)
            return;
        const target = this.groups.has(groupId) ? groupId : '';
        if (track.groupId === target)
            return;
        track.groupId = target;
        // A call lane stays post-send even if a group is chosen: putting it into a
        // group would feed the master sum and send the guest back to the room.
        if (track.postSend)
            return;
        track.analyser.disconnect();
        track.analyser.connect(this.groupInput(target));
    }
    /**
     * Marca a faixa como canal de convidado da Sala e move a saída do canal para
     * depois do ponto de envio. O convidado passa a obedecer ao fader, mute, pan e
     * FX da própria faixa dentro da DAW, mas o som dele não entra no `masterSum`
     * (que é o que volta pra sala) — entra só no caminho dos alto-falantes, depois
     * do envio, então o músico remoto não escuta a si mesmo atrasado.
     */
    setTrackPostSend(trackId, enabled) {
        const track = this.tracks.get(trackId);
        if (!track || track.postSend === enabled)
            return;
        track.postSend = enabled;
        track.analyser.disconnect();
        track.analyser.connect(enabled ? this.masterAnalyser : this.groupInput(track.groupId));
    }
    setGroupVolume(id, value) {
        const group = this.groups.get(id);
        if (!group)
            return;
        group.volume = value;
        group.output.gain.setTargetAtTime(this.groupsGain(value, group.muted), this.ctx.currentTime, 0.01);
    }
    setGroupPan(id, value) {
        const group = this.groups.get(id);
        if (!group)
            return;
        group.pan = value;
        group.panner.pan.setTargetAtTime(value, this.ctx.currentTime, 0.01);
    }
    setGroupMuted(id, muted) {
        const group = this.groups.get(id);
        if (!group)
            return;
        group.muted = muted;
        group.output.gain.setTargetAtTime(this.groupsGain(group.volume, muted), this.ctx.currentTime, 0.01);
    }
    getGroupLevel(id) {
        const group = this.groups.get(id);
        return group ? measurePeak(group.analyser) : 0;
    }
    /** Set one built-in unit on a sub-group's rack, mirroring the master bus. */
    setGroupFx(id, fxId, unit) {
        const group = this.groups.get(id);
        if (!group)
            return;
        const copy = { enabled: unit.enabled, mix: unit.mix, params: { ...unit.params } };
        group.fx.state[fxId] = copy;
        applyBuiltinUnit(group.fx.units[fxId], copy);
    }
    getGroupFx(id) {
        const group = this.groups.get(id);
        if (!group)
            return null;
        const rack = defaultBuiltinFx();
        for (const fxId of BUILTIN_FX_IDS) {
            const unit = group.fx.state[fxId];
            rack[fxId] = { enabled: unit.enabled, mix: unit.mix, params: { ...unit.params } };
        }
        return rack;
    }
    applyGroupFxPreset(id, rack) {
        for (const fxId of BUILTIN_FX_IDS)
            this.setGroupFx(id, fxId, rack[fxId]);
    }
    /** Drawn volume envelope for the bus, in the same step/dB language as tracks. */
    setGroupAutomation(id, points) {
        const group = this.groups.get(id);
        if (!group)
            return;
        group.automation = sortedAutomation(points);
        if (this.songOriginTime !== null)
            this.scheduleGroupAutomation(group);
    }
    getGroupAutomation(id) {
        return [...(this.groups.get(id)?.automation ?? [])];
    }
    scheduleGroupAutomation(group, fromStep = 0) {
        const origin = this.songOriginTime;
        if (origin === null)
            return;
        const stepDuration = this.songStepDuration;
        const now = this.ctx.currentTime;
        const startStep = Math.max(0, fromStep, (now - origin) / stepDuration);
        scheduleAutomationEnvelope(group.autoGain.gain, group.automation, origin, stepDuration, startStep, now);
    }
    groupsGain(volume, muted) {
        return muted ? 0 : Math.max(0, volume);
    }
    groupInput(groupId) {
        const group = this.groups.get(groupId);
        return group ? group.input : this.masterSum;
    }
    // ------------------------------------------------------------- aux sends
    /**
     * Create a free aux bus. Every existing track gets a silent send tap into it,
     * so the producer can immediately dial sends from the mixer; the bus itself is
     * transparent (rack disabled) until something is enabled on it.
     */
    addAux(id, volume = 1) {
        if (this.auxes.has(id))
            return;
        const input = this.ctx.createGain();
        const fx = createBuiltinChain(this.ctx, defaultBuiltinFx());
        wireBuiltinSerial(fx);
        const output = this.ctx.createGain();
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.55;
        output.gain.value = Math.max(0, volume);
        input.connect(fx.input);
        fx.output.connect(output);
        output.connect(analyser);
        analyser.connect(this.masterSum);
        this.auxes.set(id, { input, fx, output, analyser, volume, muted: false });
        for (const track of this.tracks.values()) {
            if (track.auxSends.has(id))
                continue;
            const send = this.ctx.createGain();
            send.gain.value = 0;
            track.duckGain.connect(send);
            send.connect(input);
            track.auxSends.set(id, send);
        }
    }
    hasAux(id) {
        return this.auxes.has(id);
    }
    listAuxes() {
        return [...this.auxes.keys()];
    }
    /** Tear the bus down and pull every track's send tap out of it. */
    removeAux(id) {
        const aux = this.auxes.get(id);
        if (!aux)
            return;
        for (const track of this.tracks.values()) {
            const send = track.auxSends.get(id);
            if (send) {
                send.disconnect();
                track.auxSends.delete(id);
            }
        }
        aux.input.disconnect();
        for (const unit of Object.values(aux.fx.units)) {
            unit.lfo?.stop();
            unit.tremLfo?.stop();
            for (const node of unit.extra)
                node.disconnect();
        }
        aux.fx.input.disconnect();
        aux.fx.output.disconnect();
        aux.output.disconnect();
        aux.analyser.disconnect();
        this.auxes.delete(id);
    }
    setAuxVolume(id, value) {
        const aux = this.auxes.get(id);
        if (!aux)
            return;
        aux.volume = value;
        aux.output.gain.setTargetAtTime(aux.muted ? 0 : Math.max(0, value), this.ctx.currentTime, 0.01);
    }
    setAuxMuted(id, muted) {
        const aux = this.auxes.get(id);
        if (!aux)
            return;
        aux.muted = muted;
        aux.output.gain.setTargetAtTime(muted ? 0 : Math.max(0, aux.volume), this.ctx.currentTime, 0.01);
    }
    /** How much of one track feeds one aux (0..1-ish linear send gain). */
    setAuxSend(trackId, auxId, value) {
        const send = this.tracks.get(trackId)?.auxSends.get(auxId);
        if (!send)
            return;
        send.gain.setTargetAtTime(Math.max(0, value), this.ctx.currentTime, 0.01);
    }
    getAuxSend(trackId, auxId) {
        return this.tracks.get(trackId)?.auxSends.get(auxId)?.gain.value ?? 0;
    }
    getAuxLevel(id) {
        const aux = this.auxes.get(id);
        return aux ? measurePeak(aux.analyser) : 0;
    }
    setAuxFx(id, fxId, unit) {
        const aux = this.auxes.get(id);
        if (!aux)
            return;
        const copy = { enabled: unit.enabled, mix: unit.mix, params: { ...unit.params } };
        aux.fx.state[fxId] = copy;
        applyBuiltinUnit(aux.fx.units[fxId], copy);
    }
    getAuxFx(id) {
        const aux = this.auxes.get(id);
        if (!aux)
            return null;
        const rack = defaultBuiltinFx();
        for (const fxId of BUILTIN_FX_IDS) {
            const unit = aux.fx.state[fxId];
            rack[fxId] = { enabled: unit.enabled, mix: unit.mix, params: { ...unit.params } };
        }
        return rack;
    }
    applyAuxFxPreset(id, rack) {
        for (const fxId of BUILTIN_FX_IDS)
            this.setAuxFx(id, fxId, rack[fxId]);
    }
    // --------------------------------------------------------------- sidechain
    /**
     * Make one track duck whenever others speak - kick against bass, voice against
     * music, kick *and* snare against a rhythm guitar. `sourceIds` of [] removes
     * the duck.
     *
     * Every source lands on the same follower input, so their signals add before
     * the envelope is measured - the same summing amp an external compressor has.
     *
     * The envelope is followed on the audio thread by the shared worklet, and the
     * result drives `duckGain.gain` directly, so the same numbers run in the
     * offline render: what you hear ducked is what the file exports.
     */
    async setSidechainDuck(trackId, sourceIds, depth = 0.7) {
        const track = this.tracks.get(trackId);
        if (!track)
            return;
        const level = clampRange(depth, 0, 1);
        track.duckDepth = level;
        const wanted = normalizeDuckSources(sourceIds, trackId, this.tracks.keys());
        // Claimed or live, the right sources are already recorded: then only the
        // depth moves, and a second call cannot start a second follower.
        if (sameIdList(track.duckSourceIds, wanted)) {
            track.duck?.follower.parameters.get('depth')?.setValueAtTime(level, this.ctx.currentTime);
            return;
        }
        if (wanted.length === 0) {
            this.releaseDuck(track);
            return;
        }
        // Record the claim before awaiting the module, so concurrent calls for the
        // same duck cannot both reach the build step. The last one to arrive owns it.
        track.duckSourceIds = wanted;
        await this.buildDuck(trackId, wanted, level);
    }
    /** Which tracks currently open this track's gate, in the order they were added. */
    getSidechainSources(trackId) {
        return [...(this.tracks.get(trackId)?.duckSourceIds ?? [])];
    }
    /**
     * The follower's output is connected to `duckGain.gain`, whose intrinsic value
     * must be 0: an AudioParam adds its own value to every connected input, so a
     * leftover 1 would put the whole duck back under the signal.
     *
     * Adding or removing a source keeps the existing follower: its envelope has
     * memory (attack and release), and throwing it away would make the duck hiccup
     * at the moment the producer is only trying to change who controls it.
     */
    async buildDuck(trackId, wanted, depth) {
        await this.ensureWorkletModule(this.ctx, SIDECHAIN_PROCESSOR_NAME, SIDECHAIN_WORKLET_SOURCE);
        // Either the track is gone, or a later call has since claimed a different
        // list; that call does the wiring, and honouring this one would undo it.
        const track = this.tracks.get(trackId);
        if (!track || !sameIdList(track.duckSourceIds, wanted))
            return;
        let link = track.duck;
        if (!link) {
            const follower = new AudioWorkletNode(this.ctx, SIDECHAIN_PROCESSOR_NAME, {
                numberOfInputs: 2,
                numberOfOutputs: 1,
                outputChannelCount: [1],
            });
            // A worklet whose only destination is an AudioParam is not pulled by Chrome,
            // so give the control signal a silent way out of the graph.
            const sink = this.ctx.createGain();
            sink.gain.value = 0;
            follower.connect(sink);
            sink.connect(this.masterSum);
            follower.connect(track.duckGain.gain);
            track.duckGain.gain.value = 0;
            link = { follower, sink, sources: [] };
            track.duck = link;
        }
        link.follower.parameters.get('depth')?.setValueAtTime(depth, this.ctx.currentTime);
        const still = new Set(wanted);
        for (const id of link.sources) {
            if (still.has(id))
                continue;
            // A source that is gone with its track needs no unplugging; its nodes were
            // disconnected when it was removed.
            this.tracks.get(id)?.monoMerger.disconnect(link.follower);
        }
        const wired = [];
        for (const id of wanted) {
            const source = this.tracks.get(id);
            if (!source)
                continue;
            if (!link.sources.includes(id))
                source.monoMerger.connect(link.follower);
            wired.push(id);
        }
        link.sources = wired;
    }
    /** Tear the control path down and hand the fader back to the track. */
    releaseDuck(track) {
        if (track.duck) {
            for (const id of track.duck.sources) {
                this.tracks.get(id)?.monoMerger.disconnect(track.duck.follower);
            }
            track.duck.follower.disconnect();
            track.duck.follower.disconnect(track.duckGain.gain);
            track.duck.sink.disconnect();
            track.duck = null;
        }
        track.duckSourceIds = [];
        track.duckGain.gain.value = 1;
    }
    /**
     * Register a worklet from source text once per context. Callers that arrive
     * together share one promise: two `addModule` calls racing on the same
     * processor name throw, and a duck turned on while the export runs would
     * otherwise be enough to trip it.
     */
    async ensureWorkletModule(ctx, processorName, source) {
        const registered = this.workletNamesFor(ctx);
        if (registered.has(processorName))
            return;
        const loads = this.workletLoadsFor(ctx);
        const pending = loads.get(processorName);
        if (pending) {
            await pending;
            return;
        }
        const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
        const load = (async () => {
            try {
                await ctx.audioWorklet.addModule(url);
                registered.add(processorName);
            }
            finally {
                URL.revokeObjectURL(url);
                loads.delete(processorName);
            }
        })();
        loads.set(processorName, load);
        await load;
    }
    workletNamesFor(ctx) {
        let names = this.loadedWorklets.get(ctx);
        if (!names) {
            names = new Set();
            this.loadedWorklets.set(ctx, names);
        }
        return names;
    }
    workletLoadsFor(ctx) {
        let loads = this.workletLoads.get(ctx);
        if (!loads) {
            loads = new Map();
            this.workletLoads.set(ctx, loads);
        }
        return loads;
    }
    // ---------------------------------------------------------------- tracks
    addTrack(id, volume = 1, pan = 0) {
        // Never stack two graphs on one id: the old nodes would stay wired to the
        // mix bus and keep contributing to the output.
        if (this.tracks.has(id))
            this.removeTrack(id);
        const panner = this.ctx.createStereoPanner();
        const fxInput = this.ctx.createGain();
        const shaper = this.ctx.createWaveShaper();
        const filter = this.ctx.createBiquadFilter();
        const fx = createBuiltinChain(this.ctx, defaultBuiltinFx());
        const namSplit = this.ctx.createGain();
        const namSum = this.ctx.createGain();
        const gain = this.ctx.createGain();
        const autoGain = this.ctx.createGain();
        const analyser = this.ctx.createAnalyser();
        // Mono fold-down lives between the track gain and the analyser so the meter
        // still shows what actually reaches the mix.
        const monoSplitter = this.ctx.createChannelSplitter(2);
        const monoMerger = this.ctx.createChannelMerger(2);
        const monoGains = [
            this.ctx.createGain(),
            this.ctx.createGain(),
            this.ctx.createGain(),
            this.ctx.createGain(),
        ];
        const rvSend = this.ctx.createGain();
        const dlSend = this.ctx.createGain();
        const duckGain = this.ctx.createGain();
        analyser.fftSize = 256;
        gain.gain.value = volume;
        panner.pan.value = pan;
        filter.type = 'allpass';
        filter.frequency.value = 20000;
        monoGains[0].gain.value = 1;
        monoGains[1].gain.value = 0;
        monoGains[2].gain.value = 0;
        monoGains[3].gain.value = 1;
        rvSend.gain.value = 0;
        dlSend.gain.value = 0;
        duckGain.gain.value = 1;
        const track = {
            panner,
            fxInput,
            shaper,
            filter,
            fx,
            chain: BUILTIN_FX_IDS.map((fxId) => ({ kind: 'builtin', id: fxId })),
            namSplit,
            namSum,
            gain,
            autoGain,
            automation: [],
            analyser,
            trim: 1,
            phase: 1,
            mono: false,
            monoSplitter,
            monoMerger,
            monoGains,
            rvSend,
            dlSend,
            auxSends: new Map(),
            duckGain,
            duck: null,
            duckSourceIds: [],
            duckDepth: 0.7,
            plugins: [],
            muted: false,
            volume,
            pan,
            groupId: '',
            postSend: false,
            buffer: null,
            bufferLabel: '',
            monitor: null,
            clipStart: 0,
            clipDuration: 0,
            fadeIn: 0.005,
            fadeOut: 0.005,
            instrument: null,
            notes: [],
            patternSteps: 0,
            voice: '',
        };
        this.tracks.set(id, track);
        this.rewire(id);
        gain.connect(autoGain);
        autoGain.connect(monoSplitter);
        // 0: L -> L   1: L -> R   2: R -> L   3: R -> R
        monoSplitter.connect(monoGains[0], 0);
        monoSplitter.connect(monoGains[1], 0);
        monoSplitter.connect(monoGains[2], 1);
        monoSplitter.connect(monoGains[3], 1);
        monoGains[0].connect(monoMerger, 0, 0);
        monoGains[1].connect(monoMerger, 0, 1);
        monoGains[2].connect(monoMerger, 0, 0);
        monoGains[3].connect(monoMerger, 0, 1);
        monoMerger.connect(duckGain);
        duckGain.connect(analyser);
        analyser.connect(this.groupInput(track.groupId));
        duckGain.connect(rvSend);
        rvSend.connect(this.reverbBus.input);
        duckGain.connect(dlSend);
        dlSend.connect(this.delayBus.input);
        // Any aux that already exists gets a silent send tap from this track too.
        for (const [auxId, aux] of this.auxes) {
            const send = this.ctx.createGain();
            send.gain.value = 0;
            duckGain.connect(send);
            send.connect(aux.input);
            track.auxSends.set(auxId, send);
        }
    }
    /**
     * Whether the graph for `id` already exists. Callers that re-apply a full
     * track state must check this first: `addTrack` builds a brand new node
     * graph, so rebuilding a live track would drop its buffer and its loaded
     * NAM/IR plugins.
     */
    hasTrack(id) {
        return this.tracks.has(id);
    }
    removeTrack(id) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        this.disconnectInput(id);
        this.stopTrackRecorder(id);
        track.plugins.forEach((plugin) => plugin.dispose());
        track.panner.disconnect();
        track.fxInput.disconnect();
        track.shaper.disconnect();
        track.filter.disconnect();
        track.namSplit.disconnect();
        track.namSum.disconnect();
        // Every node a unit created is in its `extra` list, including the internal
        // wiring (shapers, LFOs, band splits, makeup gains) that used to leak when
        // only the shell was disconnected. Oscillators are stopped as well - a
        // running OscillatorNode keeps its context slice alive even when unplugged.
        for (const unit of Object.values(track.fx.units)) {
            unit.lfo?.stop();
            unit.tremLfo?.stop();
            for (const node of unit.extra)
                node.disconnect();
        }
        track.gain.disconnect();
        track.autoGain.disconnect();
        track.analyser.disconnect();
        track.monoSplitter.disconnect();
        track.monoMerger.disconnect();
        for (const stage of track.monoGains)
            stage.disconnect();
        track.rvSend.disconnect();
        track.dlSend.disconnect();
        for (const send of track.auxSends.values())
            send.disconnect();
        track.auxSends.clear();
        this.releaseDuck(track);
        track.duckGain.disconnect();
        // A track that was ducked by this one loses that source: the others it was
        // listening to keep working, and only a track left with nobody to follow is
        // handed its fader back.
        for (const other of this.tracks.values()) {
            if (other === track || !other.duckSourceIds.includes(id))
                continue;
            const rest = other.duckSourceIds.filter((sourceId) => sourceId !== id);
            if (rest.length === 0) {
                this.releaseDuck(other);
                continue;
            }
            const link = other.duck;
            if (link) {
                // The removed track's own outputs were unplugged above, so only the
                // follower's guest list needs updating.
                link.sources = link.sources.filter((sourceId) => sourceId !== id);
            }
            other.duckSourceIds = rest;
        }
        this.tracks.delete(id);
    }
    rewire(id) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        track.panner.disconnect();
        track.fxInput.disconnect();
        track.shaper.disconnect();
        track.filter.disconnect();
        track.namSplit.disconnect();
        track.namSum.disconnect();
        for (const plugin of track.plugins)
            plugin.output.disconnect();
        for (const unit of Object.values(track.fx.units))
            unit.output.disconnect();
        track.panner.connect(track.fxInput);
        track.fxInput.connect(track.shaper);
        track.shaper.connect(track.filter);
        const plugins = new Map(track.plugins.map((plugin) => [plugin.id, plugin]));
        const branches = [];
        const branchPluginIds = new Set();
        let currentBranch = null;
        for (const stage of track.chain) {
            if (stage.kind === 'builtin') {
                currentBranch = null;
                continue;
            }
            const plugin = plugins.get(stage.id);
            if (!plugin || !plugin.enabled)
                continue;
            if (plugin.kind === 'nam') {
                currentBranch = { id: plugin.id, plugins: [plugin] };
                branches.push(currentBranch);
                branchPluginIds.add(plugin.id);
            }
            else if (currentBranch) {
                currentBranch.plugins.push(plugin);
                branchPluginIds.add(plugin.id);
            }
        }
        let cursor = track.filter;
        let parallelConnected = false;
        for (const stage of track.chain) {
            if (branchPluginIds.has(stage.id)) {
                if (!parallelConnected && branches.length > 0) {
                    cursor.connect(track.namSplit);
                    for (const branch of branches) {
                        let bCursor = track.namSplit;
                        for (const plugin of branch.plugins) {
                            bCursor.connect(plugin.input);
                            bCursor = plugin.output;
                        }
                        bCursor.connect(track.namSum);
                    }
                    cursor = track.namSum;
                    parallelConnected = true;
                }
                continue;
            }
            if (stage.kind === 'builtin') {
                const unit = track.fx.units[stage.id];
                cursor.connect(unit.input);
                cursor = unit.output;
                continue;
            }
            const plugin = plugins.get(stage.id);
            if (!plugin || !plugin.enabled)
                continue;
            cursor.connect(plugin.input);
            cursor = plugin.output;
        }
        cursor.connect(track.gain);
        // A take reads the lane's input straight off its patch cable, so reweaving the
        // chain never moves the recorder's tap: the printer is above this method, and
        // the running pass keeps growing while the producer re-orders the effects
        // behind it.
    }
    setChainOrder(trackId, ids) {
        const track = this.tracks.get(trackId);
        if (!track)
            return;
        const chain = [];
        const pluginSeen = new Set();
        for (const id of ids) {
            if (id.startsWith('fx:')) {
                const fxId = id.slice(3);
                if (!BUILTIN_FX_IDS.includes(fxId))
                    continue;
                if (chain.some((stage) => stage.kind === 'builtin' && stage.id === fxId))
                    continue;
                chain.push({ kind: 'builtin', id: fxId });
            }
            else {
                const plugin = track.plugins.find((item) => item.id === id);
                if (!plugin || pluginSeen.has(id))
                    continue;
                pluginSeen.add(id);
                chain.push({ kind: 'plugin', id });
            }
        }
        // A built-in unit is wired because the chain says so: the producer adds it
        // and removes it, and a unit that is not in the list does not touch the
        // signal. Plugins are different — a file the producer loaded is never
        // dropped from the path just because the order list forgot it.
        for (const plugin of track.plugins) {
            if (!pluginSeen.has(plugin.id))
                chain.push({ kind: 'plugin', id: plugin.id });
        }
        track.chain = chain;
        this.rewire(trackId);
    }
    /**
     * Put a plugin instance on the track and in its signal path.
     *
     * A plugin is only half back until the chain names it: an instance that sits
     * in the rack but not in the list is a card with knobs and no audio, which is
     * exactly how a restored NAM used to come back. `insertPluginIntoChain` is
     * idempotent, so a caller that will re-apply the saved order right after loses
     * nothing by the plugin landing at a provisional spot first.
     */
    registerPlugin(track, plugin) {
        if (track.plugins.some((item) => item.id === plugin.id)) {
            // The id is taken: this instance lost a race between two restores. Take it
            // off the graph instead of leaving it silent and undisposable.
            plugin.dispose();
            return;
        }
        track.plugins.push(plugin);
        this.insertPluginIntoChain(track, plugin.id);
    }
    insertPluginIntoChain(track, pluginId) {
        if (track.chain.some((entry) => entry.kind === 'plugin' && entry.id === pluginId))
            return;
        const stage = { kind: 'plugin', id: pluginId };
        const plugin = track.plugins.find((item) => item.id === pluginId);
        if (plugin?.kind === 'nam') {
            // Keep all amps next to each other so the parallel group stays visually
            // obvious in the chain.
            let lastNam = -1;
            track.chain.forEach((entry, index) => {
                if (entry.kind !== 'plugin')
                    return;
                const item = track.plugins.find((candidate) => candidate.id === entry.id);
                if (item?.kind === 'nam')
                    lastNam = index;
            });
            if (lastNam >= 0) {
                track.chain.splice(lastNam + 1, 0, stage);
                return;
            }
        }
        const index = track.chain.findIndex((entry) => entry.kind === 'builtin');
        if (index < 0)
            track.chain.push(stage);
        else
            track.chain.splice(index, 0, stage);
    }
    setVolume(id, value) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        track.volume = value;
        this.applyTrackGain(track);
    }
    setPan(id, value) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        const clamped = Math.max(-1, Math.min(1, value));
        track.pan = clamped;
        track.panner.pan.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
    }
    setBuiltinFx(id, fxId, unit) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        const copy = { enabled: unit.enabled, mix: unit.mix, params: { ...unit.params } };
        track.fx.state[fxId] = copy;
        applyBuiltinUnit(track.fx.units[fxId], copy);
    }
    setMuted(id, muted) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        track.muted = muted;
        this.applyTrackGain(track);
    }
    /**
     * Track fader = volume x trim x polarity. Folding trim/phase into the single
     * gain node keeps the live and offline graphs identical.
     */
    applyTrackGain(track) {
        const value = track.muted ? 0 : track.volume * track.trim * track.phase;
        track.gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
    }
    setTrim(id, linear) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        track.trim = Math.max(0, Math.min(4, linear));
        this.applyTrackGain(track);
    }
    setPhaseInvert(id, invert) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        track.phase = invert ? -1 : 1;
        this.applyTrackGain(track);
    }
    setMono(id, mono) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        if (track.mono === mono)
            return;
        track.mono = mono;
        applyMonoGains(track.monoGains, mono, this.ctx.currentTime);
    }
    // ------------------------------------------------------------------ sends
    setTrackSend(id, kind, value) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        const gain = Math.max(0, Math.min(1, value));
        const node = kind === 'rv' ? track.rvSend : track.dlSend;
        node.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
    }
    setSendConfig(next) {
        const merged = { ...this.sendConfig, ...next };
        const rvDecay = clampRange(merged.rvDecay, 0.3, 8);
        const dlTime = clampRange(merged.dlTime, 20, 2000);
        const dlFeedback = clampRange(merged.dlFeedback, 0, 0.9);
        const rvReturn = clampRange(merged.rvReturn, 0, 2);
        const dlReturn = clampRange(merged.dlReturn, 0, 2);
        const changed = { ...this.sendConfig };
        this.sendConfig = { rvDecay, dlTime, dlFeedback, rvReturn, dlReturn };
        if (changed.rvDecay !== rvDecay) {
            this.reverbBus.decay = rvDecay;
            if (this.reverbBus.convolver) {
                this.reverbBus.convolver.buffer = makeImpulse(this.ctx, rvDecay);
            }
        }
        if (this.reverbBus.output)
            this.reverbBus.output.gain.value = rvReturn;
        if (this.delayBus.delayNode && changed.dlTime !== dlTime) {
            this.delayBus.delayNode.delayTime.setTargetAtTime(dlTime / 1000, this.ctx.currentTime, 0.05);
        }
        if (this.delayBus.feedback && changed.dlFeedback !== dlFeedback) {
            this.delayBus.feedback.gain.setTargetAtTime(dlFeedback, this.ctx.currentTime, 0.05);
        }
        if (this.delayBus.output)
            this.delayBus.output.gain.value = dlReturn;
    }
    getSendConfig() {
        return { ...this.sendConfig };
    }
    // -------------------------------------------------------------- master bus
    getTrackTunerAnalyser(trackId) {
        return this.tracks.get(trackId)?.fx.units.tuner.tunerAnalyser ?? null;
    }
    getMasterTunerAnalyser() {
        return this.masterFx.units.tuner.tunerAnalyser ?? null;
    }
    getAuxTunerAnalyser(auxId) {
        return this.auxes.get(auxId)?.fx.units.tuner.tunerAnalyser ?? null;
    }
    setMasterFx(fxId, unit) {
        const copy = { enabled: unit.enabled, mix: unit.mix, params: { ...unit.params } };
        this.masterFx.state[fxId] = copy;
        applyBuiltinUnit(this.masterFx.units[fxId], copy);
    }
    getMasterFx() {
        const rack = defaultBuiltinFx();
        for (const id of BUILTIN_FX_IDS) {
            const unit = this.masterFx.state[id];
            rack[id] = { enabled: unit.enabled, mix: unit.mix, params: { ...unit.params } };
        }
        return rack;
    }
    applyMasterFxPreset(rack) {
        for (const id of BUILTIN_FX_IDS)
            this.setMasterFx(id, rack[id]);
    }
    getTrackStaging(id) {
        const track = this.tracks.get(id);
        if (!track)
            return null;
        return {
            trim: track.trim,
            phase: track.phase,
            mono: track.mono,
            rv: track.rvSend.gain.value,
            dl: track.dlSend.gain.value,
        };
    }
    getLevel(id) {
        const track = this.tracks.get(id);
        if (!track)
            return 0;
        return measurePeak(track.analyser);
    }
    // --------------------------------------------------------------- plugins
    findTrack(trackId) {
        const track = this.tracks.get(trackId);
        if (!track)
            throw new Error('Track não encontrada');
        return track;
    }
    hasPlugin(trackId, pluginId) {
        return this.tracks.get(trackId)?.plugins.some((plugin) => plugin.id === pluginId) === true;
    }
    addIrPlugin(trackId, buffer, name, restore) {
        const track = this.findTrack(trackId);
        const input = this.ctx.createGain();
        const output = this.ctx.createGain();
        const dry = this.ctx.createGain();
        const wet = this.ctx.createGain();
        const sum = this.ctx.createGain();
        const level = this.ctx.createGain();
        const panner = this.ctx.createStereoPanner();
        const lowCut = this.ctx.createBiquadFilter();
        const highCut = this.ctx.createBiquadFilter();
        const convolver = this.ctx.createConvolver();
        lowCut.type = 'highpass';
        lowCut.frequency.value = 20;
        highCut.type = 'lowpass';
        highCut.frequency.value = 20000;
        convolver.normalize = true;
        convolver.buffer = buffer;
        dry.gain.value = 0;
        wet.gain.value = 1;
        level.gain.value = 1.2;
        // input -> dry ------------------------\
        // input -> filters -> IR -> wet -> sum -> level -> pan -> output
        input.connect(dry);
        dry.connect(sum);
        input.connect(lowCut);
        lowCut.connect(highCut);
        highCut.connect(convolver);
        convolver.connect(wet);
        wet.connect(sum);
        sum.connect(level);
        level.connect(panner);
        panner.connect(output);
        const params = [
            { name: 'Mix', value: 1, min: 0, max: 1, step: 0.01, unit: 'percent' },
            { name: 'Output', value: 1.2, min: 0, max: 3, step: 0.01, unit: 'ratio' },
            { name: 'Pan', value: 0, min: -1, max: 1, step: 0.01, unit: 'pan' },
            { name: 'Low Cut', value: 20, min: 20, max: 1000, step: 1, unit: 'hz' },
            { name: 'High Cut', value: 20000, min: 1000, max: 20000, step: 10, unit: 'hz' },
        ];
        const plugin = {
            id: restore?.id ?? newId(),
            name,
            kind: 'ir',
            enabled: restore?.enabled ?? true,
            params,
            detail: `${(buffer.duration * 1000).toFixed(0)} ms · ${buffer.numberOfChannels}ch`,
            input,
            output,
            source: { irBuffer: buffer },
            setParam: (paramName, value) => {
                const now = this.ctx.currentTime;
                if (paramName === 'Mix') {
                    dry.gain.setTargetAtTime(1 - value, now, 0.02);
                    wet.gain.setTargetAtTime(value, now, 0.02);
                }
                else if (paramName === 'Output') {
                    level.gain.setTargetAtTime(value, now, 0.02);
                }
                else if (paramName === 'Pan') {
                    panner.pan.setTargetAtTime(value, now, 0.02);
                }
                else if (paramName === 'Low Cut') {
                    lowCut.frequency.setTargetAtTime(value, now, 0.02);
                }
                else if (paramName === 'High Cut') {
                    highCut.frequency.setTargetAtTime(value, now, 0.02);
                }
            },
            dispose: () => {
                input.disconnect();
                dry.disconnect();
                lowCut.disconnect();
                highCut.disconnect();
                convolver.disconnect();
                wet.disconnect();
                sum.disconnect();
                level.disconnect();
                panner.disconnect();
                output.disconnect();
            },
        };
        this.registerPlugin(track, plugin);
        if (restore?.params) {
            for (const saved of restore.params) {
                const param = plugin.params.find((item) => item.name === saved.name);
                if (!param)
                    continue;
                param.value = saved.value;
                plugin.setParam(saved.name, saved.value);
            }
        }
        this.rewire(trackId);
        return toInfo(plugin);
    }
    async addWorkletPlugin(trackId, file, restore) {
        const track = this.findTrack(trackId);
        await this.resume();
        const sourceText = await file.text();
        const match = /registerProcessor\s*\(\s*['"`]([^'"`]+)['"`]/.exec(sourceText);
        if (!match) {
            throw new Error('o arquivo não registra um AudioWorkletProcessor');
        }
        const processorName = match[1];
        await this.ensureWorkletModule(this.ctx, processorName, sourceText);
        const node = new AudioWorkletNode(this.ctx, processorName);
        const panner = this.ctx.createStereoPanner();
        node.connect(panner);
        const params = [];
        node.parameters.forEach((param, paramName) => {
            const minRaw = Math.abs(param.minValue) > 1e6 ? 0 : param.minValue;
            const maxRaw = Math.abs(param.maxValue) > 1e6 ? 1 : param.maxValue;
            params.push({ name: paramName, value: param.value, min: minRaw, max: maxRaw });
        });
        params.push({ name: 'Pan', value: 0, min: -1, max: 1, step: 0.01, unit: 'pan' });
        const plugin = {
            id: restore?.id ?? newId(),
            name: file.name.replace(/\.js$/i, ''),
            kind: 'worklet',
            enabled: restore?.enabled ?? true,
            params,
            detail: processorName,
            input: node,
            output: panner,
            source: { workletSource: sourceText, processorName },
            setParam: (paramName, value) => {
                if (paramName === 'Pan') {
                    panner.pan.setTargetAtTime(value, this.ctx.currentTime, 0.02);
                    return;
                }
                node.parameters.get(paramName)?.setTargetAtTime(value, this.ctx.currentTime, 0.02);
            },
            dispose: () => {
                node.disconnect();
                panner.disconnect();
                node.port.close();
            },
        };
        this.registerPlugin(track, plugin);
        if (restore?.params) {
            for (const saved of restore.params) {
                const param = plugin.params.find((item) => item.name === saved.name);
                if (!param)
                    continue;
                param.value = saved.value;
                plugin.setParam(saved.name, saved.value);
            }
        }
        this.rewire(trackId);
        return toInfo(plugin);
    }
    getNamEngine() {
        if (!this.namEnginePromise) {
            this.namEnginePromise = NamEngine.attach(this.ctx, { assetBaseUrl: NAM_ASSET_BASE });
        }
        return this.namEnginePromise;
    }
    async addNamPlugin(trackId, file, restore) {
        const track = this.findTrack(trackId);
        await this.resume();
        const json = await file.text();
        try {
            JSON.parse(json);
        }
        catch {
            throw new Error('arquivo .nam inválido (JSON malformado)');
        }
        const engine = await this.getNamEngine();
        let slim = 1;
        // NAM is a mono model. Run one instance per channel so the pan control of
        // every amp in the chain survives the next stage instead of being summed.
        const nodes = [];
        const input = this.ctx.createGain();
        const output = this.ctx.createGain();
        const dry = this.ctx.createGain();
        const wet = this.ctx.createGain();
        const sum = this.ctx.createGain();
        const level = this.ctx.createGain();
        const panner = this.ctx.createStereoPanner();
        const stereo = this.ctx.createGain();
        const splitter = this.ctx.createChannelSplitter(2);
        const merger = this.ctx.createChannelMerger(2);
        const bass = this.ctx.createBiquadFilter();
        const mid = this.ctx.createBiquadFilter();
        const treble = this.ctx.createBiquadFilter();
        const presence = this.ctx.createBiquadFilter();
        bass.type = 'lowshelf';
        bass.frequency.value = 120;
        mid.type = 'peaking';
        mid.frequency.value = 700;
        mid.Q.value = 0.9;
        treble.type = 'highshelf';
        treble.frequency.value = 3200;
        presence.type = 'peaking';
        presence.frequency.value = 4500;
        presence.Q.value = 0.7;
        stereo.channelCount = 2;
        stereo.channelCountMode = 'explicit';
        stereo.channelInterpretation = 'speakers';
        dry.gain.value = 0;
        wet.gain.value = 1;
        level.gain.value = 1;
        let model;
        try {
            const left = await engine.createNode();
            left.channelCount = 1;
            left.channelCountMode = 'explicit';
            left.channelInterpretation = 'speakers';
            nodes.push(left);
            const right = await engine.createNode();
            right.channelCount = 1;
            right.channelCountMode = 'explicit';
            right.channelInterpretation = 'speakers';
            nodes.push(right);
            model = await left.loadModel(json, { slimSize: slim });
            await right.loadModel(json, { slimSize: slim });
        }
        catch (error) {
            nodes.forEach((node) => void node.dispose());
            throw error;
        }
        input.connect(stereo);
        stereo.connect(splitter);
        splitter.connect(nodes[0], 0);
        splitter.connect(nodes[1], 1);
        nodes[0].connect(merger, 0, 0);
        nodes[1].connect(merger, 0, 1);
        merger.connect(bass);
        bass.connect(mid);
        mid.connect(treble);
        treble.connect(presence);
        presence.connect(wet);
        wet.connect(sum);
        input.connect(dry);
        dry.connect(sum);
        sum.connect(level);
        level.connect(panner);
        panner.connect(output);
        const params = [
            { name: 'Input', value: 1, min: 0, max: 4, step: 0.01, unit: 'ratio' },
            { name: 'Bass', value: 0, min: -12, max: 12, step: 0.1, unit: 'db' },
            { name: 'Mid', value: 0, min: -12, max: 12, step: 0.1, unit: 'db' },
            { name: 'Treble', value: 0, min: -12, max: 12, step: 0.1, unit: 'db' },
            { name: 'Presence', value: 0, min: -12, max: 12, step: 0.1, unit: 'db' },
            { name: 'Output', value: 1, min: 0, max: 4, step: 0.01, unit: 'ratio' },
            { name: 'Mix', value: 1, min: 0, max: 1, step: 0.01, unit: 'percent' },
            { name: 'Pan', value: 0, min: -1, max: 1, step: 0.01, unit: 'pan' },
        ];
        if (model.slimmable) {
            params.push({ name: 'Slim', value: 1, min: 0, max: 1, step: 0.01, unit: 'percent' });
        }
        const sampleRateMismatch = model.expectedSampleRate > 0 && Math.abs(model.expectedSampleRate - this.ctx.sampleRate) > 1;
        const detailParts = [
            'stereo (2x mono)',
            model.slimmable ? 'A2 slimmable' : 'modelo estático',
            model.hasLoudness ? `${model.loudness.toFixed(1)} dB` : 'sem loudness',
            model.expectedSampleRate > 0 ? `${Math.round(model.expectedSampleRate)} Hz` : 'sr n/d',
        ];
        if (sampleRateMismatch)
            detailParts.push('⚠ resample');
        const plugin = {
            id: restore?.id ?? newId(),
            name: file.name.replace(/\.nam$/i, ''),
            kind: 'nam',
            enabled: restore?.enabled ?? true,
            params,
            detail: detailParts.join(' · '),
            input,
            output,
            source: { namJson: json, namSlim: slim },
            setParam: (paramName, value) => {
                const now = this.ctx.currentTime;
                if (paramName === 'Input') {
                    input.gain.setTargetAtTime(value, now, 0.02);
                }
                else if (paramName === 'Bass') {
                    bass.gain.setTargetAtTime(value, now, 0.02);
                }
                else if (paramName === 'Mid') {
                    mid.gain.setTargetAtTime(value, now, 0.02);
                }
                else if (paramName === 'Treble') {
                    treble.gain.setTargetAtTime(value, now, 0.02);
                }
                else if (paramName === 'Presence') {
                    presence.gain.setTargetAtTime(value, now, 0.02);
                }
                else if (paramName === 'Output') {
                    level.gain.setTargetAtTime(value, now, 0.02);
                }
                else if (paramName === 'Mix') {
                    dry.gain.setTargetAtTime(1 - value, now, 0.02);
                    wet.gain.setTargetAtTime(value, now, 0.02);
                }
                else if (paramName === 'Pan') {
                    panner.pan.setTargetAtTime(value, now, 0.02);
                }
                else if (paramName === 'Slim') {
                    slim = Math.max(0, Math.min(1, value));
                    plugin.source.namSlim = slim;
                    nodes.forEach((node) => void node.setSlimSize(slim));
                }
            },
            dispose: () => {
                nodes.forEach((node) => void node.dispose());
                input.disconnect();
                dry.disconnect();
                stereo.disconnect();
                splitter.disconnect();
                merger.disconnect();
                bass.disconnect();
                mid.disconnect();
                treble.disconnect();
                presence.disconnect();
                wet.disconnect();
                sum.disconnect();
                level.disconnect();
                panner.disconnect();
                output.disconnect();
            },
        };
        this.registerPlugin(track, plugin);
        if (restore?.params) {
            for (const saved of restore.params) {
                const param = plugin.params.find((item) => item.name === saved.name);
                if (!param)
                    continue;
                param.value = saved.value;
                plugin.setParam(saved.name, saved.value);
            }
        }
        this.rewire(trackId);
        return toInfo(plugin);
    }
    setPluginEnabled(trackId, pluginId, enabled) {
        const track = this.tracks.get(trackId);
        if (!track)
            return;
        const plugin = track.plugins.find((item) => item.id === pluginId);
        if (!plugin)
            return;
        plugin.enabled = enabled;
        this.rewire(trackId);
    }
    setPluginParam(trackId, pluginId, name, value) {
        const track = this.tracks.get(trackId);
        if (!track)
            return;
        const plugin = track.plugins.find((item) => item.id === pluginId);
        if (!plugin)
            return;
        plugin.setParam(name, value);
        const param = plugin.params.find((item) => item.name === name);
        if (param)
            param.value = value;
    }
    removePlugin(trackId, pluginId) {
        const track = this.tracks.get(trackId);
        if (!track)
            return;
        const index = track.plugins.findIndex((item) => item.id === pluginId);
        if (index < 0)
            return;
        track.plugins[index].dispose();
        track.plugins.splice(index, 1);
        track.chain = track.chain.filter((stage) => !(stage.kind === 'plugin' && stage.id === pluginId));
        this.rewire(trackId);
    }
    // ------------------------------------------------------- built-in amp sim
    setFxEnabled(id, enabled) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        if (enabled) {
            track.shaper.curve = makeDriveCurve(35);
            track.filter.type = 'lowpass';
            track.filter.frequency.setTargetAtTime(4500, this.ctx.currentTime, 0.02);
        }
        else {
            track.shaper.curve = null;
            track.filter.type = 'allpass';
            track.filter.frequency.setTargetAtTime(20000, this.ctx.currentTime, 0.02);
        }
    }
    setDrive(id, amount) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        track.shaper.curve = makeDriveCurve(amount);
    }
    setCabinet(id, frequency) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        track.filter.type = 'lowpass';
        track.filter.frequency.setTargetAtTime(frequency, this.ctx.currentTime, 0.02);
    }
    // ---------------------------------------------------------- input devices
    async listInputs() {
        await this.resume();
        try {
            // Asking for permission is what reveals device labels.
            const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
            probe.getTracks().forEach((track) => track.stop());
        }
        catch {
            /* permission denied: still try to list what the browser exposes */
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((device) => device.kind === 'audioinput');
    }
    /**
     * The same list without touching the microphone, so the app can auto-detect
     * an input on load without triggering the permission prompt. Labels stay
     * empty until the user has granted permission at least once, so the caller
     * must accept unnamed devices and prefer the ones that came back labelled.
     */
    async listInputsQuietly() {
        await this.resume();
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((device) => device.kind === 'audioinput');
    }
    /**
     * The first real input the browser exposes, system default first. Used when
     * a track is armed but no device was chosen — the producer should hear the
     * guitar the moment they plug it in, not after pressing a "detect" button.
     */
    async detectInput() {
        const devices = await this.listInputs();
        // A device id is only published once the page holds microphone permission,
        // so an unnamed/ id-less list means "the browser will not let us in", not
        // "there is no hardware". Say which, instead of opening a phantom input.
        const usable = devices.filter((device) => device.deviceId);
        if (usable.length === 0) {
            throw new Error(devices.length > 0
                ? 'O navegador negou permissão de microfone — libere o acesso no cadeado da barra de endereço'
                : 'Nenhum microfone ou interface encontrado pelo navegador');
        }
        return usable[0].deviceId;
    }
    /**
     * Open a live input for a track. The saved project can hold a device id that
     * no longer exists (an interface unplugged, a browser that renamed it), and
     * `exact` then throws `OverconstrainedError` — which is what makes an entry
     * look dead in a DAW that remembers its routing. So ask for that device, and
     * if the browser cannot give it, fall back to the system default and report
     * which one actually opened.
     *
     * `channel` picks which part of the device this lane owns. A two-input
     * interface is one browser stream, so lane A takes channel 1 and lane B takes
     * channel 2 by splitting that shared stream — the way a real console patches
     * two mic cables into two channels.
     *
     * Special device ID `opdaw:asio-input` uses the native ASIO input stream
     * when ASIO is active with input channels.
     */
    async connectInput(trackId, deviceId, monitor, channel = 0) {
        await this.resume();
        this.disconnectInput(trackId);
        const track = this.tracks.get(trackId);
        if (!track)
            throw new Error('Track não encontrada');
        // Handle ASIO input device
        const isAsioInput = deviceId === 'opdaw:asio-input';
        // The app's own cables are nodes in this context, not devices: never asked
        // of the browser, never counted in `sharedStreams`, never stopped by a lane
        // letting go. Everything after the branch is the ordinary lane machinery,
        // which is why the monitor lamp, the lane meter and the recorder work on a
        // cable without a second copy of any.
        const isMaster = deviceId === MASTER_CABLE_ID;
        const isSala = deviceId === SALA_CABLE_ID;
        const isCable = isMaster || isSala;
        let stream;
        let sourceChannels;
        let resolvedId;
        let liveLabel = 'Entrada de áudio';
        if (isAsioInput) {
            const asioStream = this.getAsioInputStream();
            if (!asioStream) {
                throw new Error('ASIO input não está ativo. Ative o ASIO com canais de entrada > 0.');
            }
            stream = asioStream;
            resolvedId = 'opdaw:asio-input';
            // Get channel count from the stream
            const tracks = stream.getAudioTracks();
            sourceChannels = tracks[0]?.getSettings().channelCount || this.asioInputChannels || 2;
            liveLabel = `ASIO Input (${sourceChannels} ch)`;
        }
        else {
            const constraints = (id, strict) => ({
                audio: {
                    deviceId: id ? (strict ? { exact: id } : { ideal: id }) : undefined,
                    // Ask for everything the interface can give: a lane that wants input 5
                    // can only take it if the stream carries five. A two-input device still
                    // answers with two, and nothing breaks.
                    channelCount: { ideal: MAX_INPUT_CHANNELS },
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
            });
            // One interface is one physical stream. Two lanes patching channel 1 and
            // channel 2 must read the same stream instead of asking the browser for the
            // same hardware twice. The app's own cables are the deliberate exception.
            const cached = isCable ? undefined : this.sharedStreams.get(deviceId);
            if (isMaster) {
                stream = this.ensureMasterCable();
            }
            else if (isSala) {
                stream = this.ensureSalaCable();
            }
            else if (cached) {
                stream = cached.stream;
            }
            else {
                try {
                    stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId, true));
                }
                catch (error) {
                    const name = error?.name;
                    if (name === 'OverconstrainedError' || name === 'NotFoundError') {
                        stream = await navigator.mediaDevices.getUserMedia(constraints('', false));
                    }
                    else {
                        throw error;
                    }
                }
            }
            const live = stream.getAudioTracks()[0];
            if (!live) {
                if (!cached && !isCable)
                    stream.getTracks().forEach((item) => item.stop());
                throw new Error('A entrada não tem pista de áudio');
            }
            // getSettings() is the only honest answer about how many channels the
            // device is really sending; the graph would happily duplicate a mono one.
            // A generated stream says nothing about itself, and the cables are stereo
            // by construction — the buses they drain are — so that is the answer.
            const settings = live.getSettings();
            resolvedId = settings.deviceId || deviceId;
            sourceChannels =
                (typeof settings.channelCount === 'number' && settings.channelCount > 0
                    ? settings.channelCount
                    : stream.getAudioTracks()[0].getSettings().channelCount) || (isCable ? 2 : 1);
            liveLabel = isMaster
                ? MASTER_CABLE_LABEL
                : isSala
                    ? SALA_CABLE_LABEL
                    : live.label || 'Entrada de áudio';
        }
        // The lane that gets here twice with the same device id reuses the stream
        // already open, so channel 1 and channel 2 come from one capture. The cables
        // are not counted: they belong to this context and outlive every lane.
        const sharedKey = isCable ? `cable:${deviceId}` : deviceId;
        let shared = isCable ? undefined : this.sharedStreams.get(sharedKey);
        if (!isCable) {
            if (!shared) {
                shared = { stream, users: 0 };
                this.sharedStreams.set(sharedKey, shared);
            }
            shared.users += 1;
        }
        const source = this.ctx.createMediaStreamSource(stream);
        // `out` carries exactly the channel(s) this lane picked, at unity gain.
        const out = this.ctx.createGain();
        // One door to the lane, and the lamp is who opens it: the input enters the
        // chain at a listening level, so what the producer hears is the sound with
        // the lane's effects on it. The take does not come through here — the
        // recorder reads `out`, above the door — so closing the lamp to work in
        // silence never costs a sample of the performance.
        const gain = this.ctx.createGain();
        // The gain node controls the monitor level: when monitor is ON, signal passes
        // to the track's processing chain (panner -> FX -> master -> speakers).
        // When monitor is OFF, gain is 0 so the user hears nothing, but a separate
        // Sala send (salaGain) still routes signal to the call room.
        gain.gain.value = monitor ? 0.6 : 0;
        let splitter = null;
        let laneChannels = sourceChannels;
        // A lane that asked for a channel the device does not send gets the whole
        // stream instead of silence: a mono mic patched as "entrada 3" is still the
        // mic, and the report below says which of the two happened.
        let effectiveChannel = channel;
        if (effectiveChannel >= 1 && sourceChannels >= 2) {
            splitter = this.ctx.createChannelSplitter(Math.min(MAX_INPUT_CHANNELS, Math.max(2, sourceChannels)));
            source.connect(splitter);
            // A splitter output is a single-channel feed, so this lane really is mono:
            // it hears, and records, only the input it was patched into.
            const index = Math.min(splitter.numberOfOutputs, effectiveChannel) - 1;
            splitter.connect(out, index);
            laneChannels = 1;
            effectiveChannel = index + 1;
        }
        else {
            source.connect(out);
            if (sourceChannels < 2) {
                effectiveChannel = 0;
                laneChannels = 1;
            }
        }
        out.connect(gain);
        gain.connect(track.panner);
        // Sala send: taps the live input BEFORE the monitor gain, so the signal reaches
        // the call room even when the user has monitoring turned OFF.
        // This sends the dry signal (pre-track-FX). For post-FX signal, the master
        // tap in ensureCallCable is used when monitor is ON.
        const salaGain = this.ctx.createGain();
        // Um cabo do próprio app nunca volta para a sala: o retorno da sala enviado
        // de novo seria o eco da rede, e a master já sai pelo cabo de envio — mandá-la
        // outra vez por aqui duplicaria o que a sala recebe.
        salaGain.gain.value = isCable ? 0 : 1;
        out.connect(salaGain);
        salaGain.connect(this.salaBus);
        // Send da segunda saída: mesma torneira que a Sala (post-cadeia ao vivo),
        // aberta só quando o monitor está fechado — ver secondBus.
        const secondGain = this.ctx.createGain();
        secondGain.gain.value = isCable ? 0 : monitor ? 0 : 0.6;
        out.connect(secondGain);
        secondGain.connect(this.secondBus);
        const status = {
            deviceId: resolvedId,
            label: liveLabel,
            channels: laneChannels,
            sourceChannels,
            channel: effectiveChannel,
            sampleRate: this.ctx.sampleRate,
        };
        this.inputs.set(trackId, {
            stream,
            streamKey: sharedKey,
            // The cables are this context's own nodes: a lane letting go does not stop
            // them, exactly as the call room's stream is not ours to stop.
            borrowed: isCable,
            source,
            out,
            gain,
            salaGain,
            secondGain,
            splitter,
            monitor,
            status,
        });
        return status;
    }
    /** The live input of a track, or null when nothing is connected. */
    inputStatus(trackId) {
        return this.inputs.get(trackId)?.status ?? null;
    }
    /**
     * Patches an external MediaStream — the call room — into a track.
     *
     * Same lane as a hardware input (`source -> out -> gain -> track.panner`, with
     * the recorder's tap on `out`), because that is what makes the monitor button, the
     * lane's meter and the recorder work without a second copy of any of them. The
     * `streamKey` deliberately is not a device id: `disconnectInput` only stops a
     * shared stream when the key exists in `sharedStreams`, and the call's stream
     * belongs to the SDK, not to this engine.
     */
    connectCallInput(trackId, stream, monitor = true, label = 'Chamada') {
        const track = this.tracks.get(trackId);
        if (!track)
            throw new Error('Track não encontrada');
        this.disconnectInput(trackId);
        const live = stream.getAudioTracks()[0];
        if (!live)
            throw new Error('O stream da chamada não tem pista de áudio');
        const source = this.ctx.createMediaStreamSource(stream);
        const out = this.ctx.createGain();
        const gain = this.ctx.createGain();
        // The gain node controls the monitor level: when monitor is ON, signal passes
        // to the track's processing chain (panner -> FX -> master -> speakers).
        // When monitor is OFF, gain is 0 so the user hears nothing, but a separate
        // Sala send (salaGain) still routes signal to the call room.
        gain.gain.value = monitor ? 0.6 : 0;
        source.connect(out);
        out.connect(gain);
        gain.connect(track.panner);
        // Sala send: taps the live input BEFORE the monitor gain, so the signal reaches
        // the call room even when the user has monitoring turned OFF.
        // For a call return lane, gain is 0 so the remote sound does not echo back into the room.
        const salaGain = this.ctx.createGain();
        salaGain.gain.value = 0;
        out.connect(salaGain);
        salaGain.connect(this.salaBus);
        // Segunda saída: a chamada também chega lá mesmo com o monitor fechado.
        const secondGain = this.ctx.createGain();
        secondGain.gain.value = monitor ? 0 : 0.6;
        out.connect(secondGain);
        secondGain.connect(this.secondBus);
        const channels = live.getSettings().channelCount || 1;
        const status = {
            deviceId: 'call',
            label,
            channels,
            sourceChannels: channels,
            channel: 0,
            sampleRate: live.getSettings().sampleRate || this.ctx.sampleRate,
        };
        this.inputs.set(trackId, {
            stream,
            streamKey: `call:${label}`,
            borrowed: true,
            source,
            out,
            gain,
            salaGain,
            secondGain,
            splitter: null,
            monitor,
            status,
        });
        return status;
    }
    setInputMonitor(trackId, enabled) {
        const entry = this.inputs.get(trackId);
        if (!entry)
            return;
        entry.monitor = enabled;
        // The gain node controls the monitor level: when ON, signal passes to the
        // track's processing chain (panner -> FX -> master -> speakers).
        // When OFF, gain is 0 so the user hears nothing. The Sala send (salaGain)
        // remains at unity gain so the signal still reaches the call room.
        entry.gain.gain.setTargetAtTime(enabled ? 0.6 : 0, this.ctx.currentTime, 0.02);
        // Porta invertida para a segunda saída: com monitor OFF a entrada segue
        // direto para lá; com monitor ON ela já viaja no master, e este send fecha
        // para o sinal não sair duplicado na segunda saída.
        entry.secondGain.gain.setTargetAtTime(enabled ? 0 : 0.6, this.ctx.currentTime, 0.02);
    }
    /**
     * Whether the live input of a lane is reaching the mix — that is, whether the
     * producer lit the monitor.
     */
    isInputLive(trackId) {
        return this.inputs.get(trackId)?.monitor ?? false;
    }
    /**
     * One node in the live path: the common case of the chain below, kept because
     * every caller that has a single insert reads better with one argument.
     */
    setLiveInsert(trackId, node) {
        return this.setLiveInsertChain(trackId, node ? [node] : []);
    }
    /**
     * Puts a row of nodes between a lane's input and the monitor feed it already
     * has, or takes the whole row out again.
     *
     * `out -> 1 -> 2 -> … -> gain` keeps the promises the single insert made, only
     * longer: the monitor hears every plugin in the chain, while the recorder's tap
     * — which reads `out` further up — still gets the device exactly as it came.
     * Only the lane's own destination is unplugged, never the whole `out`, because
     * the recorder may be reading it.
     */
    setLiveInsertChain(trackId, nodes) {
        const entry = this.inputs.get(trackId);
        if (!entry)
            return false;
        const chain = (nodes ?? []).filter(Boolean);
        const previous = entry.liveInsertChain ?? [];
        if (previous.length === chain.length && previous.every((node, index) => node === chain[index]))
            return true;
        for (const node of previous) {
            try {
                node.disconnect();
            }
            catch { }
        }
        // Whatever `out` was feeding goes away with the old row: the monitor gain when
        // the lane was bare, the first plugin when it was not. Leaving the direct
        // connection in place while a chain is bolted on would run the input twice.
        try {
            entry.out.disconnect(entry.gain);
        }
        catch { }
        try {
            entry.out.disconnect(entry.salaGain);
        }
        catch { }
        try {
            entry.out.disconnect(entry.secondGain);
        }
        catch { }
        if (previous[0]) {
            try {
                entry.out.disconnect(previous[0]);
            }
            catch { }
        }
        // Ensure salaGain is connected to salaBus (disconnecting sources must not unhook it from the bus)
        try {
            entry.salaGain.connect(this.salaBus);
        }
        catch { }
        try {
            entry.secondGain.connect(this.secondBus);
        }
        catch { }
        entry.liveInsertChain = chain;
        entry.liveInsert = chain[0] ?? null;
        if (chain.length === 0) {
            entry.out.connect(entry.gain);
            // Sala send taps `out` (pre-chain) when no plugins
            entry.out.connect(entry.salaGain);
            entry.out.connect(entry.secondGain);
            return true;
        }
        // Every hop is made here, from nodes that may have arrived with connections
        // of their own from a previous order of the same chain: a node that kept
        // them would fork the signal around the plugins instead of through them.
        for (const node of chain) {
            try {
                node.disconnect();
            }
            catch { }
        }
        entry.out.connect(chain[0]);
        for (let index = 0; index < chain.length - 1; index += 1)
            chain[index].connect(chain[index + 1]);
        const lastNode = chain[chain.length - 1];
        lastNode.connect(entry.gain);
        // Sala send taps the LAST node of the chain (post-VST, pre-monitor-gain)
        // so the processed signal reaches Sala even when monitor is OFF.
        lastNode.connect(entry.salaGain);
        // A segunda saída recebe a mesma torneira: a entrada processada pela
        // cadeia ao vivo, mesmo com o monitor fechado.
        lastNode.connect(entry.secondGain);
        return true;
    }
    /** The node a lane's input currently enters first, if any. */
    liveInsert(trackId) {
        return this.inputs.get(trackId)?.liveInsert ?? null;
    }
    /** Every node of that path, in signal order — an empty list when the lane is dry. */
    liveInsertChain(trackId) {
        return this.inputs.get(trackId)?.liveInsertChain ?? [];
    }
    disconnectInput(trackId) {
        const entry = this.inputs.get(trackId);
        if (!entry)
            return;
        entry.splitter?.disconnect();
        entry.source.disconnect();
        for (const node of entry.liveInsertChain ?? [])
            node.disconnect();
        entry.liveInsert?.disconnect();
        entry.liveInsert = null;
        entry.liveInsertChain = [];
        entry.out.disconnect();
        entry.gain.disconnect();
        entry.salaGain?.disconnect();
        entry.secondGain?.disconnect();
        // The stream belongs to the device, not to the lane: only stop it when the
        // last lane patching into it lets go. A borrowed stream — the call room's — is
        // never ours to stop at all.
        const shared = this.sharedStreams.get(entry.streamKey);
        if (entry.borrowed) {
            // leave the SDK's stream running; it owns its tracks
        }
        else if (shared) {
            shared.users -= 1;
            if (shared.users <= 0) {
                shared.stream.getTracks().forEach((track) => track.stop());
                this.sharedStreams.delete(entry.streamKey);
            }
        }
        else {
            entry.stream.getTracks().forEach((track) => track.stop());
        }
        this.inputs.delete(trackId);
    }
    hasInput(trackId) {
        return this.inputs.has(trackId);
    }
    // ------------------------------------------------------------- recording
    /** Frames per sample-tap callback; also the resolution of the live peaks. */
    static TAKE_CHUNK = 2048;
    /**
     * Tap each armed lane and start its take.
     *
     * The tap is the lane's patch cable: what lands on disk is the input exactly as
     * the device gave it, patched to the channel this lane owns. The lane's
     * effects stay behind the take — they run live while the producer plays and
     * again every time the clip is read back — so a performance is never married
     * to a sound, and a different amp tomorrow still fits the recording. That is
     * also why the file is stereo-safe: the recorder reads the patch, not the mix.
     *
     * Reading the samples ourselves, rather than through MediaRecorder, is what lets
     * a stereo interface really give a two-channel take and lets the lane redraw
     * while the take grows instead of only after the transport stops.
     */
    async startRecording(trackIds) {
        await this.resume();
        const started = [];
        this.takePeaks.clear();
        for (const trackId of trackIds) {
            const entry = this.inputs.get(trackId);
            if (!entry)
                continue;
            if (this.recorders.has(trackId))
                continue;
            // Tap what the lane actually carries, not the raw device: a lane patched to
            // input 1 must record input 1 alone.
            const tap = entry.out;
            const channels = Math.max(1, Math.min(2, entry.status.channels || 1));
            const node = this.ctx.createScriptProcessor(AudioEngine.TAKE_CHUNK, channels, 1);
            const sink = this.ctx.createGain();
            // Silent, but the tap only runs if its output reaches the destination —
            // a dangling ScriptProcessor never fires its callback in Chrome.
            sink.gain.value = 0;
            const analyser = this.ctx.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.55;
            const recorder = {
                node,
                sink,
                tap,
                channels,
                chunks: [],
                written: 0,
                analyser,
            };
            node.onaudioprocess = (event) => {
                const input = event.inputBuffer;
                const taken = [];
                let peak = 0;
                for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
                    const data = input.getChannelData(channel);
                    taken.push(data.slice(0));
                    // Every fourth sample is enough for a peak readout and keeps the
                    // work off the audio thread's critical path.
                    for (let i = 0; i < data.length; i += 4) {
                        const value = Math.abs(data[i]);
                        if (value > peak)
                            peak = value;
                    }
                }
                recorder.chunks.push(taken);
                recorder.written += input.length;
                this.recordPeak(trackId, peak);
            };
            tap.connect(node);
            tap.connect(analyser);
            node.connect(sink);
            sink.connect(this.ctx.destination);
            this.recorders.set(trackId, recorder);
            started.push(trackId);
        }
        return started;
    }
    /**
     * Live spectrum of a running take, in 0..255 per frequency bin, or null when
     * that lane is not recording. The caller owns the returned array.
     */
    takeSpectrum(trackId) {
        const recorder = this.recorders.get(trackId);
        if (!recorder)
            return null;
        const data = new Uint8Array(recorder.analyser.frequencyBinCount);
        recorder.analyser.getByteFrequencyData(data);
        return data;
    }
    /** Bin resolution, so the caller can label the frequency axis honestly. */
    get takeSpectrumBinHz() {
        return this.ctx.sampleRate / 512;
    }
    recordPeak(trackId, peak) {
        let entry = this.takePeaks.get(trackId);
        if (!entry) {
            entry = { peaks: new Float32Array(4096), written: 0, reported: 0 };
            this.takePeaks.set(trackId, entry);
        }
        if (entry.written >= entry.peaks.length) {
            const grown = new Float32Array(entry.peaks.length * 2);
            grown.set(entry.peaks);
            entry.peaks = grown;
        }
        entry.peaks[entry.written] = peak;
        entry.written += 1;
        const now = performance.now();
        if (!this.onTakeProgress || now - entry.reported < 120)
            return;
        entry.reported = now;
        this.onTakeProgress(trackId, Array.from(entry.peaks.subarray(0, entry.written)), (entry.written * AudioEngine.TAKE_CHUNK) / this.ctx.sampleRate);
    }
    /** Assemble each running tap into an AudioBuffer, channel for channel. */
    async stopRecording() {
        const entries = [...this.recorders.entries()];
        this.recorders.clear();
        this.takePeaks.clear();
        const result = new Map();
        for (const [trackId, recorder] of entries) {
            recorder.node.onaudioprocess = null;
            // The tap belongs to the graph (the lane's input, or the end of its
            // effects), so only the connection into the recorder is taken down.
            try {
                recorder.tap.disconnect(recorder.node);
            }
            catch {
                /* already detached */
            }
            try {
                recorder.tap.disconnect(recorder.analyser);
            }
            catch {
                /* already detached */
            }
            try {
                recorder.node.disconnect();
            }
            catch {
                /* already detached */
            }
            try {
                recorder.sink.disconnect();
            }
            catch {
                /* already detached */
            }
            try {
                recorder.analyser.disconnect();
            }
            catch {
                /* already detached */
            }
            const length = recorder.written;
            if (length === 0)
                continue;
            const width = Math.max(1, recorder.chunks[0]?.length ?? 1);
            // A stereo request can still come back with a silent second channel;
            // keeping it would fake a stereo clip out of a mono mic.
            let channels = width;
            if (width > 1) {
                const hasSecond = recorder.chunks.some((chunk) => {
                    const data = chunk[1];
                    if (!data)
                        return false;
                    for (let i = 0; i < data.length; i += 1) {
                        if (data[i] !== 0)
                            return true;
                    }
                    return false;
                });
                if (!hasSecond)
                    channels = 1;
            }
            const buffer = this.ctx.createBuffer(channels, length, this.ctx.sampleRate);
            let offset = 0;
            for (const chunk of recorder.chunks) {
                const frames = chunk[0]?.length ?? 0;
                if (frames === 0)
                    continue;
                for (let channel = 0; channel < channels; channel += 1) {
                    const data = chunk[channel];
                    if (data)
                        buffer.getChannelData(channel).set(data, offset);
                }
                offset += frames;
            }
            result.set(trackId, buffer);
        }
        return result;
    }
    stopTrackRecorder(trackId) {
        const recorder = this.recorders.get(trackId);
        if (!recorder)
            return;
        recorder.node.onaudioprocess = null;
        try {
            recorder.tap.disconnect(recorder.node);
        }
        catch {
            /* already detached */
        }
        try {
            recorder.tap.disconnect(recorder.analyser);
        }
        catch {
            /* already detached */
        }
        try {
            recorder.node.disconnect();
        }
        catch {
            /* already detached */
        }
        try {
            recorder.sink.disconnect();
        }
        catch {
            /* already detached */
        }
        this.recorders.delete(trackId);
        this.takePeaks.delete(trackId);
    }
    isRecordingTrack(trackId) {
        return this.recorders.has(trackId);
    }
    // ---------------------------------------------------------------- sounds
    playClick(accent = false, when = this.ctx.currentTime) {
        scheduleClick(this.ctx, this.masterGain, when, accent);
    }
    // ----------------------------------------------------------------- clips
    setBuffer(id, buffer, label = '') {
        const track = this.tracks.get(id);
        if (!track)
            return;
        track.buffer = buffer;
        track.bufferLabel = buffer ? label : '';
        track.clipDuration = buffer ? buffer.duration : 0;
        // A preview rendered from the old clip must not play over the new one.
        track.monitor = null;
    }
    /**
     * Put a rendered pass in front of the speakers and the export without
     * touching the recorded clip. Passing null gives the dry take back.
     */
    setMonitorBuffer(id, buffer, key = '') {
        const track = this.tracks.get(id);
        if (!track)
            return;
        track.monitor = buffer ? { buffer, key } : null;
    }
    /** The key of the preview this lane is playing, or '' when it plays the take. */
    monitorKey(id) {
        return this.tracks.get(id)?.monitor?.key ?? '';
    }
    /** Which stored sample is currently loaded in this track, if any. */
    getBufferLabel(id) {
        const track = this.tracks.get(id);
        return track && track.buffer ? track.bufferLabel : '';
    }
    /**
     * Edge fades for the clip, in seconds. Tiny default ramps (5 ms) are always
     * present so a trimmed edge never clicks; the user can extend them.
     */
    setClipFade(id, fadeIn, fadeOut) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        track.fadeIn = Math.max(0, Math.min(10, fadeIn));
        track.fadeOut = Math.max(0, Math.min(10, fadeOut));
    }
    getClipFade(id) {
        const track = this.tracks.get(id);
        return { fadeIn: track?.fadeIn ?? 0, fadeOut: track?.fadeOut ?? 0 };
    }
    // -------------------------------------------------------------- automation
    /**
     * Volume automation for one track: breakpoints at 16th-note steps, levels in
     * dB relative to the fader. It runs on its own gain node, so drawing a lane
     * never moves the fader the user set and riding the fader never erases a lane.
     */
    setAutomation(id, points) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        track.automation = sortedAutomation(points);
        // Live edit while rolling: re-cut the envelope from where the song is now.
        if (this.songOriginTime !== null)
            this.scheduleAutomation(track);
    }
    getAutomation(id) {
        return [...(this.tracks.get(id)?.automation ?? [])];
    }
    /**
     * Schedules one track's envelope onto its automation node. Ramps are
     * exponential between successive gains, which is what makes the param move in a
     * straight line in dB - the same line the lane draws and the same shape the
     * offline render builds.
     */
    scheduleAutomation(track, fromStep = 0) {
        const origin = this.songOriginTime;
        if (origin === null)
            return;
        const stepDuration = this.songStepDuration;
        const now = this.ctx.currentTime;
        // A playback that starts mid-envelope has to resume it, not restart it.
        const startStep = Math.max(0, fromStep, (now - origin) / stepDuration);
        scheduleAutomationEnvelope(track.autoGain.gain, track.automation, origin, stepDuration, startStep, now);
    }
    /**
     * Clears every automation envelope. Called on stop so a parked playhead never
     * leaves a track sitting at the last drawn gain.
     */
    resetAutomation() {
        this.songOriginTime = null;
        const now = this.ctx.currentTime;
        this.tracks.forEach((track) => {
            track.autoGain.gain.cancelScheduledValues(now);
            track.autoGain.gain.setValueAtTime(1, now);
        });
        this.groups.forEach((group) => {
            group.autoGain.gain.cancelScheduledValues(now);
            group.autoGain.gain.setValueAtTime(1, now);
        });
    }
    /**
     * Round-trip estimate in milliseconds (render quantum + output latency).
     * What you hear through the monitors arrives this late, so a take sung "in
     * time" lands behind the grid by roughly the same amount.
     */
    latencyMs() {
        const ctx = this.ctx;
        const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency ?? 0 : 0;
        const out = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency ?? 0 : 0;
        return Math.max(0, Math.round((base + out) * 1000));
    }
    // ------------------------------------------------------------ output device
    /**
     * Which playback device the mix leaves through. Empty means the system
     * default, which is the only path a browser gives without asking.
     */
    get outputDeviceId() {
        return this.outputDevice;
    }
    /**
     * The second card the same mix is copied to, or '' when only the main output
     * is playing. Kept separate from `outputDeviceId` because it is an extra tap
     * on the master, not a replacement for the main route.
     */
    get secondOutputDeviceId() {
        return this.outputDevice2;
    }
    /**
     * Send the whole mix — every lane, the sends, the metronome and the live
     * input — out of one chosen speaker instead of the default one.
     *
     * A Web Audio graph cannot name a device, but it can hand its output to a
     * media stream, and a media element can be told which playback device to use.
     * So the sum goes to a hidden stream and that stream plays on the chosen
     * card. It is a real gain: an interface with its own outputs for headphones
     * and monitors can be picked here. It costs a little latency, which is why
     * the number next to it is shown, and it is not ASIO: a browser and Electron
     * reach the card through the system mixer (WASAPI shared on Windows), so the
     * exclusive-driver path of a pro interface is not available to this program.
     */
    async setOutputDevice(deviceId) {
        const wanted = deviceId.trim();
        if (!wanted) {
            this.releaseOutputStream();
            this.outputDevice = '';
            // Back on the card the context picked for itself.
            this.speakerGain.disconnect();
            if (this.outputSink2) {
                this.speakerGain.connect(this.outputSink2);
            }
            else {
                this.speakerGain.connect(this.ctx.destination);
            }
            return { deviceId: '', label: 'Dispositivo padrão do sistema', routed: false, error: '' };
        }
        const label = await outputLabelFor(wanted);
        if (!this.outputSink) {
            try {
                this.outputSink = this.ctx.createMediaStreamDestination();
            }
            catch (error) {
                return { deviceId: '', label, routed: false, error: error.message };
            }
            this.speakerGain.connect(this.outputSink);
        }
        if (!this.outputElement) {
            const element = document.createElement('audio');
            element.srcObject = this.outputSink.stream;
            element.autoplay = true;
            element.style.position = 'absolute';
            element.style.width = '1px';
            element.style.height = '1px';
            element.style.opacity = '0';
            element.setAttribute('aria-hidden', 'true');
            document.body.appendChild(element);
            this.outputElement = element;
        }
        const element = this.outputElement;
        try {
            if (typeof element.setSinkId === 'function')
                await element.setSinkId(wanted);
            else
                throw new Error('esta máquina não expõe dispositivos de saída');
            await element.play();
        }
        catch (error) {
            const message = error.message || 'a saída escolhida não aceitou o áudio';
            this.releaseOutputStream();
            this.outputDevice = '';
            this.speakerGain.disconnect();
            if (this.outputSink2) {
                this.speakerGain.connect(this.outputSink2);
            }
            else {
                this.speakerGain.connect(this.ctx.destination);
            }
            return { deviceId: '', label, routed: false, error: message };
        }
        // Only take the default road away once the chosen one is carrying sound.
        this.speakerGain.disconnect(this.ctx.destination);
        // Keep secondary output connected if it exists
        if (this.outputSink2) {
            this.speakerGain.connect(this.outputSink2);
        }
        this.outputDevice = wanted;
        return { deviceId: wanted, label, routed: true, error: '' };
    }
    /**
     * Define a segunda saída (ex.: cabo virtual VB-Cable/Voicemeeter).
     * O master toca em AMBAS as saídas simultaneamente.
     */
    async setSecondOutputDevice(deviceId) {
        const wanted = deviceId.trim();
        if (!wanted) {
            this.releaseSecondOutputStream();
            this.outputDevice2 = '';
            return { deviceId: '', label: 'Desativado', routed: false, error: '' };
        }
        const label = await outputLabelFor(wanted);
        // Two media elements on one card would play the mix twice, so the duplicate
        // route has to point somewhere the main output is not already going.
        if (wanted === this.outputDevice) {
            return {
                deviceId: '',
                label,
                routed: false,
                error: 'a segunda saída precisa ser diferente da principal',
            };
        }
        if (!this.outputSink2) {
            try {
                this.outputSink2 = this.ctx.createMediaStreamDestination();
            }
            catch (error) {
                return { deviceId: '', label, routed: false, error: error.message };
            }
            this.speakerGain.connect(this.outputSink2);
            // A entrada ao vivo com monitor OFF também chega à segunda saída por
            // este bus — o monitor só decide o que sai na principal.
            this.secondBus.connect(this.outputSink2);
        }
        if (!this.outputElement2) {
            const element = document.createElement('audio');
            element.srcObject = this.outputSink2.stream;
            element.autoplay = true;
            element.style.position = 'absolute';
            element.style.width = '1px';
            element.style.height = '1px';
            element.style.opacity = '0';
            element.setAttribute('aria-hidden', 'true');
            document.body.appendChild(element);
            this.outputElement2 = element;
        }
        const element = this.outputElement2;
        try {
            if (typeof element.setSinkId === 'function')
                await element.setSinkId(wanted);
            else
                throw new Error('esta máquina não expõe dispositivos de saída');
            await element.play();
        }
        catch (error) {
            const message = error.message || 'a saída secundária não aceitou o áudio';
            this.releaseSecondOutputStream();
            this.outputDevice2 = '';
            return { deviceId: '', label, routed: false, error: message };
        }
        this.outputDevice2 = wanted;
        return { deviceId: wanted, label, routed: true, error: '' };
    }
    /** Libera o stream da segunda saída. */
    releaseSecondOutputStream() {
        if (this.outputElement2) {
            try {
                this.outputElement2.pause();
            }
            catch {
                /* never started */
            }
            this.outputElement2.srcObject = null;
            this.outputElement2.remove();
            this.outputElement2 = null;
        }
        if (this.outputSink2) {
            try {
                this.speakerGain.disconnect(this.outputSink2);
            }
            catch {
                /* already detached */
            }
            try {
                this.secondBus.disconnect(this.outputSink2);
            }
            catch {
                /* already detached */
            }
            this.outputSink2.stream.getTracks().forEach((track) => track.stop());
            this.outputSink2 = null;
        }
    }
    /** Whether the mix is leaving to nowhere on purpose (Dummy Audio). */
    get dummyAudioMode() {
        return this.dummyAudio;
    }
    /**
     * Dummy Audio: the transport, the meters and every plugin keep working, but
     * the door to the sound card stays shut. It is the mode to edit on a laptop
     * with no interface attached, or to prove a session runs without making noise.
     */
    setDummyAudio(enabled) {
        this.dummyAudio = enabled;
        this.outputGain.gain.value = enabled ? 0 : 1;
    }
    /**
     * Anexa o tap que alimenta o sink ASIO nativo. Insere um worklet transparente
     * entre a saída do mix e o ganho do alto-falante: outputGain -> tap ->
     * speakerGain. O tap copia o master para uma MessagePort cuja outra ponta a
     * página entrega ao processo que escreve no driver ASIO. Devolve essa ponta e
     * a taxa do contexto, para o host abrir o stream na mesma taxa (sem resample).
     *
     * Só o executável chama isto; no navegador não há processo nativo para receber
     * a porta, então o método nem é invocado.
     */
    async attachNativeSink(batchFrames = 256) {
        if (this.masterTap) {
            // Já anexado: só ajusta o lote e devolve uma porta nova para o host.
            this.masterTap.port.postMessage({ batchFrames });
        }
        else {
            await this.ensureWorkletModule(this.ctx, MASTER_TAP_NAME, MASTER_TAP_SOURCE);
            const tap = new AudioWorkletNode(this.ctx, MASTER_TAP_NAME, {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
            });
            this.outputGain.disconnect(this.speakerGain);
            this.outputGain.connect(tap);
            tap.connect(this.speakerGain);
            this.masterTap = tap;
        }
        const channel = new MessageChannel();
        this.masterTap.port.postMessage({ attachPort: channel.port1, batchFrames }, [channel.port1]);
        return { sampleRate: this.ctx.sampleRate, port: channel.port2, batchFrames };
    }
    /**
     * Anexa a porta de entrada ASIO nativa. Cria um worklet que recebe o PCM da
     * interface ASIO e o disponibiliza como uma MediaStream para as tracks usarem
     * como entrada. Isso substitui o getUserMedia/WASAPI para latência real.
     *
     * Só o executável chama isto; no navegador não há processo nativo para receber
     * a porta, então o método nem é invocado.
     */
    async attachNativeInput(batchFrames = 256, inputChannels = 2) {
        await this.ensureWorkletModule(this.ctx, ASIO_INPUT_NAME, ASIO_INPUT_SOURCE);
        // Create a MediaStreamDestination to receive the ASIO input
        const dest = this.ctx.createMediaStreamDestination();
        dest.channelCount = inputChannels;
        const inputNode = new AudioWorkletNode(this.ctx, ASIO_INPUT_NAME, {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [inputChannels],
        });
        inputNode.connect(dest);
        this.asioInputNode = inputNode;
        this.asioInputStream = dest.stream;
        this.asioInputChannels = inputChannels;
        const channel = new MessageChannel();
        inputNode.port.postMessage({ attachPort: channel.port1, batchFrames, channels: inputChannels }, [channel.port1]);
        return {
            sampleRate: this.ctx.sampleRate,
            port: channel.port2,
            batchFrames,
            stream: dest.stream
        };
    }
    /**
     * Handle incoming ASIO input PCM data from the native worker.
     * This is called from the renderer when the input port receives data.
     */
    handleAsioInputPcm(samples) {
        if (this.asioInputNode && this.asioInputNode.port) {
            this.asioInputNode.port.postMessage({ kind: 'pcm', samples });
        }
    }
    /**
     * Liga/desliga o caminho WASAPI enquanto o ASIO carrega o som. Com o sink
     * ativo, speakerGain zera (o alto-falante do sistema fica mudo) mas o tap, que
     * vem antes dele, continua mandando o mix inteiro para a interface. O grafo
     * segue renderizando porque speakerGain continua ligado ao destination.
     */
    setNativeSinkActive(active) {
        this.nativeSinkActive = active;
        this.speakerGain.gain.value = active ? 0 : 1;
    }
    get nativeSinkMode() {
        return this.nativeSinkActive;
    }
    /** Remove o tap e devolve o caminho direto outputGain -> speakerGain. */
    detachNativeSink() {
        this._detachNativeSinkInternal();
    }
    /** Internal detach - can be called externally (e.g., worker crash). */
    _detachNativeSinkInternal() {
        this.setNativeSinkActive(false);
        const tap = this.masterTap;
        if (!tap)
            return;
        try {
            this.outputGain.disconnect(tap);
        }
        catch {
            /* já desconectado */
        }
        try {
            tap.disconnect();
            tap.port.postMessage({ attachPort: null });
        }
        catch {
            /* já foi */
        }
        this.outputGain.connect(this.speakerGain);
        this.masterTap = null;
    }
    /** Called by external code (e.g., worker crash handler) to notify of external detach. */
    notifyNativeSinkDetached() {
        this._detachNativeSinkInternal();
        this.onNativeSinkDetached?.();
    }
    /** Remove the ASIO input worklet and clean up the stream. */
    detachNativeInput() {
        const inputNode = this.asioInputNode;
        if (!inputNode)
            return;
        try {
            inputNode.disconnect();
            inputNode.port.postMessage({ attachPort: null });
        }
        catch {
            /* já foi */
        }
        this.asioInputNode = null;
        this.asioInputStream = null;
        this.asioInputChannels = 0;
    }
    /** Store the ASIO input MediaStream for use by tracks. */
    setAsioInputStream(stream) {
        this.asioInputStream = stream;
    }
    /** Get the ASIO input MediaStream for use by tracks. */
    getAsioInputStream() {
        return this.asioInputStream;
    }
    /** Everything the mix's exit looks like, for the device window. */
    describeOutput() {
        return {
            deviceId: this.outputDevice,
            routed: Boolean(this.outputElement?.sinkId && this.outputSink),
            latencyMs: this.latencyMs(),
            inputLatencyMs: this.inputLatencyMs(),
        };
    }
    /**
     * What the browser admits about the entry side. Chrome reports it on the
     * AudioContext when the input is a real device; a value of 0 means the
     * browser gave nothing, which is reported as 0 rather than guessed at.
     */
    inputLatencyMs() {
        const ctx = this.ctx;
        const inLatency = Number.isFinite(ctx.inputLatency) ? ctx.inputLatency ?? 0 : 0;
        return Math.max(0, Math.round(inLatency * 1000));
    }
    releaseOutputStream() {
        const element = this.outputElement;
        if (element) {
            try {
                element.pause();
            }
            catch {
                /* never started */
            }
            element.srcObject = null;
            element.remove();
            this.outputElement = null;
        }
        if (this.outputSink) {
            try {
                this.speakerGain.disconnect(this.outputSink);
            }
            catch {
                /* already detached */
            }
            this.outputSink.stream.getTracks().forEach((track) => track.stop());
            this.outputSink = null;
        }
    }
    setClipStart(id, step) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        track.clipStart = Math.max(0, step);
    }
    /**
     * Trims the tail of a recorded clip without touching the stored sample, so
     * the edit stays reversible. `seconds` is clamped to the buffer length.
     */
    setClipDuration(id, seconds) {
        const track = this.tracks.get(id);
        if (!track)
            return;
        if (!track.buffer) {
            track.clipDuration = 0;
            return;
        }
        const max = track.buffer.duration;
        track.clipDuration = Math.min(max, Math.max(0.02, seconds || max));
    }
    getClipDuration(id) {
        return this.tracks.get(id)?.clipDuration ?? 0;
    }
    /** Full length of the stored sample, used to clamp timeline trims. */
    getBufferDuration(id) {
        return this.tracks.get(id)?.buffer?.duration ?? 0;
    }
    /**
     * Copies `from`..`to` seconds of a track's take into a fresh buffer. Used by
     * the razor: a lane holds one clip, so the second half becomes its own file
     * that another lane can carry.
     */
    sliceBuffer(id, from, to) {
        const src = this.tracks.get(id)?.buffer;
        if (!src)
            return null;
        const a = Math.max(0, Math.min(src.length, Math.round(from * src.sampleRate)));
        const b = Math.max(a, Math.min(src.length, Math.round(to * src.sampleRate)));
        if (b - a <= 0)
            return null;
        const out = this.ctx.createBuffer(src.numberOfChannels, b - a, src.sampleRate);
        for (let channel = 0; channel < src.numberOfChannels; channel += 1) {
            out.copyToChannel(src.getChannelData(channel).slice(a, b), channel);
        }
        return out;
    }
    clipEnd(track) {
        return clipEndOf(track.clipDuration, track.buffer?.duration ?? 0);
    }
    hasBuffer(id) {
        return Boolean(this.tracks.get(id)?.buffer);
    }
    /**
     * Schedules every recorded clip relative to the song position.
     * `stepDuration` is the length of a 16th note in seconds.
     */
    startBuffersAt(when, stepDuration, fromStep) {
        // Automation is written in steps and scheduled in seconds; this is the
        // translation for the pass that is about to start.
        this.songStepDuration = stepDuration > 0 ? stepDuration : 0.125;
        this.songOriginTime = when - fromStep * this.songStepDuration;
        this.tracks.forEach((track) => this.scheduleAutomation(track, fromStep));
        this.groups.forEach((group) => this.scheduleGroupAutomation(group, fromStep));
        this.tracks.forEach((track) => {
            // A lane with a rendered native pass plays that pass; the take underneath
            // stays where the producer left it.
            const take = takeToPlay(track);
            if (!take)
                return;
            const source = this.ctx.createBufferSource();
            source.buffer = take;
            const shape = this.ctx.createGain();
            // The clip goes in as itself: a take is printed from the lane's input, so
            // what is already on the lane keeps playing during an over-dub instead of
            // being muted to protect a printer that no longer reads the chain.
            source.connect(shape);
            shape.connect(track.panner);
            const end = this.clipEnd(track);
            const delta = track.clipStart - fromStep;
            if (delta >= 0) {
                const t0 = when + delta * stepDuration;
                source.start(t0, 0, Math.max(0.02, end));
                scheduleClipFade(shape, t0, 0, end, track.fadeIn, track.fadeOut);
            }
            else {
                const offset = -delta * stepDuration;
                if (offset >= end)
                    return;
                source.start(when, offset, Math.max(0.02, end - offset));
                scheduleClipFade(shape, when, offset, end, track.fadeIn, track.fadeOut);
            }
            // Prune finished sources so a long looping session never accumulates them.
            source.onended = () => {
                const idx = this.sources.indexOf(source);
                if (idx >= 0)
                    this.sources.splice(idx, 1);
            };
            this.sources.push(source);
        });
    }
    playBuffers(when = this.ctx.currentTime) {
        this.stopBuffers();
        this.startBuffersAt(when, 0.125, 0);
    }
    /**
     * Stops every scheduled source. `keepAutomation` is for the loop wrap, where
     * a stop is only the other half of a restart: resetting the lanes there would
     * drop every track back to the fader for the few milliseconds between the two
     * calls, and that seam is audible.
     */
    stopBuffers(keepAutomation = false) {
        this.sources.forEach((source) => {
            try {
                source.stop();
            }
            catch {
                /* already stopped */
            }
        });
        this.sources.length = 0;
        this.stopNotes();
        // A stopped song must not leave a track parked at whatever the last drawn
        // breakpoint said; the fader is what you hear again.
        if (!keepAutomation)
            this.resetAutomation();
    }
    // ------------------------------------------------------------ instruments
    setInstrument(trackId, kind, voice = '') {
        const track = this.tracks.get(trackId);
        if (!track)
            return;
        track.instrument = kind;
        track.voice = voice;
    }
    setNotes(trackId, notes, patternSteps = 0) {
        const track = this.tracks.get(trackId);
        if (!track)
            return;
        track.notes = notes;
        track.patternSteps = isPatterned(patternSteps) ? Math.round(patternSteps) : 0;
    }
    /** Plays one synth voice through the track's full signal chain. */
    playNote(trackId, kind, pitch, velocity, when, duration) {
        const track = this.tracks.get(trackId);
        if (!track)
            return;
        // Live playing (MIDI pad or the computer keyboard) is often the first thing
        // a visitor does, before the transport ever ran. A suspended context keeps a
        // frozen currentTime, so wake it up and schedule against the clock it has
        // afterwards instead of a timestamp that is already in the past.
        if (this.ctx.state === 'suspended') {
            void this.ctx.resume().then(() => this.voice(track, kind, pitch, velocity, when, duration)).catch(() => { });
            return;
        }
        this.voice(track, kind, pitch, velocity, when, duration);
    }
    voice(track, kind, pitch, velocity, when, duration) {
        const gate = this.ctx.createGain();
        gate.gain.value = 1;
        gate.connect(track.panner);
        scheduleVoice(this.ctx, gate, kind, pitch, velocity, Math.max(when, this.ctx.currentTime), duration, track.voice);
        const entry = {
            gate,
            timer: window.setTimeout(() => {
                const idx = this.voiceGates.indexOf(entry);
                if (idx >= 0)
                    this.voiceGates.splice(idx, 1);
                gate.disconnect();
            }, (duration + 2.5) * 1000),
        };
        this.voiceGates.push(entry);
    }
    /** Silences every in-flight instrument voice (seek / stop / loop restart). */
    stopNotes() {
        for (const { gate, timer } of this.voiceGates) {
            window.clearTimeout(timer);
            try {
                gate.disconnect();
            }
            catch {
                /* already detached */
            }
        }
        this.voiceGates.length = 0;
    }
    // ------------------------------------------------------------- rendering
    /**
     * Rebuilds the track chain inside an OfflineAudioContext so the exported file
     * sounds like what you hear (plugins included).
     */
    async buildOfflinePlugin(ctx, plugin, warnings) {
        const paramValue = (name, fallback) => {
            const param = plugin.params.find((item) => item.name === name);
            return param ? param.value : fallback;
        };
        if (plugin.kind === 'ir' && plugin.source.irBuffer) {
            const input = ctx.createGain();
            const output = ctx.createGain();
            const dry = ctx.createGain();
            const wet = ctx.createGain();
            const sum = ctx.createGain();
            const level = ctx.createGain();
            const panner = ctx.createStereoPanner();
            const lowCut = ctx.createBiquadFilter();
            const highCut = ctx.createBiquadFilter();
            const convolver = ctx.createConvolver();
            const mix = paramValue('Mix', 1);
            lowCut.type = 'highpass';
            lowCut.frequency.value = paramValue('Low Cut', 20);
            highCut.type = 'lowpass';
            highCut.frequency.value = paramValue('High Cut', 20000);
            convolver.normalize = true;
            convolver.buffer = plugin.source.irBuffer;
            dry.gain.value = 1 - mix;
            wet.gain.value = mix;
            level.gain.value = paramValue('Output', 1.2);
            panner.pan.value = paramValue('Pan', 0);
            input.connect(dry);
            dry.connect(sum);
            input.connect(lowCut);
            lowCut.connect(highCut);
            highCut.connect(convolver);
            convolver.connect(wet);
            wet.connect(sum);
            sum.connect(level);
            level.connect(panner);
            panner.connect(output);
            return { input, output: panner };
        }
        if (plugin.kind === 'worklet' && plugin.source.workletSource && plugin.source.processorName) {
            const name = plugin.source.processorName;
            try {
                await this.ensureWorkletModule(ctx, name, plugin.source.workletSource);
                const node = new AudioWorkletNode(ctx, name);
                const panner = ctx.createStereoPanner();
                panner.pan.value = paramValue('Pan', 0);
                node.connect(panner);
                for (const param of plugin.params) {
                    node.parameters.get(param.name)?.setValueAtTime(param.value, 0);
                }
                return { input: node, output: panner };
            }
            catch (error) {
                warnings.push(`Plugin "${plugin.name}" ignorado no export: ${error.message}`);
                return null;
            }
        }
        if (plugin.kind === 'nam' && plugin.source.namJson) {
            try {
                const namEngine = await withTimeout(NamEngine.attach(ctx, { assetBaseUrl: NAM_ASSET_BASE }), 5000, 'motor NAM não respondeu no contexto offline');
                const nodes = [];
                for (let channel = 0; channel < 2; channel += 1) {
                    const node = await withTimeout(namEngine.createNode(), 5000, 'nó NAM não pôde ser criado offline');
                    node.channelCount = 1;
                    node.channelCountMode = 'explicit';
                    await withTimeout(node.loadModel(plugin.source.namJson, {
                        slimSize: plugin.source.namSlim,
                    }), 8000, 'modelo NAM não carregou offline');
                    nodes.push(node);
                }
                const input = ctx.createGain();
                const output = ctx.createGain();
                const dry = ctx.createGain();
                const wet = ctx.createGain();
                const sum = ctx.createGain();
                const level = ctx.createGain();
                const panner = ctx.createStereoPanner();
                const stereo = ctx.createGain();
                const splitter = ctx.createChannelSplitter(2);
                const merger = ctx.createChannelMerger(2);
                const bass = ctx.createBiquadFilter();
                const mid = ctx.createBiquadFilter();
                const treble = ctx.createBiquadFilter();
                const presence = ctx.createBiquadFilter();
                stereo.channelCount = 2;
                stereo.channelCountMode = 'explicit';
                stereo.channelInterpretation = 'speakers';
                bass.type = 'lowshelf';
                bass.frequency.value = 120;
                bass.gain.value = paramValue('Bass', 0);
                mid.type = 'peaking';
                mid.frequency.value = 700;
                mid.Q.value = 0.9;
                mid.gain.value = paramValue('Mid', 0);
                treble.type = 'highshelf';
                treble.frequency.value = 3200;
                treble.gain.value = paramValue('Treble', 0);
                presence.type = 'peaking';
                presence.frequency.value = 4500;
                presence.Q.value = 0.7;
                presence.gain.value = paramValue('Presence', 0);
                const mix = paramValue('Mix', 1);
                input.gain.value = paramValue('Input', 1);
                dry.gain.value = 1 - mix;
                wet.gain.value = mix;
                level.gain.value = paramValue('Output', 1);
                panner.pan.value = paramValue('Pan', 0);
                input.connect(stereo);
                stereo.connect(splitter);
                splitter.connect(nodes[0], 0);
                splitter.connect(nodes[1], 1);
                nodes[0].connect(merger, 0, 0);
                nodes[1].connect(merger, 0, 1);
                merger.connect(bass);
                bass.connect(mid);
                mid.connect(treble);
                treble.connect(presence);
                presence.connect(wet);
                wet.connect(sum);
                input.connect(dry);
                dry.connect(sum);
                sum.connect(level);
                level.connect(panner);
                panner.connect(output);
                return { input, output: panner };
            }
            catch (error) {
                warnings.push(`NAM "${plugin.name}" ignorado no export: ${error.message}`);
                return null;
            }
        }
        return null;
    }
    async render(request) {
        const sampleRate = this.ctx.sampleRate;
        const bars = Math.max(1, Math.floor(request.bars));
        const totalSteps = bars * 16;
        const stepDuration = 60 / Math.max(30, request.bpm) / 4;
        // Export-of-selection: render only [startStep, endStep). Everything is
        // scheduled in absolute arrangement time and then shifted earlier by the
        // selection's start, so the offline context begins on the first chosen step.
        const hasSelection = request.startStep !== undefined || request.endStep !== undefined;
        const selStart = Math.max(0, Math.min(totalSteps - 1, Math.floor(request.startStep ?? 0)));
        const selEnd = Math.max(selStart + 1, Math.min(totalSteps, Math.ceil(request.endStep ?? totalSteps)));
        const selSteps = selEnd - selStart;
        const selOffset = selStart * stepDuration;
        // A single track export only needs to cover its recorded clip; a stem has to
        // be as long as the arrangement so all of them start and end together.
        const stem = Boolean(request.trackId) || Boolean(request.groupId);
        const sequenceDuration = stem && !request.aligned ? 0 : selSteps * stepDuration;
        const entries = [];
        for (const [id, track] of this.tracks) {
            if (request.trackId && id !== request.trackId)
                continue;
            if (request.groupId && track.groupId !== request.groupId)
                continue;
            entries.push([id, track]);
        }
        let contentDuration = sequenceDuration;
        const noteEnd = (track) => patternContentEnd(track.notes, track.patternSteps, totalSteps) * stepDuration;
        for (const [, track] of entries) {
            if (track.buffer) {
                contentDuration = Math.max(contentDuration, track.clipStart * stepDuration + this.clipEnd(track) - selOffset);
            }
            if (track.instrument && track.notes.length > 0) {
                contentDuration = Math.max(contentDuration, noteEnd(track) - selOffset);
            }
        }
        // Reverb/delay tails must fit in the exported file.
        let tail = 0;
        const busTail = (reverbEnabled, delayEnabled) => {
            if (reverbEnabled)
                tail = Math.max(tail, this.sendConfig.rvDecay * 0.9);
            if (delayEnabled) {
                tail = Math.max(tail, (this.sendConfig.dlTime / 1000) * (2 + this.sendConfig.dlFeedback * 4));
            }
        };
        for (const [, track] of entries) {
            if (!track.buffer && !(track.instrument && track.notes.length > 0))
                continue;
            if (track.fx.state.reverb.enabled) {
                tail = Math.max(tail, track.fx.state.reverb.params.decay * 0.9);
            }
            if (track.fx.state.delay.enabled) {
                const delay = track.fx.state.delay.params;
                tail = Math.max(tail, (delay.time / 1000) * (2 + delay.feedback * 4));
            }
            // Shared send buses only ring when a track actually feeds them.
            busTail(track.rvSend.gain.value > 0, track.dlSend.gain.value > 0);
            // A producer aux rings too, but only for tracks that send into it.
            for (const [auxId, send] of track.auxSends) {
                if (send.gain.value <= 0)
                    continue;
                const aux = this.auxes.get(auxId);
                if (!aux)
                    continue;
                if (aux.fx.state.reverb.enabled) {
                    tail = Math.max(tail, aux.fx.state.reverb.params.decay * 0.9);
                }
                if (aux.fx.state.delay.enabled) {
                    const delay = aux.fx.state.delay.params;
                    tail = Math.max(tail, (delay.time / 1000) * (2 + delay.feedback * 4));
                }
            }
        }
        if (this.masterFx.state.reverb.enabled) {
            tail = Math.max(tail, this.masterFx.state.reverb.params.decay * 0.9);
        }
        if (this.masterFx.state.delay.enabled) {
            const delay = this.masterFx.state.delay.params;
            tail = Math.max(tail, (delay.time / 1000) * (2 + delay.feedback * 4));
        }
        // A selection export is exactly the chosen range plus the reverb/delay tail;
        // a full export still ends after the last clip so an empty arrangement does
        // not pad out to the full bar count.
        const bodyDuration = hasSelection ? selSteps * stepDuration : contentDuration;
        const duration = bodyDuration + 0.35 + tail;
        const offline = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
        const master = offline.createGain();
        // A stem is the track as it leaves its own fader, not the master bus with one
        // track soloed: putting the glue/limiting on every stem would make them sum
        // to something that is not the mix. The mix keeps the full chain.
        master.gain.value = stem ? 1 : request.masterMuted ? 0 : request.masterVolume;
        master.connect(offline.destination);
        const masterSum = offline.createGain();
        if (stem) {
            masterSum.connect(master);
        }
        else {
            // Mirror of the live master bus: sum -> glue FX -> volume.
            const masterFx = createBuiltinChain(offline, this.masterFx.state);
            wireBuiltinSerial(masterFx);
            masterSum.connect(masterFx.input);
            masterFx.output.connect(master);
        }
        const reverbBus = this.createSendBus('reverb', offline, masterSum);
        const delayBus = this.createSendBus('delay', offline, masterSum);
        // Producer aux buses, mirrored from the live graph: send -> FX -> fader ->
        // master sum. Built once so a track's send tap has a destination to land on.
        const auxBuses = new Map();
        for (const [auxId, aux] of this.auxes) {
            const input = offline.createGain();
            const fx = createBuiltinChain(offline, aux.fx.state);
            wireBuiltinSerial(fx);
            const output = offline.createGain();
            output.gain.value = aux.muted ? 0 : Math.max(0, aux.volume);
            input.connect(fx.input);
            fx.output.connect(output);
            output.connect(masterSum);
            auxBuses.set(auxId, input);
        }
        // Sub-groups, built on demand so only the buses this export actually feeds
        // exist. Same shape as live: member -> FX -> pan -> fader -> automation ->
        // master sum, so a bus rack or envelope drawn in the mixer is in the file.
        const groupBuses = new Map();
        const groupDestination = (groupId) => {
            if (groupId === '')
                return masterSum;
            const existing = groupBuses.get(groupId);
            if (existing)
                return existing;
            const group = this.groups.get(groupId);
            if (!group)
                return masterSum;
            const input = offline.createGain();
            const fx = createBuiltinChain(offline, group.fx.state);
            wireBuiltinSerial(fx);
            const panner = offline.createStereoPanner();
            const output = offline.createGain();
            const autoGain = offline.createGain();
            panner.pan.value = group.pan;
            output.gain.value = this.groupsGain(group.volume, group.muted);
            input.connect(fx.input);
            fx.output.connect(panner);
            panner.connect(output);
            output.connect(autoGain);
            scheduleAutomationEnvelope(autoGain.gain, group.automation, -selOffset, stepDuration, selStart, 0);
            autoGain.connect(masterSum);
            groupBuses.set(groupId, input);
            return input;
        };
        const duckWires = [];
        const trackOutputs = new Map();
        const warnings = [];
        let renderedTracks = 0;
        for (const [trackId, track] of entries) {
            const hasNotes = Boolean(track.instrument) && track.notes.length > 0;
            if (!track.buffer && !hasNotes)
                continue;
            renderedTracks += 1;
            const panner = offline.createStereoPanner();
            panner.pan.value = track.pan;
            const fxInput = offline.createGain();
            const shaper = offline.createWaveShaper();
            const filter = offline.createBiquadFilter();
            const fx = createBuiltinChain(offline, track.fx.state);
            const namSplit = offline.createGain();
            const namSum = offline.createGain();
            const gain = offline.createGain();
            const autoGain = offline.createGain();
            const monoSplitter = offline.createChannelSplitter(2);
            const monoMerger = offline.createChannelMerger(2);
            const monoGains = [
                offline.createGain(),
                offline.createGain(),
                offline.createGain(),
                offline.createGain(),
            ];
            const rvSend = offline.createGain();
            const dlSend = offline.createGain();
            const duckGain = offline.createGain();
            if (track.shaper.curve) {
                shaper.curve = new Float32Array(track.shaper.curve);
            }
            filter.type = track.filter.type;
            filter.frequency.value = track.filter.frequency.value;
            gain.gain.value = track.muted ? 0 : track.volume * track.trim * track.phase;
            const direct = track.mono ? 0.5 : 1;
            const cross = track.mono ? 0.5 : 0;
            monoGains[0].gain.value = direct;
            monoGains[1].gain.value = cross;
            monoGains[2].gain.value = cross;
            monoGains[3].gain.value = direct;
            rvSend.gain.value = track.rvSend.gain.value;
            dlSend.gain.value = track.dlSend.gain.value;
            duckGain.gain.value = 1;
            panner.connect(fxInput);
            fxInput.connect(shaper);
            shaper.connect(filter);
            const pluginsMap = new Map(track.plugins.map((plugin) => [plugin.id, plugin]));
            const offlineBranches = [];
            const branchPluginIds = new Set();
            let currentOffBranch = null;
            for (const stage of track.chain) {
                if (stage.kind === 'builtin') {
                    currentOffBranch = null;
                    continue;
                }
                const plugin = pluginsMap.get(stage.id);
                if (!plugin || !plugin.enabled)
                    continue;
                const built = await this.buildOfflinePlugin(offline, plugin, warnings);
                if (!built)
                    continue;
                if (plugin.kind === 'nam') {
                    currentOffBranch = { id: plugin.id, plugins: [built] };
                    offlineBranches.push(currentOffBranch);
                    branchPluginIds.add(plugin.id);
                }
                else if (currentOffBranch) {
                    currentOffBranch.plugins.push(built);
                    branchPluginIds.add(plugin.id);
                }
            }
            const builtStandalone = new Map();
            let cursor = filter;
            let parallelConnected = false;
            for (const stage of track.chain) {
                if (branchPluginIds.has(stage.id)) {
                    if (!parallelConnected && offlineBranches.length > 0) {
                        cursor.connect(namSplit);
                        for (const branch of offlineBranches) {
                            let bCursor = namSplit;
                            for (const built of branch.plugins) {
                                bCursor.connect(built.input);
                                bCursor = built.output;
                            }
                            bCursor.connect(namSum);
                        }
                        cursor = namSum;
                        parallelConnected = true;
                    }
                    continue;
                }
                if (stage.kind === 'builtin') {
                    const unit = fx.units[stage.id];
                    cursor.connect(unit.input);
                    cursor = unit.output;
                    continue;
                }
                const plugin = pluginsMap.get(stage.id);
                if (!plugin || !plugin.enabled)
                    continue;
                let built = builtStandalone.get(plugin.id);
                if (!built) {
                    const res = await this.buildOfflinePlugin(offline, plugin, warnings);
                    if (!res)
                        continue;
                    built = res;
                    builtStandalone.set(plugin.id, built);
                }
                cursor.connect(built.input);
                cursor = built.output;
            }
            cursor.connect(gain);
            gain.connect(autoGain);
            scheduleAutomationEnvelope(autoGain.gain, track.automation, -selOffset, stepDuration, selStart, 0);
            autoGain.connect(monoSplitter);
            monoSplitter.connect(monoGains[0], 0);
            monoSplitter.connect(monoGains[1], 0);
            monoSplitter.connect(monoGains[2], 1);
            monoSplitter.connect(monoGains[3], 1);
            monoGains[0].connect(monoMerger, 0, 0);
            monoGains[1].connect(monoMerger, 0, 1);
            monoGains[2].connect(monoMerger, 0, 0);
            monoGains[3].connect(monoMerger, 0, 1);
            monoMerger.connect(duckGain);
            duckGain.connect(groupDestination(track.groupId));
            duckGain.connect(rvSend);
            rvSend.connect(reverbBus.input);
            duckGain.connect(dlSend);
            dlSend.connect(delayBus.input);
            for (const [auxId, liveSend] of track.auxSends) {
                const auxInput = auxBuses.get(auxId);
                if (!auxInput)
                    continue;
                const send = offline.createGain();
                send.gain.value = liveSend.gain.value;
                duckGain.connect(send);
                send.connect(auxInput);
            }
            trackOutputs.set(trackId, monoMerger);
            // The follower needs both ends of the graph, so it is wired after every
            // track exists; a source may be later in the list than the duck.
            if (track.duck && track.duckSourceIds.length > 0) {
                duckWires.push({
                    trackId,
                    duckGain,
                    sourceIds: [...track.duckSourceIds],
                    depth: track.duckDepth,
                });
            }
            // The same question the live transport asks, so a plugin that is audible in
            // the room is in the file, and one that is not is missing from both.
            const take = takeToPlay(track);
            if (take) {
                const source = offline.createBufferSource();
                source.buffer = take;
                const shape = offline.createGain();
                source.connect(shape);
                shape.connect(panner);
                const end = this.clipEnd(track);
                // Shift the clip into offline time. One that began before the selection
                // starts part-way into the buffer rather than being cut off the front.
                let when = track.clipStart * stepDuration - selOffset;
                let playOffset = 0;
                if (when < 0) {
                    playOffset = -when;
                    when = 0;
                }
                if (playOffset < end) {
                    source.start(when, playOffset, Math.max(0.02, end - playOffset));
                    scheduleClipFade(shape, when, playOffset, end, track.fadeIn, track.fadeOut);
                }
            }
            if (track.instrument) {
                for (const note of track.notes) {
                    if (!isPatterned(track.patternSteps)) {
                        if (note.step + note.length <= selStart || note.step >= selEnd)
                            continue;
                        scheduleVoice(offline, panner, track.instrument, note.pitch, note.velocity, note.step * stepDuration - selOffset, note.length * stepDuration, track.voice);
                        continue;
                    }
                    // A pattern repeats to the end of the selection: the same
                    // `patternContentEnd` the duration above used, so the exported take
                    // has exactly the hits the grid showed.
                    for (let step = note.step; step < selEnd; step += track.patternSteps) {
                        if (step + note.length <= selStart)
                            continue;
                        scheduleVoice(offline, panner, track.instrument, note.pitch, note.velocity, step * stepDuration - selOffset, note.length * stepDuration, track.voice);
                    }
                }
            }
        }
        if (renderedTracks === 0) {
            warnings.push('nenhuma track com áudio gravado — o arquivo pode ficar silencioso');
        }
        // Sidechain ducks, second pass: every track node exists now, so each follower
        // can read its sources and drive the ducked track's gain, exactly as live.
        if (duckWires.length > 0) {
            await this.ensureWorkletModule(offline, SIDECHAIN_PROCESSOR_NAME, SIDECHAIN_WORKLET_SOURCE);
            for (const wire of duckWires) {
                const sources = wire.sourceIds
                    .map((sourceId) => ({ sourceId, node: trackOutputs.get(sourceId) }))
                    .filter((entry) => Boolean(entry.node));
                const missing = wire.sourceIds.filter((sourceId) => !sources.some((entry) => entry.sourceId === sourceId));
                if (missing.length > 0) {
                    warnings.push(`sidechain da track ${wire.trackId}: ${missing.join(', ')} não está nesta exportação - o duck do arquivo seguiu as fontes que restam`);
                }
                // With none of its sources present, the follower would open the gate for
                // the whole file; leaving the track alone is what the meters showed.
                if (sources.length === 0)
                    continue;
                const follower = new AudioWorkletNode(offline, SIDECHAIN_PROCESSOR_NAME, {
                    numberOfInputs: 2,
                    numberOfOutputs: 1,
                    outputChannelCount: [1],
                });
                follower.parameters.get('depth')?.setValueAtTime(wire.depth, 0);
                const sink = offline.createGain();
                sink.gain.value = 0;
                follower.connect(sink);
                sink.connect(masterSum);
                follower.connect(wire.duckGain.gain);
                // Every source joins the same input, so the file ducks to their sum - the
                // same summing the live graph does, not the louder of the two.
                for (const { node } of sources)
                    node.connect(follower);
                wire.duckGain.gain.value = 0;
            }
        }
        const buffer = await offline.startRendering();
        // Keep exported files from clipping when a hot input or stacked plugins
        // push the mix above 0 dBFS.
        let peak = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
            const data = buffer.getChannelData(channel);
            for (let i = 0; i < data.length; i += 1) {
                const value = Math.abs(data[i]);
                if (value > peak)
                    peak = value;
            }
        }
        if (peak > 0.99) {
            const scale = 0.99 / peak;
            for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
                const data = buffer.getChannelData(channel);
                for (let i = 0; i < data.length; i += 1)
                    data[i] *= scale;
            }
            warnings.push(`o mix estourou 0 dBFS: tudo foi rebaixado ${(-20 * Math.log10(scale)).toFixed(1)} dB para caber no arquivo`);
        }
        // Measured on what the file actually contains, after any trim, so the number
        // the producer reads is the number the player will hear.
        const channels = [];
        for (let channel = 0; channel < Math.min(2, buffer.numberOfChannels); channel += 1) {
            channels.push(buffer.getChannelData(channel));
        }
        const loudness = measureLoudness(channels, buffer.sampleRate);
        // The trim above only ever looks at the samples. A file that stops just
        // below 0 dBFS can still overshoot between two of them, and that overshoot
        // is what a phone's converter turns into crackle - so it gets said out loud
        // rather than left for the producer to discover after the upload.
        if (Number.isFinite(loudness.truePeakDb) && loudness.truePeakDb > -0.5) {
            warnings.push(`true peak em ${loudness.truePeakDb.toFixed(1)} dBTP: acima de -1 dBTP os codificadores de streaming costumam distorcer - rebaixe o master ou segure o limitador`);
        }
        return { buffer, warnings, loudness };
    }
}
export function encodeWav(buffer) {
    const channels = Math.min(2, buffer.numberOfChannels);
    const length = buffer.length;
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;
    const dataSize = length * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);
    const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i += 1)
            view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);
    const channelData = [];
    for (let channel = 0; channel < channels; channel += 1) {
        channelData.push(buffer.getChannelData(channel));
    }
    let offset = 44;
    for (let i = 0; i < length; i += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
            const sample = Math.max(-1, Math.min(1, channelData[channel][i] ?? 0));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            offset += 2;
        }
    }
    return new Blob([arrayBuffer], { type: 'audio/wav' });
}
function measurePeak(analyser) {
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) {
        const value = Math.abs(data[i] - 128) / 128;
        if (value > peak)
            peak = value;
    }
    return peak;
}
