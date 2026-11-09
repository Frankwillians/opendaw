/**
 * O processo que toca o mix no driver ASIO da interface e lê a entrada ASIO.
 *
 * Por que um processo separado: o PortAudio segura o stream aberto e escreve em
 * I/O bloqueante (Pa_WriteStream / Pa_ReadStream), que prende a thread até o
 * driver aceitar o bloco. Fazer isso no processo principal do app travaria a
 * janela; fazer no renderer é impossível (sem FFI lá). Então este filho — o
 * mesmo modelo do worker de plugins, via utilityProcess — segura o stream e
 * recebe o PCM do master do WebAudio por uma MessagePort que a página construiu.
 *
 * O caminho do áudio (full-duplex):
 *   worklet do master (porta 1) --MessagePort--> esta processo (porta 2)
 *     -> ring buffer OUT -> Pa_WriteStream -> driver ASIO -> interface (saída)
 *   interface (entrada) -> Pa_ReadStream -> ring buffer IN -> MessagePort
 *     -> worklet de entrada -> tracks do WebAudio
 *
 * O que ele é: um sink ASIO nativo full-duplex (saída + entrada), em modo
 * exclusivo, na taxa e buffer escolhidos. O mix continua nascendo no WebAudio;
 * a entrada ASIO substitui o caminho WASAPI do Chromium para latência real.
 *
 * I/O bloqueante de propósito: um callback do PortAudio rodaria em thread nativa
 * e o koffi o despacharia para o event loop, adicionando jitter a cada bloco.
 * Pa_WriteStream/Pa_ReadStream bloqueiam até o driver consumir/entregar, então o
 * laço below se marca no próprio relógio do driver — sem callback, sem thread extra.
 */
const pa = require('./portaudio.cjs')
const koffi = require('koffi')

const hasParentPort = typeof process.parentPort?.postMessage === 'function'
const out = hasParentPort
  ? { send: (message) => process.parentPort.postMessage(message) }
  : { send: (message) => process.send?.(message) }

// ------------------------------------------------------------------ estado
let api = null
let initialized = false
let stream = null // ponteiro (bigint) do stream PortAudio
let running = false
let feedRunning = false
let preroll = 0
let pcmPort = null // porta de saída (renderer -> worker)
let pcmInPort = null // porta de entrada (worker -> renderer)

const cfg = {
  deviceIndex: -1,
  deviceName: '',
  sampleRate: 48000,
  channels: 2,
  frames: 256,
  outputLatencyMs: 0,
  inputLatencyMs: 0,
  inputChannels: 0,
}

const stats = {
  blocksWritten: 0,
  framesWritten: 0,
  silenceBlocks: 0,
  xruns: 0,
  writeErrors: 0,
  readErrors: 0,
  lastError: '',
  peak: 0,
  peakIn: 0,
  startedAt: 0,
  pcmMessages: 0,
  pcmFloats: 0,
}

// Ring buffer OUT (renderer -> ASIO output). Interleaved float32.
// Capacity = headroom for IPC jitter; actual level stays low because loop
// consumes at driver clock rate.
let ringOut = null
let ringOutCap = 0
let ringOutWrite = 0
let ringOutRead = 0
let ringOutCount = 0

// Ring buffer IN (ASIO input -> renderer). Interleaved float32.
let ringIn = null
let ringInCap = 0
let ringInWrite = 0
let ringInRead = 0
let ringInCount = 0

let blockBuf = null
let blockBufIn = null
let silenceBuf = null
let blockLen = 0
let blockLenIn = 0

function reply(request, payload) {
  out.send({ id: request?.id, ...payload })
}

function ensureInit() {
  if (initialized) return
  api = pa.load()
  const err = api.Initialize()
  if (err !== 0) throw new Error(pa.errorText(err))
  initialized = true
}

