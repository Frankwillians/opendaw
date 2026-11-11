/**
 * The lane's native plugin chain, in the desktop executable.
 *
 * REAPER's FX window is a list: one row per effect, a power button on the left,
 * the name in the middle, and the selected one's knobs and window below. That
 * shape is what a producer reads a signal path in — the order of the rows *is*
 * the order the audio meets the plugins, so a drive above an amp is a different
 * sound than the amp above the drive, and nothing here hides that behind a
 * dropdown.
 *
 * A lane can hold as many of them as the producer wants. Every row is a slot
 * with its own id, and that id is what the live sessions and the saved project
 * hang on: rows move up and down, get bypassed, get their knobs turned, and the
 * session the plugin process is holding has to follow the row rather than the
 * position it happened to sit in when it opened.
 *
 * Two paths run through the chain, and they are said apart because they are
 * genuinely apart:
 *
 * · Live (input monitoring): every .dll row gets its own session in the plugin
 *   process and the lane's input crosses them in a row, one batch at a time.
 *   A .vst3 has no live session in this host, so the row says so instead of
 *   pretending the chain is silent for a reason nobody can see.
 * · Clip (playback, export, bounce): the clip goes through the whole chain in
 *   order, one plugin at a time in the plugin process, and the result is what
 *   plays and what the WAV carries.
 *
 * The plugin windows belong here too, one per row rather than one per panel: a
 * producer dialing a drive, an amp and a cab against each other needs all three
 * faces on the screen at once, and the row that holds the file is the thing that
 * holds its window. The faces are drawn in the FX window beside this column.
 */
import { useEffect, useRef, useState } from 'react'

import NativeVstFaces, { faceKeyOf, useNativeFaces, NativeVstFaceStage } from './NativeVstFaces'
import NativeVstInsert, { type NativeLiveRow, type NativePreviewStatus, type NativeVstSlot } from './NativeVstInsert'

interface Props {
  trackName: string
  /** The lane's plugins, in signal order. */
  chain: NativeVstSlot[]
  sampleRate: number
  /** Whether the lane has a clip at all — without one there is nothing to process. */
  hasClip: boolean
  busy: boolean
  /** The chain's preview: the pass the engine holds for this lane, or null. */
  preview: NativePreviewStatus | null
  /** Per-slot live state, by slot id. */
  liveStates?: Record<string, NativeLiveRow>
  onChange: (next: NativeVstSlot[]) => void
  onBounce: () => void
  /** Ask for the pass again, after a plugin refused or faulted. */
  onPreviewRetry: () => void
}

/** A row that has somehow lost its id: a saved project from before the chain. */
const isIdentified = (slot: NativeVstSlot): boolean => typeof slot.id === 'string' && slot.id.length > 0

