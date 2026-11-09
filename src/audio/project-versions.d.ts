/**
 * Autosave versions: the last few states the project was in, so a bad morning
 * is recoverable.
 *
 * The live autosave overwrites one key on every edit, which is right for a
 * session but means "I recorded over the good take and only noticed ten minutes
 * later" has no way back. These helpers keep a short rolling history of whole
 * projects, newest first, and give the menu something honest to show.
 *
 * Pure on purpose: `node --test` checks the ordering, the de-duplication and the
 * quota trimming without a browser, and the App decides when to write.
 */
export interface StoredVersion {
    id: string;
    /** When it was written, as a ms epoch. */
    savedAt: number;
    /** What wrote it: the autosave, or the producer naming a moment. */
    label: string;
    /** The project exactly as it was saved. */
    json: string;
}
/** How many snapshots are kept. Eight is a morning of work, and stays small. */
export declare const MAX_VERSIONS = 8;
/** Read a stored list back: anything malformed is dropped, newest comes first. */
export declare function parseVersions(raw: string | null, limit?: number): StoredVersion[];
/**
 * Decide whether an autosave deserves its own snapshot.
 *
 * Two consecutive writes of the same project are one moment, and a write every
 * keystroke would push real work out of the eight slots within minutes.
 */
export declare function shouldRecord(newest: StoredVersion | undefined, json: string, now: number): boolean;
/**
 * Add a snapshot and keep the list inside its budget.
 *
 * Identical projects are not stored twice; the list stays newest-first, capped
 * at `limit`, and never holds two entries with the same id.
 */
export declare function addVersion(list: StoredVersion[], version: StoredVersion, limit?: number): StoredVersion[];
/** Drop one snapshot (the menu's "esquecer esta versão"). */
export declare function removeVersion(list: StoredVersion[], id: string): StoredVersion[];
export declare function findVersion(list: StoredVersion[], id: string): StoredVersion | null;
/**
 * Remove the oldest snapshots until the payload fits `budget` characters, and
 * say whether there is anything left to write. localStorage throws when it is
 * full, which is not a reason to lose the current project.
 */
export declare function trimToFit(list: StoredVersion[], budget: number): {
    kept: StoredVersion[];
    fits: boolean;
};
/**
 * How long ago, in the words a producer reads: "agora", "há 4 min", "há 2 h",
 * "ontem", "há 3 dias". Kept explicit rather than through Intl so the menu and
 * the tests say the same thing on every machine.
 */
export declare function describeAge(savedAt: number, now: number): string;
/** A clock for the menu: local time, so a snapshot matches the session. */
export declare function formatClock(savedAt: number): string;
