/**
 * The loudness meter that runs on the audio thread.
 *
 * A meter polled from JavaScript is only as good as the polling: a background
 * tab, or one frame that arrived late, drops part of the 400 ms window the
 * standard measures, and the number on screen then describes a different moment
 * than the one you heard. This class does the same job as the offline
 * measurement, but it is fed every sample by the worklet, so a window is never
 * missing anything.
 *
 * It is a `class` with no imports on purpose. The browser registers it by
 * turning this exact source into a string and evaluating it inside an
 * AudioWorklet, and `node --test` runs the very same class directly - which is
 * how the two implementations are kept in agreement rather than hoped to be.
 */
export interface MeterReading {
    /** Last 400 ms, in LUFS. -Infinity when it is under the -70 LUFS floor. */
    momentaryLufs: number;
    /** Last 3 s, in LUFS; -Infinity until three seconds have been metered. */
    shortTermLufs: number;
    /** Sample peak inside the last 400 ms window, in dBFS. */
    peakDb: number;
    /**
     * True peak inside the same window, in dBTP: the level the converter hears
     * between two samples. This is the number that keeps a master from distorting
     * on a phone, and it is always at or above `peakDb`.
     */
    truePeakDb: number;
}
export declare class LoudnessMeterCore {
    sampleRate: number;
    /** Locked by the first block: a stereo pair or one mono channel. */
    stereo: boolean | null;
    windowSize: number;
    stepSize: number;
    gatesShort: number;
    shelf: number[];
    hpf: number[];
    /**
     * True peak is read from an interpolated copy of the signal: `oversample`
     * inserted points per sample, each built from `taps` samples. The tap count is
     * odd so the middle tap lands on a whole sample and the half-sample point is
     * really between two of them; an even count puts that phase exactly between
     * two taps and throws the overshoot away.
     *
     * Both are plain literals on the instance rather than imported constants
     * because the browser runs this class from its own source text. The offline
     * meter has its own copy, and a test compares the two filters tap for tap, so
     * the number on screen and the number written into the exported file cannot
     * drift apart.
     */
    oversample: number;
    taps: number;
    /** One branch per inserted point; branch 0 is the sample itself. */
    kernel: number[][];
    /** [x1, x2, y1, y2, nextIn1, nextIn2, z1, z2] per channel: the two cascaded stages. */
    stateL: number[];
    stateR: number[];
    ringL: Float32Array;
    ringR: Float32Array;
    blockPeaks: Float32Array;
    /** The same ring, one entry per block, for the interpolated (true) peak. */
    tpPeaks: Float32Array;
    /** The tail of the previous block: the window needs samples from both sides. */
    prevLeft: Float32Array;
    prevRight: Float32Array;
    powers: Float32Array;
    ringIndex: number;
    ringFilled: number;
    sumL: number;
    sumR: number;
    peakIndex: number;
    peakFilled: number;
    blockPeak: number;
    powerIndex: number;
    powerFilled: number;
    powerSum: number;
    samplesUntilGate: number;
    constructor(sampleRate: number);
    /** High shelf of the K-weighting curve: +4 dB around 1681.97 Hz, Q 0.707. */
    designShelf(sampleRate: number): number[];
    /** RLB high-pass of the K-weighting curve: 38.13 Hz, Q 0.501. */
    designHpf(sampleRate: number): number[];
    /**
     * One branch of the interpolator per inserted point, each the sinc of its own
     * fractional delay, windowed (Blackman) so the truncation cannot add ringing of
     * its own, and normalized so a steady signal stays steady. Branch 0 is the
     * original sample: a filter must not move what is already there.
     */
    designInterpolator(): number[][];
    interpolatorHalf(): number;
    /**
     * The loudest interpolated point inside this block, in linear amplitude.
     *
     * Every inserted point needs the samples on both sides of it, so the last few
     * points of a block are measured at the start of the next one, when those
     * samples exist - which is why the loop runs from `-half` and stops `half`
     * before the end. Nothing is skipped and nothing is invented: the six samples
     * a point waits for are 0.125 ms, and the tail of the previous block is kept
     * precisely so the window can straddle the block boundary.
     */
    blockTruePeak(left: Float32Array, right: Float32Array): number;
    /** Keep the last `taps - 1` samples of a block for the next one to lean on. */
    rememberTail(tail: Float32Array, block: Float32Array): void;
    /**
     * Feed one block (128 samples in a browser) and get back the reading it
     * closed, or null when no 100 ms gate fell inside it - the usual case.
     *
     * A gate that lands mid-block is closed exactly where it lands: the block is
     * walked in pieces, so a window never borrows samples from the next one.
     */
    processBlock(left: Float32Array, right: Float32Array | null): MeterReading | null;
    /** K-weight both channels, keep their squares in the sliding rings. */
    walk(left: Float32Array, right: Float32Array, start: number, count: number, stereo: boolean): void;
    /** Close one 400 ms window: its loudness, its peak, and the 3 s mean so far. */
    closeWindow(stereo: boolean): MeterReading | null;
    pushPower(power: number): void;
    /** Power mean of the last three seconds of windows, in LUFS. */
    shortTerm(): number;
    /**
     * The loudest block entry still inside the window. Blocks are about 2.7 ms, so
     * a window holds roughly 150 of them at 48 kHz; reading them once every 100 ms
     * is cheaper than a sorted structure and exact. Both rings - the sample peak
     * and the interpolated one - are written and read with the same index, so one
     * scan serves both readings.
     */
    maxBlockPeak(ring: Float32Array): number;
}
