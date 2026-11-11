/**
 * OpenDAW for Windows — the executable version.
 *
 * The DAW itself is the same code the browser runs: it is served from disk over
 * loopback http, because Chromium refuses AudioWorklet modules and wasm on the
 * file:// scheme. On top of it this process adds what a browser tab cannot do:
 * a real window with native menus, open/save straight to the file system, and a
 * supervised native process that hosts VST plugins.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const { serve } = require('./server.cjs')
const plugins = require('./plugins.cjs')
const asioHost = require('./asio-host.cjs')
const updater = require('./updater.cjs')
const wav = require('./wav.cjs')

const DIST = path.join(__dirname, '..', 'dist')
const PREFERRED_PORT_FILE = path.join(app.getPath('userData'), 'server-port.json')
const IS_SELFTEST = process.argv.includes('--selftest')

/** Filters per kind of file the app writes; keep them in step with the UI labels. */
const FILTERS = {
  project: [{ name: 'Projeto OpenDAW (.opdaw)', extensions: ['opdaw', 'webdaw', 'json'] }],
  chain: [{ name: 'Cadeia de efeitos (.opdawchain)', extensions: ['opdawchain', 'webdawchain', 'json'] }],
  audio: [{ name: 'Faixa de áudio (.wav)', extensions: ['wav'] }],
  midi: [{ name: 'Arquivo MIDI (.mid)', extensions: ['mid', 'midi'] }],
  image: [{ name: 'Imagem (.png)', extensions: ['png'] }],
  any: [{ name: 'Todos os arquivos', extensions: ['*'] }],
}

/** The app's documents folder: created on first save, never silently skipped. */
function documentsDir() {
  const dir = path.join(app.getPath('documents'), 'OpenDAW')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

let win = null
let server = null

function readPreferredPort() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFERRED_PORT_FILE, 'utf8'))
    return Number.isInteger(raw.port) ? raw.port : 0
  } catch {
    return 0
  }
}

function writePreferredPort(port) {
  try {
    fs.mkdirSync(path.dirname(PREFERRED_PORT_FILE), { recursive: true })
    fs.writeFileSync(PREFERRED_PORT_FILE, JSON.stringify({ port }))
  } catch {
    // A missing settings file only costs the next launch its remembered port.
  }
}

// ------------------------------------------------------- audio system
/**
 * Chromium picks its Windows audio backend once, while it is starting, from
 * command-line switches: there is no API to change it later. So the producer's
 * choice is kept in a small file here and turned into switches below, before the
 * first stream exists. The page keeps its own copy for the window; this file is
 * only what the next launch reads.
 */
const AUDIO_SYSTEM_FILE = path.join(app.getPath('userData'), 'audio-system.json')

/** The systems this build can genuinely ask for, plus our own mute. */
const AUDIO_SYSTEMS = new Set(['wasapi', 'wasapi-exclusive', 'waveout', 'dummy'])

function cleanAudioSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const system = AUDIO_SYSTEMS.has(source.system) ? source.system : 'wasapi'
  const sampleRate = Number.isFinite(source.sampleRate) ? Math.max(0, Math.round(source.sampleRate)) : 0
  const bufferSize = Number.isFinite(source.bufferSize) ? Math.max(0, Math.round(source.bufferSize)) : 0
  const latency =
    source.latency === 'balanced' || source.latency === 'playback' ? source.latency : 'interactive'
  return { system, sampleRate, bufferSize, latency }
}

function readAudioSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(AUDIO_SYSTEM_FILE, 'utf8'))
    if (!raw || typeof raw.system !== 'string' || !AUDIO_SYSTEMS.has(raw.system)) return null
    return cleanAudioSettings(raw)
  } catch {
    return null
  }
}

function writeAudioSettings(settings) {
  const clean = cleanAudioSettings(settings)
  fs.mkdirSync(path.dirname(AUDIO_SYSTEM_FILE), { recursive: true })
  fs.writeFileSync(AUDIO_SYSTEM_FILE, JSON.stringify(clean))
  return clean
}

const bootAudio = readAudioSettings()
if (process.platform === 'win32' && bootAudio) {
  // Exclusive WASAPI: lower latency, and no other program can share the device.
  if (bootAudio.system === 'wasapi-exclusive') app.commandLine.appendSwitch('enable-exclusive-audio')
  // WaveOut (MME): the old path, kept for interfaces whose WASAPI driver misbehaves.
  if (bootAudio.system === 'waveout') app.commandLine.appendSwitch('force-wave-audio')
  // Frames per buffer, the same switch Chromium's own audio debugging uses.
  if (bootAudio.bufferSize > 0) {
    app.commandLine.appendSwitch('audio-buffer-size', String(bootAudio.bufferSize))
  }
}

function sendMenu(action) {
  win?.webContents.send('opdaw:menu', action)
}

/** A row of the mirrored bar: the page presses its own button for us. */
function sendMenuClick(menu, item) {
  win?.webContents.send('opdaw:menu', { menu, item })
}

/**
 * The menu bar of the executable.
 *
 * The page already draws a complete menu bar for the browser, and the producer
 * reads it in Portuguese. Duplicating those forty commands here would give two
 * menus that drift apart, so the bar is built from the structure the renderer
 * publishes (see mirrorMenuBar in src/desktop/native.ts): every row, its live
 * label ("Desfazer (3)", "Snap (on)") and its disabled state come from the page.
 * Only what the web version cannot have — Sair, Recarregar, DevTools, plugins
 * nativos — is added here.
 */
let menuStructure = null

/** Rows the mirrored menu cannot carry, appended to the group whose name matches. */
const EXTRAS = [
  {
    match: /^(arquivo|file)$/i,
    rows: () => [
      { type: 'separator' },
      { label: 'Reiniciar a sessão', click: () => sendMenu('new-project') },
      { type: 'separator' },
      { role: 'quit', label: 'Sair' },
    ],
  },
  {
    match: /^(ver|view|janela)$/i,
    rows: () => [
      { type: 'separator' },
      { label: 'Recarregar a página', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.reload() },
      { label: 'Ferramentas de desenvolvimento', accelerator: 'CmdOrCtrl+Shift+I', click: () => win?.webContents.toggleDevTools() },
      { role: 'togglefullscreen', label: 'Tela cheia' },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Zoom 100%' },
      { role: 'zoomIn', label: 'Aumentar zoom' },
      { role: 'zoomOut', label: 'Diminuir zoom' },
    ],
  },
]

/** Windows treats "&" as a mnemonic marker; a plugin name is not one. */
const menuLabel = (text, fallback) =>
  String(text ?? '').replace(/&/g, '&&').trim() || fallback

