/**
 * The `.opdaw` project file.
 *
 * localStorage autosave is a convenience for one browser on one machine; a file
 * is what lets the producer hand a session over, back it up, or open it on the
 * laptop at the studio. The audio travels inside it - a project JSON that opens
 * with silent clips is not the project - so every WAV the clips reference is
 * carried as base64 next to the metadata.
 *
 * Pure data in, data out: no engine, no DOM, so the round trip is testable with
 * `npm test`.
 *
 * The app used to be called WebDAW, and sessions saved back then say
 * `webdaw-project` inside them. Those files are read exactly as they are - a
 * rename of the product is not a reason to lose somebody's takes - but nothing
 * written from here on uses the old identity.
 */
export declare const PROJECT_FILE_KIND = "opdaw-project";
/** Kinds accepted on read, from before the OpenDAW name. */
export declare const LEGACY_PROJECT_FILE_KINDS: readonly ['webdaw-project'];
export declare const PROJECT_FILE_VERSION = 1;
export declare const PROJECT_FILE_EXTENSION = "opdaw";
export interface ProjectFileSample {
    /** The bufferId the tracks reference. */
    id: string;
    /** 16-bit WAV, base64 without line breaks. */
    wav: string;
}
export interface ProjectFile {
    kind: typeof PROJECT_FILE_KIND;
    version: number;
    savedAt: string;
    /** The same shape localStorage keeps; the app owns validating it. */
    project: unknown;
    samples: ProjectFileSample[];
}
export interface ParsedProjectFile {
    project: unknown;
    samples: Array<{
        id: string;
        bytes: Uint8Array<ArrayBuffer>;
    }>;
    /** The sample ids the tracks asked for that the file did not carry. */
    missing: string[];
}
export declare function bytesToBase64(bytes: Uint8Array): string;
export declare function base64ToBytes(text: string): Uint8Array<ArrayBuffer>;
/** Ids the project references, in track order, without duplicates. */
export declare function sampleIdsUsedBy(project: unknown): string[];
export declare function buildProjectFile(project: unknown, samples: Array<{
    id: string;
    blob: Blob;
}>): Promise<ProjectFile>;
export declare function projectFileToText(file: ProjectFile): string;
export declare function parseProjectFile(text: string): ParsedProjectFile;
export declare const CHAIN_FILE_KIND = "opdaw-chain";
/** Chain presets saved under the old name still load. */
export declare const LEGACY_CHAIN_FILE_KINDS: readonly ['webdaw-chain'];
export declare const CHAIN_FILE_EXTENSION = "opdawchain";
export interface ChainFile {
    kind: typeof CHAIN_FILE_KIND;
    version: number;
    savedAt: string;
    name: string;
    /** The FX rack (params, enable flags and mixes) as plain JSON. */
    rack: unknown;
    /** Built-in unit ids in signal order. Plugins are never carried. */
    order: string[];
}
export interface ParsedChainFile {
    name: string;
    rack: unknown;
    order: string[];
}
export declare function buildChainFile(name: string, rack: unknown, order: string[]): ChainFile;
export declare function parseChainFile(text: string): ParsedChainFile;
