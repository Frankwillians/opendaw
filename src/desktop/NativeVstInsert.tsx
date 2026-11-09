/**
 * The native plugin slot of one track.
 *
 * A Windows .dll or .vst3 answers to the native engine, not to Web Audio, so
 * this slot says which of the two paths the plugin is on rather than pretending.
 * A .dll is also bridged into the live lane (see native-live.ts): with the
 * monitor lit, the input crosses to the plugin's process a batch at a time and
 * comes back for the headphones. The clip path is the other one: the lane's
 * audio is worked on in the plugin's own process and the result is what the lane
 * plays and what the export writes — a preview pass held in the engine, so the
 * recorded file, its waveform, its trim and its undo stay exactly as they were.
 * Committing the pass for good is the bounce: the processed audio becomes the
 * clip and the dry take goes to the shelf. That is honest work, and it is the
 * same thing a hardware re-amp does.
 *
 * Both plugin generations are listed here. A VST2 is a .dll; a VST3 is a folder
 * whose real name is written inside it, so the picker reads that first and the
 * engine's own description corrects it as soon as the slot is opened.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import { pluginApi, type NativeParameter, type NativePluginEntry } from './native'

export interface NativeVstSlot {
  /**
   * Which slot this is, for as long as it stays in the lane: the chain reorders,
   * bypasses and re-knobs these rows, and a live session has to belong to one of
   * them rather than to a position that moves under it. Two copies of the same
   * .dll are two slots with two ids, the way REAPER counts them.
   */
  id?: string
  /** Full path of the .dll or of the .vst3 bundle on this machine. */
  path: string
  /** Name read from the plugin, for the clip label and the header. */
  name: string
  /** 0..1 values. `index` is a VST2 slot number or a VST3 parameter id. */
  params: { index: number; value: number }[]
  /** Switched off: the slot stays with its values but does not touch the clip. */
  bypass?: boolean
}

/**
 * What the app reports about one lane's preview — the pass the plugin process
 * rendered from the clip, which is what plays and what the export writes while it
 * stands in the lane. `error` is the plugin's own answer, kept so the producer
 * can read it and try again instead of wondering why the lane is dry.
 */
export interface NativePreviewStatus {
  state: 'busy' | 'on' | 'error'
  name: string
  peak: number
  error: string
}

/**
 * What the app knows about one slot's live session, in the lane's live signal.
 * Named because the chain lists it per row: the lane's monitor hears the whole
 * chain, and each plugin answers for itself.
 */
export interface NativeLiveRow {
  name: string
  latencyMs: number
  batches: number
  answered: number
  underruns: number
  error: string
}

interface Props {
  trackName: string
  slot: NativeVstSlot | null
  /** The project rate: a plugin is asked to describe itself at the rate it will run at. */
  sampleRate: number
  /**
   * Replace, edit or clear this slot. Null is the lane letting go of it; the
   * chain decides whether that means removing a row.
   */
  onChange: (next: NativeVstSlot | null) => void
  /**
   * What the lane's live session is doing, or null when the plugin is not in the
   * live signal at all — no clip lane, the monitor off, a bypassed slot, or a
   * .vst3, which this host has no session for yet.
   */
  liveState?: NativeLiveRow | null
  /**
   * Whether this block is one row of a longer chain, and which row. The picker,
   * the knobs and the plugin's window are the same work either way; what the
   * producer must never lose is the sense of where in the series they are.
   */
  chainHint?: string
  /**
   * This row's plugin window, held by the chain: a lane can have several faces up
   * at once, and the window belongs to the row rather than to whichever row this
   * panel happens to be editing.
   */
  faceOpen?: boolean
  /** True while the plugin is still building its toolkit. */
  facePending?: boolean
  /** The plugin's own refusal, when the last press did not end in a window. */
  faceError?: string
  /** `{width}×{height}` of the open window, or '' before the plugin answers. */
  faceSize?: string
  /** Values the plugin moved inside its own window, for these sliders to follow. */
  pluginValues?: { id: number; value: number }[]
  /** Tell the chain what the plugin answered about its own values. */
  onPluginValues?: (values: { id: number; value: number }[]) => void
  /** Open this row's interface, or put it away if it is up. */
  onToggleFace?: () => void
}

