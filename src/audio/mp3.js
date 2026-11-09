/**
 * MP3 encoding for the export path, on top of the pure-JS LAME encoder.
 *
 * Uses `@breezystack/lamejs`, the maintained fork of lamejs: the original
 * 1.2.1 npm build throws "MPEGMode is not defined" the moment an encoder is
 * constructed, so it could never print a single frame.
 *
 * Kept in its own module so the browser-only encoder import never reaches the
 * bare-Node unit tests. The encoder wants 16-bit integer samples in blocks, so
 * the rendered float buffer is converted a block at a time - a long mix never
 * allocates one giant Int16Array. Stereo feeds both channels; a mono buffer is
 * encoded as a single-channel MP3 rather than faking a second channel.
 *
 * Encoding runs on the main thread, so it yields to the event loop every few
 * blocks and reports progress: a long mix keeps the window alive and the
 * producer watches the bar move instead of wondering if the page froze.
 */
import { Mp3Encoder } from '@breezystack/lamejs';
/** LAME reads this many samples per frame at a time; 1152 is one MPEG frame. */
const BLOCK_SIZE = 1152;
/** Yield after this many blocks (~0.7 s of audio) so the UI can breathe. */
const YIELD_EVERY = 32;
function floatTo16(source, start, end) {
    const out = new Int16Array(end - start);
    for (let i = 0; i < out.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, source[start + i]));
        out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return out;
}
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));
/**
 * Encode a rendered buffer to an MP3 blob at the requested bitrate.
 * `onProgress` receives the fraction done (0..1) as the encoder advances.
 */
export async function encodeMp3(buffer, kbps = 192, onProgress) {
    const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
    const encoder = new Mp3Encoder(channels, buffer.sampleRate, kbps);
    const left = buffer.getChannelData(0);
    const right = channels > 1 ? buffer.getChannelData(1) : null;
    const parts = [];
    let blocks = 0;
    for (let i = 0; i < left.length; i += BLOCK_SIZE) {
        const end = Math.min(i + BLOCK_SIZE, left.length);
        const block = floatTo16(left, i, end);
        const chunk = right
            ? encoder.encodeBuffer(block, floatTo16(right, i, end))
            : encoder.encodeBuffer(block);
        if (chunk.length > 0)
            parts.push(new Uint8Array(chunk));
        blocks += 1;
        if (blocks % YIELD_EVERY === 0) {
            onProgress?.(end / left.length);
            await breathe();
        }
    }
    const tail = encoder.flush();
    if (tail.length > 0)
        parts.push(new Uint8Array(tail));
    onProgress?.(1);
    // Copy the LAME frames into one contiguous buffer: a freshly allocated
    // Uint8Array is backed by a plain ArrayBuffer, which is what Blob accepts.
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return new Blob([bytes], { type: 'audio/mpeg' });
}
