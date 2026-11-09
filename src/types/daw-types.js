/**
 * DAW Data Types - Complete Project Structure
 * Supports audio/MIDI clips, automation, buses, tempo map, and full project serialization
 */
export function isAudioClip(clip) {
    return clip.type === 'audio';
}
export function isMidiClip(clip) {
    return clip.type === 'midi';
}