// ------------------------------------------------------------------ ring OUT (renderer -> ASIO output)
function ringOutInit(capFloats) {
  ringOutCap = capFloats
  ringOut = new Float32Array(ringOutCap)
  ringOutWrite = 0
  ringOutRead = 0
  ringOutCount = 0
}

function ringOutPush(data) {
  const n = data.length
  if (n === 0) return
  // Se transbordar, descarta o mais antigo: áudio velho não volta, e um clique
  // contado como xrun é mais honesto do que um buffer que cresce para sempre.
  if (n > ringOutCap - ringOutCount) {
    const drop = n - (ringOutCap - ringOutCount)
    ringOutRead = (ringOutRead + drop) % ringOutCap
    ringOutCount -= drop
    stats.xruns += 1
  }
  for (let i = 0; i < n; i += 1) {
    ringOut[ringOutWrite] = data[i]
    ringOutWrite = (ringOutWrite + 1) % ringOutCap
  }
  ringOutCount += n
}

function ringOutPop(target) {
  const n = Math.min(target.length, ringOutCount)
  for (let i = 0; i < n; i += 1) {
    target[i] = ringOut[ringOutRead]
    ringOutRead = (ringOutRead + 1) % ringOutCap
  }
  ringOutCount -= n
  return n
}

// ------------------------------------------------------------------ ring IN (ASIO input -> renderer)
function ringInInit(capFloats) {
  ringInCap = capFloats
  ringIn = new Float32Array(ringInCap)
  ringInWrite = 0
  ringInRead = 0
  ringInCount = 0
}

function ringInPush(data) {
  const n = data.length
  if (n === 0) return
  // Se transbordar, descarta o mais antigo (overrun)
  if (n > ringInCap - ringInCount) {
    const drop = n - (ringInCap - ringInCount)
    ringInRead = (ringInRead + drop) % ringInCap
    ringInCount -= drop
    stats.xruns += 1 // Count overruns as xruns too
  }
  for (let i = 0; i < n; i += 1) {
    ringIn[ringInWrite] = data[i]
    ringInWrite = (ringInWrite + 1) % ringInCap
  }
  ringInCount += n
}

function ringInPop(target) {
  const n = Math.min(target.length, ringInCount)
  for (let i = 0; i < n; i += 1) {
    target[i] = ringIn[ringInRead]
    ringInRead = (ringInRead + 1) % ringInCap
  }
  ringInCount -= n
  return n
}

// ------------------------------------------------------------------ escrita
function writeBlock(buf, isSilence, countXrun) {
  const err = api.WriteStream(stream, buf, cfg.frames)
  if (err === 0) {
    stats.blocksWritten += 1
    stats.framesWritten += cfg.frames
    if (isSilence) stats.silenceBlocks += 1
  } else {
    stats.writeErrors += 1
    stats.lastError = pa.errorText(err)
    if (countXrun) stats.xruns += 1
  }
  let peak = 0
  for (let i = 0; i < buf.length; i += 1) {
    const a = buf[i] < 0 ? -buf[i] : buf[i]
    if (a > peak) peak = a
  }
  if (peak > stats.peak) stats.peak = peak
}

/**
 * Lê um bloco da entrada ASIO. Conta erros de leitura.
 */
function readBlock(buf) {
  const err = api.ReadStream(stream, buf, cfg.frames)
  if (err !== 0) {
    stats.readErrors += 1
    stats.lastError = pa.errorText(err)
    stats.xruns += 1
    return false
  }
  let peak = 0
  for (let i = 0; i < buf.length; i += 1) {
    const a = buf[i] < 0 ? -buf[i] : buf[i]
    if (a > peak) peak = a
  }
  if (peak > stats.peakIn) stats.peakIn = peak
  return true
}

/**
 * Um bloco por volta. Pa_WriteStream/Pa_ReadStream bloqueiam ~frames/taxa segundos,
 * então o laço anda no relógio do driver. O setImmediate cede o loop entre blocos
 * para as mensagens de PCM entrarem. O pré-roll de 2 blocos cria uma folga que
 * absorve o jitter da IPC; sem ele, cada atraso de mensagem viraria um bloco de silêncio.
 */
