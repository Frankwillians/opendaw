/**
 * Minimal typing for the pure-JS LAME encoder (`lamejs`). The package ships no
 * types, and only the two members the MP3 export path touches are declared -
 * enough to keep `tsc -b` honest without pulling in the whole encoder surface.
 */
declare module 'lamejs' {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number)
    /** Feed one block of 16-bit samples; returns the MP3 bytes produced so far. */
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array
    /** Drain the encoder at the end of the stream. */
    flush(): Int8Array
  }
}
