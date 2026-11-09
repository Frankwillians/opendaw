/**
 * The process that actually touches plugins.
 *
 * A bad .dll can fault, and a fault inside the app's own process would take the
 * session down with it. So every plugin call happens here, in a child process:
 * if it dies, the parent notices, answers the pending request with an error and
 * starts a fresh worker. The DAW never loses the take because a plugin crashed.
 *
 * Runs under Electron's utilityProcess (process.parentPort) and, for tests,
 * under plain Node fork (process.send).
 */
const { Vst2Plugin } = require('./vst2.cjs')
const { Vst3Plugin, isVst3Bundle } = require('./vst3.cjs')
const { scan, addExtraDir } = require('./scan.cjs')
const gui = require('./plugin-gui.cjs')
const wav = require('./wav.cjs')

const out = typeof process.parentPort?.postMessage === 'function'
  ? { send: (message) => process.parentPort.postMessage(message) }
  : { send: (message) => { process.send?.(message) } }

if (process.parentPort?.on) {
  process.parentPort.on('message', (event) => { handle(event.data) })
} else {
  process.on('message', handle)
}

function reply(request, payload) {
  out.send({ id: request?.id, ...payload })
}

/**
 * Which engine reads a path. A .vst3 is a folder on Windows and the panel hands
 * us the bundle path, so the test covers the directory and the dll inside it.
 */
function kindOf(target) {
  if (typeof target !== 'string') return 'vst2'
  if (isVst3Bundle(target)) return 'vst3'
  return /\.vst3([/\\]|$)/i.test(target) ? 'vst3' : 'vst2'
}

/**
 * Plugins stay open between requests. Opening a VST3 means creating the
 * component, wiring its controller and running setupProcessing; paying for that
 * on every bounce is a delay the producer feels each time a knob moves, and a
 * plugin torn down and rebuilt can come back in another state. The cache is
 * keyed by path and dies with the worker, so nothing outlives a fault.
 */
const instances = new Map()

/**
 * Live sessions by chain row. A session holds the plugin's mains open and its
 * block size small, which is exactly what a bounce is about to change: the render
 * path reconfigures the block size and reopens the mains. So a render on a path
 * that is being monitored puts the session down, does its work, and picks the
 * session back up with its own block size and its own knobs — see the render
 * command. The map is what tells the two apart.
 *
 * The key is the row the producer put the plugin on (`sessionId`), falling back to
 * the path for a host that has no chain yet. A lane can carry the same .dll twice,
 * and two rows of one file are two sessions: the second one gets an instance of
 * its own, because one plugin has one set of internal state and two live hops
 * through it would hear each other's signal instead of running in series.
 */
const liveSessions = new Map()

/** Which row a live call belongs to; an older host only says which file. */
function sessionKeyOf(request) {
  return String(request.sessionId || request.path || '')
}

/**
 * The instance a live row runs on. It is the row's own instance — the same one its
 * window is drawn on, when it has one — because a plugin has one set of knobs, and
 * a producer who turns a knob in a window has to be turning the knob the audio is
 * running through. See `rowInstance`.
 */
function acquireForLive(request, sampleRate, key) {
  return rowInstance(request, sampleRate, key).entry
}

/** The session a bounce on this path has to put down first, if any. */
function sessionOnPath(path) {
  const shared = instances.get(path)
  for (const [key, session] of liveSessions) {
    if (session.entry === shared) return { key, session }
  }
  return null
}

function acquire(target, sampleRate) {
  const kind = kindOf(target)
  const existing = instances.get(target)
  if (existing) return existing
  const plugin = kind === 'vst3' ? new Vst3Plugin(target) : new Vst2Plugin(target)
  // Both engines are told the project rate before they describe themselves: a
  // VST3 fixes its block size in setupProcessing, and a VST2 only answers with
  // its real parameter list after it has been opened and configured.
  const info = plugin.describe(sampleRate)
  const entry = { plugin, kind, info }
  instances.set(target, entry)
  return entry
}

function dispose(target) {
  const entry = instances.get(target)
  if (!entry) return false
  instances.delete(target)
  // Every live row that was running this file loses its session: a stale handle
  // to a closed plugin would look alive to whoever asked for it next. A row that
  // had an instance of its own keeps it — it is closed by its own live-close, and
  // the worker's exit takes the rest.
  for (const [key, session] of [...liveSessions]) {
    if (session.entry === entry) liveSessions.delete(key)
  }
  // And every window that was drawn on it: the HWND goes down with the plugin, and
  // a row left pointing at a closed instance would answer `noEditor` forever.
  for (const [key, held] of [...editors]) {
    if (held.entry === entry) editors.delete(key)
  }
  try {
    entry.plugin.close()
  } catch {
    // A plugin that faults on close still must not wedge the worker.
  }
  return true
}