function feed() {
  if (!running || !stream) {
    feedRunning = false
    return
  }

  // ---------- OUTPUT: write to ASIO ----------
  if (preroll > 0) {
    if (ringOutCount >= blockLen) preroll -= 1
    writeBlock(silenceBuf, true, false)
    setImmediate(feed)
    return
  }
  if (ringOutCount >= blockLen) {
    ringOutPop(blockBuf)
    writeBlock(blockBuf, false, true)
  } else {
    // O driver precisa de um bloco mesmo sem dados: silêncio mantém o relógio
    // vivo, e o xrun diz que a página não alimentou a tempo.
    writeBlock(silenceBuf, true, true)
  }

  // ---------- INPUT: read from ASIO and push to ringIn ----------
  if (cfg.inputChannels > 0 && ringIn) {
    // Read from ASIO input
    if (readBlock(blockBufIn)) {
      // Push to ring buffer for renderer
      ringInPush(blockBufIn)
    } else {
      // On read error, push silence to keep renderer timing
      ringInPush(silenceBuf.subarray(0, blockLenIn))
    }

    // If renderer has a port attached, try to send accumulated data
    if (pcmInPort && ringInCount >= blockLenIn) {
      const sendBuf = new Float32Array(blockLenIn)
      ringInPop(sendBuf)
      try {
        pcmInPort.postMessage({ kind: 'pcm', samples: sendBuf })
      } catch (e) {
        // Port may be closed
        pcmInPort = null
      }
    }
  }

  setImmediate(feed)
}

function startFeed() {
  if (feedRunning) return
  feedRunning = true
  preroll = 2
  setImmediate(feed)
}

function resetStats() {
  stats.blocksWritten = 0
  stats.framesWritten = 0
  stats.silenceBlocks = 0
  stats.xruns = 0
  stats.writeErrors = 0
  stats.readErrors = 0
  stats.lastError = ''
  stats.peak = 0
  stats.peakIn = 0
  stats.startedAt = Date.now()
  stats.pcmMessages = 0
  stats.pcmFloats = 0
}

function snapshot() {
  return {
    active: running,
    running,
    deviceName: cfg.deviceName,
    deviceIndex: cfg.deviceIndex,
    sampleRate: cfg.sampleRate,
    channels: cfg.channels,
    frames: cfg.frames,
    outputLatencyMs: cfg.outputLatencyMs,
    inputLatencyMs: cfg.inputLatencyMs,
    inputChannels: cfg.inputChannels,
    blocksWritten: stats.blocksWritten,
    framesWritten: stats.framesWritten,
    silenceBlocks: stats.silenceBlocks,
    xruns: stats.xruns,
    writeErrors: stats.writeErrors,
    readErrors: stats.readErrors,
    lastError: stats.lastError,
    peak: stats.peak,
    peakIn: stats.peakIn,
    bufferFillOut: blockLen ? Math.round((ringOutCount / blockLen) * 100) / 100 : 0,
    bufferFillIn: blockLenIn ? Math.round((ringInCount / blockLenIn) * 100) / 100 : 0,
    uptimeMs: stats.startedAt ? Date.now() - stats.startedAt : 0,
    pcmMessages: stats.pcmMessages,
    pcmFloats: stats.pcmFloats,
    portAttached: Boolean(pcmPort),
    portInAttached: Boolean(pcmInPort),
  }
}

// ------------------------------------------------------------------ stream
function asioFullDuplexDevices() {
  const { devices, hostApis } = pa.enumerate()
  const asioHost = hostApis.find((h) => h.type === pa.HostApiType.ASIO)
  // Devices that have BOTH input and output channels (full-duplex capable)
  const fullDuplex = devices.filter((d) =>
    d.hostApiType === pa.HostApiType.ASIO && d.maxInputChannels > 0 && d.maxOutputChannels > 0
  )
  // Output-only devices (for backward compatibility)
  const outputs = devices.filter((d) => d.hostApiType === pa.HostApiType.ASIO && d.maxOutputChannels > 0)
  return { devices, hostApis, fullDuplex, outputs, asioHost, asioPresent: Boolean(asioHost) }
}

