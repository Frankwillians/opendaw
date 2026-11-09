/**
 * Count-in maths, kept apart from the transport so the beats can be tested
 * without an audio clock or a tab that paints.
 *
 * A count-in is one bar of clicks that ends exactly on the step the song
 * restarts on — the downbeat the producer pressed play or record aiming at. The
 * scheduler walks a step counter toward it, so everything that decision needs is
 * arithmetic: does this step get a click, is it the accented one, and what
 * number should be big enough to read across the room.
 *
 * The bar is held to the downbeat rather than to step zero. A count that aims at
 * bar 3 has to count four beats just like one that aims at the top of the
 * arrangement, and it has to keep the song's own instruments out of the pre-roll
 * while it does.
 */
export declare const STEPS_PER_BEAT = 4;
export declare const STEPS_PER_BAR: number;
/** The step a count-in bar holds before the song starts: one bar, no more. */
export declare function countInStart(downbeat: number, stepsPerBar?: number): number;
/**
 * Is this scheduler step still inside the count-in bar? The bar is the run of
 * steps that ends at the downbeat, so the answer holds for negative steps (a
 * count aimed at the top) and for steps in the middle of the arrangement alike.
 */
export declare function isCountingIn(step: number, downbeat: number | null, stepsPerBar?: number): boolean;
/**
 * Which click, if any, this step of the count-in plays: 'accent' on the first
 * beat of the bar and 'beat' on the rest, so the producer hears where the bar
 * begins. Steps between beats stay silent — a count is four ticks, not sixteen.
 */
export declare function countInClick(step: number, downbeat: number, stepsPerBeat?: number): 'accent' | 'beat' | null;
/**
 * The number to show: whole beats still to wait, clamped to the four a bar
 * holds. A fraction of a beat left still reads 1 — the last tick of the count is
 * the one a singer is waiting for, and showing 0 would read as "missed it".
 */
export declare function countInBeat(stepsRemaining: number, stepsPerBeat?: number): number;
