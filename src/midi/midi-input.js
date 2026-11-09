/**
 * Web MIDI layer: controller discovery, input binding and note parsing.
 *
 * Only note messages are surfaced (0x90 / 0x80); clock, sysex and CC traffic
 * are ignored here so the app keeps a tiny, predictable surface.
 */
let access = null;
export function midiSupported() {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
}
/** Asks the browser for MIDI permission and caches the access object. */
export async function openMidiAccess() {
    if (!midiSupported()) {
        throw new Error('Web MIDI não é suportado neste navegador — use Chrome ou Edge');
    }
    access = await navigator.requestMIDIAccess({ sysex: false });
    return listMidiInputs();
}
export function listMidiInputs() {
    if (!access)
        return [];
    const devices = [];
    access.inputs.forEach((input) => {
        devices.push({
            id: input.id,
            name: input.name ?? 'Dispositivo MIDI',
            manufacturer: input.manufacturer ?? undefined,
        });
    });
    return devices;
}
/** Re-runs the callback when controllers are plugged/unplugged. */
export function watchMidiConnections(callback) {
    if (access)
        access.onstatechange = callback;
}
/** Binds one input; returns an unbind function. */
export function bindMidiInput(inputId, handlers) {
    const input = access?.inputs.get(inputId);
    if (!input)
        return () => { };
    const listener = (event) => {
        const data = event.data;
        if (!data || data.length < 3)
            return;
        const status = data[0] ?? 0;
        const command = status & 0xf0;
        const channel = (status & 0x0f) + 1;
        const pitch = data[1] ?? 0;
        const velocity = data[2] ?? 0;
        if (command === 0x90 && velocity > 0) {
            handlers.noteOn(pitch, velocity / 127, channel);
        }
        else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
            handlers.noteOff(pitch, channel);
        }
    };
    input.onmidimessage = listener;
    return () => {
        input.onmidimessage = null;
    };
}
