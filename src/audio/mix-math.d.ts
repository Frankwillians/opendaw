/**
 * Pure mix math shared by the live graph, the offline render and the tests.
 *
 * Nothing in here touches WebAudio: the engine asks these functions for numbers
 * and curves and then pushes them into nodes. That is what lets the exported
 * file and the monitors agree, and it keeps the interesting arithmetic
 * (`node --test src/audio/mix-math.test.ts`) checkable without a browser.
 */
/** -inf-safe dB → linear. Anything at or below -60 dB is treated as silence. */
export declare function dbToGain(db: number): number;
/** Linear → dB, floored at -60 so meters never print -Infinity. */
export declare function gainToDb(gain: number): number;
/** Compact dB text for meters and knobs. */
export declare function formatDb(db: number): string;
export declare function clampRange(value: number, min: number, max: number): number;
/**
 * How much of the buffer actually plays. A clip with no stored length plays to
 * the end of the buffer; a trimmed clip stops where the user dragged, and may
 * never be allowed to run past the sample.
 */
export declare function clipEnd(clipDuration: number, bufferDuration: number): number;
/**
 * Gain a clip's edge-fade envelope has at `clipTime` seconds after the start of
 * the *clip*. The live scheduler reproduces exactly this piecewise line with
 * setValueAtTime / linearRampToValueAtTime (starting it at the point the
 * playback begins, so a loop that lands inside the fade-in resumes the ramp
 * instead of restarting it), and the offline render uses the same shape. A fade
 * you drew is therefore the fade you export.
 */
export declare function fadeGainAt(clipTime: number, clipEndSeconds: number, fadeIn: number, fadeOut: number): number;
/**
 * Noise gate as a static downward expander: everything under the threshold is
 * pulled down by `rangeDb` instead of being switched off, which is what keeps
 * the crossover from clicking. Pure amplitude shaping, so it behaves identically
 * offline. No attack/hold/release is claimed — a static curve cannot have any.
 */
export declare function gateCurve(thresholdDb: number, rangeDb: number, size?: number): Float32Array;
/** A point on a drawn automation lane: song position in steps, level in dB. */
export interface AutomationBreakpoint {
    step: number;
    value: number;
}
/**
 * Gain an automation lane has at `step`. Points are connected by straight lines
 * in *dB* - which is what a drawn lane means and what a fader does - and the
 * first and last points hold outside the drawn range. No points means no change
 * to the fader, so unity.
 */
export declare function automationGainAt(points: AutomationBreakpoint[], step: number): number;
/**
 * Gain the engine puts on an automation node for a dB value. Never zero: the
 * envelope is scheduled with exponential ramps (the only way a WebAudio param
 * can move linearly in dB), and an exponential ramp cannot start or end at 0.
 * Anything under -80 dB is silence anyway.
 */
export declare function automationNodeGain(db: number): number;
/**
 * Breakpoints in song order, with junk removed. Two points on the same step are
 * collapsed to the later one so a ramp never has a zero-length span.
 */
export declare function sortedAutomation(points: AutomationBreakpoint[]): AutomationBreakpoint[];
/**
 * Lane scale for a drawn volume envelope. Automation is relative to the fader,
 * so 0 dB means "leave it alone" and the neutral line is the middle of the lane.
 * The scale is piecewise-linear: the upper half carries 0..+12 dB, the lower
 * half 0..-60 dB. That gives the range you actually mix with real pixel
 * resolution while the deep fades stay reachable without spending most of the
 * lane on silence nobody needs to dial to a tenth of a dB.
 */
export declare const AUTO_MAX_DB = 12;
export declare const AUTO_MIN_DB = -60;
export declare function autoDbToY(db: number, height: number): number;
/**
 * Inverse of `autoDbToY`. A point within one pixel of the centre line is flat:
 * a pixel is the resolution a mouse has, and a lane of "flat" points that each
 * secretly carry -0.5 dB is not what anyone meant to draw.
 */
export declare function autoYToDb(y: number, height: number): number;
/**
 * unity at full scale, never exceeds 1, and adds mostly odd-order harmonics as
 * `drive` rises. `k` is derived from drive so 0 is transparent.
 */
export declare function saturationCurve(drive: number, size?: number): Float32Array;
/** Guitar-pedal overdrive: tanh with the slope folded into the drive. */
export declare function overdriveCurve(drive: number, size?: number): Float32Array;
/**
 * The sidechain sources a track should actually listen to, cleaned up.
 *
 * A duck can follow several tracks at once - the kick and the snare both pushing
 * the bass aside, say - so the request is a list rather than one id. The list is
 * still a producer's gesture, not a trusted instruction: a track cannot duck
 * itself (that would close the gate with its own signal and choke the fader),
 * an id repeated twice would wire the same source into the follower twice and
 * quietly double the depth, and a stale id left behind by a deleted track or an
 * older project file has no graph to read. The order survives, because the chips
 * in the mixer show them in the order they were added.
 */
export declare function normalizeDuckSources(wanted: readonly string[], ownId: string, knownIds: Iterable<string>): string[];
/** Two id lists that mean the same thing: same ids, same order. */
export declare function sameIdList(a: readonly string[], b: readonly string[]): boolean;
