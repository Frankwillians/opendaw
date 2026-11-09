import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'

/** Snap a value to the nearest step inside `min`..`max`, keeping the step's decimals. */
export function clampToStep(value: number, min: number, max: number, step: number): number {
  const snapped = Math.round((value - min) / step) * step + min
  const text = String(step)
  const decimals = text.includes('.') ? text.split('.')[1].length : 0
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals))
}

interface KnobProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  accent?: string
  /** SVG edge in px; smaller sizes are used in the mixer strips. */
  size?: number
  /** Optional tooltip override; defaults to a label + hint string. */
  title?: string
  onInput: (next: number) => void
}

// Rotary control in the spirit of AmpliTube/Gearbox: drag up/down (Shift for
// fine), mouse wheel for one step, value always visible under the label.
export default function Knob({
  label,
  value,
  min,
  max,
  step,
  display,
  accent = '#6fcf97',
  size = 56,
  title,
  onInput,
}: KnobProps) {
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null)
  const ratio = max > min ? (value - min) / (max - min) : 0
  const angle = -135 + ratio * 270

  const point = (deg: number, radius: number) => {
    const rad = (deg * Math.PI) / 180
    return [28 + radius * Math.sin(rad), 28 - radius * Math.cos(rad)] as const
  }
  const arc = (from: number, to: number, radius: number) => {
    const [x1, y1] = point(from, radius)
    const [x2, y2] = point(to, radius)
    const large = Math.abs(to - from) > 180 ? 1 : 0
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
  }
  const [px, py] = point(angle, 13)
  const [qx, qy] = point(angle, 6)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
    dragRef.current = { startY: event.clientY, startValue: value }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const scale = (max - min) / 160
    const delta = (drag.startY - event.clientY) * scale * (event.shiftKey ? 0.15 : 1)
    onInput(clampToStep(drag.startValue + delta, min, max, step))
  }
  const endDrag = () => {
    dragRef.current = null
  }
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const dir = event.deltaY < 0 ? 1 : -1
    onInput(clampToStep(value + dir * step, min, max, step))
  }

  return (
    <div
      className={`knob ${size < 56 ? 'knob-compact' : ''}`}
      title={title ?? `${label}: ${display} — arraste para ajustar, Shift = fino, scroll = 1 passo`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={onWheel}
    >
      <svg width={size} height={size} viewBox="0 0 56 56" aria-hidden="true">
        <path d={arc(-135, 135, 20)} className="knob-track" />
        {ratio > 0.003 ? <path d={arc(-135, angle, 20)} stroke={accent} className="knob-arc" /> : null}
        <circle cx="28" cy="28" r="15" className="knob-cap" />
        <line x1={qx} y1={qy} x2={px} y2={py} stroke={accent} className="knob-pointer" />
      </svg>
      <span className="knob-label">{label}</span>
      <span className="knob-value">{display}</span>
    </div>
  )
}
