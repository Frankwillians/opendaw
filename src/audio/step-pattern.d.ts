/**
 * Step-pattern math for looping instrument tracks.
 *
 * A pattern track stores its hits once, inside a loop of `patternSteps` steps,
 * and the transport repeats that loop for the whole arrangement. Only a few
 * questions are interesting: does this hit sound on this song step, where does
 * a note belong when the loop gets shorter, and where does the last repeat end.
 * They live here - pure and tested - because the live scheduler, the offline
 * export and the grid all have to agree on the same answers.
 */
export interface PatternNote {
    step: number;
    length: number;
}
/** A note as the sequencer grid knows it: a pitch, a step, a strength. */
export interface PatternHit extends PatternNote {
    pitch: number;
    velocity: number;
}
/** Loop lengths the grid offers. 0 means "no loop": notes stay where drawn. */
export declare const PATTERN_LENGTHS: readonly [0, 16, 32, 64];
export declare function normalizePatternSteps(value: unknown): number;
export declare function isPatterned(patternSteps: number): boolean;
/**
 * Whether the hit of `noteStep` sounds on the absolute song step. Outside a
 * loop this is plain equality; inside one, the loop is locked to bar 1, so
 * moving the playhead never shifts the groove.
 */
export declare function hitAtStep(noteStep: number, absoluteStep: number, patternSteps: number): boolean;
/** The last step the pattern still plays on - one before the arrangement ends. */
export declare function lastPatternStart(noteStep: number, patternSteps: number, totalSteps: number): number;
/**
 * Where the track's audio actually stops. A looped pattern keeps firing until
 * the last repeat, whose tail runs past the end of the arrangement by the
 * longest note - the export needs that much room or the final hit is cut off.
 */
export declare function patternContentEnd(notes: PatternNote[], patternSteps: number, totalSteps: number): number;
/**
 * Re-homes notes onto a loop of the given length. Drawing across several bars
 * and then choosing "1 compasso" is the usual way into a step sequencer, so the
 * notes fold by bar position and the groove you played survives. Two hits that
 * land on the same cell keep the stronger one.
 */
export declare function foldIntoPattern<T extends PatternHit>(notes: T[], patternSteps: number): T[];
/**
 * A one-bar groove cycled across the whole pattern, which is how hardware
 * sequencers load a preset into a 2 or 4 bar slot: the bar repeats, and you
 * vary the last one afterwards.
 */
export declare function cycleGroove(cells: Array<{
    step: number;
    pitch: number;
    velocity?: number;
}>, patternSteps: number): PatternHit[];
/** One hit of a preset groove, placed inside the first bar of 16 steps. */
export interface GrooveCell {
    step: number;
    pitch: number;
    velocity?: number;
}
export interface GroovePreset {
    id: string;
    label: string;
    cells: GrooveCell[];
}
/**
 * Starting grooves, written one bar each so `cycleGroove` can fill a 2 or 4 bar
 * slot with them. Pitches are the GM drum notes DRUM_PIECES plays, and the
 * velocities are what makes a groove sit right before the user touches it -
 * hats under, snares on top.
 */
export declare const GROOVE_PRESETS: GroovePreset[];
/**
 * A preset laid out for a pattern length. Loading a groove goes through here so
 * a 2 bar slot never ends up with a one bar loop the user has to notice.
 */
export declare function grooveNotes(preset: GroovePreset, patternSteps: number): PatternHit[];
