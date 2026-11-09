/**
 * High-precision monophonic pitch detection for real-time instruments (guitar, bass, vocals).
 *
 * Uses Normalized Square Difference / Autocorrelation with first-peak detection
 * and parabolic interpolation to prevent octave division errors.
 */
export interface PitchInfo {
    frequency: number;
    note: string;
    octave: number;
    cents: number;
    inTune: boolean;
    clarity: number;
    rms: number;
}
/**
 * Detect the fundamental pitch from time-domain audio samples.
 */
export declare function detectPitch(buffer: Float32Array, sampleRate: number, refA4?: number, minFreq?: number, maxFreq?: number): PitchInfo | null;
