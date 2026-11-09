/**
 * Persistent sample store.
 *
 * The project JSON in localStorage only carries clip metadata; the actual
 * audio (imported files and recorded takes) lives here, in IndexedDB, as
 * 16-bit WAV blobs keyed by a stable bufferId stored on each track.
 */
export declare function saveSample(id: string, blob: Blob): Promise<void>;
export declare function loadSample(id: string): Promise<Blob | null>;
export declare function deleteSample(id: string): Promise<void>;
export declare function clearSamples(): Promise<void>;
/**
 * Every stored clip, for bundling a project into a file. Blobs the project no
 * longer references are deliberately left behind rather than deleted here - the
 * caller owns the decision about what is orphaned.
 */
export declare function listSamples(): Promise<Array<{
    id: string;
    blob: Blob;
}>>;