function closeStream() {
  running = false
  if (stream && api) {
    try {
      api.StopStream(stream)
    } catch {
      /* já parado */
    }
    try {
      api.CloseStream(stream)
    } catch {
      /* já fechado */
    }
    stream = null
  }
}

function openStream(request) {
  ensureInit()
  closeStream()
  const { fullDuplex, outputs, asioHost } = asioFullDuplexDevices()

  // Prefer full-duplex devices, fall back to output-only
  let device = null
  let isFullDuplex = false

  if (request.inputChannels > 0 && fullDuplex.length > 0) {
    // Try to find a full-duplex device
    device = fullDuplex.find((d) => d.index === request.deviceIndex)
    if (!device) {
      const preferred = asioHost ? asioHost.defaultInputDevice : -1
      device = fullDuplex.find((d) => d.index === preferred) || fullDuplex[0]
    }
    isFullDuplex = true
  } else {
    // Output-only mode (backward compatible)
    if (outputs.length === 0) {
      return { ok: false, error: 'Nenhum dispositivo ASIO de saída encontrado nesta máquina. Instale o driver da interface (ou ASIO4ALL).' }
    }
    device = outputs.find((d) => d.index === request.deviceIndex)
    if (!device) {
      const preferred = asioHost ? asioHost.defaultOutputDevice : -1
      device = outputs.find((d) => d.index === preferred) || outputs[0]
    }
    isFullDuplex = false
  }

  const sampleRate = request.sampleRate > 0 ? Math.round(request.sampleRate) : Math.round(device.defaultSampleRate) || 48000
  const outChannels = Math.max(1, Math.min(request.channels || 2, device.maxOutputChannels))
  const inChannels = isFullDuplex ? Math.max(1, Math.min(request.inputChannels || 2, device.maxInputChannels)) : 0
  const frames = request.frames > 0 ? Math.round(request.frames) : 256

  const holder = koffi.alloc('void *', 1)
  const inParams = isFullDuplex ? {
    device: device.index,
    channelCount: inChannels,
    sampleFormat: pa.SampleFormat.Float32,
    suggestedLatency: frames / sampleRate,
    hostApiSpecificStreamInfo: null,
  } : null

  const outParams = {
    device: device.index,
    channelCount: outChannels,
    sampleFormat: pa.SampleFormat.Float32,
    suggestedLatency: frames / sampleRate,
    hostApiSpecificStreamInfo: null,
  }

  const err = api.OpenStream(holder, inParams, outParams, sampleRate, frames, pa.StreamFlags.ClipOff, null, null)
  if (err !== 0) {
    return { ok: false, error: `Não abriu o stream ASIO "${device.name}": ${pa.errorText(err)}` }
  }
  stream = koffi.decode(holder, 'void *')
  let effectiveRate = sampleRate
  let latencyMs = Math.round((frames / sampleRate) * 1000)
  let inputLatencyMs = 0
  const infoPtr = api.GetStreamInfo(stream)
  if (infoPtr) {
    const info = koffi.decode(infoPtr, api.PaStreamInfo)
    if (info.sampleRate > 0) effectiveRate = info.sampleRate
    if (info.outputLatency > 0) latencyMs = Math.round(info.outputLatency * 1000)
    if (info.inputLatency > 0) inputLatencyMs = Math.round(info.inputLatency * 1000)
  }
  const startErr = api.StartStream(stream)
  if (startErr !== 0) {
    api.CloseStream(stream)
    stream = null
    return { ok: false, error: `Não iniciou o stream ASIO: ${pa.errorText(startErr)}` }
  }

  cfg.deviceIndex = device.index
  cfg.deviceName = device.name
  cfg.sampleRate = effectiveRate
  cfg.channels = outChannels
  cfg.frames = frames
  cfg.outputLatencyMs = latencyMs
  cfg.inputLatencyMs = inputLatencyMs
  cfg.inputChannels = inChannels

  blockLen = frames * outChannels
  blockLenIn = frames * inChannels
  blockBuf = new Float32Array(blockLen)
  blockBufIn = new Float32Array(blockLenIn)
  silenceBuf = new Float32Array(Math.max(blockLen, blockLenIn))
  // Ring buffer OUT: 500ms max, minimum 4 blocks worth. Scales with sample rate and buffer size.
  const ringBlocksOut = Math.max(4, Math.ceil(effectiveRate * 0.5 / frames))
  ringOutInit(ringBlocksOut * blockLen)
  // Ring buffer IN: same sizing for input
  const ringBlocksIn = Math.max(4, Math.ceil(effectiveRate * 0.5 / frames))
  ringInInit(ringBlocksIn * blockLenIn)
  resetStats()
  running = true
  startFeed()
  return { ok: true, ...cfg }
}

