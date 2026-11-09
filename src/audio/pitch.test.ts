import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectPitch } from './pitch.ts'

function generateSineWave(freq: number, sampleRate: number, length: number): Float32Array {
  const buffer = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    buffer[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.7
  }
  return buffer
}

test('detectPitch accurately finds A4 (440 Hz) sine wave', () => {
  const sampleRate = 48000
  const buffer = generateSineWave(440, sampleRate, 2048)
  const result = detectPitch(buffer, sampleRate, 440)
  assert.ok(result !== null)
  assert.equal(result.note, 'A')
  assert.equal(result.octave, 4)
  assert.ok(Math.abs(result.frequency - 440) < 0.5)
  assert.ok(Math.abs(result.cents) <= 2)
  assert.equal(result.inTune, true)
})

test('detectPitch accurately finds Guitar Low E2 (~82.4 Hz)', () => {
  const sampleRate = 48000
  const buffer = generateSineWave(82.41, sampleRate, 2048)
  const result = detectPitch(buffer, sampleRate, 440)
  assert.ok(result !== null)
  assert.equal(result.note, 'E')
  assert.equal(result.octave, 2)
  assert.ok(Math.abs(result.frequency - 82.4) < 0.6)
  assert.ok(Math.abs(result.cents) <= 3)
})

test('detectPitch detects detuned sharp note (+20 cents)', () => {
  const sampleRate = 48000
  // A4 + 20 cents = 440 * 2^(20/1200) ≈ 445.1 Hz
  const freq = 440 * 2 ** (20 / 1200)
  const buffer = generateSineWave(freq, sampleRate, 2048)
  const result = detectPitch(buffer, sampleRate, 440)
  assert.ok(result !== null)
  assert.equal(result.note, 'A')
  assert.equal(result.octave, 4)
  assert.ok(result.cents > 15 && result.cents < 25)
  assert.equal(result.inTune, false)
})

test('detectPitch returns null for silence or low noise', () => {
  const sampleRate = 48000
  const silent = new Float32Array(2048)
  assert.equal(detectPitch(silent, sampleRate), null)

  const lowNoise = new Float32Array(2048)
  for (let i = 0; i < lowNoise.length; i += 1) lowNoise[i] = (Math.random() - 0.5) * 0.001
  assert.equal(detectPitch(lowNoise, sampleRate), null)
})
