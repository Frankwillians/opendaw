/**
 * Encode a rendered buffer to an MP3 blob at the requested bitrate.
 * `onProgress` receives the fraction done (0..1) as the encoder advances.
 */
export declare function encodeMp3(buffer: AudioBuffer, kbps?: number, onProgress?: (fraction: number) => void): Promise<Blob>;