// ------------------------------------------------------------------ editor pump
/**
 * A plugin's interface is a Win32 window, and a Win32 window only lives while
 * somebody takes its messages. That somebody is this timer: it runs only while
 * at least one editor is open, and each window's own `onIdle` gets the plugin's
 * redraw call (effEditIdle, or the VST3 view's own turn) from plugin-gui.
 */
let pumpTimer = null

function pumpEditors() {
  if (gui.windows.size === 0) {
    if (pumpTimer) {
      clearInterval(pumpTimer)
      pumpTimer = null
    }
    return
  }
  try {
    gui.pump()
  } catch (error) {
    process.stderr.write(`[worker] pump: ${error.message}\n`)
  }
}

function startPump() {
  if (pumpTimer || gui.windows.size === 0) return
  pumpTimer = setInterval(pumpEditors, 16)
  // Never the reason a shutting-down worker waits: the IPC channel already
  // keeps it alive while the app is running.
  pumpTimer.unref?.()
}

/** The engine behind a cached instance, or null when the path is unknown. */
function editorOf(path) {
  const entry = instances.get(path)
  return entry && typeof entry.plugin.openEditor === 'function' ? entry : null
}

/**
 * Which chain row an editor call belongs to. The same rule as a live session:
 * the row when the host has one, the file when it does not.
 */
function editorKeyOf(request) {
  return String(request.sessionId || request.path || '')
}

/**
 * Open plugin windows, by row.
 *
 * A lane can carry the same file twice, and each row is expected to bring its own
 * interface with its own knobs — one plugin instance has one set of values, so two
 * windows drawn on one instance would move together, and that is a lie the
 * producer cannot hear coming. So a row holds one instance for both of its halves:
 * the audio it is heard through and the window it is seen through are the same
 * object, whichever of the two was opened first.
 */
const editors = new Map()

/**
 * The instance a chain row works on.
 *
 * The row keeps whatever it already runs on. Otherwise it takes the shared
 * instance the bounce knows by path, unless another row already holds that one for
 * its audio or its window; a row that arrives late to a file that is already spoken
 * for gets an instance of its own, and `own` is the flag that says whoever ends the
 * row has to close it.
 */
function rowInstance(request, sampleRate, key) {
  const held = editors.get(key)?.entry ?? liveSessions.get(key)?.entry ?? null
  if (held) return { entry: held, own: Boolean(held.own) }
  const shared = instances.get(request.path)
  const taken =
    shared &&
    ([...editors].some(([other, row]) => other !== key && row.entry === shared) ||
      [...liveSessions].some(([other, row]) => other !== key && row.entry === shared))
  if (!shared || !taken) return { entry: acquire(request.path, sampleRate), own: false }
  const kind = kindOf(request.path)
  const plugin = kind === 'vst3' ? new Vst3Plugin(request.path) : new Vst2Plugin(request.path)
  // Reported apart from a fault: a plugin that only allows one instance says so
  // here, and the row shows the producer its own words rather than a dead lane.
  return { entry: { plugin, kind, info: plugin.describe(sampleRate), own: true }, own: true }
}

/** The instance behind a place/state/show/close call, or null when nothing answers. */
function editorEntry(request) {
  const held = editors.get(editorKeyOf(request))
  // A host that says only which file gets the file's own instance, which is what
  // it opened before rows existed; a window held by a row is found by that row.
  if (held) return held.entry
  return request.sessionId ? null : editorOf(request.path)
}

/** Whether this row's window is still standing on this instance. */
function windowHolds(key, entry) {
  return editors.get(key)?.entry === entry
}

/** Let go of a window, closing the plugin only when nothing else holds it. */
function dropEditor(key) {
  const held = editors.get(key)
  if (!held) return false
  editors.delete(key)
  try {
    held.entry.plugin.closeEditor?.()
  } catch {
    // A plugin that faults on the way out of its editor still must not wedge us.
  }
  // The ear has priority over the window: a row that is still being heard live
  // keeps its instance, and `live-close` closes it when the row really ends.
  if (held.own && liveSessions.get(key)?.entry !== held.entry) {
    try {
      held.entry.plugin.close()
    } catch {
      // Same: the instance is being thrown away, and nothing else holds it.
    }
  }
  return true
}

