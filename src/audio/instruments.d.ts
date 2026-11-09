/**
 * Synthesized instruments for the Web DAW: pianos, basses and a drum kit.
 *
 * Voices are built from plain Web Audio nodes so they work identically in a
 * live AudioContext (playback, live jam, recording) and inside an
 * OfflineAudioContext (WAV export). Every voice connects into the track's
 * signal chain, so instruments run through the same NAM / cab / FX rack as
 * guitars and vocals.
 *
 * A track carries an `instrument` kind ('piano' | 'drums' | 'bass') plus a
 * `voice` string that selects the concrete timbre — one of PIANO_VOICES for
 * pianos, DRUM_KITS for drums or BASS_VOICES for basses. Unknown voice ids
 * fall back to the default.
 */
export type InstrumentKind = 'piano' | 'drums' | 'bass';
/** A MIDI note inside a clip, measured in 16th-note steps of the song. */
export interface InstrumentNote {
    step: number;
    pitch: number;
    length: number;
    velocity: number;
}
/** GM-style layout used by the drum sequencer lanes. */
export declare const DRUM_PIECES: ReadonlyArray<{
    pitch: number;
    label: string;
}>;
export declare const PIANO_VOICES: ReadonlyArray<{
    id: string;
    label: string;
}>;
export declare const DRUM_KITS: ReadonlyArray<{
    id: string;
    label: string;
}>;
export declare const BASS_VOICES: ReadonlyArray<{
    id: string;
    label: string;
}>;
export declare function defaultVoice(kind: InstrumentKind): string;
export declare function voicesFor(kind: InstrumentKind): ReadonlyArray<{
    id: string;
    label: string;
}>;
/** The three basic instruments, in the order the add-track menu shows them. */
export declare const INSTRUMENT_KINDS: ReadonlyArray<InstrumentKind>;
export declare function instrumentLabel(kind: InstrumentKind): string;
type AnyAudioContext = AudioContext | OfflineAudioContext;
/**
 * Schedule one instrument voice. `duration` shapes the piano and bass notes;
 * drums use their own fixed decays. `voice` selects the timbre (piano), kit
 * (drums) or bass character; unknown ids fall back to the default.
 */
export declare function scheduleVoice(ctx: AnyAudioContext, destination: AudioNode, kind: InstrumentKind, pitch: number, velocity: number, when: number, duration: number, voice?: string): void;
export {};
