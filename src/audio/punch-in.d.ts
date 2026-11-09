/**
 * Punch-in maths, kept apart from the transport so the timing decisions can be
 * tested without a running audio clock or a painting tab.
 *
 * A punch pass is armed by pressing record with a time selection: the transport
 * rolls, the arrangement keeps playing, and only the capture window inside the
 * region records. Everything that decides "are we inside yet" lives here.
 */
export interface PunchBounds {
    from: number;
    to: number;
}
/** One scheduler pass of the state machine, as a word the caller can act on. */
export type PunchAction = 'idle' | 'open' | 'close' | 'missed';
/**
 * The region to punch into, snapped outward to whole steps and clamped to the
 * arrangement. A sliver of a selection still becomes the step it touches, so
 * the region can always hold a hit; null when there is no selection at all, or
 * the clamp left nothing behind.
 */
export declare function punchBoundsOf(sel: {
    from: number;
    to: number;
} | null, totalSteps: number): PunchBounds | null;
/**
 * Where to start the transport so the performance has context to play into:
 * wherever the playhead already is when that is before the region, otherwise
 * one bar ahead of it. Never negative, and never past the region start.
 */
export declare function punchLeadStep(playhead: number, from: number, stepsPerBar: number): number;
/**
 * What this scheduler pass should do.
 *
 * 'missed' is the honest failure: the playhead reached the end of the region
 * while the capture window was still not open (arming a mic takes real time),
 * so nothing inside the region was recorded and there is no take to keep.
 */
export declare function punchAction(bounds: PunchBounds | null, at: number, takeOpen: boolean): PunchAction;
/**
 * Where the punched take belongs on the lane. The recorder starts late by
 * however long the input needed to arm, and audio before that never existed,
 * so the clip starts where the capture really began — but never before the
 * region the user asked for.
 */
export declare function punchStartStep(bounds: PunchBounds | null, openedAt: number): number;