// ------------------------------------------------------------------ comandos
function handle(request) {
  if (!request || typeof request !== 'object') return
  try {
    switch (request.cmd) {
      case 'devices': {
        ensureInit()
        const { outputs, asioPresent } = asioFullDuplexDevices()
        reply(request, { ok: true, devices: outputs, asioPresent })
        break
      }
      case 'open': {
        reply(request, openStream(request))
        break
      }
      case 'close': {
        closeStream()
        reply(request, { ok: true, stats: snapshot() })
        break
      }
      case 'status': {
        reply(request, { ok: true, ...snapshot() })
        break
      }
      case 'shutdown': {
        closeStream()
        if (initialized && api) {
          try {
            api.Terminate()
          } catch {
            /* já terminado */
          }
        }
        reply(request, { ok: true })
        setTimeout(() => process.exit(0), 20)
        break
      }
      default:
        reply(request, { ok: false, error: `comando desconhecido: ${request.cmd}` })
    }
  } catch (error) {
    reply(request, { ok: false, error: String(error?.message || error) })
  }
}

function attachPcmPort(port) {
  if (pcmPort) {
    try {
      pcmPort.close()
    } catch {
      /* porta anterior já foi */
    }
  }
  pcmPort = port
  port.on('message', (event) => {
    const data = event.data
    if (!data || data.kind !== 'pcm') return
    let samples = data.samples
    if (samples && !(samples instanceof Float32Array)) {
      if (samples instanceof ArrayBuffer) samples = new Float32Array(samples)
      else if (samples.buffer) samples = new Float32Array(samples.buffer)
    }
    if (samples && samples.length && ringOut) {
      stats.pcmMessages += 1
      stats.pcmFloats += samples.length
      ringOutPush(samples)
    }
  })
  port.start()
}

function attachPcmInPort(port) {
  if (pcmInPort) {
    try {
      pcmInPort.close()
    } catch {
      /* porta anterior já foi */
    }
  }
  pcmInPort = port
  port.start()
}

if (hasParentPort) {
  process.parentPort.on('message', (event) => {
    const message = event.data
    if (message && message.cmd === 'attach-port') {
      const port = event.ports?.[0]
      if (port) attachPcmPort(port)
      return
    }
    if (message && message.cmd === 'attach-in-port') {
      const port = event.ports?.[0]
      if (port) attachPcmInPort(port)
      return
    }
    handle(message)
  })
} else {
  process.on('message', handle)
}

// Status empurrado para a UI duas vezes por segundo: xruns e nível sem sondar.
setInterval(() => {
  if (running) {
    out.send({ status: snapshot() })
    stats.peak = 0
  }
}, 500)

out.send({ ready: true })