/**
 * O lado do processo principal do sink ASIO: supervisiona o worker que segura o
 * driver, encaminha os pedidos da página e — o ponto central — entrega a ele a
 * MessagePort que o audio thread do renderer construiu.
 *
 * A porta não passa por aqui mensagem a mensagem: ela é transferida uma vez para
 * o worker (utilityProcess.postMessage com transfer), e dali o PCM corre direto
 * do worklet para o processo que escreve no ASIO. O processo principal fica fora
 * do caminho quente do áudio, só observa o status.
 *
 * Se o worker cair (um driver ASIO que faulta), o próximo pedido ganha um
 * processo novo; a página recebe o erro e pode tentar de novo. O mix não se
 * perde: ele vive no WebAudio, não aqui.
 */
const path = require('node:path')
const { utilityProcess } = require('electron')

const WORKER = path.join(__dirname, 'asio-worker.cjs')
const START_TIMEOUT = 15000
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 10000

let proc = null
let ready = false
let startPromise = null
let settleStart = null
let startTimer = null
let nextId = 1
const waiting = new Map()
let pendingPort = null
let statusSink = null
let restartCount = 0
let lastRestartTime = 0

function create() {
  ready = false
  const child = utilityProcess.fork(WORKER, [], { stdio: 'pipe', serviceName: 'OpenDAW ASIO' })
  proc = child
  startPromise = new Promise((resolve, reject) => {
    settleStart = { resolve, reject }
  })
  startTimer = setTimeout(
    () => settleStart?.reject(new Error('o processo ASIO não respondeu ao iniciar')),
    START_TIMEOUT,
  )

  child.on('message', (message) => {
    if (!message) return
    if (message.ready) {
      clearTimeout(startTimer)
      ready = true
      settleStart?.resolve()
      // Reset restart count on successful start
      restartCount = 0
      lastRestartTime = 0
      // Uma porta que chegou antes do worker subir espera aqui e segue agora.
      if (pendingPort) {
        transferPort(pendingPort)
        pendingPort = null
      }
      return
    }
    if (message.status) {
      statusSink?.(message.status)
      return
    }
    if (message.id) {
      const settle = waiting.get(message.id)
      if (!settle) return
      waiting.delete(message.id)
      settle.resolve(message)
    }
  })

  child.on('exit', (code) => {
    clearTimeout(startTimer)
    if (proc === child) {
      proc = null
      ready = false
      startPromise = null
    }
    const reason = new Error(code === 0 ? 'o processo ASIO encerrou' : `o processo ASIO saiu com o código ${code}`)
    reason.faulted = code !== 0
    settleStart?.reject(reason)
    for (const settle of waiting.values()) settle.reject(reason)
    waiting.clear()
    if (code !== 0) {
      process.stderr.write(`[asio] o processo ASIO caiu (código ${code}); o próximo pedido recria o processo\n`)
      // Notify renderer of crash
      if (crashSink) {
        try {
          crashSink({ faulted: true, code })
        } catch {
          /* renderer may be gone */
        }
      }
      // Check if we should attempt restart
      const now = Date.now()
      if (now - lastRestartTime > RESTART_WINDOW_MS) {
        restartCount = 0
      }
      if (restartCount < MAX_RESTARTS) {
        restartCount++
        lastRestartTime = now
        process.stderr.write(`[asio] agendando reinício ${restartCount}/${MAX_RESTARTS}...\n`)
        setTimeout(() => {
          if (!proc) create().catch(() => {})
        }, 1000)
      } else {
        process.stderr.write(`[asio] máximo de reinícios atingido (${MAX_RESTARTS}). Intervenção manual necessária.\n`)
      }
    }
  })

  child.stdout?.on('data', (chunk) => process.stdout.write(`[asio] ${chunk}`))
  child.stderr?.on('data', (chunk) => process.stderr.write(`[asio] ${chunk}`))
  return startPromise
}

function ensure() {
  if (!proc || !startPromise) return create()
  return startPromise
}

/**
 * Inicializa o worker ASIO imediatamente (antes da criação da janela).
 * Evita crash do worker quando utilityProcess é criado depois de BrowserWindow
 * no Electron 45+.
 */
function init() {
  return ensure()
}

function transferPort(port) {
  try {
    proc.postMessage({ cmd: 'attach-port' }, [port])
  } catch (error) {
    process.stderr.write(`[asio] não transferiu a porta de áudio: ${error.message}\n`)
  }
}

/**
 * A porta que o renderer construiu e o preload entregou. Vai inteira para o
 * worker; este processo não lê o PCM.
 */
function attachPort(port) {
  if (!port) return
  if (proc && ready) {
    transferPort(port)
  } else {
    pendingPort = port
    ensure().catch(() => {
      pendingPort = null
    })
  }
}

function request(cmd, extra = {}, timeoutMs = 15000) {
  return ensure().then(
    () =>
      new Promise((resolve, reject) => {
        if (!proc) {
          reject(new Error('o processo ASIO não está disponível'))
          return
        }
        const id = nextId++
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new Error(`${cmd} ASIO demorou demais`))
        }, timeoutMs)
        waiting.set(id, {
          resolve: (message) => {
            clearTimeout(timer)
            resolve(message)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        proc.postMessage({ id, cmd, ...extra })
      }),
  )
}

/** Para onde o status empurrado pelo worker vai (a janela, via webContents). */
function setStatusSink(fn) {
  statusSink = fn
}

/** Callback quando o worker cai (para notificar o renderer). */
let crashSink = null
function setCrashSink(fn) {
  crashSink = fn
}

/** Handle input port handoff from renderer to worker. */
let pendingInPort = null
function attachInPort(port) {
  if (!port) return
  if (proc && ready) {
    try {
      proc.postMessage({ cmd: 'attach-in-port' }, [port])
    } catch (error) {
      process.stderr.write(`[asio] não transferiu a porta de entrada: ${error.message}\n`)
    }
  } else {
    pendingInPort = port
    ensure().catch(() => {
      pendingInPort = null
    })
  }
}

/** Encerra o worker com educação (o app está fechando). */
function shutdown() {
  if (proc && ready) {
    try {
      proc.postMessage({ cmd: 'shutdown' })
    } catch {
      /* já foi */
    }
  }
}

module.exports = { request, attachPort, attachInPort, setStatusSink, setCrashSink, shutdown, init }