/** The channel pair the plugin asked for; a mono pin hears the summed clip. */
function feed(entry, left, right) {
  const channels = Number(entry.info.numInputs) || 1
  if (channels >= 2) return [left, right]
  return [sum(left, right)]
}

function sum(left, right) {
  const mono = new Float32Array(left.length)
  for (let i = 0; i < left.length; i += 1) mono[i] = (left[i] + (right[i] ?? 0)) * 0.5
  return mono
}

// ------------------------------------------------------------------ live audio
/**
 * IPC moves Buffers, not Float32Arrays: a bare ArrayBuffer arrives as an empty
 * object, and over a plain Node fork a Buffer arrives as {type:'Buffer', data}.
 * So a block crossing this boundary is packed as raw little-endian float32 and
 * unpacked by copy — never as a view over someone else's pool, whose byte offset
 * is not guaranteed to be a multiple of four.
 */
function toBuffer(channel) {
  return Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength)
}

function asFloats(payload) {
  if (!payload) return null
  if (payload instanceof Float32Array) return payload
  const bytes = payload instanceof ArrayBuffer
    ? new Uint8Array(payload)
    : ArrayBuffer.isView(payload)
      ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
      : new Uint8Array(Buffer.from(payload))
  const values = new Float32Array(Math.floor(bytes.byteLength / 4))
  new Uint8Array(values.buffer).set(bytes.subarray(0, values.byteLength))
  return values
}

function applyParameters(plugin, params) {
  for (const item of params ?? []) {
    const index = Number(item?.index)
    const value = Number(item?.value)
    if (!Number.isFinite(index) || index < 0 || !Number.isFinite(value)) continue
    try {
      plugin.setParameter(index, Math.min(1, Math.max(0, value)))
    } catch (error) {
      process.stderr.write(`[worker] parâmetro ${index}: ${error.message}\n`)
    }
  }
}

