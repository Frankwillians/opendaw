import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEngine, BuiltinFxParams, BuiltinFxUnit } from './audio-engine'
import { detectPitch, type PitchInfo } from './pitch'
import Knob from '../components/Knob'

interface TunerCardProps {
  unit: BuiltinFxUnit
  engine: AudioEngine | null
  /** Where the analyser comes from: a track lane, an aux bus or the master. */
  scope?: 'track' | 'aux' | 'master'
  trackId?: string
  auxId?: string
  onParamChange: (key: keyof BuiltinFxParams, value: number) => void
}

export default function TunerCard({
  unit,
  engine,
  scope = 'track',
  trackId,
  auxId,
  onParamChange,
}: TunerCardProps): React.JSX.Element {
  const [pitch, setPitch] = useState<PitchInfo | null>(null)
  const animRef = useRef<number | null>(null)
  const bufferRef = useRef<Float32Array<ArrayBuffer> | null>(null)

  const analyser = useMemo(() => {
    if (!engine) return null
    if (scope === 'master') return engine.getMasterTunerAnalyser()
    if (scope === 'aux') return auxId ? engine.getAuxTunerAnalyser(auxId) : null
    return trackId ? engine.getTrackTunerAnalyser(trackId) : null
  }, [engine, scope, trackId, auxId])

  const sampleRate = engine?.ctx.sampleRate ?? 48000

  useEffect(() => {
    if (!unit.enabled || !analyser) {
      setPitch(null)
      return
    }

    if (!bufferRef.current || bufferRef.current.length !== analyser.fftSize) {
      bufferRef.current = new Float32Array(analyser.fftSize)
    }

    let running = true
    const loop = () => {
      if (!running) return
      const buf = bufferRef.current
      if (buf) {
        analyser.getFloatTimeDomainData(buf)
        const detected = detectPitch(buf, sampleRate, unit.params.tunerRef)
        setPitch(detected)
      }
      animRef.current = requestAnimationFrame(loop)
    }

    animRef.current = requestAnimationFrame(loop)

    return () => {
      running = false
      if (animRef.current !== null) {
        cancelAnimationFrame(animRef.current)
        animRef.current = null
      }
    }
  }, [analyser, sampleRate, unit.enabled, unit.params.tunerRef])

  const cents = pitch ? Math.max(-50, Math.min(50, pitch.cents)) : 0
  const needlePercent = 50 + (cents / 50) * 45 // 5% to 95%
  const isMuted = Boolean(unit.params.tunerMute)

  return (
    <div className="tuner-display">
      <div className="tuner-screen">
        <div className="tuner-note-row">
          <div className="tuner-note-box">
            <span className={`tuner-note ${pitch?.inTune ? 'in-tune' : ''}`}>
              {pitch?.note ?? '—'}
            </span>
            {pitch ? <span className="tuner-octave">{pitch.octave}</span> : null}
          </div>
          <div className="tuner-freq-box">
            <span className="tuner-freq">
              {pitch ? `${pitch.frequency.toFixed(1)} Hz` : 'Toque uma nota…'}
            </span>
            <span className={`tuner-badge ${pitch?.inTune ? 'tuned' : pitch ? 'tuning' : 'idle'}`}>
              {pitch?.inTune
                ? '✔ AFINADO'
                : pitch
                  ? pitch.cents < 0
                    ? `◀ ${Math.abs(pitch.cents)}¢ GRAVE`
                    : `AGUDO +${pitch.cents}¢ ▶`
                  : 'AGUARDANDO'}
            </span>
          </div>
        </div>

        {/* Cents Needle Meter */}
        <div className="tuner-meter">
          <div className="tuner-scale">
            <span>-50</span>
            <span>-25</span>
            <span className="center-mark">▼ 0</span>
            <span>+25</span>
            <span>+50</span>
          </div>
          <div className="tuner-gauge-track">
            <div className="tuner-center-zone" />
            <div
              className={`tuner-needle ${pitch?.inTune ? 'tuned' : pitch ? 'active' : ''}`}
              style={{ left: `${needlePercent}%` }}
            />
          </div>
          <div className="tuner-cents-text">
            {pitch ? `${pitch.cents > 0 ? '+' : ''}${pitch.cents} cents` : '±0¢'}
          </div>
        </div>
      </div>

      {/* Tuner Controls: Mute Toggle + Calib Knob */}
      <div className="tuner-controls">
        <button
          type="button"
          className={`mini-btn tuner-mute-btn ${isMuted ? 'muted' : ''}`}
          title="Silencia o áudio enquanto afina (como pedal Boss TU-2)"
          onClick={() => onParamChange('tunerMute', isMuted ? 0 : 1)}
        >
          {isMuted ? '🔇 MUDO (AFINANDO)' : '🔊 THRU (ÁUDIO ABERTO)'}
        </button>

        <div className="tuner-knob-box">
          <Knob
            label="REF A4"
            size={36}
            value={unit.params.tunerRef}
            min={430}
            max={450}
            step={0.5}
            display={`${unit.params.tunerRef.toFixed(1)} Hz`}
            accent="#10b981"
            onInput={(next) => onParamChange('tunerRef', next)}
          />
        </div>
      </div>
    </div>
  )
}
