/**
 * Spike do motor ASIO completo, sem UI: o supervisor sobe o worker, abre a saída
 * no driver da interface, recebe PCM por uma MessagePort transferida e escreve
 * no ASIO. É a prova de que o caminho que a DAW vai usar funciona de ponta a
 * ponta no processo nativo — não só a enumeração do spike-asio.cjs.
 *
 *   ./node_modules/electron/dist/electron.exe spike-asio-engine.cjs
 *
 * A porta aqui nasce no processo principal (MessageChannelMain) no lugar do
 * worklet, mas o worker a recebe do mesmo jeito (transfer via utilityProcess) e
 * alimenta o ring buffer igual. O status no fim diz quantos blocos foram
 * escritos e quantos xruns — blocksWritten > 0 e xruns baixos = o motor roda.
 */
const { app, MessageChannelMain } = require('electron')
const asioHost = require('./asio-host.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  try {
    const devs = await asioHost.request('devices')
    console.log('DEVICES', JSON.stringify(devs))
    if (!devs.ok || !devs.devices?.length) {
      console.log('RESULTADO: sem dispositivo ASIO de saída; nada a abrir.')
      app.quit()
      return
    }
    const dev = devs.devices.find((d) => /UMC/.test(d.name)) || devs.devices[0]
    const open = await asioHost.request('open', {
      deviceIndex: dev.index,
      sampleRate: 44100,
      channels: 2,
      frames: 256,
    })
    console.log('OPEN', JSON.stringify(open))
    if (!open.ok) {
      console.log('RESULTADO: não abriu —', open.error)
      app.quit()
      return
    }

    const { port1, port2 } = new MessageChannelMain()
    asioHost.attachPort(port2)
    port1.start()

    const frames = 256
    const ch = 2
    const rate = 44100
    const block = new Float32Array(frames * ch)
    let phase = 0
    const step = (2 * Math.PI * 440) / rate
    const total = Math.ceil(rate / frames) // ~1 segundo
    for (let b = 0; b < total; b += 1) {
      for (let f = 0; f < frames; f += 1) {
        const s = Math.sin(phase) * 0.04
        phase += step
        for (let c = 0; c < ch; c += 1) block[f * ch + c] = s
      }
      port1.postMessage({ kind: 'pcm', samples: new Float32Array(block) })
      await sleep(5)
    }
    await sleep(400)
    const status = await asioHost.request('status')
    console.log('STATUS', JSON.stringify(status))
    await asioHost.request('close')
    asioHost.shutdown()
    const ok = status.ok && status.blocksWritten > 0
    console.log(ok
      ? `RESULTADO: MOTOR ASIO OK — ${status.blocksWritten} blocos escritos, ${status.xruns} xruns, ${status.writeErrors} erros de escrita, latência ${status.outputLatencyMs} ms.`
      : 'RESULTADO: abriu mas não escreveu blocos — investigar o feed.')
    setTimeout(() => app.quit(), 250)
  } catch (error) {
    console.log('ERRO', error.message)
    setTimeout(() => app.quit(), 100)
  }
})