function buildMenu() {
  const groups = (menuStructure ?? []).map((group, index) => {
    const mirrored = (group.items ?? []).map((item, position) =>
      item?.separator
        ? { type: 'separator' }
        : {
            label: menuLabel(item?.label, '(sem rótulo)'),
            enabled: item?.disabled !== true,
            click: () => sendMenuClick(index, position),
          },
    )
    const extra = EXTRAS.find((entry) => entry.match.test(String(group.label).trim()))
    return {
      label: menuLabel(group.label, 'Menu'),
      submenu: [...mirrored, ...(extra ? extra.rows() : [])],
    }
  })

  const template = groups.length > 0 ? groups : [{ label: 'OpenDAW', submenu: [{ role: 'quit', label: 'Sair' }] }]

  // Native-only capabilities the browser version has no way to offer.
  template.push({
    label: 'Plugins',
    submenu: [
      { label: 'Procurar plugins VST…', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendMenu('scan-plugins') },
      // Read-only discovery is a PE header away, so this costs nothing but a folder pick.
      { label: 'Adicionar pasta de plugins…', click: () => addPluginsFolder(true) },
      { label: 'Painel de plugins nativos', accelerator: 'CmdOrCtrl+Shift+M', click: () => sendMenu('plugin-panel') },
    ],
  })
  template.push({
    label: 'Ajuda',
    submenu: [
      {
        label: 'Sobre o OpenDAW',
        click: () => {
          dialog.showMessageBox({
            type: 'info',
            title: 'OpenDAW',
            message: `OpenDAW ${app.getVersion()}`,
            detail: [
              'Versão para Windows, com motor de plugins nativo por FFI.',
              `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
              `Arquivos do app: ${documentsDir()}`,
            ].join('\n'),
          })
        },
      },
    ],
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}


// ----------------------------------------------------------------- IPC
ipcMain.on('opdaw:menu-structure', (_event, groups) => {
  if (!Array.isArray(groups) || groups.length === 0) return
  menuStructure = groups
  buildMenu()
})

ipcMain.handle('opdaw:info', () => ({
  native: true,
  platform: process.platform,
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  documents: documentsDir(),
  dist: DIST,
  servedFrom: server?.url ?? null,
}))

// --------------------------------------------------------------- atualizações
/**
 * O app instalado se atualiza pela última release do GitHub: consulta, baixa o
 * Setup e o entrega ao Windows. A pasta portátil não instala nada — nesse modo a
 * interface só abre a página da release.
 */
const UPDATE_MODE = process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installed'
const UPDATE_CACHE = path.join(app.getPath('userData'), 'update-check.json')
const UPDATE_DIR = path.join(app.getPath('temp'), 'OpenDAW-updates')

ipcMain.handle('opdaw:update:check', (_event, options) =>
  updater.check({
    current: app.getVersion(),
    cacheFile: UPDATE_CACHE,
    force: Boolean(options?.force),
    mode: UPDATE_MODE,
  }),
)

ipcMain.handle('opdaw:update:download', async (event, payload) => {
  const sender = event.sender
  try {
    const file = await updater.download(payload?.asset, UPDATE_DIR, (progress) => {
      if (!sender.isDestroyed()) sender.send('opdaw:update:progress', progress)
    })
    return { ok: true, path: file, name: path.basename(file) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
})

ipcMain.handle('opdaw:update:install', (_event, payload) => {
  if (UPDATE_MODE === 'portable') {
    return { ok: false, error: 'a versão portátil não se instala sozinha' }
  }
  try {
    const installer = updater.validateInstaller(payload?.path)
    // O .exe só pode ser trocado com o app fechado: o instalador silencioso só
    // começa depois do quit, e reabre o OpenDAW quando termina.
    app.once('will-quit', () => updater.launchInstaller(installer, app.getPath('exe')))
    setTimeout(() => app.quit(), 200)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message }
  }
})

ipcMain.handle('opdaw:update:open-release', async (_event, url) => {
  const target =
    typeof url === 'string' && /^https:\/\/github\.com\/Frankwillians\/opendaw\//i.test(url)
      ? url
      : updater.RELEASES_URL
  await shell.openExternal(target)
  return { ok: true }
})

ipcMain.handle('opdaw:audio-system:get', () => readAudioSettings())

ipcMain.handle('opdaw:audio-system:set', (_event, settings) => {
  try {
    return { ok: true, settings: writeAudioSettings(settings) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
})

ipcMain.handle('opdaw:save-file', async (_event, options) => {
  const kind = FILTERS[options?.kind] ? options.kind : 'any'
  const defaultName = typeof options?.defaultName === 'string' && options.defaultName ? options.defaultName : 'arquivo'
  const result = await dialog.showSaveDialog({
    title: 'Salvar arquivo',
    defaultPath: path.join(documentsDir(), defaultName),
    filters: FILTERS[kind],
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  if (options?.data == null) return { canceled: true, error: 'sem conteúdo para salvar' }
  await fs.promises.writeFile(result.filePath, Buffer.from(options.data))
  return { canceled: false, path: result.filePath }
})

ipcMain.handle('opdaw:open-file', async (_event, options) => {
  const kind = FILTERS[options?.kind] ? options.kind : 'any'
  const result = await dialog.showOpenDialog({
    title: 'Abrir arquivo',
    defaultPath: kind === 'audio' ? documentsDir() : app.getPath('documents'),
    filters: FILTERS[kind],
    properties: ['openFile'],
  })
  if (result.canceled || result.filePaths.length === 0) return { canceled: true }
  const file = result.filePaths[0]
  const buffer = await fs.promises.readFile(file)
  return {
    canceled: false,
    path: file,
    name: path.basename(file),
    // Text for project and chain files, raw bytes for anything audio reads.
    text: kind === 'audio' || kind === 'midi' || kind === 'any' ? null : buffer.toString('utf8'),
    data: buffer,
  }
})

// `params` is on this list rather than the GUI one below because it does not
// need a window: moving a knob in the panel has to reach the plugin whether or
// not its own interface is up.
for (const cmd of ['scan', 'describe', 'render', 'params']) {
  ipcMain.handle(`opdaw:plugin:${cmd}`, async (_event, payload) => {
    try {
      return await plugins.request(cmd, payload ?? {}, cmd === 'render' ? 120000 : 45000)
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) }
    }
  })
}

// ------------------------------------------------------------- live plugin audio
/**
 * The four calls a live lane makes while the producer is playing.
 *
 * `live-open` and `live-close` are ordinary requests: they happen once, and a
 * slow plugin is allowed to take its time. `live-block` is different in kind — it
 * is asked for every batch of samples the audio thread fills, and a page that
 * waits too long on one has already lost the take. So it gets a short timeout and
 * a reply the page is allowed to drop: the worklet bypasses while the answer is
 * late, and the producer hears the dry input instead of a stall.
 */
for (const cmd of ['live-open', 'live-params', 'live-close']) {
  ipcMain.handle(`opdaw:plugin:${cmd}`, async (_event, payload) => {
    try {
      return await plugins.request(cmd, payload ?? {}, cmd === 'live-open' ? 45000 : 8000)
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) }
    }
  })
}

ipcMain.handle('opdaw:plugin:live-block', async (_event, payload) => {
  try {
    // The binary travels as it was handed over: the page sends Float32Arrays and
    // the plugin process answers with Buffers, which survive this hop either way.
    return await plugins.request('live-block', payload ?? {}, 4000)
  } catch (error) {
    return { ok: false, late: true, error: (error && error.message) || String(error) }
  }
})

/**
 * A folder the producer points the host at, kept for every later scan.
 *
 * The registry and the standard folders cover an installed plugin; one that was
 * unpacked somewhere else needs the producer to say where. The answer goes
 * through the OS picker, is handed to the plugin process to remember, and the
 * page is told to look again when the page did not ask for it itself — from the
 * menu bar there is nobody to rescan otherwise, and from the panel a reminder
 * would only throw away the plugin the producer had just picked.
 */
async function addPluginsFolder(announce = false) {
  const result = await dialog.showOpenDialog(win, {
    title: 'Pasta de plugins extras',
    buttonLabel: 'Adicionar esta pasta',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return { canceled: true }
  try {
    const answer = await plugins.request('add-dir', { dir: result.filePaths[0] }, 20000)
    if (announce && answer.ok) sendMenu('scan-plugins')
    return answer
  } catch (error) {
    return { ok: false, error: (error && error.message) || String(error) }
  }
}

ipcMain.handle('opdaw:plugin:add-dir', () => addPluginsFolder())

// ------------------------------------------------------------------ plugin GUI
/**
 * A plugin's interface is a Win32 window, and Win32 measures in physical pixels
 * on the screen while the page measures in CSS pixels inside the viewport. Two
 * steps between them: the page's zoom turns CSS into device-independent pixels,
 * and the monitor's scale turns those into physical ones. The panel's rectangle
 * is where the plugin should draw, so it is the client area we are placing.
 *
 * The answer carries `inside` with it — the app's own drawable area, in the same
 * physical pixels. The producer asked for the plugin's interface to be part of
 * OpenDAW, and a window that ends up outside this one is an external window
 * again, however well it was placed when it opened.
 */
function screenRect(rect, contents) {
  const target = rect && typeof rect === 'object' ? rect : {}
  const frame = BrowserWindow.fromWebContents(contents) ?? win
  if (!frame) return { x: 80, y: 80, width: 640, height: 360, inside: { x: 0, y: 0, width: 0, height: 0 } }
  const zoom = frame.webContents.getZoomFactor() || 1
  const area = frame.getContentBounds()
  const dip = {
    x: area.x + (Number(target.x) || 0) * zoom,
    y: area.y + (Number(target.y) || 0) * zoom,
    width: Math.max(0, (Number(target.width) || 0) * zoom),
    height: Math.max(0, (Number(target.height) || 0) * zoom),
  }
  const corner = screen.dipToScreenPoint({ x: dip.x, y: dip.y })
  const far = screen.dipToScreenPoint({ x: dip.x + dip.width, y: dip.y + dip.height })
  const near = screen.dipToScreenPoint({ x: area.x, y: area.y })
  const edge = screen.dipToScreenPoint({ x: area.x + area.width, y: area.y + area.height })
  return {
    x: Math.round(Number(corner.x)),
    y: Math.round(Number(corner.y)),
    width: Math.max(0, Math.round(Number(far.x) - Number(corner.x))),
    height: Math.max(0, Math.round(Number(far.y) - Number(corner.y))),
    inside: {
      x: Math.round(Number(near.x)),
      y: Math.round(Number(near.y)),
      width: Math.max(0, Math.round(Number(edge.x) - Number(near.x))),
      height: Math.max(0, Math.round(Number(edge.y) - Number(near.y))),
    },
  }
}

/**
 * Which pane each open plugin window belongs to, in the page's own coordinates.
 *
 * The page measures the pane it drew, and that measurement is only true for as
 * long as the app window sits where it was when the pane was measured. The
 * producer moves the window — and a plugin interface that stays where it was is
 * the exact thing this feature was asked not to do. So the rectangle is kept
 * here as well: the pane does not move when the window does, its screen position
 * does, and this is what lets the app answer without waiting for the page to
 * notice anything.
 */
const guiPanes = new Map()

/**
 * Which row a plugin window belongs to. A lane can carry the same file twice and
 * each row keeps its own window, so the file is not enough to tell two panes
 * apart; a page that has no rows yet says only which file, and gets the file.
 */
function guiPaneKey(body) {
  return String((body && (body.sessionId || body.path)) || '')
}

/**
 * Put every plugin window back on the pane it was placed by. Called for the
 * things that move a pane on the screen without moving it in the page: the app
 * window being dragged or resized, restored, maximised, taken full screen, and
 * the monitor under it changing scale.
 *
 * The pass is cheap when nothing moved — one frame read and a string compare —
 * so it runs both from those events and from a slow ticker while an editor is
 * open. A title-bar drag is exactly the kind of thing an event can be late
 * about, and an interface that follows the window two hundred milliseconds later
 * is still an interface that follows it. A pane whose plugin is gone — closed,
 * or lost with the process that held it — leaves the map, so a fault does not
 * turn every later move into a request nobody answers.
 */
let paneTicker = 0
let placedFrame = ''

function appFrameKey() {
  if (!win || win.isDestroyed()) return ''
  const area = win.getBounds()
  return `${area.x},${area.y},${area.width},${area.height}`
}

const paneDebug = { ticks: 0, semPainel: 0, minimizada: 0, molduraIgual: 0, recolocou: 0 }

function repositionPluginWindows() {
  paneDebug.ticks += 1
  if (guiPanes.size === 0 || !win || win.isDestroyed()) {
    paneDebug.semPainel += 1
    return
  }
  if (win.isMinimized()) {
    paneDebug.minimizada += 1
    return
  }
  const key = appFrameKey()
  if (!key || key === placedFrame) {
    paneDebug.molduraIgual += 1
    return
  }
  placedFrame = key
  paneDebug.recolocou += 1
  for (const [target, pane] of [...guiPanes]) {
    if (!pane.contents || pane.contents.isDestroyed()) {
      guiPanes.delete(target)
      continue
    }
    settlePane(target, pane).catch((error) => {
      // The pane leaving the map is the loudest thing that can happen here: after
      // it, no later move of the app reaches that window. Say why it left.
      tracePane(target, 'sai do mapa', { erro: String(error?.message ?? error).slice(0, 90) })
      guiPanes.delete(target)
    })
  }
}

/**
 * Put one pane's window on the pane and make sure it stays there.
 *
 * The obvious pass — convert the rectangle, send `gui-place`, done — is what the
 * producer watched fail: a big plugin such as AmpliTube answers the move by
 * sizing and centring its own editor, so the single command lands, the plugin
 * overwrites it a frame later, and the interface is left on the old pixels while
 * the app has already gone. The place is therefore sent, read back, and sent
 * again while the window is not where the pane is, up to three times. Reading it
 * back is what tells a plugin that obeyed from one that argued, and the cap is
 * what keeps a plugin that genuinely wants its own position from being fought
 * forever. A pane whose plugin no longer exists leaves the map here too, so a
 * fault in a third-party binary does not turn every later window move into three
 * requests nobody answers.
 */
async function settlePane(target, pane) {
  const rect = screenRect(pane.rect, pane.contents)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await plugins.request(
      'gui-place',
      { path: pane.path, sessionId: pane.sessionId, rect },
      20000,
    )
    if (result && result.noEditor === true) {
      guiPanes.delete(target)
      tracePane(target, 'sem editor', result)
      return
    }
    // Give a plugin that resizes itself on show the chance to do it before the
    // position is read; asking in the same millisecond only measures the place
    // that was just sent.
    await new Promise((resolve) => setTimeout(resolve, 120))
    const look = await plugins
      .request('gui-state', { path: pane.path, sessionId: pane.sessionId }, 20000)
      .catch(() => null)
    const now = look?.state ?? {}
    tracePane(target, `tentativa ${attempt + 1}`, { pedido: rect, resposta: now, erro: look?.error })
    if (now.open !== true || !Number.isFinite(Number(now.x))) return
    const offX = Math.abs(Number(now.x) - rect.x)
    const offY = Math.abs(Number(now.y) - rect.y)
    if (offX <= 12 && offY <= 12) return
  }
}

/**
 * What the placement pass actually saw, kept for the selftest to print.
 *
 * A plugin window that does not follow the app is a complaint with three possible
 * authors — the pane was never recorded, the place was sent and refused, or it was
 * sent and the plugin overwrote it — and they read the same on screen. This is
 * bounded on purpose: the report only needs the first steps of a round.
 */
const paneTrace = []
function tracePane(target, cause, detail) {
  if (paneTrace.length >= 24) return
  paneTrace.push({ alvo: String(target).split(/[\\/]/).pop(), causa: cause, ...detail })
}

/** Something changed that the frame key cannot see: a monitor, a zoom, a scale. */
function nudgePluginWindows() {
  placedFrame = ''
  repositionPluginWindows()
}

function watchPluginPanes() {
  if (paneTicker) return
  paneTicker = setInterval(() => {
    if (guiPanes.size === 0) {
      clearInterval(paneTicker)
      paneTicker = 0
      placedFrame = ''
      return
    }
    repositionPluginWindows()
  }, 200)
  // Never the reason a shutting-down app waits: the window keeps the process up.
  paneTicker.unref?.()
}

/**
 * The app window's own HWND, as a number. The plugin worker runs in a different
 * process, but a window handle is valid across the whole session, so the editor
 * window can be made an owned window of the app: it stays above it, hides when
 * the app is minimised, and does not get left behind on the desktop.
 */
function ownerHandle() {
  try {
    const buffer = win?.getNativeWindowHandle()
    if (!buffer || !buffer.length) return 0
    return buffer.length >= 8 ? Number(buffer.readBigUInt64LE(0)) : buffer.readUInt32LE(0)
  } catch {
    return 0
  }
}

for (const cmd of ['gui-open', 'gui-place', 'gui-state', 'gui-close', 'gui-show']) {
  ipcMain.handle(`opdaw:plugin:${cmd}`, async (event, payload) => {
    try {
      const body = { ...(payload ?? {}) }
      const target = typeof body.path === 'string' ? body.path : ''
      const key = guiPaneKey(body)
      // The viewport rectangle is remembered before it is turned into screen
      // pixels: the app window's position is the other half of the answer, and
      // that half changes on its own when the producer drags the title bar.
      if (target && key && (cmd === 'gui-open' || cmd === 'gui-place') && body.rect) {
        guiPanes.set(key, { path: target, sessionId: body.sessionId, rect: { ...body.rect }, contents: event.sender })
        watchPluginPanes()
      } else if (cmd === 'gui-close' && key) guiPanes.delete(key)
      // Opening a GUI is where a plugin spends its first real work: an
      // installed-and-authorised AmpliTube takes seconds, and a worker that
      // faults inside it is answered by the supervisor, not by this timeout.
      if (body.rect) body.rect = screenRect(body.rect, event.sender)
      if (cmd === 'gui-open') body.owner = ownerHandle()
      return await plugins.request(cmd, body, cmd === 'gui-open' ? 120000 : 20000)
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) }
    }
  })
}

// ------------------------------------------------------ realtime bridge
/**
 * The pipe a live plugin runs through: the page builds a MessageChannel around
 * its own audio thread, the preload carries the far end here, and this side
 * answers it — either from the app's own process, or all the way through to the
 * process that holds the plugins.
 *
 * The direction is the whole point. A port sent *down* from here arrives in the
 * page as a proxy that an AudioWorklet refuses to take, so the page owns the
 * channel and the app owns only the end it was handed.
 *
 * The probe is what the test reads: the audio thread asks, this side answers,
 * and the thread counts how many frames of audio it had to render while waiting.
 * That count is what a live chain costs, in the producer's own units.
 */
const rtPipes = new Set()
ipcMain.on('opdaw:plugin:rt-handoff', (event) => {
  const port = event.ports?.[0]
  if (!port) return
  port.on('message', (message) => {
    const data = message.data ?? {}
    if (data.kind !== 'probe') return
    if (data.hop !== 'worker') {
      port.postMessage({ kind: 'probe-echo', hop: 'main' })
      return
    }
    // The long way: through the supervisor's queue into the process that has the
    // .dll loaded. The reply carries nothing but the fact that it arrived, which
    // is enough — the question is the wait, not the work.
    plugins
      .request('rt-probe', {}, 5000)
      .then(() => port.postMessage({ kind: 'probe-echo', hop: 'worker' }))
      .catch(() => port.postMessage({ kind: 'probe-echo', hop: 'worker', failed: true }))
  })
  port.start()
  rtPipes.add(port)
  // A channel the renderer built is closed when the renderer goes away; keeping
  // a dead port alive here would keep the plugin supervisor's queue warm for a
  // page that no longer exists.
  event.sender.once('destroyed', () => {
    rtPipes.delete(port)
    try {
      port.close()
    } catch {
      // Already gone.
    }
  })
})

// ----------------------------------------------------------------- ASIO
/**
 * O sink ASIO nativo. Os pedidos vão ao worker supervisionado; a porta de áudio
 * que o renderer construiu é transferida inteira a ele (o PCM não passa por
 * aqui). O status que o worker empurra segue para a janela duas vezes por
 * segundo, para a UI mostrar xruns e nível sem sondar.
 */
asioHost.setStatusSink((status) => win?.webContents.send('opdaw:asio:status', status))
asioHost.setCrashSink((info) => win?.webContents.send('opdaw:asio:crash', info))
ipcMain.handle('opdaw:asio:devices', () => asioHost.request('devices'))
ipcMain.handle('opdaw:asio:open', (_event, request) => asioHost.request('open', request ?? {}))
ipcMain.handle('opdaw:asio:close', () => asioHost.request('close'))
ipcMain.handle('opdaw:asio:status', () => asioHost.request('status'))
ipcMain.on('opdaw:asio:handoff', (event) => {
  const port = event.ports?.[0]
  if (port) asioHost.attachPort(port)
})
ipcMain.on('opdaw:asio:in-handoff', (event) => {
  const port = event.ports?.[0]
  if (port) asioHost.attachInPort(port)
})

// ----------------------------------------------------------------- window
function allowMedia(session) {
  session.setPermissionRequestHandler((_details, permission, callback) => {
    // A microphone and a MIDI controller are the point of this app; asking for
    // permission on every take is the failure mode, not the safety feature.
    // `audioOutput` is what lets the page name a speaker and route the mix to it
    // (setSinkId); without it the output list arrives without labels.
    callback(
      [
        'media',
        'audioCapture',
        'audioOutput',
        'midiSysex',
        'fullscreen',
      ].includes(permission),
    )
  })
}

/**
 * Confiar no certificado da sala que roda na rede local.
 *
 * O `node server.js` da sala usa certificado autoassinado, e um `import()` de
 * `https://192.168.x.x:5250/js/sala-sdk.js` dentro do app simplesmente falha — sem
 * aviso, porque não há barra de endereço onde aceitar. Em vez de desligar a
 * validação de TLS inteiro, isto vale apenas para endereços que não podem ser
 * públicos por definição: loopback, ranges privados (RFC1918), link-local,
 * `.local`/`.lan` e `localhost`. Um host de internet com certificado ruim continua
 * sendo recusado, exatamente como num navegador.
 */
const PRIVATE_HOST = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|localhost$|.+\.local$|.+\.lan$)/i

function trustLocalRooms(session) {
  // Electron entrega (event, webContents, url, error, certificate, callback).
  session.on('certificate-error', (event, _contents, url, error, _certificate, callback) => {
    const host = String(url || '')
      .replace(/^[a-z]+:\/\//i, '')
      .split('/')[0]
      .split('@')
      .pop()
      .replace(/:\d+$/, '')
    // Só um erro de certificado, num endereço que não pode ser público por
    // definição. DNS quebrado, conexão recusada e companhia seguem morrendo como
    // morriam antes — o que se resolve aqui é a autoassinatura da sala, nada mais.
    const certProblem = /^net::ERR_CERT/i.test(String(error || ''))
    if (certProblem && PRIVATE_HOST.test(host)) {
      event.preventDefault()
      callback(true)
      return
    }
    callback(false)
  })
}

async function createWindow() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    dialog.showErrorBox(
      'OpenDAW não encontrou o app',
      `Falta a pasta de arquivos gerados:\n${DIST}\n\nRode "npm run build" no projeto e abra de novo.`,
    )
    app.quit()
    return
  }

  server = await serve(DIST, readPreferredPort())
  writePreferredPort(server.port)

  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#1e222a',
    title: 'OpenDAW',
    // The portable build ships an icon next to this file; without one Windows
    // shows the generic Electron logo in the taskbar.
    icon: fs.existsSync(path.join(__dirname, 'icon.png')) ? path.join(__dirname, 'icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  buildMenu()
  allowMedia(win.webContents.session)
  trustLocalRooms(win.webContents.session)
  if (IS_SELFTEST) watchConsole()

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (server && url.startsWith(server.url)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    dialog.showErrorBox('O OpenDAW fechou a janela', `Motivo: ${details.reason}. Reabra o programa.`)
  })
  win.on('closed', () => {
    win = null
  })

  // A plugin's interface is a window of its own, and the app moving out from
  // under it is how it gets left behind on the desktop. Everything that changes
  // where the page's pane sits on the screen — the drag of the title bar, a
  // resize, a restore, a maximise, full screen, a monitor that changes scale —
  // has to send the plugin window after it, because none of those reach the page
  // as anything it would redraw. A drag fires `move` sixty times a second, so the
  // window events go through the pass that only acts when the frame really
  // changed; a monitor or a zoom changes pixels the frame cannot see, so those
  // ask for the placement outright.
  for (const name of [
    'move',
    'resize',
    'restore',
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen',
    'show',
  ]) {
    win.on(name, repositionPluginWindows)
  }
  for (const name of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(name, nudgePluginWindows)
  }
  win.webContents.on('zoom-changed', nudgePluginWindows)

  await win.loadURL(server.url)

  if (IS_SELFTEST) await runSelftest()
}

/** Console errors collected while the selftest page boots. */
const pageErrors = []

function watchConsole() {
  if (!win) return
  // Electron 45 hands the console message as an event object, not as arguments.
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') pageErrors.push(event.message)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    pageErrors.push(`renderer gone: ${details.reason}`)
  })
}

/**
 * Two seconds of material a plugin can actually chew on: a decaying saw on each
 * side plus a different sine, so a bounce that folded stereo onto mono shows up
 * as two unequal channel peaks rather than passing unnoticed.
 */
function testClipBase64(sampleRate = 48000, seconds = 2) {
  const frames = Math.floor(sampleRate * seconds)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate
    const env = Math.min(1, t * 6) * Math.exp(-t * 1.1)
    const sawL = 2 * (t * 110 - Math.floor(t * 110 + 0.5))
    const sawR = 2 * (t * 165 - Math.floor(t * 165 + 0.5))
    left[i] = (sawL * 0.3 + Math.sin(2 * Math.PI * 220 * t) * 0.3) * env
    right[i] = (sawR * 0.3 + Math.sin(2 * Math.PI * 277 * t) * 0.3) * env
  }
  return wav.encodeStereoFloat32(left, right, sampleRate).toString('base64')
}

/**
 * `npm start -- --selftest` opens the app, proves the page really booted, drives
 * the native plugin process once, and leaves a screenshot behind. This is the
 * check for the desktop build — it never touches the development browser tab.
 */
async function runSelftest() {
  const report = { steps: [], ok: true }
  const step = (name, value) => {
    report.steps.push(`${name}: ${value}`)
    if (value === false) report.ok = false
  }
  // Some lines are facts the test watched happen rather than assertions, and a
  // fact has no true/false attached to it.
  const note = (line) => report.steps.push(line)
  if (!win) return

  // The selftest window is never on screen, and Chromium refuses to hand back a
  // frame for a window it has stopped painting. Asking it to stay visible turns
  // the compositor back on; the retry is for the frame that is still in flight.
  win.show()
  win.setAlwaysOnTop(true, 'screen-saver')
  await new Promise((resolve) => setTimeout(resolve, 400))
  const grab = async (name) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const image = await win.webContents.capturePage()
        fs.writeFileSync(path.join(__dirname, name), image.toPNG())
        if (fs.existsSync(path.join(__dirname, name))) return true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    return false
  }

  try {
    const page = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 80 && !document.querySelector('.tcp-track'); i += 1) await waitFor(100);
      return {
        title: document.title,
        native: !!(window.OpenDAW && window.OpenDAW.native),
        tracks: document.querySelectorAll('.tcp-track').length,
        header: !!document.querySelector('.dock-header'),
        bodyText: (document.body.innerText || '').slice(0, 140).replace(/\\s+/g, ' '),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      };
    })()`)
    step('título', page.title)
    step('ponte nativa', page.native)
    step(`tracks na tela (${page.tracks})`, page.tracks > 0)
    step('sem estouro horizontal', !page.overflow)
    step('texto inicial', JSON.stringify(page.bodyText))
    step('console sem erros', pageErrors.length === 0 ? 'limpo' : pageErrors.slice(0, 5).join(' | '))
    if (pageErrors.length > 0) report.ok = false

    // What the page measures with, not what the machine says: the meter, the
    // count-in and the clock are all painted from the animation frame, so a page
    // that stops painting shows up as a silent report — every measurement at
    // zero, no code at fault. This leg found exactly that: with nothing asking
    // for frames, the test window went 'hidden' a few seconds in and the meter
    // legs below it read 0% for the rest of the run. The trace below therefore
    // does two things: it records when the page changed its mind (an event still
    // arrives in a hidden page), and by asking for a frame every frame it keeps
    // the page painting — which is what the legs that measure sound need. A real
    // producer who minimises the window still gets a frozen meter and a running
    // engine; that is the browser's power saving, not a bug to hide here.
    const fôlego = await win.webContents.executeJavaScript(`(async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      // A trace that outlives this leg. The moment the machine takes the window
      // away, the animation frame stops, and every measurement made afterwards
      // reads zero — so what matters is not only whether the page paints now, but
      // when it stopped: visibilitychange is an event, and an event still arrives
      // in a hidden page that no longer paints.
      const rastro = window.__opdawPinta || (window.__opdawPinta = { quadros: 0, virou: [] });
      if (!rastro.rodando) {
        rastro.rodando = true;
        const passo = () => { rastro.quadros += 1; requestAnimationFrame(passo); };
        requestAnimationFrame(passo);
        document.addEventListener('visibilitychange', () => {
          rastro.virou.push(document.visibilityState + '@' + Math.round(performance.now()) + 'ms');
        });
      }
      const janelas = [];
      for (let i = 0; i < 3; i += 1) {
        const antes = rastro.quadros;
        await esperar(300);
        janelas.push(rastro.quadros - antes);
      }
      return { vis: document.visibilityState, foco: document.hasFocus(),
        minimized: ${JSON.stringify(!!win.isMinimized())}, visivel: ${JSON.stringify(!!win.isVisible())},
        quadro: ${JSON.stringify(`${win.getBounds().width}x${win.getBounds().height}`)},
        fps: janelas.join('/'), quadros: rastro.quadros, virou: rastro.virou.join(' ') };
    })()`)
    step(
      'a página pinta (quadros em 3 janelas de 300ms, janela minimizada?)',
      `fps ${fôlego.fps} · ${fôlego.vis}${fôlego.foco ? ' com foco' : ' sem foco'} · ` +
        `app ${fôlego.visivel ? 'visível' : 'escondida'}${fôlego.minimized ? ' e MINIMIZADA' : ''} · ${fôlego.quadro}` +
        `${fôlego.virou ? ` · virou ${fôlego.virou}` : ''}`,
    )

    // A previous run that was interrupted — a plugin that took the process down,
    // a window closed by hand — leaves its clip and its takes in the app's own
    // session, and the next test then reads that as a broken product. Start from
    // an empty project: every step below writes what it needs and asserts on it.
    win.webContents.send('opdaw:menu', 'new-project')
    const cleanStart = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 150 && document.querySelector('.arrangement-lane .audio-item'); i += 1) await waitFor(100);
      await waitFor(300);
      return !document.querySelector('.arrangement-lane .audio-item');
    })()`)
    step('começa com a sessão limpa', cleanStart)

    // Device detection has exactly one home per shell: the page's Devices menu
    // and, here, the executable's own Dispositivos bar. Nothing may survive on a
    // lane or on the header strip, and the monitor is a headphone, not a word.
    const devices = await win.webContents.executeJavaScript(`(() => {
      const text = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
      const items = [...document.querySelectorAll('.menu-item')]
        .filter((item) => text(item.querySelector(':scope > span')) === 'Devices')
        .flatMap((item) => [...item.querySelectorAll('.dropdown > button')].map(text));
      const detected = [...document.querySelectorAll('button')]
        .filter((button) => /detectar/i.test(text(button)))
        .map((button) => text(button));
      const mon = [...document.querySelectorAll('.mon-btn')].map((button) => ({
        label: text(button),
        wide: Math.round(button.getBoundingClientRect().width),
      }));
      return { items, detected, mon, before: text(document.querySelector('.toast')) };
    })()`)
    step(
      `Detectar só em Devices (${devices.detected.join(' / ') || 'nenhum'})`,
      devices.detected.length === devices.items.filter((t) => /detectar/i.test(t)).length &&
        devices.items.some((t) => /detectar/i.test(t)),
    )
    step(`  menu Devices: ${JSON.stringify(devices.items)}`, devices.items.length > 0)
    step(
      `monitor é fone de ouvido (${devices.mon.map((m) => `${m.label} ${m.wide}px`).join(', ')})`,
      devices.mon.length > 0 && devices.mon.every((m) => m.label === '🎧'),
    )

    // The other half of the bridge: the native item has to reach the page's own
    // handler, which is the one that asks for the microphone and counts devices.
    win.webContents.send('opdaw:menu', 'refresh-inputs')
    const menuToast = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 80; i += 1) {
        await waitFor(100);
        const now = (document.querySelector('.toast')?.textContent || '').replace(/\\s+/g, ' ').trim();
        // Wait for the answer itself, not merely for a different toast: the app
        // posts its own start-up notices while this is running.
        if (/entrada/i.test(now)) return now.slice(0, 90);
      }
      return '';
    })()`)
    step(`  Dispositivos ▸ Detectar respondeu: ${JSON.stringify(menuToast)}`, /entrada/i.test(menuToast))

    // ------------------------------------------------------------------ a entrada ao vivo
    // The question the producer actually asks is not "does the list have rows" but
    // "does the sound get in". With Chromium's fake capture device the page holds a
    // real MediaStream with a real device id, so the patch, the channel row, the
    // monitor lamp and the recorder are measured against audio instead of against
    // a promise: the take on the lane has to carry bars, not merely exist.
    //
    // There is one printing choice now, and it is the lamp. A lane with a cable
    // opened hears itself through its effects while it plays, and the take it
    // writes is the raw input — so the leg that used to click SECO/FX measures the
    // same thing from the other side: the button must be gone, and the audio must
    // still arrive.
    const live = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const text = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
      const pick = (select, value) => {
        const write = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        write.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const listing = (select) => [...select.options].map((o) => o.value + ':' + text(o));
      const out = {
        dispositivo: '', entradas: [], canais: '', escuta: '', gravando: '',
        monitor: false, botoesSecco: -1, clipe: false, barras: 0, pico: 0,
      };
      const sel = document.querySelector('.input-select');
      if (!sel) return out;
      out.entradas = listing(sel);
      // The app's own cables sit at the top of the list, and a test session has
      // nothing playing through the master (or the room) while this leg records —
      // a take patched to either would be silence, and the silence would look
      // like a broken input. This leg measures the microphone path, so it asks
      // for a device that is not an internal cable; each cable has a leg of its
      // own below.
      const notCable = (o) =>
        o.value && !o.disabled && o.value !== 'opdaw:master-cable' && o.value !== 'opdaw:sala-return';
      const anyReal = (o) => o.value && !o.disabled;
      const real = [...sel.options].find(notCable) ?? [...sel.options].find(anyReal);
      if (!real) return out;
      out.dispositivo = text(real);
      pick(sel, real.value);
      for (let i = 0; i < 60 && !document.querySelector('.ch-select'); i += 1) await waitFor(100);
      const ch = document.querySelector('.ch-select');
      if (!ch) return out;
      out.canais = listing(ch).join(' / ');
      // The printing choice is gone from the lane: no segmented buttons survive on
      // any track row, and the second patch row holds nothing but the channel.
      out.botoesSecco = document.querySelectorAll('.ch-seg-btn').length;
      const mon = document.querySelector('.tcp-track .mon-btn');
      if (mon && !mon.classList.contains('on')) {
        mon.click();
        for (let i = 0; i < 40; i += 1) {
          await waitFor(50);
          if (document.querySelector('.tcp-track .mon-btn')?.classList.contains('on')) break;
        }
      }
      out.monitor = document.querySelector('.tcp-track .mon-btn')?.classList.contains('on') === true;
      // The lamp's own warning is the promise being kept: opening the monitor means
      // the room is live, and the app says so. Wait for it instead of reading
      // whatever toast the patch left behind.
      for (let i = 0; i < 40 && !/fone/i.test(text(document.querySelector('.toast'))); i += 1) {
        await waitFor(50);
      }
      out.escuta = text(document.querySelector('.toast')).slice(0, 64);
      const arm = document.querySelector('.tcp-track .btn-arm');
      if (arm) arm.click();
      await waitFor(250);
      const rec = document.querySelector('.btn-rec');
      if (!rec) return out;
      rec.click();
      for (let i = 0; i < 60 && !/gravando/i.test(text(document.querySelector('.toast'))); i += 1) {
        await waitFor(100);
      }
      out.gravando = text(document.querySelector('.toast')).slice(0, 72);
      await waitFor(2000);
      rec.click();
      for (let i = 0; i < 90 && !document.querySelector('.audio-item .waveform'); i += 1) await waitFor(100);
      out.clipe = !!document.querySelector('.audio-item .waveform');
      const bars = [...document.querySelectorAll('.audio-item .waveform rect')].map(
        (rect) => Number(rect.getAttribute('height')) || 0,
      );
      out.barras = bars.filter((h) => h > 6).length;
      out.pico = bars.length ? Math.max(...bars) : 0;
      return out;
    })()`)
    step(`  entrada de verdade na lista (${live.dispositivo || JSON.stringify(live.entradas)})`, Boolean(live.dispositivo))
    step(`  canais oferecidos na lane: ${JSON.stringify(live.canais)}`, live.canais !== '')
    step(
      `  sem escolha de impressão na lane (${live.botoesSecco} botão(ões) SECO/FX)`,
      live.botoesSecco === 0,
    )
    step(`  MON abriu a escuta ao vivo: ${JSON.stringify(live.escuta)}`, live.monitor && /fone/i.test(live.escuta))
    step(`  gravador abriu: ${JSON.stringify(live.gravando)}`, /gravando/i.test(live.gravando))
    step(
      `  a entrada encheu o clipe (${live.barras} barra(s), pico ${live.pico})`,
      live.clipe && live.barras > 4 && live.pico > 6,
    )
    step(`  foto da captura ao vivo`, await grab('selftest-live-input.png'))

    // ------------------------------------------------------------ a contagem de compasso
    // The count is the part a producer reads with headphones on and eyes elsewhere,
    // so it is checked as a thing that happens on the screen: the bar of clicks has
    // to paint 4·3·2·1, say that the recorder is waiting for the downbeat, and only
    // then drop into record.
    const count = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const text = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
      const out = { ligado: false, numeros: [], aviso: '', gravando: '', rodando: false, parou: false };
      const toggle = [...document.querySelectorAll('.transport-btn')].find(
        (b) => text(b) === '1234',
      );
      if (!toggle) return out;
      // The leg above may have left the transport rolling, and a count-in only
      // happens when record starts from a stopped song — so park it first.
      const play = document.querySelector('.btn-play');
      if (play?.classList.contains('active')) {
        play.click();
        for (let i = 0; i < 40 && play.classList.contains('active'); i += 1) await waitFor(100);
      }
      toggle.click();
      // React commits the toggle one tick later, and it is the committed state —
      // not the DOM class — that the record button reads. Without this wait the
      // leg silently takes the plain continuous-record path and counts nothing.
      for (let i = 0; i < 20 && !toggle.classList.contains('on'); i += 1) await waitFor(50);
      out.ligado = toggle.classList.contains('on');
      const rec = document.querySelector('.btn-rec');
      if (!rec) return out;
      rec.click();
      // Two bars of watching is enough for a one-bar count and the take after it.
      for (let i = 0; i < 90; i += 1) {
        const n = document.querySelector('.count-num');
        if (n) {
          const value = text(n);
          if (out.numeros[out.numeros.length - 1] !== value) out.numeros.push(value);
          if (!out.aviso) out.aviso = text(document.querySelector('.count-cap'));
        }
        // "Gravando em N track(s) desde o 1º tempo" is the take landing on the
        // downbeat. Matching on "gravando" too is what separates it from the
        // arming toast ("o gravador abre no 1º tempo"), which appears at once and
        // would otherwise cut the watching short before a single number painted,
        // and from the plain path's "gravação contínua".
        const toast = text(document.querySelector('.toast'));
        if (/gravando.*1º tempo/i.test(toast)) {
          out.gravando = toast.slice(0, 72);
          break;
        }
        await waitFor(60);
      }
      await waitFor(700);
      // The lane already carries a take from the leg above and one clip per lane is
      // what this build does, so the proof that the second pass really ran is the
      // recorder's own light, not a new clip appearing.
      out.rodando = rec.classList.contains('recording')
      rec.click();
      for (let i = 0; i < 40 && rec.classList.contains('recording'); i += 1) await waitFor(100);
      out.parou = !rec.classList.contains('recording');
      await waitFor(400);
      return out;
    })()`)
    step(`  count-in ligado pelo botão 1234`, count.ligado)
    step(`  a tela contou ${JSON.stringify(count.numeros)}`, count.numeros.join('') === '4321')
    step(`  e avisou que ia gravar: ${JSON.stringify(count.aviso)}`, /1º TEMPO/i.test(count.aviso))
    step(`  caiu no gravador no tempo: ${JSON.stringify(count.gravando)}`, /1º tempo/i.test(count.gravando))
    step(`  girou e parou quando mandado parar (${count.rodando} → ${count.parou})`, count.rodando && count.parou)
    await grab('selftest-count-in.png')

    // Both legs above record for real, and that leaves two kinds of mess behind: a
    // take sitting on a lane, which the bounce leg below would count as one of its
    // own, and an undo stack, which the native-menu leg expects to find disabled.
    // Ctrl+Z until the stack runs out is the way out — "Novo projeto" was tried
    // first and it clears the sample store along with the arrangement, which left
    // the bounce leg below holding a clip whose audio was no longer anywhere.
    const pageUndoState = () =>
      win.webContents.executeJavaScript(`(() => {
        const row = [...document.querySelectorAll('.dropdown button')]
          .find((b) => /Desfazer/.test(b.textContent || ''));
        return {
          dirty: !!document.querySelector('.arrangement-lane .audio-item, .take-actions'),
          tracks: document.querySelectorAll('.tcp-track').length,
          undoDisabled: row ? row.disabled === true : true,
          label: row ? (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 20) : '(sem linha)',
        };
      })()`)
    const renewProject = async () => {
      await win.webContents.executeJavaScript(`(async () => {
        const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const play = document.querySelector('.btn-play');
        if (play?.classList.contains('active')) {
          play.click();
          for (let i = 0; i < 40 && play.classList.contains('active'); i += 1) await waitFor(100);
        }
        return true;
      })()`)
      for (let i = 0; i < 60; i += 1) {
        const state = await pageUndoState()
        if (!state.dirty && state.undoDisabled) break
        win.webContents.send('opdaw:menu', 'undo')
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      return pageUndoState()
    }
    const renewed = await renewProject()
    step(
      `  o projeto volta limpo antes das pernas de plugin (lane ${renewed.dirty ? 'com sobra' : 'vazia'}, ${renewed.tracks} track(s), pilha ${JSON.stringify(renewed.label)})`,
      !renewed.dirty && renewed.tracks > 0 && renewed.undoDisabled,
    )

    // ------------------------------------------------------------ o metrônomo
    // A click that only exists in the code is not a metronome. The lanes are empty
    // again and nothing is patched, so whatever moves the master meter here is the
    // click itself: the level has to rise on the beat and fall back between beats,
    // and the number of rises tells whether it really keeps time.
    const metro = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const text0 = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
      const level = () => {
        const fill = document.querySelector('.mcp-channel.master .mcp-meter-fill');
        return fill ? Number(String(fill.style.height || '').replace('%', '')) || 0 : 0;
      };
      const out = { ligado: false, base: 0, picoChao: 0, pico: 0, batidas: 0, voltou: false, parou: false, desligado: false, medidor: false, caiu: false, fim: 0, quieto: false, tocava: false, antes: 0 };
      out.medidor = !!document.querySelector('.mcp-channel.master .mcp-meter-fill');
      const metroBtn = [...document.querySelectorAll('.transport-btn')].find((b) => text0(b) === '♪');
      const play = document.querySelector('.btn-play');
      const stop = [...document.querySelectorAll('.transport-btn')].find((b) => text0(b) === '◼');
      if (!metroBtn || !play) return out;
      // Silence first: the floor this leg measures against, in this machine, now.
      // Two things keep the master bus loud after the legs above — a transport left
      // running and a monitor lamp still lit. The lamp is the whole story on a live
      // input now: there is no second door from the microphone into the mix, so
      // closing it really does close the room.
      out.tocava = play.classList.contains('active');
      if (out.tocava) {
        if (stop) stop.click(); else play.click();
        for (let i = 0; i < 40 && play.classList.contains('active'); i += 1) await waitFor(100);
      }
      for (const lane of document.querySelectorAll('.tcp-track')) {
        const mon = lane.querySelector('.mon-btn');
        if (mon?.classList.contains('on')) mon.click();
        const arm = lane.querySelector('.btn-arm');
        if (arm?.classList.contains('armed')) arm.click();
      }
      await waitFor(400);
      // The floor is the quietest window of ten samples, not the single lowest
      // frame: one lazy meter frame must not read as a silent room next to a
      // microphone that is still talking. picoChao says whether what is left is
      // continuous sound or a stray frame the analyser had not released.
      const traco = [];
      for (let i = 0; i < 40; i += 1) { traco.push(level()); await waitFor(40); }
      let floor = 100;
      for (let i = 0; i + 10 <= traco.length; i += 1) {
        let windowMax = 0;
        for (let k = 0; k < 10; k += 1) windowMax = Math.max(windowMax, traco[i + k]);
        floor = Math.min(floor, windowMax);
      }
      out.base = floor;
      out.picoChao = Math.max(...traco);
      out.quieto = floor <= 6;
      out.antes = level();
      metroBtn.click();
      for (let i = 0; i < 20 && !metroBtn.classList.contains('on'); i += 1) await waitFor(50);
      out.ligado = metroBtn.classList.contains('on');
      play.click();
      let above = false;
      for (let i = 0; i < 90; i += 1) {
        const at = level();
        out.pico = Math.max(out.pico, at);
        const threshold = Math.min(99, Math.max(out.base + 4, 6));
        if (!above && at > threshold) { above = true; out.batidas += 1; }
        else if (above && at <= threshold) { above = false; out.voltou = true; }
        await waitFor(30);
      }
      if (stop) stop.click();
      for (let i = 0; i < 30 && play.classList.contains('active'); i += 1) await waitFor(100);
      out.parou = !play.classList.contains('active');
      metroBtn.click();
      for (let i = 0; i < 20 && metroBtn.classList.contains('on'); i += 1) await waitFor(50);
      out.desligado = !metroBtn.classList.contains('on');
      // Then let the meter fall all the way back. A leg that leaves the master
      // pinned at its peak would hand the next legs a level that is not playing,
      // and the sala meters read the same bus.
      out.caiu = false;
      const settle = Math.min(99, Math.max(out.base + 4, 6));
      for (let i = 0; i < 60; i += 1) {
        if (level() <= settle) { out.caiu = true; break; }
        await waitFor(50);
      }
      out.fim = level();
      return out;
    })()`)
    step(
      `  metrônomo ligado pelo botão ♪ (${metro.medidor ? 'medidor da master na tela' : 'SEM medidor da master'})`,
      metro.ligado && metro.medidor,
    )
    step(
      `  a medição começa em silêncio (chão ${metro.base}%, pico do chão ${metro.picoChao}%, ${metro.tocava ? 'vinha tocando' : 'parado'})`,
      metro.quieto,
    )
    step(
      `  o clique mexe a saída (base ${metro.base}%, pico ${metro.pico}%, ${metro.batidas} subida(s) em ~2,7s)`,
      metro.pico > Math.min(99, Math.max(metro.base, 0) + 4) && metro.batidas >= 2,
    )
    step(`  e volta ao silêncio entre os cliques`, metro.voltou)
    step(`  parou com o ◼ e o ♪ foi desligado (${metro.parou} → ${metro.desligado})`, metro.parou && metro.desligado)
    step(`  e o medidor da master volta ao chão (${metro.fim}%, limiar ${Math.max(metro.base + 4, 6)}%)`, metro.caiu)

    // ------------------------------------------------------------ a saída
    // The window that names the microphone also names the exit, and routing is
    // only half the promise: as soon as the chosen card accepts the mix the engine
    // takes the default road away, so the click has to still move the meter with
    // the graph hanging off an <audio> element instead of the context destination.
    const rota = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const text = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
      const level = () => {
        const fill = document.querySelector('.mcp-channel.master .mcp-meter-fill');
        return fill ? Number(String(fill.style.height || '').replace('%', '')) || 0 : 0;
      };
      const pick = (select, value) => {
        const write = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        write.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const out = {
        janela: false, saidas: [], escolhida: '', roteada: '', ms: [], pico: 0,
        deVolta: '', nota: '', erro: '', bate: false, fechou: false,
      };
      const abrir = [...document.querySelectorAll('.dropdown button')]
        .find((b) => /Dispositivos de .udio/.test(b.textContent || ''));
      if (!abrir) return out;
      abrir.click();
      for (let i = 0; i < 40 && !document.querySelector('.dev-select'); i += 1) await waitFor(50);
      const sel = document.querySelector('.dev-select');
      out.janela = !!sel;
      if (!sel) return out;
      out.saidas = [...sel.options].filter((o) => o.value).map((o) => text(o));
      out.nota = [...document.querySelectorAll('.dev-section .plugin-note')].map(text).join(' | ').slice(0, 170);
      out.ms = [...document.querySelectorAll('.dev-ms')].map((n) => text(n));
      const real = out.saidas.length ? [...sel.options].find((o) => o.value) : null;
      if (real) {
        pick(sel, real.value);
        for (let i = 0; i < 40 && !/saindo por|recusada/.test(text(document.querySelector('.dev-latency'))); i += 1) {
          await waitFor(50);
        }
        out.escolhida = text(real);
        out.roteada = text(document.querySelector('.dev-latency')).slice(0, 96);
        out.erro = text(document.querySelector('.plugin-note.error')).slice(0, 96);
        // The name the window reports has to be the playback row that was chosen,
        // not whichever device happened to answer with the same id.
        out.bate = out.escolhida !== '' && out.roteada.includes(out.escolhida);
        const metroBtn = [...document.querySelectorAll('.transport-btn')].find((b) => text(b) === '♪');
        const play = document.querySelector('.btn-play');
        if (metroBtn && play) {
          if (!metroBtn.classList.contains('on')) metroBtn.click();
          for (let i = 0; i < 20 && !metroBtn.classList.contains('on'); i += 1) await waitFor(50);
          play.click();
          for (let i = 0; i < 60; i += 1) { out.pico = Math.max(out.pico, level()); await waitFor(30); }
          const stop = [...document.querySelectorAll('.transport-btn')].find((b) => text(b) === '◼');
          if (stop) stop.click(); else play.click();
          for (let i = 0; i < 40 && play.classList.contains('active'); i += 1) await waitFor(100);
          metroBtn.click();
          for (let i = 0; i < 20 && metroBtn.classList.contains('on'); i += 1) await waitFor(50);
        }
        pick(sel, '');
        for (let i = 0; i < 40 && !/padr.ão/.test(text(document.querySelector('.dev-latency'))); i += 1) await waitFor(50);
        out.deVolta = text(document.querySelector('.dev-latency')).slice(0, 80);
      }
      const fechar = [...document.querySelectorAll('.devices-window .reaper-btn')].find((b) => text(b) === 'X');
      if (fechar) fechar.click();
      for (let i = 0; i < 20 && document.querySelector('.devices-window'); i += 1) await waitFor(50);
      out.fechou = !document.querySelector('.devices-window');
      return out;
    })()`)
    const rotaFeita = rota.saidas.length > 0
    step(
      `  janela de Dispositivos aberta, saída listada: ${rotaFeita ? JSON.stringify(rota.escolhida) : `(${JSON.stringify(rota.nota)})`}`,
      rota.janela && (rotaFeita || /nenhuma saída nomeada/i.test(rota.nota)),
    )
    step(
      `  o mix aceita a saída e diz o nome dela: ${JSON.stringify(rota.roteada || rota.erro || rota.nota)}`,
      rotaFeita ? /saindo por/.test(rota.roteada) && rota.erro === '' && rota.bate : true,
    )
    step(
      `  com a saída trocada o clique ainda mexe a master (pico ${rota.pico}%)`,
      rotaFeita ? rota.pico > 6 : true,
    )
    step(
      `  e volta pelo caminho padrão ao devolver (${JSON.stringify(rota.deVolta || rota.nota)})`,
      rotaFeita ? /padr/.test(rota.deVolta) : true,
    )
    step(`  latência lida na janela: ${JSON.stringify(rota.ms)}`, rota.ms.length >= 2)
    step(`  a janela fecha pelo X`, rota.fechou)

    // ------------------------------------------------------------------ o cabo do master
    // The in-app cable is the one input that is always there: no permission, no
    // driver, nothing unplugged. Patched into a lane it has to carry what the desk
    // sends out, so it is measured the same way as a microphone — record while
    // something plays and look for it in the take. The click is the signal here:
    // the lanes are empty at this point, and the metronome is scheduled straight
    // into the master fader, so the cable and the meter see the same audio. The
    // lamp stays shut on purpose: a monitor opened on a lane fed by the master is a
    // howling loop, which is exactly what the app warns the producer about.
    const cabo = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const text = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
      const level = () => {
        const fill = document.querySelector('.mcp-channel.master .mcp-meter-fill');
        return fill ? Number(String(fill.style.height || '').replace('%', '')) || 0 : 0;
      };
      const pick = (select, value) => {
        const write = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        write.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const out = { plug: '', roteiro: false, salaOption: false, jackFora: false, lampada: false, gravando: '', masterPico: 0,
                    clipe: false, barras: 0, pico: 0, desligou: false };
      const sel = document.querySelector('.input-select');
      if (!sel) return out;
      pick(sel, 'opdaw:master-cable');
      for (let i = 0; i < 60 && !/master/i.test(text(sel.selectedOptions[0])); i += 1) await waitFor(50);
      out.plug = text(sel.selectedOptions[0]);
      out.roteiro = sel.value === 'opdaw:master-cable';
      out.salaOption = [...sel.options].some((o) => o.value === 'opdaw:sala-return');
      out.jackFora = !document.querySelector('.btn-sala');
      const mon = document.querySelector('.tcp-track .mon-btn');
      if (mon?.classList.contains('on')) {
        mon.click();
        for (let i = 0; i < 40 && mon.classList.contains('on'); i += 1) await waitFor(50);
      }
      out.lampada = mon?.classList.contains('on') === true;
      for (let i = 0; i < 40 && level() > 6; i += 1) await waitFor(50);
      const metro = [...document.querySelectorAll('.transport-btn')].find((b) => text(b) === '♪');
      const stop = [...document.querySelectorAll('.transport-btn')].find((b) => text(b) === '◼');
      if (metro && !metro.classList.contains('on')) {
        metro.click();
        for (let i = 0; i < 20 && !metro.classList.contains('on'); i += 1) await waitFor(50);
      }
      const arm = document.querySelector('.tcp-track .btn-arm');
      if (arm && !arm.classList.contains('armed')) arm.click();
      await waitFor(250);
      const rec = document.querySelector('.btn-rec');
      if (!rec) return out;
      rec.click();
      for (let i = 0; i < 60 && !/gravando/i.test(text(document.querySelector('.toast'))); i += 1) {
        await waitFor(100);
      }
      out.gravando = text(document.querySelector('.toast')).slice(0, 72);
      // Three seconds of clicks: enough for the cable to carry a beat or two into
      // the take, short enough that the loop never gets to feed itself.
      for (let i = 0; i < 60; i += 1) { out.masterPico = Math.max(out.masterPico, level()); await waitFor(50); }
      rec.click();
      for (let i = 0; i < 90 && !document.querySelector('.audio-item .waveform'); i += 1) await waitFor(100);
      out.clipe = !!document.querySelector('.audio-item .waveform');
      const bars = [...document.querySelectorAll('.audio-item .waveform rect')].map(
        (rect) => Number(rect.getAttribute('height')) || 0,
      );
      out.barras = bars.filter((h) => h > 6).length;
      out.pico = bars.length ? Math.max(...bars) : 0;
      if (stop) stop.click();
      for (let i = 0; i < 30 && document.querySelector('.btn-play')?.classList.contains('active'); i += 1) {
        await waitFor(100);
      }
      if (metro?.classList.contains('on')) {
        metro.click();
        for (let i = 0; i < 20 && metro.classList.contains('on'); i += 1) await waitFor(50);
      }
      out.desligou = metro ? !metro.classList.contains('on') : true;
      return out;
    })()`)
    step(
      `  o cabo do master aparece como entrada: ${JSON.stringify(cabo.plug)}`,
      cabo.roteiro && /master/i.test(cabo.plug),
    )
    step(
      `  o retorno da sala também é entrada (opção ${cabo.salaOption}) e o jack saiu da mesa (fora ${cabo.jackFora})`,
      cabo.salaOption && cabo.jackFora,
    )
    step(
      `  escuta fechada no cabo (sem laço): lampada ${cabo.lampada}, ♪ desligado ${cabo.desligou}`,
      cabo.lampada === false && cabo.desligou === true,
    )
    step(
      `  gravando do cabo: ${JSON.stringify(cabo.gravando)} (medidor da tela ${cabo.masterPico}%)`,
      /gravando/i.test(cabo.gravando),
    )
    // The take is the proof, not the meter: the fill on the screen is painted by
    // requestAnimationFrame, and a page that is hidden or covered stops painting
    // while the recorder keeps sampling. So the level read here is printed as
    // company for the line above, and the gate is the audio that actually landed
    // on the lane.
    step(
      `  o clipe saiu do mix da master (${cabo.barras} barra(s), pico ${cabo.pico})`,
      cabo.clipe && cabo.barras > 0 && cabo.pico > 6,
    )
    step(`  foto do take vindo do cabo`, await grab('selftest-master-cable.png'))

    // The cable has to read as a device, not as a feature: the Devices window is
    // where a producer goes to find out what is plugged where, so the row that
    // names it has to be there, say which lane is wearing it, and stay inside the
    // window when the list gets long.
    const ficha = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const text = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
      const out = { abriu: false, nome: '', meta: '', uso: '', salaNome: '', salaMeta: '', salaUso: '', cabe: false, fora: 0, fecha: false };
      const btn = [...document.querySelectorAll('button')].find((b) =>
        /Entradas, saídas e latência/.test(b.title || ''),
      );
      if (!btn) return out;
      btn.click();
      let janela = null;
      for (let i = 0; i < 60; i += 1) {
        await waitFor(50);
        janela = document.querySelector('.devices-window');
        if (janela) break;
      }
      if (!janela) return out;
      out.abriu = true;
      const seccao = [...janela.querySelectorAll('.dev-section')].find((s) =>
        /Cabos virtuais/.test(text(s.querySelector('.dev-title'))),
      );
      const linhas = seccao ? [...seccao.querySelectorAll('.dev-row')] : [];
      const linha = linhas[0];
      if (linha) {
        out.nome = text(linha.querySelector('.dev-name'));
        out.meta = text(linha.querySelector('.dev-meta'));
        out.uso = text(linha.querySelector('.dev-users'));
      }
      const corpo = janela.querySelector('.fx-body');
      if (corpo) corpo.scrollTop = corpo.scrollHeight;
      await waitFor(150);
      // A última linha da seção é o retorno da sala: com a lista rolada até o
      // fim, é ela que tem que estar inteira dentro da janela — a primeira pode
      // ter subido para fora de propósito, que é o que a rolagem serve pra fazer.
      const salaLinha = linhas[linhas.length - 1];
      if (salaLinha && linhas.length > 1) {
        out.salaNome = text(salaLinha.querySelector('.dev-name'));
        out.salaMeta = text(salaLinha.querySelector('.dev-meta'));
        out.salaUso = text(salaLinha.querySelector('.dev-users'));
      }
      if (salaLinha && corpo) {
        const jr = janela.getBoundingClientRect();
        const lr = salaLinha.getBoundingClientRect();
        out.fora = Math.round(lr.bottom - jr.bottom);
        out.cabe = lr.top >= jr.top - 1 && lr.bottom <= jr.bottom + 1;
      }
      const x = [...janela.querySelectorAll('.midi-tools button')].find((b) => /^X$/.test(text(b)));
      if (x) x.click();
      for (let i = 0; i < 40; i += 1) {
        await waitFor(50);
        if (!document.querySelector('.devices-window')) break;
      }
      out.fecha = !document.querySelector('.devices-window');
      return out;
    })()`)
    step(
      `  a janela de Dispositivos nomeia o cabo: ${JSON.stringify(ficha.nome)} / ${JSON.stringify(ficha.meta)}`,
      ficha.abriu && /Cabo virtual/.test(ficha.nome) && /GTR/.test(ficha.meta),
    )
    step(
      `  e o que passa por ele está dito: ${JSON.stringify(ficha.uso)}`,
      /gravando a mesa inteira|ninguém escutando/.test(ficha.uso),
    )
    step(
      `  a sala tem a sua linha: ${JSON.stringify(ficha.salaNome)} / ${JSON.stringify(ficha.salaMeta)}`,
      /Retorno da sala/.test(ficha.salaNome) && /desligado|esperando a sala|sala no ar/.test(ficha.salaMeta),
    )
    step(
      `  a linha do retorno cabe na janela (fora ${ficha.fora}px, fechou ${ficha.fecha})`,
      ficha.cabe && ficha.fecha,
    )

    // The room return as a lane input, proven without a room: a synthetic
    // participant (an oscillator into a MediaStream, the same shape the SDK
    // hands over) enters through `connectCallReturn` with the listening gain
    // shut. The cable sums the sources before that gain, so the take has to
    // print the tone even though nobody is monitoring it — a device records
    // what the room sends, not what the producer chose to hear.
    const voltaSala = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const text = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
      const pick = (select, value) => {
        const write = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        write.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const out = { motor: false, plug: '', gravando: '', clipe: false, barras: 0, pico: 0, escuta: null, soltou: false };
      // O engine só aparece como prop de um componente montado (RecordHud durante
      // a gravação, SalaCableWindow quando a sala está montada). Nesta perna nenhum
      // dos dois existe ainda, então montamos a janela da sala pelo menu — ela não
      // liga em servidor nenhum sozinha, só expõe o engine no fiber — e a deixamos
      // montada (escondida) para a caminhada achar a testemunha.
      const menuSala = document.querySelector('.menu-sala');
      if (menuSala) menuSala.click();
      const achaEngine = () => {
        const raiz = document.querySelector('#root') || document.body;
        const chave = Object.keys(raiz).find(
          (k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'),
        );
        const fila = chave ? [raiz[chave]] : [];
        let cand = null;
        while (fila.length && !cand) {
          const no = fila.shift();
          const e = no?.memoizedProps?.engine;
          if (e?.getCallSendLevel && e?.getCallReturnLevel && e?.callReturnKeys) cand = e;
          if (no?.child) fila.push(no.child);
          if (no?.sibling) fila.push(no.sibling);
          if (fila.length > 6000) break;
        }
        return cand;
      };
      let eng = null;
      for (let i = 0; i < 40 && !eng; i += 1) {
        eng = achaEngine();
        if (!eng) await waitFor(50);
      }
      if (!eng) return out;
      // Esconde a janela (sem desmontar) para ela não cobrir a mesa durante o take.
      const fechaSala = document.querySelector('.sala-window .fx-header button');
      if (fechaSala) fechaSala.click();
      out.motor = true;
      const sel = document.querySelector('.input-select');
      if (!sel) return out;
      pick(sel, 'opdaw:sala-return');
      for (let i = 0; i < 60 && sel.value !== 'opdaw:sala-return'; i += 1) await waitFor(50);
      out.plug = text(sel.selectedOptions[0]);
      const mon = document.querySelector('.tcp-track .mon-btn');
      if (mon?.classList.contains('on')) {
        mon.click();
        for (let i = 0; i < 40 && mon.classList.contains('on'); i += 1) await waitFor(50);
      }
      // O participante sintético: tom contínuo, escuta fechada (listen=false).
      const ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      osc.frequency.value = 260;
      const gain = ctx.createGain();
      gain.gain.value = 0.3;
      const sink = ctx.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(sink);
      osc.start();
      eng.connectCallReturn('selftest:sala', sink.stream, false);
      out.escuta = eng.getCallReturnGain('selftest:sala');
      await waitFor(300);
      const arm = document.querySelector('.tcp-track .btn-arm');
      if (arm && !arm.classList.contains('armed')) arm.click();
      await waitFor(250);
      const rec = document.querySelector('.btn-rec');
      const stop = [...document.querySelectorAll('.transport-btn')].find((b) => text(b) === '◼');
      if (!rec) { osc.stop(); ctx.close().catch(() => {}); return out; }
      rec.click();
      for (let i = 0; i < 60 && !/gravando/i.test(text(document.querySelector('.toast'))); i += 1) {
        await waitFor(100);
      }
      out.gravando = text(document.querySelector('.toast')).slice(0, 72);
      await waitFor(2500);
      rec.click();
      for (let i = 0; i < 90 && !document.querySelector('.audio-item .waveform'); i += 1) await waitFor(100);
      out.clipe = !!document.querySelector('.audio-item .waveform');
      const bars = [...document.querySelectorAll('.audio-item .waveform rect')].map(
        (rect) => Number(rect.getAttribute('height')) || 0,
      );
      out.barras = bars.filter((h) => h > 6).length;
      out.pico = bars.length ? Math.max(...bars) : 0;
      if (stop) stop.click();
      for (let i = 0; i < 30 && document.querySelector('.btn-play')?.classList.contains('active'); i += 1) {
        await waitFor(100);
      }
      eng.disconnectCallReturn('selftest:sala');
      osc.stop();
      ctx.close().catch(() => {});
      out.soltou = !eng.callReturnKeys().includes('selftest:sala');
      return out;
    })()`)
    step(
      `  o retorno da sala grava numa faixa comum: ${JSON.stringify(voltaSala.plug)} (escuta do canal ${voltaSala.escuta}, take ${voltaSala.barras} barra(s), pico ${voltaSala.pico})`,
      voltaSala.motor && /sala/i.test(voltaSala.plug) && voltaSala.escuta === 0 &&
        voltaSala.clipe && voltaSala.barras > 0 && voltaSala.pico > 6,
    )
    step(
      `  gravando do retorno: ${JSON.stringify(voltaSala.gravando)} · canal solto no fim ${voltaSala.soltou}`,
      /gravando/i.test(voltaSala.gravando) && voltaSala.soltou,
    )
    step(`  foto do take vindo da sala`, await grab('selftest-sala-return.png'))

    // The toggles above are project changes like any other: hand the page back a
    // new project so the menu leg below still finds Undo disabled and an empty lane.
    const renewedAfterMetro = await renewProject()
    step(
      `  e a pilha volta vazia depois do metrônomo (${renewedAfterMetro.tracks} track(s), ${JSON.stringify(renewedAfterMetro.label)})`,
      renewedAfterMetro.undoDisabled && renewedAfterMetro.tracks > 0,
    )

    // The native bar is not a second list of commands somebody has to keep in
    // sync: the page publishes its own menus and the rows come back as
    // positions. Prove the groups arrived, that a disabled row is disabled
    // there too, and that pressing one really presses the page's button.
    const chrome = await win.webContents.executeJavaScript(`(() => {
      const nav = document.querySelector('.menu-items');
      const header = document.querySelector('.menu-bar');
      return {
        native: !!header?.classList.contains('native'),
        display: nav ? getComputedStyle(nav).display : '(sem nav)',
        groups: nav ? nav.querySelectorAll('.menu-item').length : 0,
      };
    })()`)
    step(
      `  sem barra de menus web no executável (display ${chrome.display}, ${chrome.groups} grupos ainda no documento)`,
      chrome.native && chrome.display === 'none' && chrome.groups >= 6,
    )

    const menuSnapshot = () => {
      const groups = Menu.getApplicationMenu()?.items ?? []
      return {
        labels: groups.map((item) => String(item.label ?? '')),
        rows: groups.flatMap((group, g) =>
          (group.submenu?.items ?? []).map((item, i) => ({
            g,
            i,
            label: String(item.label ?? ''),
            enabled: item.enabled !== false,
            kind: String(item.type ?? ''),
          })),
        ),
      }
    }
    const pageTracks = () =>
      win.webContents.executeJavaScript(`document.querySelectorAll('.tcp-track').length`)
    const waitForTracks = async (target) => {
      for (let i = 0; i < 60; i += 1) {
        const count = await pageTracks()
        if (count === target) return count
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return pageTracks()
    }

    const bar0 = await (async () => {
      // The page publishes its menus a moment after it mounts; wait for the
      // first group rather than asserting against the startup fallback.
      for (let i = 0; i < 80; i += 1) {
        const snapshot = menuSnapshot()
        if (snapshot.labels.includes('Arquivo')) return snapshot
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return menuSnapshot()
    })()
    const bar = bar0
    const wanted = ['Arquivo', 'Editar', 'Ver', 'Mix', 'Track', 'Devices', 'Plugins', 'Ajuda']
    step(
      `barra nativa espelhada (${bar.labels.join(' · ')})`,
      wanted.every((label) => bar.labels.includes(label)),
    )
    const fileRows = bar.rows.filter((row) => bar.labels[row.g] === 'Arquivo').map((row) => row.label)
    step(
      `  Arquivo traz os itens da página e os do executável (${fileRows.length})`,
      fileRows.some((label) => /Novo Projeto/.test(label)) &&
        fileRows.some((label) => /Exportar Áudio/.test(label)) &&
        fileRows.includes('Sair'),
    )
    // (a função `undoRow` lá em cima lê a página; esta linha é a da barra nativa)
    const undoBarItem = bar.rows.find((row) => /^Desfazer/.test(row.label))
    step(`  desfazer vem desabilitado: ${undoBarItem?.enabled === false}`, undoBarItem?.enabled === false)
    const snapRow = bar.rows.find((row) => /^Snap/.test(row.label))
    step(`  rótulo vivo: ${JSON.stringify(snapRow?.label)}`, /^Snap \(o/.test(String(snapRow?.label)))

    const trackGroup = bar.labels.indexOf('Track')
    const insertRow = bar.rows.find((row) => row.g === trackGroup && /^Inserir Track$/.test(row.label))
    const beforeTracks = await pageTracks()
    if (insertRow) {
      Menu.getApplicationMenu()?.items[trackGroup]?.submenu?.items[insertRow.i]?.click()
    }
    const afterTracks = await waitForTracks(beforeTracks + 1)
    step(
      `  Inserir Track pela barra do Windows (${beforeTracks} → ${afterTracks})`,
      !!insertRow && afterTracks === beforeTracks + 1,
    )
    // A row whose label carries live state has to change in the bar by itself,
    // and pressing it again has to put it back — that is the round trip the
    // producer depends on every time the page re-renders.
    const pressRow = (row) => {
      if (!row) return false
      Menu.getApplicationMenu()?.items[row.g]?.submenu?.items[row.i]?.click()
      return true
    }
    const viewGroup = bar.labels.indexOf('Ver')
    const snapOn = menuSnapshot().rows.find((row) => row.g === viewGroup && /^Snap \(on\)/.test(row.label))
    pressRow(snapOn)
    let snapOff = snapOn
    for (let i = 0; i < 40 && !/^Snap \(off\)/.test(String(snapOff?.label ?? '')); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      snapOff = menuSnapshot().rows.find((row) => row.g === viewGroup && /^Snap/.test(row.label))
    }
    step(
      `  a barra se re-publica sozinha: ${JSON.stringify(snapOff?.label)}`,
      /^Snap \(off\)/.test(String(snapOff?.label ?? '')),
    )
    pressRow(snapOff)
    let snapBack = snapOff
    for (let i = 0; i < 40 && !/^Snap \(on\)/.test(String(snapBack?.label ?? '')); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      snapBack = menuSnapshot().rows.find((row) => row.g === viewGroup && /^Snap/.test(row.label))
    }
    step(`  e volta para ${JSON.stringify(snapBack?.label)}`, /^Snap \(on\)/.test(String(snapBack?.label ?? '')))

    // Remove the lane the test added through the same bar, so what follows runs
    // on the session it expects.
    const removeRow = menuSnapshot().rows.find(
      (row) => row.g === trackGroup && /^Remover Selecionada/.test(row.label),
    )
    pressRow(removeRow)
    const backTo = await waitForTracks(beforeTracks)
    step(
      `  Track ▸ Remover Selecionada pela barra do Windows (${afterTracks} → ${backTo})`,
      !!removeRow && backTo === beforeTracks,
    )

    const scanned = await plugins.request('scan', {})
    const list = (scanned.plugins ?? []).filter((entry) => !entry.error)
    step(`plugins visíveis (${list.length})`, list.length > 0)
    for (const entry of list) step(`  ${entry.kind} ${entry.name ?? entry.path}`, true)

    // Every plugin the scan found is asked twice: what it is (describe) and what
    // it does to a tone (render). VST2 and VST3 go through the same two calls, so
    // one list tells the whole story.
    // A third-party binary that takes its own process down is not this host's
    // failure: the supervisor already retried it in a clean child and the session
    // never noticed. The test says so plainly, moves to the next plugin, and at
    // the end proves the plugin process is still standing after the fall.
    const ask = async (cmd, body, timeout) => {
      try {
        return await plugins.request(cmd, body, timeout)
      } catch (error) {
        return { ok: false, faulted: true, error: (error && error.message) || String(error) }
      }
    }
    // The plugin's own name if it answered, the name the bundle carries if it
    // did not, and only then the file — a report that says "Gateway.vst3" when
    // the plugin says "Gateway" is a report the producer has to decode.
    const labelOf = (entry, info) =>
      `${entry.kind.toUpperCase()} ${(info?.name || entry.label || entry.path.split(/[\\/]/).pop() || '').trim()}`
    const unstable = []
    for (const entry of list) {
      const described = await ask('describe', { path: entry.path, sampleRate: 48000 }, 45000)
      const info = described.info ?? {}
      if (described.faulted) {
        unstable.push(labelOf(entry, info))
        note(`  ${labelOf(entry, info)}: derrubou o processo dele ao abrir — o host recriou a criança e seguiu em frente`)
        continue
      }
      step(
        `  ${labelOf(entry, info)} ${described.ok ? 'abriu' : 'não abriu'} — ${info.numParams ?? 0} parâmetro(s), ${info.numInputs ?? 0}in/${info.numOutputs ?? 0}out`,
        described.ok === true,
      )
      if (!described.ok) {
        step(`    ${described.error}`, false)
        continue
      }
      const rendered = await ask('render', { path: entry.path, sampleRate: 48000, seconds: 1 }, 120000)
      if (rendered.faulted) {
        unstable.push(labelOf(entry, info))
        note(`  ${labelOf(entry, info)}: caiu durante o bounce — o host recriou a criança e seguiu em frente`)
        continue
      }
      step(
        `    bounce: pico ${(rendered.peak ?? 0).toFixed(4)}, ${rendered.nonSilent ?? 0}/${rendered.total ?? 0} amostras vivas, ${rendered.bad ?? 0} inválidas, ${
          (rendered.reported ?? []).length
        } valor(es) devolvido(s)`,
        rendered.ok === true && (rendered.peak ?? 0) > 0 && (rendered.bad ?? 1) === 0,
      )
      if (rendered.ok) {
        fs.writeFileSync(
          path.join(__dirname, `selftest-render-${entry.kind}-${(info.name || 'plugin').replace(/[^\w-]+/g, '')}.wav`),
          Buffer.from(rendered.outputWav),
        )
      } else {
        step(`    erro: ${rendered.error}`, false)
      }
      // A knob in the panel has to reach the plugin, not only the slot: send one
      // value and read it back out of the engine that owns it. This is what makes
      // the plugin's own window agree with the numbers OpenDAW shows.
      // What is proved here is the handover — the command lands, the plugin
      // answers, the value comes back. A plugin that steps or clamps the number
      // is the plugin's own business and is written down rather than failed.
      const listed = info.params ?? []
      const first = listed.find((item) => !item.stepCount) ?? listed[0]
      if (first) {
        const wanted = Number(first.value) > 0.5 ? 0.1 : 0.9
        const applied = await ask(
          'params',
          { path: entry.path, sampleRate: 48000, params: [{ index: first.index, value: wanted }] },
          30000,
        )
        const back = (applied.applied ?? []).find((item) => item.index === first.index)?.value
        if (applied.faulted) {
          unstable.push(`${labelOf(entry, info)} (ao receber parâmetro)`)
          note(`  ${labelOf(entry, info)}: caiu ao aplicar o parâmetro ${first.index}`)
        } else {
          step(
            `    parâmetro ${first.index} (${String(first.name ?? '?').slice(0, 16)}): pedido ${wanted.toFixed(2)}, ` +
              `o plugin devolve ${back === undefined ? 'nada' : back.toFixed(2)}`,
            applied.ok === true && back !== undefined,
          )
          if (back !== undefined && Math.abs(back - wanted) > 0.08) {
            note(`      ${labelOf(entry, info)} ajustou o valor sozinho — a leitura dele é que manda`)
          }
        }
      }
    }
    if (unstable.length > 0) {
      const after = await ask('scan', {}, 45000)
      step(
        `${unstable.length} plugin(s) de terceiros caíram sozinhos e o host absorveu (${unstable.join('; ').slice(0, 90)}) — varridura depois: ${
          (after.plugins ?? []).length
        } arquivo(s)${after.error ? `, ${String(after.error).slice(0, 40)}` : ''}`,
        !after.faulted && (after.plugins ?? []).length > 0,
      )
    }

    // The menu bar is only half the wiring: the page has to answer it. Sending
    // the same event the menu sends proves the panel really opens on the
    // producer's side of the bridge, with the same rows the scan found.
    win.webContents.send('opdaw:menu', 'plugin-panel')
    const panel = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 120 && !document.querySelector('.plugin-window'); i += 1) await waitFor(100);
      const box = document.querySelector('.plugin-window')?.getBoundingClientRect();
      // The rows come from a disk scan that only starts once the window is up:
      // measuring the first paint would call a still-listing panel an empty one.
      const listed = () => document.querySelectorAll('.plugin-window .plugin-row').length;
      for (let i = 0; i < 400 && listed() === 0 && !document.querySelector('.plugin-window .plugin-note.error'); i += 1) {
        await waitFor(100);
      }
      let detail = '';
      for (let i = 0; i < 60; i += 1) {
        detail = (document.querySelector('.plugin-window .plugin-detail')?.innerText || '').replace(/\\s+/g, ' ').trim();
        if (detail && !/^Abrindo o plugin/.test(detail)) break;
        await waitFor(100);
      }
      return {
        open: !!box,
        rows: document.querySelectorAll('.plugin-window .plugin-row').length,
        dead: document.querySelectorAll('.plugin-window .plugin-row.dead').length,
        detail: detail.slice(0, 80),
        fits: !!box && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
        // Discovery is a promise the panel has to keep twice over: it says where
        // it looked, it offers a folder the producer can name, and the names it
        // prints are the plugins', not their file paths.
        buttons: [...document.querySelectorAll('.plugin-window .plugin-toolbar button')]
          .map((button) => (button.textContent || '').trim()),
        dirRows: document.querySelectorAll('.plugin-window .plugin-dirs li').length,
        dirSummary: (document.querySelector('.plugin-window .plugin-dirs summary')?.textContent || '').trim(),
        named: [...document.querySelectorAll('.plugin-window .plugin-name')]
          .map((node) => (node.textContent || '').trim()),
      };
    })()`)
    step(`painel abriu (${panel.rows} linha(s), ${panel.dead} descartado(s))`, panel.open && panel.rows > 0)
    step(`  leitura: ${JSON.stringify(panel.detail)}`, panel.detail.length > 0)
    step('  painel cabe inteiro na tela', panel.fits)
    step(`  o painel diz onde procurou (${panel.dirRows} pasta(s): ${JSON.stringify(panel.dirSummary)})`, panel.dirRows > 0)
    step(
      '  o painel oferece uma pasta extra',
      panel.buttons.some((text) => /Adicionar pasta/.test(text)),
    )
    step(
      `  nomes dos plugins, não caminhos: ${JSON.stringify(panel.named.slice(0, 3))}`,
      panel.named.length > 0 &&
        panel.named.every((name) => name.length > 0 && !/[\\/:]|\.(dll|vst3|vst)$/i.test(name)),
    )
    if (panel.open) {
      const panelShot = await grab('selftest-plugins.png')
      step('captura do painel', panelShot)
      const closed = await win.webContents.executeJavaScript(`(async () => {
        const box = document.querySelector('.plugin-window .fx-header button');
        if (box) box.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        return !document.querySelector('.plugin-window');
      })()`)
      step('painel fecha pelo botão', closed)
    }

    // The other half of the engine: a VST2 slot inside a track's own chain.
    // Clicking the lane's FX button has to show it, list the .dll the scan
    // found, and refuse to bounce while the lane has no clip.
    const insert = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const fxButton = [...document.querySelectorAll('.tcp-track button')]
        .find((button) => /^FX/.test((button.textContent || '').trim()));
      if (!fxButton) return { opened: false };
      fxButton.click();
      for (let i = 0; i < 100 && !document.querySelector('.native-vst'); i += 1) await waitFor(100);
      await waitFor(400);
      const block = document.querySelector('.native-vst');
      // This insert scans on mount, just like the separate panel. Wait for its
      // own asynchronous list instead of mistaking the first paint for zero
      // installed plugins.
      const listed = () => [...document.querySelectorAll('.native-vst select option')]
        .some((option) => /\\.(dll|vst3)$/i.test(option.value || ''));
      for (let i = 0; i < 400 && !listed() && !document.querySelector('.native-vst .plugin-note.error'); i += 1) {
        await waitFor(100);
      }
      // The list carries the plugin's own name, not the file it lives in, so
      // what identifies an entry here is the path the option holds as its value.
      const options = [...document.querySelectorAll('.native-vst select option')]
        .map((o) => (o.value || '').trim()).filter((value) => /\\.(dll|vst3)$/i.test(value));
      const bounce = [...document.querySelectorAll('.native-vst-chain button')]
        .find((button) => /Aplicar (a cadeia )?ao clipe/.test(button.textContent || ''));
      // The chain is a list now, so the first thing to prove is that it exists at
      // all: rows, and the button that adds one.
      const addPlugin = [...document.querySelectorAll('.native-vst-chain button')]
        .find((button) => /\\+ Plugin/.test(button.textContent || ''));
      const box = document.querySelector('.fx-window')?.getBoundingClientRect();
      const body = document.querySelector('.fx-window .fx-body-scroll');
      const scrolled = body ? getComputedStyle(body).overflowY : '';

      // The built-in rack is a real pedalboard now: the picker only offers units
      // that are absent, adding one creates its card, and the card's X unwires it
      // without losing the saved knob values. Exercise both directions in the
      // page, then put the unit back in the picker by removing the new card.
      const chain = document.querySelector('.signal-chain');
      const chainStyle = chain ? getComputedStyle(chain) : null;
      const beforeRects = [...document.querySelectorAll('.signal-chain .card-fx')]
        .map((card) => card.getBoundingClientRect());
      const chainHorizontal = beforeRects.some((rect, index) => beforeRects.slice(index + 1)
        .some((other) => Math.abs(rect.top - other.top) <= 2 && other.left > rect.left));
      const picker = document.querySelector('.chain-add-select');
      const choice = picker ? [...picker.options].find((option) => option.value) : null;
      let chosen = choice?.value || '';
      // An older session may explicitly contain all eleven units. Make one
      // absent through the same X the producer uses, then exercise add + remove.
      if (!chosen) {
        const candidate = document.querySelector('.signal-chain .card-fx');
        chosen = candidate?.getAttribute('data-fx-id') || '';
        candidate?.querySelector('.chain-remove')?.click();
        await waitFor(200);
      }
      const activePicker = document.querySelector('.chain-add-select');
      if (activePicker && chosen) {
        activePicker.value = chosen;
        activePicker.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(200);
      }
      const addedCard = chosen ? document.querySelector('[data-fx-id="' + chosen + '"]') : null;
      const added = !!addedCard;
      if (addedCard) addedCard.querySelector('.chain-remove')?.click();
      await waitFor(200);
      const removed = !!chosen && !document.querySelector('[data-fx-id="' + chosen + '"]');
      const optionBack = !!chosen && !!document.querySelector('.chain-add-select option[value="' + chosen + '"]');
      const result = {
        opened: !!block,
        chainList: !!document.querySelector('.native-vst-chain'),
        rows: document.querySelectorAll('.native-vst-row').length,
        addPlugin: !!addPlugin,
        chainHorizontal,
        chainRow: chainStyle?.flexDirection === 'row',
        chainWrap: chainStyle?.flexWrap === 'wrap',
        chainFits: !!chain && chain.scrollWidth <= chain.clientWidth + 1,
        chainAdded: added,
        chainRemoved: removed && optionBack,
        plugins: new Set(options).size,
        named: [...document.querySelectorAll('.native-vst select option')].filter((o) => o.value).length,
        bounce: bounce ? bounce.textContent.trim() : '(sem botão)',
        blocked: !!bounce && bounce.disabled,
        // Discovery is offered where the producer actually looks for a plugin:
        // inside the track's own chain, not only in the separate panel.
        scanRow: [...document.querySelectorAll('.native-vst-scan .mini-btn')].map((button) =>
          (button.textContent || '').trim(),
        ),
        scanHint: (document.querySelector('.native-vst-scan-hint')?.textContent || '').trim(),
        // The chain is long and scrolls inside the window; what must fit on
        // screen is the window itself, not every card in it.
        fits: !!box && box.bottom <= window.innerHeight + 1 && box.right <= window.innerWidth + 1,
        scrolls: !!body && (body.scrollHeight > body.clientHeight || scrolled === 'auto' || scrolled === 'scroll'),
      };
      const close = [...document.querySelectorAll('.fx-window .fx-footer button')]
        .find((button) => (button.textContent || '').trim() === 'Fechar');
      if (close) close.click();
      await waitFor(250);
      result.closed = !document.querySelector('.fx-window');
      return result;
    })()`)
    step(`encaixe de plugin na lane (${insert.plugins} arquivo(s) na lista)`, insert.opened && insert.plugins > 0)
    // The list is the shape the producer asked for: a chain with rows, not one
    // slot hidden behind a panel, and a button that puts another row on the end.
    step(
      `  cadeia em lista, com ${insert.rows} linha(s) e botão de adicionar`,
      insert.chainList && insert.addPlugin,
    )
    step(`  sem clipe não processa: ${JSON.stringify(insert.bounce)}`, insert.blocked)
    step('  encaixe cabe na janela', insert.fits && insert.scrolls)
    step(
      `  o encaixe rebusca e aceita pasta extra: ${JSON.stringify(insert.scanRow)}`,
      insert.scanRow.some((text) => /Procurar de novo/.test(text)) &&
        insert.scanRow.some((text) => /Adicionar pasta/.test(text)),
    )
    step(`  e diz o que encontrou: ${JSON.stringify(insert.scanHint)}`, /\d/.test(insert.scanHint))
    step(
      '  efeitos embutidos ficam lado a lado e quebram em fileiras',
      insert.chainHorizontal && insert.chainRow && insert.chainWrap && insert.chainFits,
    )
    step('  + Efeito adiciona o cartão escolhido', insert.chainAdded)
    step('  ✕ remove o efeito e devolve a opção ao seletor', insert.chainRemoved)
    step('  janela de FX fecha', insert.closed)

    // The half that had only ever run in the worker: a clip going through a real
    // .dll inside the app. Node synthesizes the WAV, the page drops it on the
    // lane the way the producer would, picks the plugin in the native insert and
    // presses bounce — then the dry take has to be on the shelf behind the wet.
    const clipB64 = testClipBase64()
    const bounce = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const out = { clip: false, dll: '', armed: false, toast: '', takes: -1, shelf: '', preview: '', previewOn: false, previewPeak: 0 };

      const fxButton = [...document.querySelectorAll('.tcp-track button')]
        .find((button) => /^FX/.test((button.textContent || '').trim()));
      if (!fxButton) return out;
      fxButton.click();
      for (let i = 0; i < 100 && !document.querySelector('.fx-window'); i += 1) await waitFor(100);
      const head = document.querySelector('.fx-window .fx-header span')?.textContent || '';
      const trackName = head.split('—').pop().trim();
      const lane = [...document.querySelectorAll('.arrangement-lane')]
        .find((item) => (item.querySelector('.lane-label')?.textContent || '').trim().startsWith(trackName));
      if (!lane) return out;

      const bytes = Uint8Array.from(atob('${clipB64}'), (ch) => ch.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'teste-vst.wav', { type: 'audio/wav' }));
      lane.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));

      for (let i = 0; i < 300 && !lane.querySelector('.audio-item'); i += 1) await waitFor(100);
      out.clip = !!lane.querySelector('.audio-item');

      const select = document.querySelector('.native-vst select');
      // The VST2 file is the one this machine always answers with, so the bounce
      // is proved on it; the picker is matched by the path it carries. The list
      // arrives when the plugin process answers — and a process that fell takes
      // its list with it until the next request hands out a fresh one, so the leg
      // waits for an entry instead of reading a picker that has not filled yet.
      let option = null;
      for (let i = 0; i < 120 && !option; i += 1) {
        option = select ? [...select.options].find((o) => /\\.dll$/i.test(o.value || '')) : null;
        if (!option) await waitFor(100);
      }
      if (select && option) {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        out.dll = (option.textContent || '').trim();
      }

      // The automatic half, before anybody presses a thing: picking a plugin on a
      // lane with a clip has to end with the plugin's pass inside the lane, which
      // is what the speakers play and what the exported WAV carries. The row names
      // the peak it measured, so "the plugin's sound never comes out" is either
      // proved wrong here or written down with the reason.
      for (let i = 0; i < 400; i += 1) {
        const early = document.querySelector('.native-vst-preview');
        if (early && /pico ([0-9.]+)/.test(early.textContent || '')) break;
        await waitFor(100);
      }
      const auto = document.querySelector('.native-vst-preview');
      out.preview = (auto?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
      out.previewOn = !!auto && auto.classList.contains('on');
      out.previewPeak = Number((/pico ([0-9.]+)/.exec(out.preview) || [])[1] ?? 0);

      const findBounce = () => [...document.querySelectorAll('.native-vst-chain button')]
        .find((button) => /Aplicar (a cadeia )?ao clipe|Processando/.test(button.textContent || ''));
      let button = null;
      for (let i = 0; i < 400; i += 1) {
        button = findBounce();
        if (button && !button.disabled) break;
        await waitFor(100);
      }
      out.armed = !!button && !button.disabled;
      if (!out.armed) return out;
      button.click();

      for (let i = 0; i < 900; i += 1) {
        const text = (document.querySelector('.toast')?.textContent || '').replace(/\\s+/g, ' ').trim();
        if (/aplicad[ao]|Não deu para aplicar/.test(text)) { out.toast = text.slice(0, 140); break; }
        await waitFor(100);
      }

      const shelf = [...document.querySelectorAll('select')]
        .find((item) => /takes: \\d+/.test(item.options[0]?.textContent || ''));
      if (shelf) {
        out.takes = Number(/takes: (\\d+)/.exec(shelf.options[0].textContent || '')[1]);
        out.shelf = [...shelf.options].slice(1).map((o) => (o.textContent || '').trim()).join(' | ').slice(0, 90);
      }
      return out;
    })()`)
    step('clipe importado por arraste na lane', bounce.clip)
    step(`  plugin escolhido: ${JSON.stringify(bounce.dll.slice(0, 40))}`, bounce.dll.length > 0)
    step(
      `  pré-escuta automática do clipe: ${JSON.stringify(bounce.preview)}`,
      bounce.previewOn && bounce.previewPeak > 0,
    )
    step('  botão de bounce libera com o clipe', bounce.armed)
    step(`  aviso do plugin: ${JSON.stringify(bounce.toast)}`, /aplicad[ao]/.test(bounce.toast))
    step(`  take seco na prateleira (${bounce.takes})`, bounce.takes >= 1)
    step(`  rótulo do take: ${JSON.stringify(bounce.shelf)}`, /seco/.test(bounce.shelf))

    // Bypass is the honest switch: the lane goes back to the clip it really holds,
    // so the plugin's pass leaves and the row leaves with it. Turning it back on
    // has to render the pass again by itself — that round trip is the difference
    // between an effect that is in the lane and a label that says there is one.
    // The bounce printed the chain into the clip and emptied the row, so the leg
    // puts a plugin back the way the producer would: the "+ Plugin" button and the
    // picker, never a hidden API.
    const previewToggle = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const out = { row: false, bypassed: false, back: '', backOn: false };
      const rows = () => document.querySelectorAll('.native-vst-row').length;
      const ensureSlot = async () => {
        if (rows() > 0) return true;
        const add = [...document.querySelectorAll('.native-vst-chain button')]
          .find((b) => /\\+ Plugin/.test(b.textContent || ''));
        if (!add) return false;
        add.click();
        await waitFor(150);
        const select = document.querySelector('.native-vst select');
        let option = null;
        for (let i = 0; i < 120 && !option; i += 1) {
          option = select ? [...select.options].find((o) => /\\.dll$/i.test(o.value || '')) : null;
          if (!option) await waitFor(100);
        }
        if (!select || !option) return false;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 100 && rows() === 0; i += 1) await waitFor(100);
        return rows() > 0;
      };
      out.row = await ensureSlot();
      if (!out.row) return out;
      const power = () => [...document.querySelectorAll('.native-vst .mini-btn')]
        .find((b) => /\\u23fb/.test(b.textContent || ''));
      const row = () => document.querySelector('.native-vst-preview');
      const first = power();
      if (!first) return out;
      first.click();
      for (let i = 0; i < 100 && !!row(); i += 1) await waitFor(100);
      out.bypassed = !row();
      const second = power();
      if (!second) return out;
      second.click();
      for (let i = 0; i < 400; i += 1) {
        const live = row();
        if (live && live.classList.contains('on')) break;
        await waitFor(100);
      }
      const back = row();
      out.back = (back?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 70);
      out.backOn = !!back && back.classList.contains('on');
      return out;
    })()`)
    step('  a cadeia volta a ter um plugin depois do bounce', previewToggle.row)
    step('  bypass devolve a lane ao clipe e tira a pré-escuta', previewToggle.bypassed)
    step(`  e o plugin volta a tocar sozinho: ${JSON.stringify(previewToggle.back)}`, previewToggle.backOn)

    // The point of the whole refactor, in the producer's words: as many plugins on
    // one lane as they want. A second row is added the same way, the list grows,
    // and the order buttons move it — because the order is the sound.
    const secondSlot = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const out = { added: false, rows: 0, names: [], moved: false, hint: '', removed: false };
      const names = () => [...document.querySelectorAll('.native-vst-row-label')].map((n) => (n.textContent || '').trim());
      // Two rows of the same file carry the same label, so the name cannot show a
      // swap. The row's own id is what the sessions and the saved project hang on:
      // when that sequence changes, the audio really meets the plugins in the new
      // order, which is the whole point of the list.
      const ids = () => [...document.querySelectorAll('.native-vst-row')].map((r) => r.dataset.slotId || '').join('|');
      const add = [...document.querySelectorAll('.native-vst-chain button')]
        .find((b) => /\\+ Plugin/.test(b.textContent || ''));
      if (!add) return out;
      add.click();
      await waitFor(150);
      const select = document.querySelector('.native-vst select');
      const options = select ? [...select.options].filter((o) => /\\.dll$/i.test(o.value || '')) : [];
      if (!select || options.length === 0) return out;
      // A machine with one VST2 still gets the second row: two copies of the same
      // file are two slots, the way REAPER counts them.
      const wanted = options.find((o) => o.value !== select.value) || options[0];
      select.value = wanted.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 120 && document.querySelectorAll('.native-vst-row').length < 2; i += 1) await waitFor(100);
      out.rows = document.querySelectorAll('.native-vst-row').length;
      out.added = out.rows >= 2;
      out.names = names();
      const antes = ids();
      const down = [...document.querySelectorAll('.native-vst-row')][0]?.querySelector('.native-vst-row-move button:nth-child(2)');
      if (down && !down.disabled) {
        down.click();
        for (let i = 0; i < 60; i += 1) {
          if (ids() !== antes) break;
          await waitFor(100);
        }
        out.moved = ids() !== antes;
      }
      out.hint = (document.querySelector('.native-vst-order-hint')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      const kill = [...document.querySelectorAll('.native-vst-row')][1]?.querySelector('.mini-btn.danger');
      if (kill) {
        kill.click();
        for (let i = 0; i < 60 && document.querySelectorAll('.native-vst-row').length > 1; i += 1) await waitFor(100);
      }
      out.removed = document.querySelectorAll('.native-vst-row').length === 1;
      return out;
    })()`)
    step(`  segundo plugin entra na cadeia (${secondSlot.rows} linha(s): ${JSON.stringify(secondSlot.names.map((n) => n.slice(0, 22)))})`, secondSlot.added)
    step('  ▲/▼ trocam a ordem das linhas', secondSlot.moved)
    step(`  e a janela diz o que a ordem custa: ${JSON.stringify(secondSlot.hint)}`, /de cima para baixo/.test(secondSlot.hint))
    step('  ✕ devolve a cadeia a uma linha', secondSlot.removed)

    // The producer's own words: "the plugin has to work in real time, not only
    // when recording". So with this lane's monitor lit, the input crosses to the
    // plugin's own process a batch at a time and comes back for the headphones.
    // The row saying "ao vivo" is only half of it — when a batch is late the
    // worklet hands over the dry input, and a lane listening to the microphone is
    // indistinguishable from one listening to the amp by ear alone. What tells
    // them apart is the count of blocks the plugin process actually answered with
    // audio, and that it keeps growing while the light is on.
    const liveRow = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const out = { mon: false, state: '', lit: false, refused: false, batches: 0, answered: 0, underruns: 0,
        cresceu: false, pico: 0, quadros: 0, vis: '', virou: '' };
      const head = document.querySelector('.fx-window .fx-header span')?.textContent || '';
      const trackName = head.split('\\u2014').pop().trim();
      const track = [...document.querySelectorAll('.tcp-track')]
        .find((item) => (item.querySelector('.track-title')?.value || '').trim().startsWith(trackName));
      const mon = track?.querySelector('.mon-btn');
      if (mon && !mon.classList.contains('on')) {
        mon.click();
        for (let i = 0; i < 40 && !mon.classList.contains('on'); i += 1) await waitFor(50);
      }
      out.mon = !!mon && mon.classList.contains('on');
      const row = () => document.querySelector('.native-vst-live');
      for (let i = 0; i < 120; i += 1) {
        const at = row();
        if (at && (at.classList.contains('on') || at.classList.contains('off'))) break;
        await waitFor(100);
      }
      const now = row();
      out.state = (now?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
      out.lit = !!now && now.classList.contains('on');
      out.refused = !!now && now.classList.contains('off');
      out.batches = Number(now?.dataset.liveBatches || 0);
      out.answered = Number(now?.dataset.liveAnswered || 0);
      out.underruns = Number(now?.dataset.liveUnderruns || 0);
      const agora = () => row();
      const conta = () => {
        const at = agora();
        return {
          respondeu: Number(at?.dataset.liveAnswered || 0),
          enviados: Number(at?.dataset.liveBatches || 0),
          atrasos: Number(at?.dataset.liveUnderruns || 0),
        };
      };
      const primeiro = conta();
      for (let i = 0; i < 50 && conta().respondeu === primeiro.respondeu; i += 1) await waitFor(100);
      // Read the three counts at one instant, the way the producer would see
      // them: a row polled at open and a row polled five seconds later are not
      // the same measurement, and mixing them would report a session that sends
      // nothing and answers everything.
      const depois = conta();
      out.cresceu = depois.respondeu > primeiro.respondeu;
      out.answered = depois.respondeu;
      out.batches = depois.enviados;
      out.underruns = depois.atrasos;
      const nivel = () => Number.parseFloat(document.querySelector('.mcp-channel.master .mcp-meter-fill')?.style.height || '0') || 0;
      // The meter is painted from the animation frame, so the frame rate is read
      // in the same window as the level: a plugin that answered 63 blocks while
      // the page painted nothing is a covered window, not a silent bridge.
      let quadros = 0;
      const rastro = window.__opdawPinta || { quadros: 0, virou: [] };
      const antes = rastro.quadros;
      for (let i = 0; i < 30; i += 1) { out.pico = Math.max(out.pico, nivel()); await waitFor(50); }
      out.quadros = rastro.quadros - antes;
      out.vis = document.visibilityState;
      out.virou = rastro.virou.slice(-4).join(' ');
      return out;
    })()`)
    step(`  a lane escuta o plugin em tempo real: ${JSON.stringify(liveRow.state)}`, liveRow.lit)
    step(
      `  e o áudio volta do processo dos plugins (${liveRow.answered} bloco(s) respondidos, ` +
        `${liveRow.underruns} atraso(s), ${liveRow.batches} enviado(s))`,
      liveRow.answered > 0 && liveRow.cresceu,
    )
    step(
      `o medidor da master com o plugin no caminho de saída (pico ${liveRow.pico.toFixed(1)}%, ` +
        `monitor ${liveRow.mon ? 'aceso' : 'apagado'}, ${liveRow.quadros} quadros em 1,5s, página ${liveRow.vis}` +
        `${liveRow.virou ? `, virou ${liveRow.virou}` : ''})`,
    )

    // Keep the window on screen for the picture: the insert with its knobs is
    // the part most likely to overflow, and a screenshot is how that gets seen.
    const scrolled = await win.webContents.executeJavaScript(`(() => {
      const body = document.querySelector('.fx-window .fx-body-scroll');
      const block = document.querySelector('.native-vst');
      if (!body || !block) return false;
      block.scrollIntoView({ block: 'end' });
      return true;
    })()`)
    step('encaixe de plugin alcançável dentro da janela', scrolled)
    const insertShot = await grab('selftest-vst-insert.png')
    step('captura do encaixe com o plugin aberto', insertShot)

    // The other half of a plugin: its own interface. The page presses its button,
    // the worker opens a real Win32 window and the plugin draws in it; the proof
    // is that the window exists with a client area in it, and that it is gone
    // again when the producer closes the strip. Both generations are driven
    // through the same steps, because the page does not know which one it is
    // holding — it only knows the path it picked.
    //
    // Every file the list offers gets its own chance. A third-party plugin that
    // takes its process down inside its own GUI is a fact about that plugin, and
    // the host's answer is to try the next one and write down what happened,
    // which is what a producer with an installed folder of effects needs the test
    // to do: tell them which interface opened and which one does not.
    const guiList = (pattern) => win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('.native-vst select');
      if (!select) return [];
      const wanted = new RegExp(${JSON.stringify(pattern)}, 'i');
      return [...new Set([...select.options].map((o) => (o.value || '').trim()).filter((v) => wanted.test(v)))];
    })()`)
    const driveGui = (path) => win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      // What the row's own interface is saying: the face while it is up, the
      // strip's refusal after the plugin said no and the face went away.
      const said = () => {
        const pane = document.querySelector('.native-vst-faces > .native-vst-stage');
        const text = pane ? pane.innerText : document.querySelector('.native-vst-face-bar')?.innerText;
        return (text || '').replace(/\\s+/g, ' ').trim();
      };
      const out = { pressed: false, said: '', opened: false };
      const select = document.querySelector('.native-vst select');
      if (!select) return out;
      select.value = ${JSON.stringify(path)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      // The button only lights up once the engine has answered whether this
      // plugin has an interface at all, so waiting for it is waiting for describe.
      let open = null;
      for (let i = 0; i < 600 && !open; i += 1) {
        open = [...document.querySelectorAll('.native-vst button')]
          .find((b) => /Abrir interface/.test(b.textContent || '') && !b.disabled);
        if (!open) await waitFor(100);
      }
      if (!open) {
        out.said = said().slice(0, 180) || 'o botão não ficou disponível';
        return out;
      }
      open.click();
      out.pressed = true;
      let text = '';
      for (let i = 0; i < 1200; i += 1) {
        text = said();
        if (/esta área|foi fechada|recusou|não expõe|falhou|não oferece|caiu e a janela/.test(text)) break;
        await waitFor(100);
      }
      out.said = text.slice(0, 180);
      out.opened = /esta área/.test(text);
      return out;
    })()`)
    const closeGui = () => win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const button = document.querySelector('.native-vst-stage.open button');
      if (button) button.click();
      for (let i = 0; i < 60 && document.querySelector('.native-vst-stage.open'); i += 1) await waitFor(100);
      return !document.querySelector('.native-vst-stage.open');
    })()`)

    // Every file that answered with a real window, kept for the test below that
    // needs two of them at once.
    const proven = []
    for (const [label, pattern] of [['VST2', '\\.dll$'], ['VST3', '\\.vst3$']]) {
      const candidates = await guiList(pattern)
      step(`o encaixe oferece interface própria para ${candidates.length} arquivo(s) ${label}`, candidates.length > 0)
      let proved = null
      for (const path of candidates.slice(0, 4)) {
        const file = path.split(/[\\/]/).pop() ?? path
        try {
          const press = await driveGui(path)
          const opened = await ask('gui-state', { path }, 30000)
          const frame = opened.state ?? {}
          const live = opened.ok === true && frame.open === true && Number(frame.hwnd) > 0
          if (!live) {
            // Two different answers read as one symptom, so the line says which:
            // a window that is not up, and a process that no longer knows this
            // path because it died with the window inside it.
            const why = !opened.ok
              ? String(opened.error ?? 'sem resposta').slice(0, 48)
              : frame.open !== true
                ? 'o plugin fechou a janela dele'
                : 'sem área útil'
            note(`  ${file}: não abriu (${why})${press.pressed ? '' : ' — o encaixe nem ofereceu o botão'}`)
            await closeGui()
            continue
          }
          proved = { file, frame, press }
          proven.push({ label, file, path })
          step(
            `  janela ${label} (${file}): ${frame.clientWidth}x${frame.clientHeight}, handle ${frame.hwnd ? 'ok' : 'ausente'}, ` +
              `${frame.pluginAskedForSize ? 'tamanho pedido pelo plugin' : 'tamanho pedido pelo host'}, ` +
              `${frame.childrenFitted ? `${frame.childrenFitted} filho(s) encaixado(s)` : 'sem filhos'}` +
              `${frame.platformType ? `, plataforma ${frame.platformType}` : ''}`,
            true,
          )
          step(`  a faixa avisa: ${JSON.stringify(press.said.slice(0, 60))}`, press.opened)
          // REAPER does not squeeze a plugin's face between knobs: the chain keeps
          // its column and the interface keeps the rest of the window. The proof
          // is geometry — the pane is a child of the FX window, it sits beside the
          // chain, it is wider than the column it left, and the plugin's canvas is
          // the area under the bar that names it.
          const split = await win.webContents.executeJavaScript(`(() => {
            const host = document.querySelector('.fx-window');
            const stack = document.querySelector('.fx-window > .native-vst-faces');
            const stage = stack?.querySelector(':scope > .native-vst-stage');
            const body = document.querySelector('.fx-window .fx-body-scroll');
            const canvas = stage?.querySelector('.native-vst-stage-canvas');
            const bar = stage?.querySelector('.native-vst-stage-bar');
            if (!host || !stack || !stage || !body || !canvas || !bar) return null;
            const h = host.getBoundingClientRect();
            const s = stage.getBoundingClientRect();
            const b = body.getBoundingClientRect();
            const c = canvas.getBoundingClientRect();
            const barBox = bar.getBoundingClientRect();
            return {
              beside: s.left >= b.right - 2,
              wide: s.width >= h.width * 0.5,
              canvas: [Math.round(c.width), Math.round(c.height)],
              // The footer is a separate grid row. The canvas ends at the
              // stage's bottom, under its own bar — not at the window's bottom.
              underBar: c.top >= barBox.bottom - 1 && Math.abs(s.bottom - c.bottom) <= 2 && c.height > 200,
              fits: h.right <= window.innerWidth + 1 && h.bottom <= window.innerHeight + 1,
            };
          })()`)
          step(
            `  a cadeia fica ao lado da interface (${
              split
                ? `${split.canvas[0]}x${split.canvas[1]}px de tela, janela ${split.fits ? 'inteira' : 'cortada'}`
                : 'sem painel dividido'
            })`,
            !!split && split.beside && split.wide && split.underBar && split.fits,
          )
          step(
            `  a interface ${frame.clientWidth}x${frame.clientHeight} cabe na área do painel`,
            !!split && frame.clientWidth <= split.canvas[0] + 2 && frame.clientHeight <= split.canvas[1] + 2,
          )
          step(`captura da janela ${label}`, await grab(`selftest-gui-${label.toLowerCase()}.png`))
          // The FX window minimises now, and a plugin interface that stayed put
          // would be an amp face hovering over a desktop that no longer holds it.
          // So the pane's visibility drives the window's own, and the round trip
          // has to leave the plugin open with its knobs where they were.
          const putAway = await ask('gui-show', { path, visible: false }, 20000)
          const broughtBack = await ask('gui-show', { path, visible: true }, 20000)
          step(
            `  miniminar o painel põe a janela fora da tela e traz de volta (${label})`,
            putAway.ok === true &&
              putAway.visible === false &&
              broughtBack.visible === true &&
              broughtBack.state?.open === true,
          )
          // The complaint this round answers is the producer's own: the app window
          // gets dragged and the plugin's interface stays on the old pixels, which
          // makes it an external window again. Nothing in the page moved — the pane
          // is the same rectangle, only the screen under it changed — so the app
          // has to send the window after itself. Move the window, read the plugin
          // back, and check it came along and stayed inside.
          //
          // The move is by where the app actually ended up, not by where it asked
          // to go: this window is nearly as big as the display, and a Windows move
          // can be answered with the same pixels. Measuring the applied bounds is
          // what tells "the plugin did not follow" from "the app did not go" —
          // two very different failures that used to print the same line.
          const place = win.getBounds()
          const work = screen.getDisplayMatching(place).workArea
          const resting = {
            x: work.x + 20,
            y: work.y + 20,
            width: Math.min(place.width, work.width - 40),
            height: Math.min(place.height, work.height - 40),
          }
          win.setBounds(resting)
          await new Promise((resolve) => setTimeout(resolve, 400))
          const moved = win.getBounds()
          const offset = { x: Math.min(140, work.width - moved.width - 60), y: Math.min(90, work.height - moved.height - 60) }
          const near = screen.dipToScreenPoint({ x: moved.x, y: moved.y })
          const far = screen.dipToScreenPoint({ x: moved.x + offset.x, y: moved.y + offset.y })
          const expected = { x: Math.round(far.x - near.x), y: Math.round(far.y - near.y) }
          const before = (await ask('gui-state', { path }, 20000)).state ?? {}
          win.setBounds({ ...moved, x: moved.x + offset.x, y: moved.y + offset.y })
          const applied = win.getBounds()
          const gone = Math.abs(applied.x - moved.x) >= 40 && Math.abs(applied.y - moved.y) >= 40
          let followed = null
          let last = null
          for (let i = 0; i < 60 && !followed; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100))
            const look = await ask('gui-state', { path }, 20000)
            const now = look.state ?? {}
            if (now.open === true && Number.isFinite(Number(now.x))) {
              last = now
              if (
                Math.abs(Number(now.x) - Number(before.x) - expected.x) <= 12 &&
                Math.abs(Number(now.y) - Number(before.y) - expected.y) <= 12
              ) {
                followed = now
              }
            }
          }
          const area = screenRect({ x: 0, y: 0 }, win.webContents).inside
          const inside =
            !!followed &&
            Number(followed.x) >= area.x - 2 &&
            Number(followed.y) >= area.y - 2 &&
            Number(followed.x) + Number(followed.clientWidth) <= area.x + area.width + 2 &&
            Number(followed.y) + Number(followed.clientHeight) <= area.y + area.height + 2
          // What the screen saw, in one sentence the producer can read: how far the
          // plugin's window travelled against how far the app did, or, when it did
          // not follow, whether the app itself even moved.
          const andou = followed
            ? `${Math.round(Number(followed.x) - Number(before.x))},${Math.round(
                Number(followed.y) - Number(before.y),
              )} esperado ${expected.x},${expected.y}`
            : `ficou onde estava: andou ${
                last
                  ? `${Math.round(Number(last.x) - Number(before.x))},${Math.round(
                      Number(last.y) - Number(before.y),
                    )}`
                  : 'nada'
              } de ${expected.x},${expected.y} em 6s; o app ${
                gone ? 'andou de verdade' : 'não saiu do lugar'
              }`
          step(`  mover o OpenDAW leva a janela do plugin junto (${andou})`, !!followed)
          step('  e ela continua dentro da área do app', inside)
          if (!followed) {
            // Which of the three authors it was: never recorded, refused, or
            // overwritten after the place. The map and the ticker's own reasons say.
            note(
              `    rastros do painel: ${JSON.stringify(paneTrace.slice(-6))} ` +
                `· decididor ${JSON.stringify(paneDebug)} · ${guiPanes.size} painel(is) no mapa`,
            )
          }
          win.setBounds(moved)
          await new Promise((resolve) => setTimeout(resolve, 300))
          const settled = await ask('gui-state', { path }, 20000)
          step(
            '  de volta ao lugar, a janela do plugin volta também',
            !!followed &&
              settled.state?.open === true &&
              Math.abs(Number(settled.state?.x) - Number(before.x)) <= 12,
          )
          // The other way the same promise gets broken: the plugin's canvas is
          // bigger than the app. The producer pulls the window down to its
          // minimum, and an interface that keeps the size it signed up for is an
          // interface hanging off the screen with its knobs out of reach. The
          // app's area is the ceiling, so the window has to come inside it.
          const roomy = win.getBounds()
          win.setBounds({ x: roomy.x, y: roomy.y, width: 1100, height: 680 })
          let squeezed = null
          for (let i = 0; i < 60 && !squeezed; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100))
            const look = await ask('gui-state', { path }, 20000)
            const now = look.state ?? {}
            const limit = screenRect({ x: 0, y: 0 }, win.webContents).inside
            if (
              now.open === true &&
              Number(now.x) >= limit.x - 2 &&
              Number(now.y) >= limit.y - 2 &&
              Number(now.clientWidth) <= limit.width + 2 &&
              Number(now.clientHeight) <= limit.height + 2
            ) {
              squeezed = { now, limit }
            }
          }
          step(
            `  uma janela do app menor não deixa o plugin passar dela ` +
              `(${squeezed ? `${squeezed.now.clientWidth}x${squeezed.now.clientHeight} na área de ${squeezed.limit.width}x${squeezed.limit.height}` : 'passou do app'})`,
            !!squeezed,
          )
          if (!squeezed) {
            note(
              `    o app encolheu para ${win.getBounds().width}x${win.getBounds().height} e o painel ` +
                `decidiu ${JSON.stringify(paneDebug)} · ${JSON.stringify(paneTrace.slice(-3))}`,
            )
          }
          win.setBounds(roomy)
          await new Promise((resolve) => setTimeout(resolve, 400))
          // The legs that follow measure levels and pixels of their own; the
          // window goes back to the size the run started this lane with.
          win.setBounds(place)
          await new Promise((resolve) => setTimeout(resolve, 300))

          const shut = await closeGui()
          const afterClose = await ask('gui-state', { path }, 20000)
          step(`  fechar na faixa devolve a tela (${label})`, shut && afterClose.state?.open !== true)
        } catch (error) {
          // A third-party GUI can take more than its own process down, and the
          // page's frame going away is a fact worth its own line rather than an
          // exception that silences the rest of the report.
          note(`  ${file}: a rodada da interface quebrou (${String(error.message).slice(0, 70)})`)
          if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
            throw new Error(`a janela do OpenDAW caiu junto com a interface de ${file}`)
          }
        }
      }
      step(`a interface ${label} abre no painel ao lado da cadeia`, proved !== null)
    }
    // Several interfaces at once — the other half of what the producer asked for.
    // A chain is a drive, an amp and a cab, and a host that can only ever show one
    // of their faces sends the producer back to the desktop for the knobs. So: two
    // rows in one lane, both windows up, and the question answered by the process
    // that holds them — are there two windows, with two handles, one per row? Then
    // close one and see whether the other is still where it was.
    //
    // Two different plugins is the everyday shape; when the machine only answered
    // with one that opens, the same file goes in twice, which is the harder case:
    // the host keys its windows by row, and a second row of one .dll that shared
    // the first row's instance would be one interface standing in for two sounds.
    const pair =
      proven.length >= 2
        ? [proven[0].path, proven[1].path]
        : proven.length === 1
          ? [proven[0].path, proven[0].path]
          : []
    const openTwo =
      pair.length === 2
        ? await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const stages = () => [...document.querySelectorAll('.native-vst-faces > .native-vst-stage')];
      const rows = () => [...document.querySelectorAll('.native-vst-row')];
      const canvas = (s) => s.querySelector('.native-vst-stage-canvas').getBoundingClientRect();
      const out = { rows: 0, faces: 0, slots: [], paths: [], boxes: [], picked: '' };
      // The second file goes in through "+ Plugin", the way a producer adds it:
      // with no row selected the picker appends one instead of replacing.
      document.querySelector('.native-vst-row-name')?.click();
      [...document.querySelectorAll('.native-vst-chain button')].find((b) => /\\+ Plugin/.test(b.textContent || ''))?.click();
      const wanted = ${JSON.stringify(pair[1])};
      for (let i = 0; i < 200 && rows().length < 2; i += 1) {
        const select = document.querySelector('.native-vst select');
        if (select && select.value !== wanted) {
          select.value = wanted;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await waitFor(100);
      }
      out.rows = rows().length;
      out.picked = (document.querySelector('.native-vst select')?.value || '').split(/[\\\\/]/).pop();
      // Both windows, opened from their own rows: a face belongs to the line in
      // the chain, not to whichever row the panel happens to be editing.
      for (const row of rows().slice(0, 2)) {
        if (row.dataset.faceOpen !== '1') row.querySelector('.native-vst-row-gui')?.click();
        for (let i = 0; i < 400 && row.dataset.faceOpen !== '1'; i += 1) await waitFor(100);
      }
      const list = stages();
      out.faces = list.length;
      // The handles are looked up by what the face itself says it belongs to, not
      // by the row's id: the stack and the chain can only be compared later if
      // both halves of the test ask about the same key.
      out.slots = list.map((s) => s.dataset.faceKey || '');
      out.paths = list.map((s) => s.dataset.facePath || '');
      out.boxes = list.map((s) => {
        const b = canvas(s);
        return [Math.round(b.width), Math.round(b.height), Math.round(b.top)];
      });
      return out;
    })()`)
        : null
    const twoHandles = []
    if (openTwo) {
      for (let i = 0; i < openTwo.slots.length; i += 1) {
        const look = await ask('gui-state', { path: openTwo.paths[i], sessionId: openTwo.slots[i] }, 20000)
        twoHandles.push(Number(look.state?.hwnd) || 0)
      }
    }
    // Each face the height it was given, one under the other, and both wide
    // enough to be read: a column that squeezed the second interface to a strip
    // would be the same complaint the producer made about the old panel.
    step(
      `  duas interfaces abertas ao mesmo tempo (${openTwo?.faces ?? 0} no painel, ` +
        `${openTwo?.boxes.map((b) => `${b[0]}x${b[1]}`).join(' + ') ?? 'nada'}; ` +
        `handles ${twoHandles.join(' / ') || 'nenhum'})`,
      !!openTwo &&
        openTwo.faces === 2 &&
        openTwo.rows >= 2 &&
        twoHandles.length === 2 &&
        twoHandles.every((h) => h > 0) &&
        twoHandles[0] !== twoHandles[1] &&
        openTwo.boxes.every((b) => b[0] > 200 && b[1] > 120) &&
        Math.abs(openTwo.boxes[0][2] - openTwo.boxes[1][2]) > 30,
    )
    const closeOne = openTwo
      ? await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const stages = () => [...document.querySelectorAll('.native-vst-faces > .native-vst-stage')];
      const rows = () => [...document.querySelectorAll('.native-vst-row')];
      const rowOf = (key) => rows().find((r) => (r.dataset.slotId || '') === key);
      const out = { left: 0, stillOpen: 0, closedKey: '', closedPath: '', slot: '', path: '', kept: '' };
      const first = stages()[0];
      out.closedKey = first?.dataset.faceKey || '';
      out.closedPath = first?.dataset.facePath || '';
      first?.querySelector('.native-vst-stage-bar button')?.click();
      for (let i = 0; i < 100 && stages().length > 1; i += 1) await waitFor(100);
      const rest = stages();
      out.left = rest.length;
      // The row that kept its window still says so, and the one that lost it does
      // not: the strip is the producer's only readout of which line has a face.
      // Which face moved up in the column is not a fault — the stack closes its
      // gap — so what is checked is that the survivor is still the same plugin.
      const survivor = rest[0]
      out.slot = survivor?.dataset.faceKey || ''
      out.path = survivor?.dataset.facePath || ''
      out.kept = survivor?.querySelector('.native-vst-stage-name')?.textContent?.slice(0, 24) ?? ''
      out.stillOpen = document.querySelectorAll('.native-vst-row[data-face-open=\\'1\\']').length
      out.rowClosedFlag = rowOf(out.closedKey)?.dataset.faceOpen ?? ''
      return out;
    })()`)
      : null
    // The two questions a stack of faces has to answer: the window that stayed is
    // the same window (same handle, same plugin, same knobs), and the one that was
    // closed is really down in the process that drew it — not left on screen with
    // nothing in the page pointing at it any more. Both are read here, while the
    // survivor is still on screen: the housekeeping below closes it too, and a
    // window that has been put away on purpose tells nothing about whether the
    // close of its neighbour touched it.
    const handleBefore = new Map((openTwo?.slots ?? []).map((slot, i) => [slot, twoHandles[i]]))
    const keptLook = closeOne?.slot
      ? await ask('gui-state', { path: closeOne.path, sessionId: closeOne.slot }, 20000)
      : {}
    const droppedLook = closeOne?.closedKey
      ? await ask('gui-state', { path: closeOne.closedPath, sessionId: closeOne.closedKey }, 20000)
      : {}
    const keptSame =
      !!closeOne &&
      Number(keptLook.state?.hwnd) === Number(handleBefore.get(closeOne.slot)) &&
      keptLook.state?.open === true
    const droppedGone = !closeOne || droppedLook.noEditor === true || droppedLook.state?.open !== true
    step(
      `  fechar uma deixa a outra na tela (restam ${closeOne?.left ?? 0}, ` +
        `${closeOne?.stillOpen ?? 0} linha(s) com janela${closeOne?.kept ? `, ${closeOne.kept}` : ''}` +
        `, handle ${Number(keptLook.state?.hwnd) || 0} contra ${handleBefore.get(closeOne?.slot ?? '') ?? 'ausente'}` +
        `${droppedGone ? '' : ', a fechada continua no ar'})`,
      !!closeOne &&
        closeOne.left === 1 &&
        closeOne.stillOpen === 1 &&
        closeOne.rowClosedFlag === '0' &&
        keptSame &&
        droppedGone,
    )
    // The shape this feature promises: a row that leaves the chain takes its
    // window with it, and closing every window leaves the lane as it was found.
    // Read after the two answers above, so the survivor is only put away once it
    // has been proved to be the same window it was.
    const sweep = closeOne
      ? await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const stages = () => [...document.querySelectorAll('.native-vst-faces > .native-vst-stage')];
      const rows = () => [...document.querySelectorAll('.native-vst-row')];
      const out = { cleared: -1, windowsDown: -1, removed: false };
      for (const s of stages()) s.querySelector('.native-vst-stage-bar button')?.click();
      for (let i = 0; i < 100 && stages().length > 0; i += 1) await waitFor(100);
      out.cleared = stages().length;
      const kill = rows().slice(-1)[0]?.querySelector('.mini-btn.danger');
      kill?.click();
      for (let i = 0; i < 200 && rows().length > 1; i += 1) await waitFor(100);
      out.removed = rows().length === 1;
      return out;
    })()`)
      : null
    // The process is the one that has to confirm the sweep: the page put the
    // windows away, so the only remaining doubt is whether anything is left up
    // there with nothing pointing at it.
    const stillUp = sweep
      ? (
          await Promise.all(
            (openTwo?.slots ?? []).map(async (slot, i) => {
              // The survivor was closed by this sweep on purpose; the question is
              // whether the process agrees that nothing of this lane is up.
              const look = await ask('gui-state', { path: openTwo.paths[i], sessionId: slot }, 20000).catch(
                () => ({}),
              )
              return look.state?.open === true
            }),
          )
        ).filter(Boolean).length
      : -1
    step(
      `  e o resto sai junto: janela(s) ${sweep?.cleared ?? -1} após fechar todas, ` +
        `${stillUp} ainda no ar no processo, cadeia com ${sweep?.removed ? 'uma' : 'duas'} linha(s)`,
      !!sweep && sweep.cleared === 0 && sweep.removed && stillUp === 0,
    )
    // The cost of the round, in the plugin's own terms: how many times a
    // third-party binary took its process down while the app was watching.
    const survived = plugins.faults()
    note(
      `  quedas do processo dos plugins durante o teste: ${survived.count}` +
        `${survived.reason ? ` (a última ${survived.reason})` : ''}`,
    )

    // Whether a plugin can be heard in the room, not only in the file, is a
    // measurement, not a promise. A browser's audio thread gets 128 samples of
    // budget and cannot wait on a process boundary, so the only question that
    // matters is how many frames of audio it has to render while it waits for
    // the process that holds the .dll to answer. The page builds the channel
    // around its own audio thread and hands the far end down through the window;
    // the preload carries it here. Two seconds of that, counted by the audio
    // thread's own frame counter, decides what the app may promise out loud.
    const realtime = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const out = { handed: false, ready: false, blocks: 0, seconds: 0, rate: 0, main: null, worker: null, error: '' };
      let ctx = null;
      try {
        ctx = new AudioContext();
        out.rate = ctx.sampleRate;
        await ctx.resume();
        if (ctx.state !== 'running') throw new Error('sem saída de áudio (' + ctx.state + ')');
        await ctx.audioWorklet.addModule('/rt/rt-bridge-worklet.js');
        const node = new AudioWorkletNode(ctx, 'rt-bridge', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        const mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute);
        mute.connect(ctx.destination);
        const seen = { ready: false, last: null };
        node.port.onmessage = (event) => {
          const data = event.data;
          if (data.kind === 'ready') seen.ready = true;
          if (data.kind === 'stats') seen.last = data;
        };
        window.addEventListener('message', (event) => {
          const data = event.data;
          if (event.source === window && data && data.opdawRt === 'status' && data.ok === true) out.handed = true;
        });
        // The page owns the channel because only its own ports can be
        // transferred into its audio thread.
        const channel = new MessageChannel();
        node.port.postMessage({ attachPort: channel.port1 }, [channel.port1]);
        window.postMessage({ opdawRt: 'handoff' }, '*', [channel.port2]);
        for (let i = 0; i < 60 && !out.handed; i += 1) await waitFor(100);
        out.ready = seen.ready;
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          if (seen.last && seen.last.frames >= out.rate * 2) break;
          await waitFor(120);
        }
        const last = seen.last ?? {};
        out.blocks = last.blocks ?? 0;
        out.seconds = (last.frames ?? 0) / out.rate;
        out.rate = last.rate || out.rate;
        out.main = last.main;
        out.worker = last.worker;
        return out;
      } catch (error) {
        out.error = String(error?.message ?? error).slice(0, 90);
        return out;
      } finally {
        try {
          await ctx?.close();
        } catch {}
      }
    })()`)

    // The wait is counted in frames because that is the currency of the thread
    // that paid for it: 128 frames is one block of audio, and a round trip that
    // costs one block is a chain the producer can play through. Frames are also
    // what the app would have to hold as lookahead, so the same number says how
    // much delay the live path adds.
    const rtFmt = (sample) =>
      sample
        ? `${sample.n}x · mediana ${sample.median} amostras (${((sample.median / (realtime.rate || 48000)) * 1000).toFixed(1)}ms) · ` +
          `média ${sample.avg} · pior ${sample.worst}`
        : 'sem resposta'
    const rtOwed = (realtime.rate || 48000) / 128
    const rtBlocksPerSecond = realtime.seconds > 0 ? realtime.blocks / realtime.seconds : 0
    note(
      `  ponte de tempo real medida pelo próprio thread de áudio: ${realtime.blocks} blocos em ` +
        `${realtime.seconds.toFixed(2)}s a ${realtime.rate}Hz ` +
        `(${rtBlocksPerSecond.toFixed(0)} blocos/s, esperados ${rtOwed.toFixed(0)})` +
        `${realtime.error ? ` — ${realtime.error}` : ''}`,
    )
    note(`    até o app: ${rtFmt(realtime.main)}`)
    note(`    até o processo dos plugins: ${rtFmt(realtime.worker)}`)
    step(
      '  a página abre o canal e o preload entrega ao app',
      !realtime.error && realtime.handed === true && realtime.ready === true,
    )
    step(
      `  o thread não espera pela ponte (${rtBlocksPerSecond.toFixed(0)} de ${rtOwed.toFixed(0)} blocos/s)`,
      !realtime.error && realtime.seconds >= 1.5 && rtBlocksPerSecond >= rtOwed * 0.9,
    )
    step(
      '  a ponte atravessa até o processo dos plugins e volta',
      !realtime.error && !!realtime.main?.n && !!realtime.worker?.n,
    )

    // What the page holds right now, read before and after the keystroke. The
    // toolbar's own row carries the depth of the undo stack, so a step that did
    // not get recorded says so here instead of leaving the next line to guess;
    // and the time the page took to answer separates a hung renderer (seconds)
    // from an assertion that is simply false (milliseconds).
    const probe = async (label) => {
      const at = Date.now()
      const state = await win.webContents.executeJavaScript(`(() => {
        const row = [...document.querySelectorAll('.dropdown button')]
          .find((b) => /Desfazer/.test(b.textContent || ''));
        const shelf = document.querySelector('.take-actions');
        return {
          undo: row ? (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 20) : '(sem linha)',
          blocked: row ? row.disabled : null,
          shelf: shelf ? (shelf.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 56) : '(nenhuma)',
          clip: !!document.querySelector('.arrangement-lane .audio-item'),
          fx: !!document.querySelector('.fx-window'),
          toast: (document.querySelector('.toast')?.textContent || '').trim().slice(0, 56),
        };
      })()`)
      state.ms = Date.now() - at
      note(
        `  ${label}: ${state.undo} (desabilitado: ${state.blocked}) · prateleira ${JSON.stringify(state.shelf)} · ` +
          `clipe ${state.clip} · janela de FX ${state.fx ? 'aberta' : 'fechada'} · respondeu em ${state.ms}ms` +
          `${state.toast ? ` · aviso ${JSON.stringify(state.toast)}` : ''}`,
      )
      return state
    }

    await probe('estado antes de fechar')
    const shut = await win.webContents.executeJavaScript(`(async () => {
      const footer = [...document.querySelectorAll('.fx-window .fx-footer button')]
        .find((b) => (b.textContent || '').trim() === 'Fechar');
      // The footer is the polite way out; the header's X is the one a producer
      // reaches for when the list has grown past the scroll.
      const close = footer ?? [...document.querySelectorAll('.fx-window .fx-header button')]
        .find((b) => (b.textContent || '').trim() === 'X');
      if (close) close.click();
      for (let i = 0; i < 30 && document.querySelector('.fx-window'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return !document.querySelector('.fx-window');
    })()`)
    step('  janela fecha depois do bounce', shut)

    // The insert promises Ctrl+Z hands the dry pass back. The take shelf only
    // renders while the lane has takes, so its disappearance is the proof.
    //
    // The bounce is no longer the last thing the run touched — the chain rows and
    // the plugin windows were tested after it, and each of those edits is a step
    // of its own — so the walk is honest about that: undo until the shelf goes and
    // count the presses a producer would need, while still checking the promise
    // that matters, which is that the clip survives the whole walk and the undo
    // stops before the recording itself is undone.
    const beforeUndo = await probe('antes do Ctrl+Z')
    const walked = []
    let shelfGone = false
    for (let step = 0; step < 8 && !shelfGone; step += 1) {
      win.webContents.send('opdaw:menu', 'undo')
      const look = await win.webContents.executeJavaScript(`(async () => {
        const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let i = 0; i < 150 && document.querySelector('.take-actions'); i += 1) await waitFor(100);
        return {
          shelf: !document.querySelector('.take-actions'),
          clip: !!document.querySelector('.arrangement-lane .audio-item'),
          undo: [...document.querySelectorAll('.dropdown button')]
            .find((b) => /Desfazer/.test(b.textContent || ''))?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 14) ?? '',
        };
      })()`)
      walked.push(look)
      shelfGone = look.shelf
    }
    const undone = walked[walked.length - 1] ?? { shelf: false, clip: false }
    const afterUndo = await probe('depois do Ctrl+Z')
    step(
      `  Ctrl+Z devolve o seco sem perder o clipe (${walked.length} passo(s) até a prateleira ` +
        `sumir, clipe ${undone.clip ? 'ficou' : 'sumiu'})`,
      undone.shelf && undone.clip,
    )
    if (!(undone.shelf && undone.clip)) {
      // Which half of the promise broke, in the page's own words.
      note(
        `    por que falhou: a prateleira ${undone.shelf ? 'sumiu' : 'ficou'} e o clipe ` +
          `${undone.clip ? 'ficou' : 'sumiu'} — pilha antes ${JSON.stringify(beforeUndo.undo)} ` +
          `e depois ${JSON.stringify(afterUndo.undo)} (caminhada ${JSON.stringify(
          walked.map((w) => `${w.shelf ? 'prateleira fora' : 'prateleira'}${w.clip ? '' : ' SEM CLIPE'}/${w.undo}`),
        )})`,
      )
    }

    const afterBounce = await grab('selftest-bounce.png')
    step('captura após o bounce', afterBounce)

    // ------------------------------------------------------------ o cabo virtual
    // The one feature here that only exists if two programs agree: the room's
    // SDK, imported over the network from a different port, and this app's master
    // bus. Everything below is read off the window the producer actually sees —
    // the two meters are the page's own rAF loop, not a guess from network stats.
    const salaBase = (process.env.OPENDAW_SALA || 'http://127.0.0.1:5263').replace(/\/+$/, '')
    let salaInfo = null
    try {
      salaInfo = await fetch(`${salaBase}/api/info`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json())
    } catch (error) {
      note(`  a sala não respondeu em ${salaBase}: ${error.message}`)
    }
    if (!salaInfo || !Array.isArray(salaInfo.rooms)) {
      step(`cabo virtual: sala fora do ar — rode "node server.js --http" na pasta sala e repita (${salaBase})`, false)
    } else {
      note(`  sala alcançada: ${salaBase} (instância ${salaInfo.instance}, ${salaInfo.tls ? 'https' : 'http'})`)
      const salaRoom = `cabo${Math.random().toString(36).slice(2, 6)}`
      const ligou = await win.webContents.executeJavaScript(`(async () => {
        const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const text = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
        const setVal = (input, value) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const out = { botao: false, janela: false, faixasAntes: 0, faixasDepois: 0, luz: '', jack: '', erro: '', nomes: [], aviso: '' };
        const btn = document.querySelector('.menu-sala');
        if (!btn) return out;
        out.botao = true;
        btn.click();
        for (let i = 0; i < 40 && !document.querySelector('.sala-window'); i += 1) await waitFor(50);
        const janela = document.querySelector('.sala-window');
        if (!janela) return out;
        out.janela = true;
        out.faixasAntes = document.querySelectorAll('.tcp-track').length;
        out.clipeAntes = document.querySelectorAll('.audio-item').length;
        const campos = [...janela.querySelectorAll('.sala-fields input')];
        setVal(campos[0], ${JSON.stringify(salaBase)});
        setVal(campos[1], ${JSON.stringify(salaRoom)});
        setVal(campos[3], 'DAW executável');
        // "faixa gravável" ligado de propósito: é a promessa que se quer ver cumprida.
        const caixas = [...janela.querySelectorAll('.sala-check input')];
        if (!caixas[0].checked) caixas[0].click();
        [...janela.querySelectorAll('button')].find((b) => /LIGAR O CABO/i.test(text(b))).click();
        for (let i = 0; i < 120 && !janela.querySelector('.sala-led'); i += 1) await waitFor(100);
        out.luz = document.querySelector('.menu-sala')?.textContent || '';
        out.jack = text(janela.querySelector('.sala-jack'));
        out.erro = text(document.querySelector('.sala-error'));
        out.aviso = text(document.querySelector('.sala-notice'));
        out.nomes = [...document.querySelectorAll('.track-title')].map((i) => i.value);
        out.faixasDepois = document.querySelectorAll('.tcp-track').length;
        return out;
      })()`)
      step('  a entrada do cabo está no menu Mix (o jack saiu da mesa)', ligou.botao)
      step('  a janela do cabo abriu', ligou.janela)
      step(
        `  o SDK importado de outra origem ligou o cabo: ${JSON.stringify(ligou.jack)}${
          ligou.erro ? ` — erro ${JSON.stringify(ligou.erro.slice(0, 90))}` : ''
        }`,
        /enviando a master/i.test(ligou.jack) && /\(ligado\)/.test(ligou.luz),
      )

      // Um músico de fora, sintético, com o mesmo SDK que a DAW carregou: é ele
      // que tem que virar faixa gravável sem ninguém mexer em nada.
      const convidado = await win.webContents.executeJavaScript(`(async () => {
        const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const text = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
        const base = ${JSON.stringify(salaBase)};
        const mod = await import(base + '/js/sala-sdk.js?cb=' + Date.now());
        const ctx = new AudioContext();
        await ctx.resume().catch(() => {});
        const osc = ctx.createOscillator();
        osc.frequency.value = 260;
        const gain = ctx.createGain();
        gain.gain.value = 0.3;
        osc.connect(gain);
        osc.start();
        const link = await mod.joinRoom({
          url: base,
          room: ${JSON.stringify(salaRoom)},
          name: 'Convidado do teste',
          audioContext: ctx,
          mode: 'jam',
          ice: { hostOnly: true },
        });
        link.useNode(gain, { kind: 'daw' });
        window.__salaConvidado = { link, ctx, osc, gain };
        const antes = document.querySelectorAll('.tcp-track').length;
        for (let i = 0; i < 90 && document.querySelectorAll('.tcp-track').length === antes; i += 1) await waitFor(100);
        await waitFor(400);
        const nomes = [...document.querySelectorAll('.track-title')].map((input) => input.value);
        return {
          entrou: !!link.peerId,
          faixasNovas: document.querySelectorAll('.tcp-track').length - antes,
          nomes,
          rotulo: nomes.slice(antes),
          naJanela: text(document.querySelector('.sala-peers')),
        };
      })()`)
      step(
        `  o convidado virou faixa sozinho: ${JSON.stringify(convidado.rotulo)}`,
        convidado.entrou && convidado.faixasNovas > 0 && /Convidado do teste/.test(convidado.rotulo.join(' ')),
      )
      step(`  a janela lista o par: ${JSON.stringify(convidado.naJanela)}`, /Convidado do teste/.test(convidado.naJanela))

      // Rastro do que acontece com a janela. A perna já apanhou aqui com as duas
      // barras em zero e a foto mostrando a janela fechada, sem explicação — então
      // um MutationObserver marca o instante em que a janela sai do DOM e o estado
      // do jack nesse momento. Na próxima rodada quem fechou está dito, não chutado.
      await win.webContents.executeJavaScript(`(() => {
        const t = (window.__trilha = []);
        const estado = (porQue) => t.push({
          t: Math.round(performance.now()),
          porQue,
          janela: !!document.querySelector('.sala-window'),
          barras: document.querySelectorAll('.sala-bar').length,
          led: !!document.querySelector('.sala-led'),
          jack: (document.querySelector('.menu-sala')?.textContent || '').trim(),
        });
        estado('rastro instalado');
        const obs = new MutationObserver(() => {
          const sumida = !document.querySelector('.sala-window');
          if (sumida !== obs.janelaSumida) {
            obs.janelaSumida = sumida;
            estado(sumida ? 'a janela saiu do DOM' : 'a janela voltou ao DOM');
          }
        });
        obs.janelaSumida = !document.querySelector('.sala-window');
        obs.observe(document.body, { childList: true, subtree: true });
        // Leitura do motor, pelo fiber do React: é a testemunha quando a barra da
        // tela e o áudio discordam. A varredura começa no pé do React (#root) e não
        // na janela do cabo — a janela pode estar escondida (o componente sai do
        // DOM quando não se desenha nada), e o engine é um só de qualquer forma.
        window.__engenho = (() => {
          const raiz = document.querySelector('#root') || document.body;
          const chave = Object.keys(raiz).find(
            (k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'),
          );
          const fila = chave ? [raiz[chave]] : [];
          let achado = null;
          while (fila.length && !achado) {
            const no = fila.shift();
            const eng = no?.memoizedProps?.engine;
            if (eng?.getCallSendLevel && eng?.getCallReturnLevel && eng?.callReturnKeys) achado = eng;
            if (no?.child) fila.push(no.child);
            if (no?.sibling) fila.push(no.sibling);
            if (fila.length > 6000) break;
          }
          return achado;
        })();
        window.__motor = () => {
          const eng = window.__engenho;
          if (!eng) return { erro: 'fiber sem engine' };
          return {
            ida: +eng.getCallSendLevel().toFixed(4),
            volta: +eng.getCallReturnLevel().toFixed(4),
            retornos: eng.callReturnKeys().length,
            faixas: eng.callInputKeys ? eng.callInputKeys().length : '?',
          };
        };
        // Média do nível colhida no próprio nó, no ritmo do áudio. A barra da tela
        // depende de pintura e de janela aberta; o número do graph depende só do
        // sinal, e é ele que diz se o transporte estava tocando ou não.
        window.__colher = async (ms, chave) => {
          const valores = [];
          const fim = Date.now() + ms;
          while (Date.now() < fim) {
            const lida = window.__motor()[chave];
            valores.push(typeof lida === 'number' ? lida : 0);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const media = valores.reduce((a, b) => a + b, 0) / Math.max(1, valores.length);
          return {
            media: +media.toFixed(4),
            max: +Math.max(...valores, 0).toFixed(4),
            lidas: valores.length,
          };
        };
        // Mudo coletivo das faixas durante as pernas do envio. Os plugins que as
        // pernas de VST deixaram abertos enchem o barramento de ruído (pico 0,66,
        // média 0,07) do mesmo tamanho do clique de metrônomo que se quer medir —
        // sem silenciar, o teste passava por sorte e não por prova. Guarda quais
        // botões ele próprio clicou para devolver só esses.
        window.__silenciarFaixas = (ligar) => {
          const botões = [...document.querySelectorAll('.tcp-track .btn-mute')];
          if (ligar) {
            window.__faixasMudadas = [];
            for (const b of botões) {
              if (!b.classList.contains('muted')) {
                b.click();
                window.__faixasMudadas.push(b);
              }
            }
          } else {
            for (const b of window.__faixasMudadas || []) {
              if (b.isConnected && b.classList.contains('muted')) b.click();
            }
            window.__faixasMudadas = [];
          }
          return {
            silenciadas: (window.__faixasMudadas || []).length,
            faixasNaTela: botões.length,
          };
        };
        return true;
      })()`)

      // Os dois medidores são a prova que importa. O convidado é mudo, depois fala,
      // e a VOLTA tem que subir com ele enquanto a IDA não se mexe — mix-minus: o
      // que chega da sala nunca volta pelo cabo. A comparação é relativa ao ruído
      // que já estava no barramento (uma entrada viva dos testes de antes enche a
      // ida mesmo com o transporte parado), senão o teste virava refém da ordem
      // das pernas.
      const mixMinus = await win.webContents.executeJavaScript(`(async () => {
        const waitFor = (t) => new Promise((resolve) => setTimeout(resolve, t));
        const barras = () => [...document.querySelectorAll('.sala-bar i')].map((i) => parseFloat(i.style.width) || 0);
        const pico = async (ms) => {
          const ida = [];
          const volta = [];
          const fim = Date.now() + ms;
          while (Date.now() < fim) {
            const [a, v] = barras();
            ida.push(a);
            volta.push(v);
            await waitFor(80);
          }
          return { ida: Math.max(...ida, 0), volta: Math.max(...volta, 0) };
        };
        const convidado = window.__salaConvidado;
        const motorCalado = window.__motor();
        if (!convidado) return { faltou: 'janela do convidado', motorCalado, trilha: window.__trilha };
        convidado.gain.gain.value = 0;
        await waitFor(700);
        const mudo = await pico(1400);
        convidado.gain.gain.value = 0.3;
        await waitFor(700);
        const falando = await pico(1400);
        return { mudo, falando, motorCalado, motorFalando: window.__motor(), trilha: window.__trilha || [] };
      })()`)
      const sobeVolta = !mixMinus.faltou && mixMinus.falando.volta - mixMinus.mudo.volta > 4 && mixMinus.falando.volta > 4
      const idaNaoSeMexe = !mixMinus.faltou && Math.abs(mixMinus.falando.ida - mixMinus.mudo.ida) < 3
      // o motor é a palavra final: se a volta dele sobe com o convidado falando e a
      // ida não se mexe, o mix-minus está de pé mesmo se a barra não pintou
      const motorProva =
        typeof mixMinus.motorFalando?.volta === 'number' &&
        mixMinus.motorFalando.volta > 0.02 &&
        Math.abs((mixMinus.motorFalando.ida ?? 9) - (mixMinus.motorCalado?.ida ?? 0)) < 0.02
      step(
        `  só o convidado falando: volta ${mixMinus.mudo?.volta ?? '?'}% calado → ${
          mixMinus.falando?.volta ?? '?'
        }% falando, ida ${mixMinus.mudo?.ida ?? '?'}% → ${mixMinus.falando?.ida ?? '?'}% (mix-minus) · motor ${JSON.stringify(
          mixMinus.motorCalado,
        )} → ${JSON.stringify(mixMinus.motorFalando)}`,
        (sobeVolta && idaNaoSeMexe) || motorProva,
      )
      if (mixMinus.faltou) note('  o convidado de teste não estava mais na página — mix-minus sem prova')
      note(`  rastro da janela do cabo: ${JSON.stringify(mixMinus.trilha || [])}`)

      // O envio só tem prova se houver áudio no barramento, e a grade pode estar
      // vazia nesta altura do teste — as pernas de plugin/bounce terminam com um
      // Ctrl+Z que devolve o take seco, e o cursor não volta ao zero quando o
      // transporte para. O metrônomo é a fonte que não depende de nenhuma das duas
      // coisas: o clique é sintetizado direto no `masterGain`, que é exatamente o
      // nó de onde o cabo pega a master.
      const gradeTemClipe = await win.webContents.executeJavaScript(
        `!!document.querySelector('.arrangement-lane .audio-item')`,
      )
      if (!gradeTemClipe) {
        note('  a grade estava sem clipe (o Ctrl+Z do teste de bounce levou a gravação molhada) — o envio vai ser provado com o clique do metrônomo no barramento')
      }

      const rodando = await win.webContents.executeJavaScript(`(async () => {
        const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const barras = () => [...document.querySelectorAll('.sala-bar i')].map((i) => parseFloat(i.style.width) || 0);
        const play = document.querySelector('.btn-play');
        const clique = document.querySelector('.transport-btn.toggle[title^="Metr"]');
        if (!play || !clique || !window.__colher) return { faltou: !play ? 'play' : !clique ? 'metrônomo' : 'leitor do motor' };
        const mudas = window.__silenciarFaixas(true);
        if (!clique.classList.contains('on')) clique.click();
        const base = await window.__colher(900, 'ida');
        const barraBase = barras()[0] ?? null;
        play.click();
        for (let i = 0; i < 60 && !play.classList.contains('active'); i += 1) await waitFor(100);
        const tocando = await window.__colher(2600, 'ida');
        const barraTocando = barras()[0] ?? null;
        play.click();
        for (let i = 0; i < 60 && play.classList.contains('active'); i += 1) await waitFor(100);
        await waitFor(300);
        const sobra = await window.__colher(700, 'ida');
        if (clique.classList.contains('on')) clique.click();
        window.__silenciarFaixas(false);
        return {
          base,
          tocando,
          sobra,
          barraBase,
          barraTocando,
          mudas,
          parado: !play.classList.contains('active'),
          motor: window.__motor(),
        };
      })()`)
      const envioVive =
        !rodando.faltou &&
        rodando.tocando.max > 0.1 &&
        rodando.base.max < 0.02 &&
        rodando.tocando.media > rodando.base.media + 0.008 &&
        rodando.parado
      step(
        `  o master no ar enche a ida no motor (${rodando.mudas?.silenciadas ?? '?'} faixas mudas para o ruído dos plugins não fraudar a medida): parado ${
          rodando.base?.media ?? '?'
        } (pico ${rodando.base?.max ?? '?'}) → metrônomo tocando ${rodando.tocando?.media ?? '?'} (pico ${
          rodando.tocando?.max ?? '?'
        }, ${rodando.tocando?.lidas ?? 0} leituras) → depois de parar ${
          rodando.sobra?.media ?? '?'
        }; barra da janela ${rodando.barraBase}% → ${rodando.barraTocando}%; transporte parado: ${rodando.parado}`,
        envioVive,
      )
      if (rodando.faltou) note(`  faltou ${JSON.stringify(rodando.faltou)} na página — envio não medido no motor`)

      // O botão de mudo do cabo: a sala para de ouvir, o medidor zera, e nada
      // muda na mixagem — é a porta de envio, não o fader mestre.
      const mudo = await win.webContents.executeJavaScript(`(async () => {
        const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const text = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
        const barras = () => [...document.querySelectorAll('.sala-bar i')].map((i) => parseFloat(i.style.width) || 0);
        const play = document.querySelector('.btn-play');
        const clique = document.querySelector('.transport-btn.toggle[title^="Metr"]');
        const janela = () => !!document.querySelector('.sala-window');
        const vazio = { comSom: { media: 0, max: 0 }, fechado: { media: 0, max: 0 }, reaberto: { media: 0, max: 0 } };
        if (!play) return { achou: false, ...vazio, rotulo: '', janela: janela(), faltou: 'play' };
        const mudas = window.__silenciarFaixas(true);
        if (clique && !clique.classList.contains('on')) clique.click();
        play.click();
        for (let i = 0; i < 60 && !play.classList.contains('active'); i += 1) await waitFor(100);
        const botao = [...document.querySelectorAll('.sala-window button')].find((b) => /CABO (ABERTO|FECHADO)/i.test(text(b)));
        if (!botao) {
          play.click();
          window.__silenciarFaixas(false);
          return { achou: false, ...vazio, rotulo: '', janela: janela(), faltou: 'botão do cabo' };
        }
        const comSom = await window.__colher(1300, 'ida');
        botao.click();
        await waitFor(300);
        const fechado = await window.__colher(1300, 'ida');
        const rotulo = text(botao);
        const barraFechada = barras()[0] ?? null;
        botao.click();
        await waitFor(300);
        // A metronome tick is a few milliseconds of a second, so the window that
        // proves the send came back has to be long enough to hold one — 1,3s read
        // a passing tick on some runs and none on others.
        const reaberto = await window.__colher(2600, 'ida');
        play.click();
        for (let i = 0; i < 60 && play.classList.contains('active'); i += 1) await waitFor(100);
        if (clique && clique.classList.contains('on')) clique.click();
        window.__silenciarFaixas(false);
        return { achou: true, comSom, fechado, reaberto, rotulo, barraFechada, mudas, janela: janela() };
      })()`)
      step(
        `  CABO FECHADO corta a ida no motor (pico ${mudo.comSom?.max ?? '?'} → ${mudo.fechado?.max ?? '?'} → ${
          mudo.reaberto?.max ?? '?'
        } ao reabrir; média ${mudo.comSom?.media ?? '?'} → ${mudo.fechado?.media ?? '?'}; barra ${
          mudo.barraFechada
        }%; rótulo ${JSON.stringify(mudo.rotulo)}; janela aberta: ${mudo.janela})`,
        mudo.achou && mudo.comSom.max > 0.1 && mudo.fechado.max < 0.005 && mudo.reaberto.max > 0.1 &&
          /FECHADO/.test(mudo.rotulo || ''),
      )

      note(
        `  rastro até o fim do cabo: ${JSON.stringify(
          await win.webContents.executeJavaScript(`(window.__trilha || []).slice(-8)`),
        )}`,
      )
      const foto = await grab('selftest-sala-cable.png')
      step('  foto da janela do cabo', foto)

      // Desligar o cabo tem que devolver exatamente o que ele pegou: as faixas
      // que nasceram da sala somem, a entrada do menu diz (desligado), e a grade
      // do producer fica clipe por clipe como estava — o cabo não mexe na mixagem.
      // A janela pode ter sido escondida por uma tecla das pernas anteriores (o
      // Esc fecha sobreposições), e escondida ela não está no DOM: se o menu
      // ainda disser (ligado), reabre-se por ele antes de desligar.
      // O número de antes do cabo é a régua: desligar tem que devolver exatamente
      // essas faixas, nem uma sobra da sala, nem uma do producer a menos.
      const faixasDoProducer = ligou.faixasAntes;
      const desligou = await win.webContents.executeJavaScript(`(async () => {
        const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const text = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
        window.__salaConvidado?.link?.leave();
        await waitFor(500);
        let janela = document.querySelector('.sala-window');
        const jackAceso = /\\(ligado\\)/.test(document.querySelector('.menu-sala')?.textContent || '');
        if (!janela && jackAceso) {
          document.querySelector('.menu-sala')?.click();
          for (let i = 0; i < 60 && !document.querySelector('.sala-window'); i += 1) await waitFor(100);
          janela = document.querySelector('.sala-window');
        }
        const nomesDeFaixa = () => [...document.querySelectorAll('.track-title')].map((input) => input.value);
        const antes = document.querySelectorAll('.tcp-track').length;
        const nomesAntes = nomesDeFaixa();
        const botao = janela && [...janela.querySelectorAll('button')].find((b) => /DESCONECTAR/i.test(text(b)));
        if (botao) botao.click();
        for (let i = 0; i < 60 && janela?.querySelector('.sala-led'); i += 1) await waitFor(100);
        await waitFor(600);
        const nomes = nomesDeFaixa();
        window.__salaConvidado?.ctx?.close().catch(() => {});
        return {
          semLuz: !janela?.querySelector('.sala-led'),
          reaberta: !botao && jackAceso,
          jack: (document.querySelector('.menu-sala')?.textContent || '').trim(),
          faixasAntes: antes,
          faixasDepois: document.querySelectorAll('.tcp-track').length,
          nomesAntes,
          nomes,
          // O que a sala acrescentou tem que sumir; o que já era do producer fica.
          novasQueSobraram: nomes.filter((n) => /Convidado|sala/i.test(n)),
          sobrouConvidado: nomes.some((n) => /Convidado do teste/.test(n)),
          clipe: document.querySelectorAll('.audio-item').length,
        };
      })()`)
      step(
        `  o cabo desligou e levou as faixas da sala junto (${desligou.faixasAntes} → ${desligou.faixasDepois} faixas, ${faixasDoProducer} eram do producer antes do cabo · nomes na mesa antes ${JSON.stringify(desligou.nomesAntes)} · depois ${JSON.stringify(desligou.nomes)} · sobra da sala ${JSON.stringify(desligou.novasQueSobraram)})`,
        desligou.semLuz && /\(desligado\)/.test(desligou.jack) && !desligou.sobrouConvidado &&
          desligou.novasQueSobraram.length === 0 && desligou.faixasDepois === faixasDoProducer,
      )
      step(
        `  a grade ficou como estava: ${ligou.clipeAntes} clipe(s) antes do cabo, ${desligou.clipe} depois de desligar`,
        desligou.clipe === ligou.clipeAntes,
      )
    }

    // The selftest wrote a clip into the app's own profile. Start a fresh
    // session afterwards so the producer never opens OpenDAW to find our noise.
    win.webContents.send('opdaw:menu', 'new-project')
    const reset = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 150 && document.querySelector('.arrangement-lane .audio-item'); i += 1) await waitFor(100);
      return !document.querySelector('.arrangement-lane .audio-item');
    })()`)
    step('sessão volta limpa após o teste', reset)

    // ---------------------------------------------------------------- ASIO
    // Proves the bundled PortAudio+ASIO engine through the same path the app
    // uses: enumerate via the host, then drive the real Devices UI to hand the
    // mix to the driver and confirm the worker writes blocks. A studio machine
    // without an ASIO driver is valid, so absence is a note, never a failure.
    // Runs last and gives the interface back afterwards, so it disturbs nothing.
    try {
      const listed = await asioHost.request('devices', {}, 20000)
      if (!listed.ok) {
        note(`ASIO: o motor não listou dispositivos — ${listed.error ?? 'sem detalhe'}`)
      } else if (!listed.asioPresent || (listed.devices ?? []).length === 0) {
        note('ASIO: a DLL carregou, mas nenhum driver ASIO de saída nesta máquina (instale o driver da interface ou o ASIO4ALL)')
      } else {
        note(`ASIO: ${listed.devices.length} saída(s) nativa(s) pronta(s)`)
        for (const device of listed.devices.slice(0, 6)) {
          note(`  · ${device.name} — ${device.maxOutputChannels} saídas | ${device.defaultSampleRate} Hz${device.isDefaultOutput ? ' | padrão' : ''}`)
        }
        // Drive the page: Devices ▸ ASIO ▸ Ativar, run the metronome so real PCM
        // crosses the tap, read the worker, then Parar and restore WASAPI.
        const drive = await win.webContents.executeJavaScript(`(async () => {
          const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const text = (node) => (node?.textContent || '').trim().replace(/\\s+/g, ' ');
          const out = { abriu: false, escolheu: false, ativou: false, ativo: '', parou: false, voltou: false, pico: 0, domPico: 0, realBlocks: 0, totalBlocks: 0, pcmMsgs: 0, pcmFloats: 0, portAttached: false, erro: '' };
          const abrir = [...document.querySelectorAll('.dropdown button')].find((b) => /Dispositivos de .udio/.test(b.textContent || ''));
          if (!abrir) return out;
          abrir.click();
          for (let i = 0; i < 40 && !document.querySelector('.dev-system'); i += 1) await waitFor(50);
          out.abriu = !!document.querySelector('.dev-system');
          const asioBtn = [...document.querySelectorAll('.dev-system')].find((b) => /^ASIO/.test(text(b.querySelector('.dev-system-name'))));
          if (!asioBtn || asioBtn.disabled) return out;
          // Choosing ASIO hands the mix to the driver immediately (chooseAudioSystem
          // calls activateAsio), so wait for the readout rather than a second click.
          asioBtn.click();
          out.escolheu = true;
          const ativoNow = () => /ASIO ativo/.test(text(document.querySelector('.dev-latency')));
          let retry = false;
          for (let i = 0; i < 160 && !ativoNow(); i += 1) {
            if (!retry && i >= 12) {
              const ativar = [...document.querySelectorAll('.devices-window .reaper-btn')].find((b) => /Ativar ASIO/.test(text(b)));
              if (ativar && !ativar.disabled) { ativar.click(); retry = true; }
            }
            await waitFor(50);
          }
          out.ativo = text(document.querySelector('.dev-latency')).slice(0, 120);
          out.ativou = /ASIO ativo/.test(out.ativo);
          out.erro = text(document.querySelector('.devices-window .plugin-note.error')).slice(0, 160);
          if (!out.ativou) return out;
          // Play the metronome and watch the worker WHILE it sounds: the status
          // push resets peak every 500 ms, so the honest proof of real PCM is
          // blocksWritten - silenceBlocks read during play, not the peak after.
          const metroBtn = [...document.querySelectorAll('.transport-btn')].find((b) => text(b) === '♪');
          const play = document.querySelector('.btn-play');
          const level = () => { const f = document.querySelector('.mcp-channel.master .mcp-meter-fill'); return f ? Number(String(f.style.height || '').replace('%', '')) || 0 : 0; };
          if (metroBtn && play) {
            if (!metroBtn.classList.contains('on')) metroBtn.click();
            play.click();
            for (let i = 0; i < 24; i += 1) {
              await waitFor(50);
              out.domPico = Math.max(out.domPico, level());
              try {
                const s = await window.OpenDAW.asio.status();
                if (s) {
                  out.pico = Math.max(out.pico, Number(s.peak) || 0);
                  out.totalBlocks = Math.max(out.totalBlocks, s.blocksWritten || 0);
                  out.realBlocks = Math.max(out.realBlocks, (s.blocksWritten || 0) - (s.silenceBlocks || 0));
                  out.pcmMsgs = Math.max(out.pcmMsgs, s.pcmMessages || 0);
                  out.pcmFloats = Math.max(out.pcmFloats, s.pcmFloats || 0);
                  out.portAttached = Boolean(s.portAttached);
                }
              } catch { /* o stream pode fechar no fim; ignora */ }
            }
            const stop = [...document.querySelectorAll('.transport-btn')].find((b) => text(b) === '◼');
            if (stop) stop.click(); else play.click();
            metroBtn.click();
          }
          await waitFor(300);
          const parar = [...document.querySelectorAll('.devices-window .reaper-btn')].find((b) => /Parar ASIO/.test(text(b)));
          if (parar) { parar.click(); out.parou = true; }
          for (let i = 0; i < 60 && /ASIO ativo/.test(text(document.querySelector('.dev-latency'))); i += 1) await waitFor(50);
          const wasapi = [...document.querySelectorAll('.dev-system')].find((b) => /^WASAPI compartilhado/.test(text(b.querySelector('.dev-system-name'))));
          if (wasapi) { wasapi.click(); out.voltou = true; }
          await waitFor(200);
          const fechar = [...document.querySelectorAll('.devices-window .reaper-btn')].find((b) => text(b) === 'X');
          if (fechar) fechar.click();
          return out;
        })()`)
        // Real PCM is proven by the drive watching the worker during play:
        // realBlocks = blocksWritten - silenceBlocks. The DOM master meter says
        // the metronome actually sounded, so a zero here is a tap/handoff fault,
        // not a silent transport.
        const wrote = drive.realBlocks > 0
        step(
          `  ASIO pela UI: abriu ${drive.abriu}, escolheu ${drive.escolheu}, ativou ${drive.ativou} (${drive.ativo || 'sem leitura'}), metrônomo na master ${drive.domPico}%, ${drive.realBlocks} bloco(s) de PCM real de ${drive.totalBlocks} (pico ${Number(drive.pico).toFixed(3)}), porta no worker ${drive.portAttached}, ${drive.pcmMsgs} msg PCM / ${drive.pcmFloats} amostras, erro "${drive.erro}", parou ${drive.parou}, voltou ao WASAPI ${drive.voltou}`,
          Boolean(drive.ativou && wrote && drive.parou && drive.voltou),
        )
      }
    } catch (error) {
      note(`ASIO: o motor não respondeu (${error.message}) — o resto do app não depende disso`)
    }

    const image = await grab('selftest-window.png')
    step('captura da janela', image)
  } catch (error) {
    report.ok = false
    step('exceção', error.message)
  }

  console.log('SELFTEST ' + JSON.stringify(report, null, 2))
  app.quit()
}

