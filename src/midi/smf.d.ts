/**
 * Standard MIDI File (SMF) codec - pure bytes in, pure notes out.
 *
 * Nothing here touches the audio graph, React or the browser: the module is
 * importable by bare Node so it can be unit tested with `npm test` and reused
 * by any import/export path. `parseMidi` reads format 0 and 1 files with PPQ
 * division and merges every track into one note list; `writeMidi` emits a
 * single-track format 0 file. The note shape mirrors midi-edit.ts and is
 * re-declared here so this module never resolves browser-only files.
 */
export interface RollNote {
    /** Absolute 16th-note position in the arrangement. */
    step: number;
    /** MIDI note number 0..127. */
    pitch: number;
    /** Length in 16th-note steps. */
    length: number;
    /** 0..1. */
    velocity: number;
}
export interface MidiParseResult {
    /** Ticks per quarter note from the MThd division field. */
    ppq: number;
    /** Tempo from the first Set Tempo meta event, 120 when absent. */
    bpm: number;
    /** All tracks merged, sorted by start step. */
    notes: RollNote[];
}
/**
 * Parse a format 0 or 1 SMF. Note-ons are matched to note-offs through a
 * per-(channel, pitch) stack; a note-on with velocity 0 counts as a note-off.
 * Meta and sysex events are skipped, except the first Set Tempo (FF 51 03)
 * which sets the bpm. SMPTE division is rejected rather than faked.
 */
export declare function parseMidi(bytes: Uint8Array): MidiParseResult;
/**
 * Write a format 0 SMF: MThd, one MTrk with a Set Tempo meta at tick 0, the
 * note-on/off pairs sorted by tick, and a final End-of-Track. Steps are 16th
 * notes, so tick = round(step * ppq / 4). Pitch is clamped to 0..127 and
 * note-on velocity to 1..127 so a written note can never be read back as an
 * immediate note-off.
 */
export declare function writeMidi(notes: RollNote[], opts?: {
    bpm?: number;
    ppq?: number;
}): Uint8Array;
