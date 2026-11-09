/**
 * High-precision monophonic pitch detection for real-time instruments (guitar, bass, vocals).
 *
 * Uses Normalized Square Difference / Autocorrelation with first-peak detection
 * and parabolic interpolation to prevent octave division errors.
 */

export interface PitchInfo {
  frequency: number
  note: string
  octave: number
  cents: number
  inTune: boolean
  clarity: number
  rms: number
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/**
 * Detect the fundamental pitch from time-domain audio samples.
 */
export function detectPitch(
  buffer: Float32Array,
  sampleRate: number,
  refA4 = 440,
  minFreq = 40,
  maxFreq = 1200,
): PitchInfo | null {
  const size = buffer.length
  if (size < 256 || sampleRate <= 0) return null

  // 1. Calculate RMS to verify an audible signal is present
  let sumSq = 0
  for (let i = 0; i < size; i += 1) {
    const val = buffer[i]
    sumSq += val * val
  }
  const rms = Math.sqrt(sumSq / size)
  if (rms < 0.005) {
    return null
  }

  // 2. Bound lag (tau) based on frequency range
  const minLag = Math.max(1, Math.floor(sampleRate / maxFreq))
  const maxLag = Math.min(Math.floor(size / 2), Math.floor(sampleRate / minFreq))

  const correlations = new Float32Array(maxLag + 1)
  let maxCorrelation = 0

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let corr = 0
    let normA = 0
    let normB = 0
    const count = size - lag

    for (let i = 0; i < count; i += 1) {
      const a = buffer[i]
      const b = buffer[i + lag]
      corr += a * b
      normA += a * a
      normB += b * b
    }

    const norm = Math.sqrt(normA * normB)
    const normalizedCorr = norm > 0 ? corr / norm : 0
    correlations[lag] = normalizedCorr
    if (normalizedCorr > maxCorrelation) {
      maxCorrelation = normalizedCorr
    }
  }

  if (maxCorrelation < 0.6) {
    return null
  }

  // 3. Find the FIRST prominent peak to prevent octave errors (octave doubling/halving)
  const threshold = Math.max(0.6, maxCorrelation * 0.85)
  let bestLag = -1

  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    const curr = correlations[lag]
    if (curr >= threshold) {
      // Check if it's a local maximum
      if (curr >= correlations[lag - 1] && curr >= correlations[lag + 1]) {
        bestLag = lag
        break
      }
    }
  }

  if (bestLag === -1) {
    // Fallback to highest correlation peak
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      if (correlations[lag] === maxCorrelation) {
        bestLag = lag
        break
      }
    }
  }

  if (bestLag <= 0) return null

  // 4. Parabolic interpolation around bestLag for sub-sample accuracy
  let interpolatedLag = bestLag
  if (bestLag > minLag && bestLag < maxLag) {
    const alpha = correlations[bestLag - 1]
    const beta = correlations[bestLag]
    const gamma = correlations[bestLag + 1]
    const denom = 2 * (2 * beta - alpha - gamma)
    if (Math.abs(denom) > 1e-6) {
      const delta = (gamma - alpha) / denom
      if (Math.abs(delta) < 1) {
        interpolatedLag = bestLag + delta
      }
    }
  }

  const frequency = sampleRate / interpolatedLag
  if (!Number.isFinite(frequency) || frequency < minFreq || frequency > maxFreq) {
    return null
  }

  // 5. Calculate musical note and cents from frequency
  const semitonesFromA4 = 12 * Math.log2(frequency / refA4)
  const midiNote = 69 + semitonesFromA4
  const roundedMidi = Math.round(midiNote)
  const cents = Math.round((midiNote - roundedMidi) * 100)

  const noteIndex = ((roundedMidi % 12) + 12) % 12
  const note = NOTE_NAMES[noteIndex]
  const octave = Math.floor(roundedMidi / 12) - 1
  const inTune = Math.abs(cents) <= 3

  return {
    frequency: Math.round(frequency * 10) / 10,
    note,
    octave,
    cents,
    inTune,
    clarity: Math.round(maxCorrelation * 100) / 100,
    rms: Math.round(rms * 1000) / 1000,
  }
}