// ----------------------------------------------------------------- boot
// A selftest run is a test, not a second window: it must not be swallowed by
// the lock when the producer already has OpenDAW open.
const single = IS_SELFTEST || app.requestSingleInstanceLock()
if (!single) {
  app.quit()
} else {
  // The live input leg of the selftest needs a microphone to exist. A test box
  // has none — and CI has none either — so Chromium's fake capture device stands
  // in: it hands the page a real MediaStream with a real device id and a tone in
  // it, which is exactly what the patch, the channel split and the recorder have
  // to be measured against. Only for the test; a normal launch never touches the
  // machine's own recorder.
  if (IS_SELFTEST) {
    app.commandLine.appendSwitch('use-fake-device-for-media-stream')
    app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
    // And the test process must not be put to sleep. A test box has windows on
    // top of the test window, and Chromium responds by downgrading the whole
    // renderer: timers stretched, the process capped, and a leg that waits 100 ms
    // getting 400. These switches keep the process and its timers at normal speed
    // for the run; they do not, on their own, keep the page painting — the frame
    // trace further down is what does that. A normal launch touches neither.
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
    app.commandLine.appendSwitch('disable-renderer-backgrounding')
    app.commandLine.appendSwitch('disable-background-timer-throttling')
  }
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.opendaw.studio')
    // Initialize ASIO worker BEFORE window creation to avoid crash in Electron 45+
    // (utilityProcess fork after BrowserWindow causes PortAudio/koffi crash)
    await asioHost.init()
    await createWindow()
    // Aviso discreto de versão nova. Falha de rede aqui é silêncio, não erro:
    // quem quiser conferir na mão usa Ajuda ▸ Verificar atualizações.
    setTimeout(() => {
      updater
        .check({ current: app.getVersion(), cacheFile: UPDATE_CACHE, mode: UPDATE_MODE })
        .then((result) => {
          if (!result?.ok || !result.newer) return
          try {
            win?.webContents.send('opdaw:update:available', result)
          } catch {
            // Janela já fechada: o aviso simplesmente não tem para quem ir.
          }
        })
        .catch(() => {})
    }, 6000)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })
  app.on('window-all-closed', () => {
    asioHost.shutdown()
    if (server) void server.close()
    app.quit()
  })
}