async function handle(request) {
  if (!request || typeof request.cmd !== 'string') return
  try {
    if (request.cmd === 'scan') {
      const walked = []
      const plugins = scan(request.dirs ?? [], walked)
      // The folders are reported with the answer, each with how many plugin-shaped
      // files it gave up — the question behind the request is always "did the host
      // look where my plugin is", and a folder that is empty is part of that
      // answer. Ones that are not on this machine at all are left out.
      const dirs = walked.filter((item) => item.exists)
      reply(request, { ok: true, plugins, dirs })
      return
    }

    if (request.cmd === 'add-dir') {
      const result = addExtraDir(request.dir)
      reply(request, result.error ? { ok: false, error: result.error } : { ok: true, ...result })
      return
    }

    if (request.cmd === 'rt-probe') {
      // The spike's other half: how long a message takes to come in and out of
      // the process that holds the plugins, answered by this process alone. A
      // live block will pay this trip for every block of audio, so the number is
      // the whole question, and it is measured before any audio is promised.
      reply(request, { ok: true, probed: true, clock: request.clock ?? 0 })
      return
    }

    if (request.cmd === 'close') {
      reply(request, { ok: true, closed: dispose(request.path) })
      return
    }

    if (request.cmd === 'describe') {
      const rate = Number(request.sampleRate) > 0 ? Number(request.sampleRate) : 48000
      const entry = acquire(request.path, rate)
      reply(request, { ok: true, kind: entry.kind, info: entry.info })
      return
    }

    if (request.cmd === 'params') {
      const rate = Number(request.sampleRate) > 0 ? Number(request.sampleRate) : 48000
      const entry = acquire(request.path, rate)
      if (entry.info.error) throw new Error(entry.info.error)
      // Both engines take a 0..1 value at the same index the panel listed, and
      // both keep whatever the plugin's own window set: this is the handover from
      // panel to plugin, so a producer who moves a slider in the OpenDAW strip
      // sees the same number inside the plugin's GUI.
      const applied = []
      for (const item of request.params ?? []) {
        const index = Number(item.index)
        const value = Number(item.value)
        if (!Number.isFinite(index) || index < 0 || !Number.isFinite(value)) continue
        try {
          entry.plugin.setParameter(index, Math.min(1, Math.max(0, value)))
          // Read it back from the plugin: a value it refuses, steps, or clamps is
          // the plugin's answer, and the panel should show that rather than the
          // number that was typed.
          const held = typeof entry.plugin.parameterValue === 'function'
            ? Number(entry.plugin.parameterValue(index))
            : Number.NaN
          applied.push({ index, value: Number.isFinite(held) ? held : Math.min(1, Math.max(0, value)) })
        } catch (error) {
          process.stderr.write(`[worker] parâmetro ${index}: ${error.message}\n`)
        }
      }
      reply(request, {
        ok: true,
        kind: entry.kind,
        applied,
        reported: entry.plugin.reportedValues?.() ?? [],
      })
      return
    }

    if (request.cmd === 'render') {
      const sampleRate = Number(request.sampleRate) > 0 ? Number(request.sampleRate) : 48000
      let left
      let right
      if (request.inputWav) {
        const decoded = wav.decode(Buffer.from(request.inputWav))
        left = decoded.left
        right = decoded.right
      } else {
        // No audio supplied: a decaying sine proves the signal really went
        // through the plugin rather than being copied around.
        const frames = Math.floor(sampleRate * (Number(request.seconds) || 2))
        left = new Float32Array(frames)
        right = new Float32Array(frames)
        for (let i = 0; i < frames; i += 1) {
          const t = i / sampleRate
          const value = Math.sin(2 * Math.PI * 220 * t) * Math.min(1, t * 8) * Math.exp(-t * 0.8)
          left[i] = value
          right[i] = value * 0.9
        }
      }

      const entry = acquire(request.path, sampleRate)
      const { plugin, info } = entry
      // A VST3 that could not be opened still describes itself: the reason it
      // failed is more useful to the producer than a bare error dialog. Checked
      // before anything is put down, so a refusal leaves the live ear alone.
      if (info.error) throw new Error(info.error)
      // A bounce reconfigures the block size and reopens the mains. Done to a
      // plugin that is being heard live, that would leave the monitor holding
      // buffers of the wrong size — so the session is put down for the length of
      // the pass and picked up again with its own block size and its own knobs.
      // Nothing here awaits while the plugin works, so no live block can squeeze
      // between the two: the monitor simply falls back to dry until the clip is
      // through, and the live counters report that stretch as underruns.
      const row = sessionOnPath(request.path)
      const held = row?.session ?? null
      if (held && typeof plugin.stopLive === 'function') {
        try {
          plugin.stopLive()
        } catch (error) {
          process.stderr.write(`[worker] live pause: ${error.message}\n`)
        }
      }
      for (const parameter of request.params ?? []) {
        const position = Number(parameter?.index)
        // VST2 indexes and VST3 parameter ids both come through here; the
        // engines map a position onto the id themselves.
        if (Number.isFinite(position) && position >= 0) plugin.setParameter(position, Number(parameter.value))
      }
      // Both channels cross as they are; a plugin with a single input pin is
      // handed the summed pair so it hears the whole clip.
      let outputs
      try {
        outputs = plugin.render(feed(entry, left, right), sampleRate)
      } finally {
        if (held && typeof plugin.startLive === 'function') {
          try {
            held.geometry = plugin.startLive(sampleRate, held.geometry.block)
            applyParameters(plugin, held.params)
          } catch (error) {
            // The live ear cannot be re-opened. Say so to whoever is pumping
            // rather than leave a session that answers with the wrong buffers.
            liveSessions.delete(row.key)
            process.stderr.write(`[worker] live resume: ${error.message}\n`)
          }
        }
      }

      let peak = 0
      let nonSilent = 0
      let bad = 0
      const wet = outputs[0]
      // A plugin with one output feeds both sides of the clip, so the bounce
      // never silently turns a stereo lane into a mono one.
      const second = outputs[1] ?? wet
      for (let i = 0; i < wet.length; i += 1) {
        const a = wet[i]
        const b = second[i]
        if (!Number.isFinite(a) || !Number.isFinite(b)) bad += 1
        const magnitude = Math.max(Math.abs(a), Math.abs(b))
        if (magnitude > peak) peak = magnitude
        if (magnitude > 1e-6) nonSilent += 1
      }

      reply(request, {
        ok: true,
        kind: entry.kind,
        info: entry.info,
        // What the plugin reported on the way out — its meters, and any knob its
        // own interface moved. The FX window reads these so the panel and the
        // plugin cannot drift apart.
        reported: typeof plugin.reportedValues === 'function' ? plugin.reportedValues() : [],
        // A Buffer, not an ArrayBuffer: IPC (and the mobile-style clone in
        // utilityProcess) turns a bare ArrayBuffer into an empty object.
        outputWav: wav.encodeStereoFloat32(wet, second, sampleRate),
        peak,
        nonSilent,
        total: wet.length,
        bad,
      })
      return
    }

    if (request.cmd === 'live-open') {
      const sampleRate = Number(request.sampleRate) > 0 ? Number(request.sampleRate) : 48000
      const key = sessionKeyOf(request)
      const running = liveSessions.get(key)
      if (running) {
        // The same row asking again — a project reopened, a monitor toggled: the
        // session it already has is the answer, on the knobs it is being shown.
        applyParameters(running.entry.plugin, request.params)
        running.params = request.params ?? running.params
        reply(request, { ok: true, kind: running.entry.kind, reused: true, geometry: running.geometry, block: running.geometry.block })
        return
      }
      const entry = acquireForLive(request, sampleRate, key)
      if (entry.info.error) throw new Error(entry.info.error)
      if (typeof entry.plugin.startLive !== 'function') {
        // Plugin doesn't support live processing (no startLive method)
        if (entry.own && !windowHolds(key, entry)) entry.plugin.close()
        throw new Error('este plugin não suporta processamento ao vivo; continue valendo no passe do clipe')
      }
      const geometry = entry.plugin.startLive(sampleRate, Number(request.block) || 128)
      applyParameters(entry.plugin, request.params)
      // The knobs the panel is showing are kept with the session: a bounce on this
      // same plugin runs its own parameter list, and when the live ear is picked
      // back up it has to come back on the values the producer can see.
      liveSessions.set(key, {
        key,
        path: request.path,
        entry,
        geometry,
        blocks: 0,
        peak: 0,
        params: request.params ?? [],
      })
      reply(request, { ok: true, kind: entry.kind, geometry, info: entry.info, block: geometry.block })
      return
    }

    if (request.cmd === 'live-block') {
      const session = liveSessions.get(sessionKeyOf(request))
      if (!session) throw new Error('esse plugin não tem sessão ao vivo aberta')
      const left = asFloats(request.left)
      if (!left || left.length === 0) throw new Error('o bloco de entrada veio vazio')
      const right = asFloats(request.right) ?? left
      // The same pin rule as the bounce: a plugin with one input hears the summed
      // pair rather than whichever channel happened to be asked for first.
      const input = session.geometry.channels >= 2 ? [left, right] : [sum(left, right)]
      const outputs = session.entry.plugin.processLive(input)
      const wet = outputs[0] ?? new Float32Array(0)
      const second = outputs[1] ?? wet
      let peak = 0
      let bad = 0
      for (let i = 0; i < wet.length; i += 1) {
        const a = wet[i]
        const b = second[i] ?? a
        if (!Number.isFinite(a) || !Number.isFinite(b)) bad += 1
        const magnitude = Math.max(Math.abs(a), Math.abs(b))
        if (magnitude > peak) peak = magnitude
      }
      session.blocks += 1
      if (peak > session.peak) session.peak = peak
      reply(request, {
        ok: true,
        left: toBuffer(wet),
        right: toBuffer(second),
        peak,
        bad,
        blocks: session.blocks,
      })
      return
    }

    if (request.cmd === 'live-params') {
      const session = liveSessions.get(sessionKeyOf(request))
      if (!session) throw new Error('esse plugin não tem sessão ao vivo aberta')
      applyParameters(session.entry.plugin, request.params)
      if (Array.isArray(request.params)) session.params = request.params
      reply(request, {
        ok: true,
        blocks: session.blocks,
        peak: session.peak,
        reported: session.entry.plugin.reportedValues?.() ?? [],
      })
      return
    }

    if (request.cmd === 'live-close') {
      const key = sessionKeyOf(request)
      const session = liveSessions.get(key)
      if (!session) {
        reply(request, { ok: true, closed: false, blocks: 0, peak: 0 })
        return
      }
      liveSessions.delete(key)
      // The engine counts its own calls since the buffers were made, and a clip
      // pass in the middle of a session rebuilds those buffers — so what the
      // producer is owed is the length of the session, which this record kept,
      // with the engine's count beside it as the cross-check.
      const calls = Number(session.entry.plugin.stopLive?.()) ?? 0
      if (session.entry.own && !windowHolds(key, session.entry)) {
        // The second copy of a file belongs to this row alone and goes with it;
        // the shared instance stays for the bounce and for the editor. A row whose
        // window is still up keeps its instance — the window has the only handle
        // to it now, and `gui-close` is what puts it down.
        try {
          session.entry.plugin.close()
        } catch {
          // A plugin that faults on the way out still must not wedge the worker.
        }
      }
      reply(request, {
        ok: true,
        closed: true,
        blocks: session.blocks,
        pluginCalls: Number.isFinite(calls) ? calls : 0,
        peak: session.peak,
      })
      return
    }

    if (request.cmd === 'gui-open') {
      const rate = Number(request.sampleRate) > 0 ? Number(request.sampleRate) : 48000
      const key = editorKeyOf(request)
      const already = editors.get(key)
      if (already && already.entry.plugin.editorState?.()?.open === true) {
        // The row already has its window up: answer with the truth of it instead
        // of asking the plugin to open a second editor on the same instance.
        reply(request, {
          ok: true,
          kind: already.entry.kind,
          state: already.entry.plugin.editorState(),
          info: already.entry.info,
          reported: already.entry.plugin.reportedValues?.() ?? [],
        })
        return
      }
      const host = rowInstance(request, rate, key)
      const entry = host.entry
      if (entry.info.error) throw new Error(entry.info.error)
      if (typeof entry.plugin.openEditor !== 'function') {
        throw new Error('este motor ainda não mostra interface própria')
      }
      const state = entry.plugin.openEditor(request.rect ?? {}, { owner: request.owner })
      // The plugin picks its own canvas size, and a pane sitting near a screen
      // edge can be smaller than that. The app's own area travels inside the
      // rectangle, so the window that comes up is already inside it: an
      // interface the producer has to hunt for on the desktop is not an
      // interface that lives in the program.
      if (request.rect?.inside && typeof entry.plugin.placeEditor === 'function') {
        entry.plugin.placeEditor(request.rect)
      }
      editors.set(key, { key, path: request.path, entry, own: host.own })
      startPump()
      reply(request, {
        ok: true,
        kind: entry.kind,
        state,
        info: entry.info,
        reported: entry.plugin.reportedValues?.() ?? [],
      })
      return
    }

    if (
      request.cmd === 'gui-place' ||
      request.cmd === 'gui-state' ||
      request.cmd === 'gui-close' ||
      request.cmd === 'gui-show'
    ) {
      const entry = editorEntry(request)
      if (!entry) {
        // `noEditor` is the answer that means "this process has never opened that
        // plugin", which is a different fact from "the plugin closed its window":
        // after a fault, the fresh process knows nothing, and the panel has to be
        // able to tell the producer its window went down with the plugins instead
        // of going on saying it is still on the screen.
        reply(request, { ok: false, noEditor: true, error: 'não há plugin aberto nesse endereço' })
        return
      }
      if (request.cmd === 'gui-place') {
        // The panel says where, the plugin says how big: a window stretched to a
        // div would give a fixed-size GUI a canvas it never asked for.
        const rect = request.rect ?? {}
        if (typeof entry.plugin.placeEditor === 'function') entry.plugin.placeEditor(rect)
        else if (entry.plugin.editor) gui.placeClient(entry.plugin.editor.window, rect)
      } else if (request.cmd === 'gui-show') {
        // The pane the plugin draws in can be hidden (the FX panel was minimised,
        // the lane was closed) without the plugin itself going away. Hiding the
        // window is what keeps an interface from floating over the desktop with
        // nowhere to be, and the pump keeps running so the plugin stays alive.
        const window = entry.plugin.editor?.window
        if (window) gui.shown(window, request.visible !== false)
      } else if (request.cmd === 'gui-close') {
        // The row lets go of its window. A plugin instance that only existed for
        // that window goes with it; one the producer is still hearing live, or
        // that the bounce knows by path, stays.
        if (!dropEditor(editorKeyOf(request))) entry.plugin.closeEditor?.()
        // The last window closed takes the pump with it: an idle worker that
        // holds no editor holds no messages either.
        pumpEditors()
      }
      reply(request, {
        ok: true,
        kind: entry.kind,
        // Whether the interface is on the screen — the answer a hide is checked
        // against, so "put away" and "gone" are never the same report.
        visible: gui.isVisible(entry.plugin.editor?.window),
        state: entry.plugin.editorState?.() ?? { open: false },
        // The plugin may have moved its own knobs since the last look; the panel
        // reads them from here instead of guessing.
        reported: entry.plugin.reportedValues?.() ?? [],
      })
      return
    }

    reply(request, { ok: false, error: `comando desconhecido: ${request.cmd}` })
  } catch (error) {
    reply(request, { ok: false, error: (error && error.message) || String(error) })
  }
}

out.send({ ready: true })
