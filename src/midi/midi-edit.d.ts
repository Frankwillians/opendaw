/**
 * Pure MIDI note editing - the maths behind quantize, humanize, nudge, scale
 * snapping and velocity. Run with `npm test`.
 *
 * Nothing here touches the audio graph or React: each function takes the whole
 * note list and returns a new one, so the caller can hand the result straight
 * to the undo stack. The optional `include` predicate is how a tool is limited
 * to the box selection while leaving the rest of the pattern untouched.
 *
 * Notes are the same shape as InstrumentNote in the engine; the type is written
 * out here so this module can be imported by bare Node with no resolution of
 * browser-only files.
 */
export interface RollNote {
    /** Absolute 16th-note position in the arrangement. */
    step: number;
    /** MIDI note number. */
    pitch: number;
    /** Length in 16th-note steps, at least 1. */
    length: number;
    /** 0..1. */
    velocity: number;
}
/** Anything that returns 0..1; pass a seeded one for a reproducible humanize. */
export type NoteRng = () => number;
/** Which notes a tool should touch. Omit it to touch every note. */
export type NoteFilter = (note: RollNote, index: number) => boolean;
/** Deterministic 32-bit generator, so a humanize pass can be tested. */
export declare function mulberry32(seed: number): NoteRng;
/** Grid choices in 16th-note steps; the value the select submits. */
export declare const QUANTIZE_GRIDS: ReadonlyArray<{
    steps: number;
    label: string;
}>;
/**
 * Snap note starts to a grid. `strength` 0..1 blends between the original
 * position and the grid, which is the difference between a machine groove and a
 * player who is mostly on time. Length is deliberately left alone: quantizing
 * the tail is what turns a phrase into a brick.
 */
export declare function quantizeNotes(notes: readonly RollNote[], gridSteps: number, strength?: number, include?: NoteFilter): RollNote[];
/**
 * Push notes slightly off the grid and vary their velocity. `amount` 0..1 sets
 * how far a hit may drift (at 1 it can land two 16ths away) and how much the
 * loudness wiggles. Timing jitter is always a whole step, because a fraction of
 * a step cannot be represented here.
 */
export declare function humanizeNotes(notes: readonly RollNote[], amount?: number, rng?: NoteRng, include?: NoteFilter): RollNote[];
/** Move notes by whole steps and semitones - what the arrow keys do. */
export declare function nudgeNotes(notes: readonly RollNote[], deltaSteps: number, deltaPitch?: number, include?: NoteFilter): RollNote[];
/** Slide the box itself along with its notes, so the selection stays put. */
export declare function shiftSelectionBox<T extends {
    left: number;
    right: number;
    high: number;
    low: number;
}>(box: T, deltaSteps: number, deltaPitch: number): T;
/** One note's loudness, clamped to the range the engine expects. */
export declare function withVelocity(notes: readonly RollNote[], index: number, velocity: number): RollNote[];
/** Scale every note at once, keeping the quietest ones audible. */
export declare function scaleVelocities(notes: readonly RollNote[], factor: number, include?: NoteFilter): RollNote[];
export declare const SCALE_ROOTS: ReadonlyArray<string>;
/** Semitone offsets from the root. `intervals` empty means "no scale". */
export declare const SCALE_MODES: ReadonlyArray<{
    id: string;
    label: string;
    intervals: readonly number[];
}>;
/** Pitch classes (0..11) that belong to a scale; empty id gives every note. */
export declare function scalePitchClasses(root: number, modeId: string): number[];
/** True when the scale is off (no notes to tint) or the pitch is a member. */
export declare function isScalePitch(pitch: number, root: number, modeId: string): boolean;
/** Nearest pitch class inside the scale, preferring the note already there. */
export declare function nearestScalePitch(pitch: number, root: number, modeId: string): number;
/** Pull every note into the scale, the shortest move wins. */
export declare function snapNotesToScale(notes: readonly RollNote[], root: number, modeId: string, include?: NoteFilter): RollNote[];
