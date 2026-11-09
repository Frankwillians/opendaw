/**
 * Loudness measurement, ITU-R BS.1770 / EBU R128, as pure data in - numbers out.
 *
 * Why this exists next to the peak meter: a peak meter only tells you that one
 * transient nearly clipped. Two mixes with the same peak can be 6 LU apart in
 * how loud they *feel*, and a master that reads -14 LUFS integrated is what a
 * streaming service expects. This module measures the thing the ear follows.
 *
 * The chain is the standard's: K-weighting (a high shelf that adds the +4 dB
 * the ear is missing above 2 kHz, then the RLB high-pass that takes away the
 * LF energy that does not contribute to loudness), mean square per channel over
 * a 400 ms window that slides 100 ms at a time, the -0.7 dB stereo alignment
 * offset, and then gating - silence is not allowed to make a programme look
 * quiet, and material 10 LU under the average is not allowed to make it look
 * loud.
 *
 * The tracker is streaming: blocks go in, windows come out. The same code
 * measures a finished offline render (push the whole buffer) and a bus that is
 * playing right now (push what the audio thread hands over), so a live meter
 * and an export report cannot disagree.
 *
 * Self-contained on purpose (no imports), so `node --test` can load it directly.
 */
/** A normalized biquad: b0, b1, b2, a1, a2 (a0 divided out). */
export type Biquad = [number, number, number, number, number];
/**
 * K-weighting for the context that will use it. 48 kHz gets the standard's own
 * numbers; anything else gets the same filters re-designed from their f0 / gain
 * / Q, which agrees with them to a couple of tenths of a dB - accurate enough
 * for a mix decision, and worth knowing if you master at 44.1 kHz.
 */
export declare function kWeighting(sampleRate: number): [Biquad, Biquad];
export declare function dbFromPower(meanSquare: number): number;
/**
 * One gated window per measurement: 400 ms of audio, advanced 100 ms. The step,
 * not the window, is what "momentary" and "short term" are built from.
 */
export interface LoudnessReport {
    /** Integrated programme loudness in LUFS; -Infinity for a silent file. */
    integratedLufs: number;
    /** Loudest 400 ms window, in LUFS. */
    momentaryMaxLufs: number;
    /** EBU Tech 3342 loudness range in LU: how much the level actually moves. */
    loudnessRangeLu: number;
    /** Sample peak in dBFS: what the numbers in the file reach. */
    peakDb: number;
    /**
     * True peak in dBTP: what the converter after the file hears between the
     * samples. Measured by four-times oversampling with an interpolation filter
     * (see `measureTruePeak`), which is what the standards ask for; this is the
     * number that keeps a master from clipping on a phone.
     */
    truePeakDb: number;
    /** Measured duration in seconds. */
    durationSeconds: number;
    /** Windows above the -70 LUFS floor, i.e. the ones the gate actually looked at. */
    measuredWindows: number;
}
/** A single reading, for a meter that updates while the mix plays. */
export interface LoudnessReading {
    /** Last 400 ms in LUFS; -Infinity until a full window has been fed. */
    momentaryLufs: number;
    /** Last 3 s power mean in LUFS; -Infinity until 3 s have been fed. */
    shortTermLufs: number;
    /** Loudest sample seen so far, in dBFS. */
    peakDb: number;
}
/**
 * Streaming BS.1770 meter. Feed it blocks of any size - a 128-sample render
 * quantum or a whole rendered buffer - and read the windows as they complete.
 */
export declare class LoudnessTracker {
    readonly sampleRate: number;
    private readonly windowSize;
    private readonly stepSize;
    private readonly shortTermWindows;
    private readonly leftChannel;
    private readonly rightChannel;
    /** The last `windowSize` weighted squares per channel, so the sum slides. */
    private readonly ringLeft;
    private readonly ringRight;
    private ringPosition;
    private sumLeft;
    private sumRight;
    /** The last `shortTermWindows` momentary powers, for the short-term mean. */
    private readonly powerRing;
    private powerPosition;
    private powerCount;
    private powerSum;
    private samplesUntilWindow;
    private samplesFed;
    private mode;
    private readonly moments;
    private readonly shorts;
    private momentary;
    private shortTerm;
    private momentaryMax;
    private peak;
    constructor(sampleRate: number);
    /**
     * Measure a block. Leaving `right` out means a mono programme, which BS.1770
     * weights once and without the stereo offset - one channel is not two.
     */
    push(left: ArrayLike<number>, right?: ArrayLike<number>): void;
    /**
     * One gate over the window that just finished: the mean square of each
     * channel, summed (stereo) or alone (mono), minus the alignment offset.
     */
    private closeWindow;
    reading(): LoudnessReading;
    /**
     * Integrated loudness and loudness range over everything fed so far.
     *
     * EBU Tech 3342 measures the range from short-term values with the first and
     * last five seconds (or ten per cent of the programme, whichever is bigger)
     * cut off, so a fade-in does not read as dynamics. Material too short to
     * survive that trim is measured whole rather than reported as no range.
     */
    /**
     * The programme the blocks that were fed add up to. True peak is not here: a
     * streaming meter does not keep the audio, and dBTP is measured over the
     * samples themselves - which `measureLoudness`, holding the whole buffer, does.
     */
    report(): Omit<LoudnessReport, 'truePeakDb'>;
}
/**
 * Measure a whole programme at once. `channels` is the list of channel arrays;
 * only the first two matter, which is all a stereo mix has.
 */
export declare function measureLoudness(channels: ArrayLike<number>[], sampleRate: number): LoudnessReport;
/**
 * The interpolation kernel, one branch per inserted point.
 *
 * Each phase is the sinc of its own fractional delay, windowed (Blackman) so the
 * truncation cannot add ringing of its own, and normalized so a steady signal
 * stays steady. Phase 0 is the original sample - the filter cannot move what is
 * already there.
 */
export declare function interpolationFilter(): number[][];
/**
 * True-peak level in dBTP, by four-times oversampling.
 *
 * The filter works in samples, not hertz, so the sample rate is not part of it.
 * Only the neighbourhood of the loudest samples is interpolated: an overshoot
 * between two samples cannot pass them by more than a few tenths of a dB, so
 * anything six dB below the file's own peak is not the answer being looked for.
 * That keeps a four-minute master to a few thousand filter runs instead of
 * hundreds of millions.
 */
export declare function measureTruePeak(channels: ArrayLike<number>[]): number;
