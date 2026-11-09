/**
 * Web MIDI layer: controller discovery, input binding and note parsing.
 *
 * Only note messages are surfaced (0x90 / 0x80); clock, sysex and CC traffic
 * are ignored here so the app keeps a tiny, predictable surface.
 */
export interface MidiDeviceInfo {
    id: string;
    name: string;
    manufacturer?: string;
}
export interface MidiNoteHandlers {
    noteOn(pitch: number, velocity: number, channel: number): void;
    noteOff(pitch: number, channel: number): void;
}
export declare function midiSupported(): boolean;
/** Asks the browser for MIDI permission and caches the access object. */
export declare function openMidiAccess(): Promise<MidiDeviceInfo[]>;
export declare function listMidiInputs(): MidiDeviceInfo[];
/** Re-runs the callback when controllers are plugged/unplugged. */
export declare function watchMidiConnections(callback: () => void): void;
/** Binds one input; returns an unbind function. */
export declare function bindMidiInput(inputId: string, handlers: MidiNoteHandlers): () => void;
