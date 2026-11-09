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
  step: number
  /** MIDI note number 0..127. */
  pitch: number
  /** Length in 16th-note steps. */
  length: number
  /** 0..1. */
  velocity: number
}

export interface MidiParseResult {
  /** Ticks per quarter note from the MThd division field. */
  ppq: number
  /** Tempo from the first Set Tempo meta event, 120 when absent. */
  bpm: number
  /** All tracks merged, sorted by start step. */
  notes: RollNote[]
}

const DEFAULT_PPQ = 480
const DEFAULT_BPM = 120

// ------------------------------------------------------------------ reading

function chunkId(bytes: Uint8Array, pos: number): string {
  return String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
}

function readU32(bytes: Uint8Array, pos: number): number {
  return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0
}

function readU16(bytes: Uint8Array, pos: number): number {
  return (bytes[pos] << 8) | bytes[pos + 1]
}

/** Variable-length quantity: up to 4 bytes, 7 bits each, high bit = continue. */
function readVlq(bytes: Uint8Array, cursor: { pos: number }): number {
  let value = 0
  for (let i = 0; i < 4; i += 1) {
    const byte = bytes[cursor.pos]
    if (byte === undefined) throw new Error('Truncated MIDI file: missing VLQ byte')
    cursor.pos += 1
    value = (value << 7) | (byte & 0x7f)
    if ((byte & 0x80) === 0) return value
  }
  throw new Error('Invalid MIDI file: VLQ longer than 4 bytes')
}

interface PendingNote {
  tick: number
  velocity: number
}

/**
 * Parse a format 0 or 1 SMF. Note-ons are matched to note-offs through a
 * per-(channel, pitch) stack; a note-on with velocity 0 counts as a note-off.
 * Meta and sysex events are skipped, except the first Set Tempo (FF 51 03)
 * which sets the bpm. SMPTE division is rejected rather than faked.
 */
export function parseMidi(bytes: Uint8Array): MidiParseResult {
  if (bytes.length < 14 || chunkId(bytes, 0) !== 'MThd') {
    throw new Error('Invalid MIDI file: missing MThd header')
  }
  const headerLength = readU32(bytes, 4)
  if (headerLength < 6) throw new Error('Invalid MIDI file: MThd header too short')
  const format = readU16(bytes, 8)
  const trackCount = readU16(bytes, 10)
  const division = readU16(bytes, 12)
  // The division is a signed 16-bit field: negative means SMPTE time code.
  if (division >= 0x8000) {
    throw new Error('SMPTE time division is not supported; only PPQ (ticks per quarter note) MIDI files can be parsed')
  }
  if (division === 0) throw new Error('Invalid MIDI file: PPQ division is zero')
  if (format !== 0 && format !== 1) {
    throw new Error(`Unsupported MIDI format ${format}: only format 0 and 1 are supported`)
  }

  const ppq = division
  // One 16th note is a quarter of a quarter note.
  const ticksPerStep = ppq / 4
  let bpm = DEFAULT_BPM
  let tempoSeen = false
  const notes: RollNote[] = []

  let pos = 8 + headerLength
  let tracksRead = 0
  while (pos + 8 <= bytes.length && tracksRead < trackCount) {
    const id = chunkId(bytes, pos)
    const length = readU32(bytes, pos + 4)
    pos += 8
    const end = Math.min(pos + length, bytes.length)
    if (id !== 'MTrk') {
      // Unknown chunks are legal in SMF; skip them whole.
      pos = end
      continue
    }
    tracksRead += 1

    const cursor = { pos }
    let tick = 0
    let running: number | null = null
    const pending = new Map<string, PendingNote[]>()

    while (cursor.pos < end) {
      tick += readVlq(bytes, cursor)
      let status = bytes[cursor.pos]
      if (status === undefined) throw new Error('Truncated MIDI track: missing event status')
      if (status >= 0x80) {
        cursor.pos += 1
      } else {
        if (running === null) throw new Error('Invalid MIDI track: data byte without a running status')
        status = running
      }

      if (status === 0xff) {
        // Meta events cancel running status.
        running = null
        const type = bytes[cursor.pos]
        cursor.pos += 1
        const metaLength = readVlq(bytes, cursor)
        const dataStart = cursor.pos
        if (type === 0x51 && metaLength >= 3 && !tempoSeen) {
          const microsPerQuarter =
            (bytes[dataStart] << 16) | (bytes[dataStart + 1] << 8) | bytes[dataStart + 2]
          if (microsPerQuarter > 0) {
            bpm = 60_000_000 / microsPerQuarter
            tempoSeen = true
          }
        }
        cursor.pos = dataStart + metaLength
      } else if (status === 0xf0 || status === 0xf7) {
        // Sysex: length-prefixed payload, never carries notes.
        running = null
        const sysexLength = readVlq(bytes, cursor)
        cursor.pos += sysexLength
      } else if (status >= 0x80 && status <= 0xef) {
        running = status
        const kind = status & 0xf0
        const channel = status & 0x0f
        const dataLength = kind === 0xc0 || kind === 0xd0 ? 1 : 2
        if (cursor.pos + dataLength > end) throw new Error('Truncated MIDI track: incomplete channel event')
        const d0 = bytes[cursor.pos]
        const d1 = dataLength === 2 ? bytes[cursor.pos + 1] : 0
        cursor.pos += dataLength

        const key = `${channel}:${d0}`
        if (kind === 0x90 && d1 > 0) {
          const stack = pending.get(key) ?? []
          stack.push({ tick, velocity: d1 })
          pending.set(key, stack)
        } else if (kind === 0x80 || kind === 0x90) {
          // Note-off, or note-on with velocity 0 which means the same thing.
          const stack = pending.get(key)
          const on = stack?.pop()
          if (on) {
            notes.push({
              step: on.tick / ticksPerStep,
              pitch: d0,
              length: (tick - on.tick) / ticksPerStep,
              velocity: on.velocity / 127,
            })
            if (stack && stack.length === 0) pending.delete(key)
          }
        }
        // Everything else on a channel (CC, pitch bend, aftertouch, program
        // change) is consumed above and ignored.
      } else {
        // System common / real-time bytes: no note content, skip their data.
        running = null
        if (status === 0xf2) cursor.pos += 2
        else if (status === 0xf1 || status === 0xf3) cursor.pos += 1
      }
      if (cursor.pos > end) throw new Error('Truncated MIDI track: event runs past the track boundary')
    }
    // Unmatched note-ons at end of track are dropped: they have no length.
    pos = end
  }

  notes.sort((a, b) => a.step - b.step || a.pitch - b.pitch)
  return { ppq, bpm, notes }
}