let idCounter = 0
const newSlotId = (): string => {
  idCounter += 1
  return `nvs-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

/** VST2 is a file, VST3 a bundle; the row says which, because only one runs live. */
const slotKind = (path: string): string => (/\.vst3([\\/]|$)/i.test(path) ? 'VST3' : 'VST2')

const activeCount = (chain: NativeVstSlot[]): number => chain.filter((slot) => !slot.bypass).length

export default function NativeVstChain({
  trackName,
  chain,
  sampleRate,
  hasClip,
  busy,
  preview,
  liveStates = {},
  onChange,
  onBounce,
  onPreviewRetry,
}: Props): React.JSX.Element {
  /**
   * Which row the panel below is showing. Held here rather than in the row's own
   * state because adding, removing and reordering rows all have an opinion about
   * it: a producer who clicks "+ Plugin" wants the picker, and one who removes
   * the row they were editing wants the neighbour, not a panel of nothing.
   */
  const [selected, setSelected] = useState<string | null>(chain[0]?.id ?? null)
  const [adding, setAdding] = useState(chain.length === 0)

  // Rows appear and go away from outside this component too — a project loading,
  // an undo step — so the selection follows the chain instead of pointing at a
  // row that is no longer there. The "+ Plugin" picker is the exception it has
  // to respect: no row is selected *because* the panel below is adding one, and
  // a reconciliation that grabs the first row back would put the picker away
  // again the moment the producer pressed it.
  useEffect(() => {
    if (chain.length === 0) {
      if (selected !== null) setSelected(null)
      if (!adding) setAdding(true)
      return
    }
    if (adding) return
    if (selected && chain.some((slot) => slot.id === selected)) return
    setSelected(chain[0].id ?? null)
  }, [chain, selected, adding])

  // A saved chain from before slot ids existed gets them here, once: the row the
  // live session belongs to has to be the row, not the position.
  useEffect(() => {
    if (!chain.some((slot) => !isIdentified(slot))) return
    onChange(chain.map((slot) => (isIdentified(slot) ? slot : { ...slot, id: newSlotId() })))
  }, [chain, onChange])

  const current = chain.find((slot) => slot.id === selected) ?? null
  const position = current ? chain.findIndex((slot) => slot.id === current.id) + 1 : 0

  /**
   * The plugin windows of this lane, held by the chain rather than by the panel:
   * the panel shows one row at a time, and the interfaces stay up whatever the
   * producer is looking at.
   */
  const {
    faces,
    close: closeFace,
    toggle: toggleFace,
    toggleEmbedded,
    errorOf,
    report,
    refuse,
  } = useNativeFaces()

  /**
   * The FX window this chain is drawn in — the element the faces are portalled
   * into, because a plugin's interface needs the room beside the column and not a
   * box between knobs. Found from the DOM rather than passed down: the chain is
   * rendered by that window, and this is the one place the split is measured.
   */
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHost(rootRef.current?.closest('.fx-window') ?? null)
  }, [])

  // A face outlives its row only as long as it takes this effect to notice: a row
  // that was removed, or one whose plugin was swapped for another file, has to
  // take its window with it. That window is the plugin process holding this row's
  // instance, and leaving it up would be an amp face still dialling settings for
  // a lane that no longer has that amp.
  useEffect(() => {
    for (const face of faces) {
      const slot = chain.find((item) => faceKeyOf(item) === face.key)
      if (!slot || slot.path !== face.path) closeFace(face.key)
    }
  }, [chain, faces, closeFace])

  const swap = (index: number, delta: number): void => {
    const target = index + delta
    if (index < 0 || target < 0 || target >= chain.length) return
    const next = [...chain]
    const moved = next.splice(index, 1)[0]
    next.splice(target, 0, moved)
    onChange(next)
  }

  const remove = (slotId: string): void => {
    const index = chain.findIndex((slot) => slot.id === slotId)
    onChange(chain.filter((slot) => slot.id !== slotId))
    if (selected === slotId) {
      const neighbour = chain[index + 1] ?? chain[index - 1] ?? null
      setSelected(neighbour?.id ?? null)
      if (!neighbour) setAdding(true)
    }
  }

  const toggleBypass = (slotId: string): void => {
    onChange(chain.map((slot) => (slot.id === slotId ? { ...slot, bypass: !slot.bypass } : slot)))
  }

  /**
   * The picker answers for one row: the row it replaces when one is selected, a
   * new row at the end when the producer pressed "+ Plugin". Null from the panel
   * means "this row is finished with".
   */
  const applySlot = (next: NativeVstSlot | null): void => {
    if (!next) {
      if (current) remove(current.id ?? '')
      else setAdding(false)
      return
    }
    if (current) {
      onChange(chain.map((slot) => (slot.id === current.id ? { ...next, id: slot.id } : slot)))
      return
    }
    const id = next.id && isIdentified(next) ? next.id : newSlotId()
    onChange([...chain, { ...next, id }])
    setSelected(id)
    setAdding(false)
  }

  const shown = adding ? null : current
  const live = shown?.id ? liveStates[shown.id] ?? null : null
  const liveRows = chain.filter((slot) => slot.id && liveStates[slot.id])
  const offLine = chain.filter((slot) => !slot.bypass && slotKind(slot.path) === 'VST3').length
  const shownFace = shown ? faces.find((face) => face.key === faceKeyOf(shown)) ?? null : null

  return (
    <div className="native-vst-chain" ref={rootRef}>
      <div className="fx-section-title">
        <span>
          Plugins nativos{' '}
          <span className="fx-section-hint">
            {chain.length === 0
              ? '— nenhum na lane'
              : `— ${chain.length} em série, ${activeCount(chain)} tocando`}
          </span>
        </span>
        <button
          type="button"
          className={`mini-btn${adding ? ' active' : ''}`}
          title="Escolher mais um plugin para o fim da cadeia"
          onClick={() => {
            setAdding(true)
            setSelected(null)
          }}
        >
          + Plugin
        </button>
      </div>

      {chain.length === 0 ? null : (
        <div className="native-vst-rows">
          {chain.map((slot, index) => {
            const rowLive = slot.id ? liveStates[slot.id] ?? null : null
            const kind = slotKind(slot.path)
            const face = faces.find((face) => face.key === faceKeyOf(slot))
            const faceUp = !!face
            const isEmbedded = face?.embedded ?? false
            return (
              <div
                className={`native-vst-row${slot.id === selected && !adding ? ' selected' : ''}${slot.bypass ? ' bypassed' : ''}`}
                key={slot.id ?? `${slot.path}-${index}`}
                data-slot-id={slot.id ?? ''}
                data-slot-path={slot.path}
                data-face-open={faceUp ? '1' : '0'}
              >
                <button
                  type="button"
                  className={`mini-btn power${slot.bypass ? '' : ' active'}`}
                  title={slot.bypass ? 'Ligar este plugin de novo' : 'Bypass: este plugin sai do caminho do áudio'}
                  onClick={() => toggleBypass(slot.id ?? '')}
                >
                  ⏻
                </button>
                <button
                  type="button"
                  className="native-vst-row-name"
                  title={`${slot.path}\n${kind} · posição ${index + 1} de ${chain.length}`}
                  onClick={() => {
                    setSelected(slot.id ?? null)
                    setAdding(false)
                  }}
                >
                  <span className="native-vst-row-index">{index + 1}</span>
                  <span className="native-vst-row-label">{(slot.name || slot.path).slice(0, 40)}</span>
                  <span className="native-vst-row-kind">{kind}</span>
                  {rowLive && !rowLive.error ? (
                    <span className="native-vst-row-live on" title="Ao vivo: a entrada passa por este plugin">
                      ●
                    </span>
                  ) : rowLive?.error ? (
                    <span className="native-vst-row-live off" title={`Seco: ${rowLive.error}`}>
                      ○
                    </span>
                  ) : (
                    <span
                      className="native-vst-row-live idle"
                      title={kind === 'VST3' ? 'Este tipo só entra no passe do clipe' : 'Sem sessão ao vivo ainda'}
                    >
                      ·
                    </span>
                  )}
                </button>
                {/* The row's own window, from the row: a chain of three plugins is
                    read by ear with three faces on the screen, and a producer who
                    has to select each row to open it would be dialling one at a
                    time. Lit when this row has a window up. */}
                <button
                  type="button"
                  className={`mini-btn native-vst-row-gui${isEmbedded ? ' embedded' : faceUp ? ' active' : ''}`}
                  title={
                    isEmbedded
                      ? 'Abrir a interface deste plugin na janela ao lado (maior)'
                      : faceUp
                      ? 'Fechar a interface deste plugin'
                      : 'Abrir a interface deste plugin pequena no cartão'
                  }
                  data-face-slot={slot.id ?? ''}
                  onClick={() => toggleEmbedded(slot)}
                >
                  {isEmbedded ? 'UI⌂' : 'UI'}
                </button>
                <span className="native-vst-row-move">
                  <button
                    type="button"
                    className="mini-btn"
                    title="Mover para antes do anterior"
                    disabled={index === 0}
                    onClick={() => swap(index, -1)}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    className="mini-btn"
                    title="Mover para depois do próximo"
                    disabled={index === chain.length - 1}
                    onClick={() => swap(index, +1)}
                  >
                    ▼
                  </button>
                </span>
                <button
                  type="button"
                  className="mini-btn danger"
                  title="Tirar este plugin da cadeia"
                  onClick={() => remove(slot.id ?? '')}
                >
                  ✕
                </button>
                {/* Embedded VST UI — shown when the user clicks UI to open small in the card */}
                {isEmbedded && face && (
                  <div className="native-vst-embedded">
                    <NativeVstFaceStage
                      face={face}
                      sampleRate={sampleRate}
                      onClose={() => toggleEmbedded(slot)}
                      report={report}
                      refuse={refuse}
                      embedded={true}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {chain.length > 1 ? (
        <div className="native-vst-order-hint">
          O áudio atravessa a cadeia de cima para baixo. {offLine > 0 ? `${offLine} .vst3 só entra no passe do clipe.` : ''}
          {liveRows.length > 1
            ? ` ${liveRows.length} sessões ao vivo em série: a latência é a soma delas.`
            : ''}
        </div>
      ) : null}

      {/* Every open interface of this lane, in the FX window's own right pane.
          The stack is a sibling of the chain column rather than a card in it:
          REAPER hands a plugin the rest of the screen because an amp face drawn
          between knobs is unreadable, and here there may be several of them. */}
      <NativeVstFaces
        faces={faces.filter((face) => !face.embedded)}
        host={host}
        sampleRate={sampleRate}
        onClose={closeFace}
        report={report}
        refuse={refuse}
      />

      <NativeVstInsert
        trackName={trackName}
        slot={shown}
        sampleRate={sampleRate}
        onChange={applySlot}
        liveState={live}
        faceOpen={shownFace?.phase === 'open'}
        facePending={shownFace?.phase === 'pending'}
        faceError={shown ? errorOf(faceKeyOf(shown)) : ''}
        faceSize={
          shownFace && shownFace.phase === 'open' && shownFace.width > 0
            ? `${shownFace.width}×${shownFace.height}`
            : ''
        }
        pluginValues={shownFace?.values ?? []}
        onPluginValues={
          shown
            ? (values) => report(faceKeyOf(shown), { values })
            : undefined
        }
        onToggleFace={shown ? () => toggleFace(shown) : undefined}
        chainHint={
          shown && chain.length > 1
            ? `slot ${position} de ${chain.length} · processa o clipe e a entrada, em série`
            : shown
              ? 'motor próprio, processa o clipe'
              : 'novo plugin: entra no fim da cadeia'
        }
      />

      {activeCount(chain) === 0 ? null : (
        // The one line that says whether the chain's sound is actually in the
        // lane: not a claim about the graph, but the peak of the pass the engine
        // is playing and writing to the export.
        <div className={`native-vst-preview ${preview?.state ?? 'idle'}`}>
          <span className="preview-state">
            {preview?.state === 'busy'
              ? `Pré-escuta: passando o clipe pelos ${activeCount(chain)} plugin(s)…`
              : preview?.state === 'on'
                ? `Pré-escuta ativa · pico ${(preview.peak ?? 0).toFixed(3)} — é este áudio que toca e que vai para o WAV`
                : preview?.state === 'error'
                  ? `A pré-escuta não veio: ${preview.error}`
                  : hasClip
                    ? 'Pré-escuta: preparando o passe da cadeia…'
                    : 'Pré-escuta: a lane ainda não tem clipe para a cadeia atravessar'}
          </span>
          {preview?.state === 'error' ? (
            <button
              type="button"
              className="mini-btn"
              onClick={onPreviewRetry}
              title="Passa o clipe pela cadeia de novo"
            >
              ↻ tentar de novo
            </button>
          ) : null}
        </div>
      )}

      <div className="native-vst-actions">
        <button
          type="button"
          className="reaper-btn highlight"
          onClick={onBounce}
          disabled={busy || !hasClip || activeCount(chain) === 0}
          title={
            !hasClip
              ? 'A lane precisa de um clipe'
              : activeCount(chain) === 0
                ? 'Nenhum plugin ligado na cadeia'
                : `Passa o clipe pelos ${activeCount(chain)} plugin(s), um depois do outro, e cria um novo take`
          }
        >
          {busy ? 'Processando…' : 'Aplicar a cadeia ao clipe (bounce)'}
        </button>
      </div>
    </div>
  )
}
