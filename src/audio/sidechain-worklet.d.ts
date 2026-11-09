/**
 * Sidechain envelope follower, as a self-contained AudioWorklet source string.
 *
 * It is written as a string on purpose: the engine registers worklets from
 * source text (blob URL) for both the live context and the OfflineAudioContext
 * used by the export, so the duck you hear while mixing is the duck that ends
 * up in the rendered file, computed on the audio thread rather than by a
 * JavaScript timer that a hidden tab would freeze.
 *
 * The node outputs a control signal: 1.0 = no duck, (1 - depth) = fully ducked.
 * It is connected to a GainNode's `gain` AudioParam whose intrinsic value is 0,
 * so the control signal alone sets the level - which is why the duck node only
 * exists while a track actually has a sidechain source.
 */
export declare const SIDECHAIN_PROCESSOR_NAME = "webdaw-sidechain";
export declare const SIDECHAIN_WORKLET_SOURCE = "\nclass SidechainEnvelope extends AudioWorkletProcessor {\n  static get parameterDescriptors() {\n    return [\n      { name: 'depth', defaultValue: 0.7, minValue: 0, maxValue: 1 },\n      { name: 'attack', defaultValue: 8, minValue: 0.5, maxValue: 200 },\n      { name: 'release', defaultValue: 180, minValue: 1, maxValue: 2000 },\n    ]\n  }\n\n  constructor() {\n    super()\n    this.env = 0\n  }\n\n  process(inputs, outputs, parameters) {\n    const input = inputs[0]\n    const output = outputs[0]\n    if (!output || output.length === 0) return true\n\n    const blockSeconds = 128 / sampleRate\n    const depth = parameters.depth\n    const attack = parameters.attack\n    const release = parameters.release\n\n    // Block RMS: how the source actually felt, not one lucky sample.\n    let sum = 0\n    let counted = 0\n    if (input) {\n      for (let channel = 0; channel < input.length; channel += 1) {\n        const data = input[channel]\n        if (!data) continue\n        for (let i = 0; i < data.length; i += 1) {\n          sum += data[i] * data[i]\n          counted += 1\n        }\n      }\n    }\n    const rms = counted > 0 ? Math.sqrt(sum / counted) : 0\n\n    // A k-rate parameter arrives as a one-sample array; read it without\n    // indexing past the end.\n    const value = (param, index) => (param && param.length > 1 ? param[index] : param ? param[0] : 0)\n\n    for (let i = 0; i < output[0].length; i += 1) {\n      const target = Math.min(1, rms * 1.6)\n      // Fast when the source arrives, slow when it leaves, so the duck breathes\n      // instead of chopping.\n      const tauMs = target > this.env ? value(attack, i) : value(release, i)\n      const coeff = Math.exp(-blockSeconds / Math.max(0.0005, tauMs / 1000))\n      this.env = target + (this.env - target) * coeff\n      const gain = 1 - Math.min(1, value(depth, i)) * this.env\n      for (let channel = 0; channel < output.length; channel += 1) {\n        output[channel][i] = gain\n      }\n    }\n    return true\n  }\n}\n\nregisterProcessor('webdaw-sidechain', SidechainEnvelope)\n";