// ------------------------------------------------------------------ writing

function pushU16(out: number[], value: number): void {
  out.push((value >> 8) & 0xff, value & 0xff)
}

function pushU32(out: number[], value: number): void {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

function pushId(out: number[], id: string): void {
  for (let i = 0; i < id.length; i += 1) out.push(id.charCodeAt(i))
}

/** Encode a delta time as a VLQ (1..4 bytes). */
function pushVlq(out: number[], value: number): void {
  let v = Math.max(0, Math.round(value)) & 0x0fffffff
  const bytes = [v & 0x7f]
  v >>>= 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>>= 7
  }
  for (const byte of bytes) out.push(byte)
}

interface WriteEvent {
  tick: number
  /** 0 = note-off, 1 = note-on; offs sort first on ties. */
  kind: 0 | 1
  pitch: number
  velocity: number
}

/**
 * Write a format 0 SMF: MThd, one MTrk with a Set Tempo meta at tick 0, the
 * note-on/off pairs sorted by tick, and a final End-of-Track. Steps are 16th
 * notes, so tick = round(step * ppq / 4). Pitch is clamped to 0..127 and
 * note-on velocity to 1..127 so a written note can never be read back as an
 * immediate note-off.
 */
export function writeMidi(notes: RollNote[], opts?: { bpm?: number; ppq?: number }): Uint8Array {
  const rawPpq = opts?.ppq ?? DEFAULT_PPQ
  const ppq = Number.isFinite(rawPpq) ? Math.min(0x7fff, Math.max(1, Math.round(rawPpq))) : DEFAULT_PPQ
  const rawBpm = opts?.bpm ?? DEFAULT_BPM
  const bpm = Number.isFinite(rawBpm) && rawBpm > 0 ? rawBpm : DEFAULT_BPM
  const ticksPerStep = ppq / 4

  const events: WriteEvent[] = []
  for (const note of notes) {
    const pitch = Math.min(127, Math.max(0, Math.round(note.pitch)))
    const velocity = Math.min(127, Math.max(1, Math.round(note.velocity * 127)))
    const onTick = Math.max(0, Math.round(note.step * ticksPerStep))
    // At least one tick of length: a zero-length note cannot be re-read.
    const duration = Math.max(1, Math.round(note.length * ticksPerStep))
    events.push({ tick: onTick, kind: 1, pitch, velocity })
    events.push({ tick: onTick + duration, kind: 0, pitch, velocity: 0 })
  }
  events.sort((a, b) => a.tick - b.tick || a.kind - b.kind || a.pitch - b.pitch)

  const body: number[] = []
  // Set Tempo at tick 0; microseconds per quarter must fit in 24 bits.
  const microsPerQuarter = Math.min(0xffffff, Math.max(1, Math.round(60_000_000 / bpm)))
  pushVlq(body, 0)
  body.push(0xff, 0x51, 0x03, (microsPerQuarter >> 16) & 0xff, (microsPerQuarter >> 8) & 0xff, microsPerQuarter & 0xff)

  let lastTick = 0
  for (const event of events) {
    pushVlq(body, event.tick - lastTick)
    lastTick = event.tick
    body.push(event.kind === 1 ? 0x90 : 0x80, event.pitch, event.velocity)
  }
  // End of Track.
  pushVlq(body, 0)
  body.push(0xff, 0x2f, 0x00)

  const out: number[] = []
  pushId(out, 'MThd')
  pushU32(out, 6)
  pushU16(out, 0) // format 0
  pushU16(out, 1) // one track
  pushU16(out, ppq)
  pushId(out, 'MTrk')
  pushU32(out, body.length)
  for (const byte of body) out.push(byte)
  return Uint8Array.from(out)
}