const isUsable = (entry: NativePluginEntry): boolean =>
  !entry.error && (entry.kind === 'vst2' || entry.kind === 'vst3')

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** One empty list for every render that has no plugin open. */
const NO_PARAMS: NativeParameter[] = []

/** The name a producer recognises, not the file name and not the export symbol. */
function entryName(entry: NativePluginEntry): string {
  // The scan already resolved the name the way a host would — the bundle's own
  // description, its first class, or the file — so that answer comes first and
  // this only fills the gap for a list built before the naming existed.
  if (entry.label) return entry.label.slice(0, 48)
  const klass =
    entry.meta?.classes?.find((item) => /^Audio/i.test(item.category ?? '')) ?? entry.meta?.classes?.[0]
  const fromMeta = String(klass?.name ?? entry.meta?.module ?? '').trim()
  if (fromMeta) return fromMeta.slice(0, 48)
  return fileName(entry.path).replace(/\.(vst3|dll|vst)$/i, '').slice(0, 48)
}

function entryVendor(entry: NativePluginEntry): string {
  const info = entry.meta?.info as { vendor?: string } | undefined
  return String(entry.meta?.vendor ?? info?.vendor ?? '').trim().slice(0, 24)
}

export default function NativeVstInsert({
  trackName,
  slot,
  sampleRate,
  onChange,
  liveState = null,
  chainHint = '',
  faceOpen = false,
  facePending = false,
  faceError = '',
  faceSize = '',
  pluginValues = [],
  onPluginValues,
  onToggleFace,
}: Props): React.JSX.Element {
  // Pinned once: the bridge object is stable, but reading it every render would
  // put a new value in the effect's dependency list and restart the disk scan.
  const [api] = useState(() => pluginApi())
  const [entries, setEntries] = useState<NativePluginEntry[] | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  /**
   * The engine's answer, kept with the path it belongs to. Reading it back means
   * one state update when the description arrives — no reset in the effect body,
   * and a stale answer about a plugin that is no longer in the slot simply does
   * not match `slot.path` and is ignored.
   */
  const [described, setDescribed] = useState<{
    path: string
    /** The plugin's own name, or '' when it did not answer at all. */
    name: string
    params: NativeParameter[]
    /** Whether the engine saw an editor to open (effFlagsHasEditor / IEditController). */
    hasEditor: boolean
    kind: string
  } | null>(null)
  // Which plugin the current correction belongs to: the rename below re-runs the
  // describe effect through `slot`, so the fix is applied once per path.
  const namedFor = useRef('')

  useEffect(() => {
    if (!api) return
    let live = true
    void api
      .scan()
      .then((result) => {
        if (!live) return
        if (!result.ok) setScanError(result.error ?? 'a varridura falhou')
        else setEntries((result.plugins ?? []).filter(isUsable))
      })
      .catch((error: Error) => {
        if (live) setScanError(error.message)
      })
    return () => {
      live = false
    }
  }, [api])

  const path = slot?.path ?? ''

  // The parameter names come from the plugin itself, so opening the slot means
  // asking it — at the project's rate, because a plugin fixes its block size and
  // its latency when it is configured and would report something else cold. The
  // dependency is the path, not the slot object: moving a knob rewrites the slot
  // and must not make the engine load the plugin all over again.
  useEffect(() => {
    if (!api || !path) return
    let live = true
    void api
      .describe(path, sampleRate)
      .then((result) => {
        if (!live) return
        const name = String(result.info?.name ?? '').trim().slice(0, 48)
        setDescribed({
          path,
          name: result.ok ? name : '',
          params: result.info?.params ?? [],
          hasEditor: result.info?.hasEditor === true,
          kind: String(result.info?.kind ?? ''),
        })
      })
      .catch(() => {
        if (live) setDescribed({ path, name: '', params: [], hasEditor: false, kind: '' })
      })
    return () => {
      live = false
    }
  }, [api, path, sampleRate])

  const answer = described?.path === path ? described : null
  // The shared empty list, so `params` keeps one identity while nothing is open
  // and the memo below does not re-run on every render.
  const params = answer ? answer.params : NO_PARAMS

  // The name in the dropdown is a guess from the bundle; the engine's answer is
  // the truth, and it is what the clip label should carry.
  useEffect(() => {
    const name = answer?.name ?? ''
    if (!slot || !name || name === slot.name) return
    if (namedFor.current === slot.path) return
    namedFor.current = slot.path
    onChange({ ...slot, name })
  }, [slot, answer, onChange])

  const listed = useMemo(() => {
    const all = entries ?? []
    const needle = search.trim().toLowerCase()
    if (!needle) return all
    return all.filter((entry) =>
      `${entryName(entry)} ${entryVendor(entry)} ${fileName(entry.path)} ${entry.kind}`
        .toLowerCase()
        .includes(needle),
    )
  }, [entries, search])

  const groups = useMemo(() => {
    const vst3 = listed.filter((entry) => entry.kind === 'vst3')
    const vst2 = listed.filter((entry) => entry.kind === 'vst2')
    return [
      { kind: 'VST3', entries: vst3 },
      { kind: 'VST2', entries: vst2 },
    ].filter((group) => group.entries.length > 0)
  }, [listed])

  // A plugin with two thousand knobs is not served by a wall of sliders: the
  // producer names the one they want. Without a search the first pages are shown.
  const [paramNeedle, setParamNeedle] = useState('')
  const visibleParams = useMemo(() => {
    const needle = paramNeedle.trim().toLowerCase()
    const filtered = needle
      ? params.filter((parameter) =>
          `${parameter.name} ${parameter.label} ${parameter.display} ${parameter.index}`
            .toLowerCase()
            .includes(needle),
        )
      : params
    return filtered.slice(0, needle ? 40 : 24)
  }, [params, paramNeedle])

  // Panel → plugin: a value set here has to be the value the plugin works with,
  // not only the value written on the slot. A bounce sends them anyway, but the
  // plugin's own window does not bounce — it shows what it is holding — so it is
  // told. Debounced, because a drag is sixty moves a second and the plugin only
  // cares about the one the slider lands on, and sent only after the engine has
  // described the plugin, since a value pushed before the plugin is configured
  // is a value the plugin overwrites when it configures itself.
  const pushed = useRef('')
  const pushTimer = useRef(0)
  useEffect(() => {
    if (!api?.setParams || !slot || answer === null || slot.params.length === 0) return
    const signature = `${slot.path}|${slot.params.map((item) => `${item.index}:${item.value}`).join(',')}`
    if (pushed.current === signature) return
    window.clearTimeout(pushTimer.current)
    pushTimer.current = window.setTimeout(() => {
      pushed.current = signature
      void api
        .setParams?.({ path: slot.path, params: slot.params, sampleRate })
        .then((result) => {
          // The plugin's own answer about its values, handed to the chain: with a
          // window up the face reads them continuously, but a preset loaded from
          // here moves knobs too, and the sliders must not disagree with it.
          if (result.ok) onPluginValues?.(result.reported ?? [])
        })
        .catch(() => {})
    }, 150)
    return () => {
      window.clearTimeout(pushTimer.current)
    }
  }, [api, slot, answer, sampleRate, onPluginValues])

  const pick = (path: string): void => {
    if (!path) {
      onChange(null)
      return
    }
    const entry = (entries ?? []).find((item) => item.path === path)
    onChange({ path, name: entry ? entryName(entry) : fileName(path), params: [] })
  }

  const setParam = (index: number, value: number): void => {
    if (!slot) return
    const rest = slot.params.filter((item) => item.index !== index)
    onChange({ ...slot, params: [...rest, { index, value }] })
  }

  /**
   * Read the folders again — after an install, or after a folder was added. The
   * plugin already in the slot is not touched: the list changes, the sound does
   * not.
   */
  const rescan = (): void => {
    if (!api) return
    setScanError(null)
    void api
      .scan()
      .then((result) => {
        if (!result.ok) setScanError(result.error ?? 'a varridura falhou')
        else setEntries((result.plugins ?? []).filter(isUsable))
      })
      .catch((error: Error) => setScanError(error.message))
  }

  const addFolder = (): void => {
    if (!api?.addDir) return
    void api
      .addDir()
      .then((result) => {
        if (!result.canceled && !result.error) rescan()
      })
      .catch(() => {})
  }

  if (api === null) return <></>

  const total = (entries ?? []).length

  /**
   * This row's plugin window is up, or one frame from being up. While it is, the
   * producer is looking at the interface the manufacturer drew — every knob they
   * needs is in there — so OpenDAW's own copies of those knobs step out of the way.
   * This is the shape REAPER's FX window has: the chain column keeps the identity
   * and the actions, the plugin takes the rest of the screen.
   */
  const ownUi = faceOpen || facePending

  /**
   * Whether the engine said there is no editor in this file. Unknown until the
   * description arrives, and unknown is not "no": a plugin that does have an
   * interface must not be gated off by an answer that has not come yet.
   */
  const noInterface = answer !== null && answer.hasEditor === false

  return (
    <div className={`native-vst${slot?.bypass ? ' bypassed' : ''}`}>
      <div className="fx-section-title">
        <span>
          Plugin nativo{' '}
          <span className="fx-section-hint">
            {chainHint
              ? chainHint
              : '(motor próprio, processa o clipe)'}
            {total > 0 ? ` — ${total} encontrado${total > 1 ? 's' : ''}` : ''}
          </span>
        </span>
        {slot ? (
          <button
            type="button"
            className={`mini-btn${slot.bypass ? '' : ' active'}`}
            title={slot.bypass ? 'Ligar o plugin de novo' : 'Bypass: o clipe passa sem o plugin'}
            onClick={() => onChange({ ...slot, bypass: !slot.bypass })}
          >
            ⏻
          </button>
        ) : null}
      </div>

      {/* While the plugin's own window is up, OpenDAW's picker, its search, its
          folder buttons and its copies of the plugin's knobs are put away: the
          producer is looking at the real interface, and a second set of sliders
          for the same parameters is how two answers get shown for one knob. */}
      {ownUi ? null : (
        <div className="fx-param">
          <label htmlFor={`native-plugin-${trackName}`}>Plugin:</label>
          <select
            id={`native-plugin-${trackName}`}
            className="reaper-input"
            value={slot?.path ?? ''}
            onChange={(event) => pick(event.target.value)}
          >
            <option value="">{entries === null ? 'lendo as pastas de plugin…' : '— nenhum —'}</option>
            {groups.map((group) => (
              <optgroup key={group.kind} label={`${group.kind} (${group.entries.length})`}>
                {group.entries.map((entry) => {
                  const vendor = entryVendor(entry)
                  return (
                    <option value={entry.path} key={entry.path}>
                      {entryName(entry)}
                      {vendor ? ` — ${vendor}` : ''}
                    </option>
                  )
                })}
              </optgroup>
            ))}
          </select>
          {slot ? (
            <button
              type="button"
              className="mini-btn danger"
              title="Tirar o plugin da lane"
              // The row's window goes with the row: the chain watches which rows
              // still exist and puts away any face left without one.
              onClick={() => onChange(null)}
            >
              ✕
            </button>
          ) : null}
        </div>
      )}

      {!ownUi && total > 8 ? (
        <div className="fx-param">
          <label htmlFor={`native-search-${trackName}`}>Buscar:</label>
          <input
            id={`native-search-${trackName}`}
            className="reaper-input"
            type="search"
            placeholder="nome, fabricante ou tipo"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      ) : null}

      {ownUi ? null : (
        <>
          {/* Discovery lives next to the list it fills: a plugin installed after
              this window opened, or one that sits outside the usual folders, is a
              click away — not a restart away. */}
          <div className="native-vst-scan">
            <button type="button" className="mini-btn" onClick={rescan}>
              Procurar de novo
            </button>
            {api.addDir ? (
              <button
                type="button"
                className="mini-btn"
                onClick={addFolder}
                title="Uma pasta de plugins que não está nos lugares de costume; vale para as próximas varriduras"
              >
                Adicionar pasta…
              </button>
            ) : null}
            <span className="native-vst-scan-hint">
              {entries === null
                ? 'lendo as pastas de plugin…'
                : total === 0
                  ? 'nada nas pastas procuradas — aponte uma pasta se o plugin estiver fora delas'
                  : `${total} plugin(s) abríve${total === 1 ? 'l' : 'is'} nas pastas do computador`}
            </span>
          </div>

          {scanError ? <div className="plugin-note error">{scanError}</div> : null}
        </>
      )}

      {!ownUi && slot && params.length > 0 ? (
        <>
          {params.length > 12 ? (
            <div className="fx-param">
              <label htmlFor={`native-knob-${trackName}`}>Parâmetro:</label>
              <input
                id={`native-knob-${trackName}`}
                className="reaper-input"
                type="search"
                placeholder={`buscar entre ${params.length} parâmetros`}
                value={paramNeedle}
                onChange={(event) => setParamNeedle(event.target.value)}
              />
            </div>
          ) : null}
          <div className="native-vst-params">
            {visibleParams.map((parameter) => {
              const current = slot.params.find((item) => item.index === parameter.index)?.value
              // A plugin that moved its own knob (a preset, a morph, a GUI drag)
              // says so; the slider follows so the two never disagree.
              const reported = pluginValues.find((item) => item.id === parameter.index)?.value
              const value = current ?? reported ?? parameter.value
              return (
                <div className="fx-param" key={parameter.index}>
                  <label htmlFor={`native-p-${parameter.index}`}>
                    {(parameter.name || `#${parameter.index}`).slice(0, 22)}
                  </label>
                  <input
                    id={`native-p-${parameter.index}`}
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={value}
                    onChange={(event) => setParam(parameter.index, Number(event.target.value))}
                  />
                  <span className="value-badge">
                    {parameter.display
                      ? `${parameter.display}${parameter.label ? ` ${parameter.label}` : ''}`
                      : value.toFixed(2)}
                  </span>
                </div>
              )
            })}
            {visibleParams.length === 0 ? (
              <div className="plugin-note">Nenhum parâmetro com esse nome — a busca usa o nome que o plugin escreveu.</div>
            ) : null}
          </div>
        </>
      ) : null}

      {!ownUi && slot && answer && answer.params.length === 0 ? (
        <div className="plugin-note">
          {answer.name
            ? 'Este plugin não expõe parâmetros ao motor: ele processa com o preset que estiver carregado no próprio arquivo.'
            : `O motor abriu o arquivo mas ele não respondeu — ${slot.name} precisa da instalação da fabricante (licença, runtimes ou o restante do pacote) para funcionar.`}
        </div>
      ) : null}

      {/* The preview line and the bounce belong to the chain, not to a row: the
          pass the lane plays is the whole series of plugins, in order, and one
          plugin's knobs are only one stage of it. */}

      {slot ? (
        // One line, three honest states: the plugin in the ear, the plugin that
        // refused and why, and the plugin waiting for the lane to be listened to.
        // The two counts are written on the row as data, not as text: the block
        // that came back from the plugin process is what tells "the amp is in the
        // monitor" from "the lane fell back to dry", and the desktop selftest has
        // to be able to read that without the producer's line filling with numbers.
        <div
          className={`native-vst-live${liveState && !liveState.error ? ' on' : liveState?.error ? ' off' : ''}`}
          data-live-slot={slot?.id ?? ''}
          data-live-path={slot?.path ?? ''}
          data-live-batches={liveState?.batches ?? 0}
          data-live-answered={liveState?.answered ?? 0}
          data-live-underruns={liveState?.underruns ?? 0}
        >
          {liveState?.error ? (
            <span>
              <strong>seco</strong> · {liveState.error}
            </span>
          ) : liveState ? (
            <span>
              <strong>ao vivo</strong> · {liveState.latencyMs} ms de ida e volta
              {liveState.underruns > 0 ? ` · ${liveState.underruns} bloco(s) sem resposta a tempo` : ''}
            </span>
          ) : (
            <span>
              <strong>seco</strong> · ligue <strong>MON</strong> ou <strong>FX</strong> nesta lane
              para ouvir o plugin na hora
            </span>
          )}
        </div>
      ) : null}

      {/* One row, one window. A lane can hold several interfaces at once, so this
          line is the row's handle on its own: the button opens or puts away the
          window this plugin drew, the size is what that plugin asked for, and a
          refusal belongs to this row alone — another row's window can be up and
          this one can still have failed to build. The face itself is drawn in the
          FX window's stage area, by the chain, not here. */}
      {slot ? (
        <div
          className="native-vst-face-bar"
          data-face-slot={slot.id ?? ''}
          data-face-path={slot.path}
          data-face-open={faceOpen ? '1' : '0'}
          data-face-pending={facePending ? '1' : '0'}
        >
          {/* The engine's answer about an editor is what decides whether the press
              can ever land: a plugin that exposes no interface still processes
              audio, and saying so here is the honest answer. */}
          <button
            type="button"
            className="mini-btn"
            disabled={!onToggleFace || noInterface}
            title={
              noInterface
                ? 'Este plugin não oferece interface própria'
                : faceOpen
                  ? 'Fechar a interface deste plugin'
                  : 'Abrir a interface deste plugin, na janela ao lado'
            }
            onClick={() => onToggleFace?.()}
          >
            {facePending ? 'abrindo…' : faceOpen ? 'Fechar interface' : 'Abrir interface'}
          </button>
          {faceOpen && faceSize ? (
            <span className="native-vst-face-size">{faceSize}</span>
          ) : null}
          {faceError ? <span className="native-vst-face-error">{faceError}</span> : null}
          {!faceOpen && noInterface ? (
            <span className="native-vst-face-error">este plugin não expõe interface ao host</span>
          ) : null}
        </div>
      ) : null}

      <div className="plugin-note">
        O plugin roda no processo nativo do OpenDAW, não no gráfico do navegador. Na entrada ao
        vivo ele está no caminho do microfone: com <strong>MON</strong> ligado — ou com a lane em{' '}
        <strong>FX</strong> — o som passa pela <strong>.dll</strong> a cada bloco e volta para o
        fone, e é esse som que um take molhado grava. O arquivo seco no armazenamento continua
        seco: a forma de onda, o trim e o <strong>Ctrl+Z</strong> são os do take original. No
        playback e no WAV exportado o plugin entra pelo passe renderizado, e{' '}
        <strong>Aplicar ao clipe</strong> grava esse passe de vez, guardando o seco na prateleira
        de takes. Um ajuste feito com a música tocando vale a partir do próximo play. Um{' '}
        <strong>.vst3</strong> ainda só entra no passe do clipe — a sessão em tempo real deste
        host é de <strong>.dll</strong>.
      </div>
    </div>
  )
}
