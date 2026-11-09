export declare const LOUDNESS_PROCESSOR_NAME = "webdaw-loudness";
export interface LiveLoudness {
    /** Last 400 ms, in LUFS; -Infinity means the meter shows -inf. */
    momentaryLufs: number;
    /** Last 3 s, in LUFS; -Infinity until three seconds have been metered. */
    shortTermLufs: number;
    /** Sample peak inside the last 400 ms, in dBFS. */
    peakDb: number;
    /** True peak inside the last 400 ms, in dBTP: what the converter hears. */
    truePeakDb: number;
}
export declare const LOUDNESS_WORKLET_SOURCE: string;
