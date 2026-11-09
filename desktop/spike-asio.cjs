/**
 * Spike: o PortAudio com ASIO carrega por koffi e abre a saída nesta máquina?
 *
 *   node --check spike-asio.cjs
 *   node spike-asio.cjs            (a partir de desktop/, para achar o koffi)
 *
 * Duas perguntas, em ordem:
 *   1. a DLL carrega e a host API ASIO (tipo 3) aparece na enumeração?
 *   2. existe dispositivo ASIO de saída e Pa_OpenStream + Pa_WriteStream
 *      funcionam nele (I/O bloqueante, float32 interleaved)?
 *
 * Se a perna 1 falhar, não há ASIO para prometer. Se a 2 falhar, há driver mas
 * o caminho de escrita precisa de ajuste. O resultado é impresso passo a passo
 * para não trocar falha de driver por falha de binding.
 */
const pa = require('./portaudio.cjs')
const koffi = require('koffi')

function main() {
  console.log('DLL:', pa.DLL_PATH)
  let api
  try {
    api = pa.load()
    console.log('PASSO 1: DLL carregada por koffi OK')
  } catch (error) {
    console.log('FALHA ao carregar a DLL:', error.message)
    process.exit(1)
  }

  const initErr = api.Initialize()
  if (initErr !== 0) {
    console.log('FALHA Pa_Initialize:', initErr, pa.errorText(initErr))
    process.exit(1)
  }
  console.log('PASSO 2: Pa_Initialize OK')

  const { hostApis, devices, defaultOutput } = pa.enumerate()
  console.log('PASSO 3: host APIs =', JSON.stringify(hostApis, null, 2))
  const asioHost = hostApis.find((h) => h.type === pa.HostApiType.ASIO)
  console.log('ASIO presente?', asioHost ? 'SIM ' + JSON.stringify(asioHost) : 'NÃO')
  const asioDevices = devices.filter((d) => d.hostApiType === pa.HostApiType.ASIO && d.maxOutputChannels > 0)
  console.log('Dispositivos ASIO de saída:', JSON.stringify(asioDevices, null, 2))
  console.log('Saída padrão do sistema (índice):', defaultOutput)

  if (!asioHost || asioDevices.length === 0) {
    console.log('RESULTADO: sem driver/dispositivo ASIO de saída nesta máquina. A enumeração funcionou; não há o que abrir.')
    api.Terminate()
    return
  }

  // Perna 2: abrir a saída no dispositivo ASIO pedido (ou o primeiro) e escrever.
  const wantIndex = process.env.ASIO_DEV ? Number(process.env.ASIO_DEV) : null
  const dev = (wantIndex != null ? asioDevices.find((d) => d.index === wantIndex) : null) || asioDevices[0]
  const rate = Math.round(dev.defaultSampleRate) || 48000
  const channels = Math.min(2, dev.maxOutputChannels)
  const frames = 256
  console.log(`PASSO 4: abrindo saída ASIO "${dev.name}" taxa=${rate} canais=${channels} buffer=${frames}`)

  const holder = koffi.alloc('void *', 1)
  const params = {
    device: dev.index,
    channelCount: channels,
    sampleFormat: pa.SampleFormat.Float32,
    suggestedLatency: dev.defaultLowOutputLatency || frames / rate,
    hostApiSpecificStreamInfo: null,
  }
  const openErr = api.OpenStream(holder, null, params, rate, frames, pa.StreamFlags.ClipOff, null, null)
  if (openErr !== 0) {
    console.log('FALHA Pa_OpenStream:', openErr, pa.errorText(openErr))
    api.Terminate()
    process.exit(2)
  }
  const stream = koffi.decode(holder, 'void *')
  console.log('PASSO 5: Pa_OpenStream OK, stream ptr =', stream)

  const infoPtr = api.GetStreamInfo(stream)
  if (infoPtr) {
    const info = koffi.decode(infoPtr, api.PaStreamInfo)
    console.log('StreamInfo: taxa efetiva =', info.sampleRate, 'latência saída (s) =', info.outputLatency)
  }

  const startErr = api.StartStream(stream)
  if (startErr !== 0) {
    console.log('FALHA Pa_StartStream:', startErr, pa.errorText(startErr))
    api.CloseStream(stream)
    api.Terminate()
    process.exit(3)
  }
  console.log('PASSO 6: Pa_StartStream OK, ativo =', api.IsStreamActive(stream))

  // Escreve ~1 segundo de um tom bem baixo (440 Hz, amplitude 0.04) para provar
  // que o caminho renderiza; se a interface estiver conectada, dá para ouvir.
  const block = new Float32Array(frames * channels)
  const totalBlocks = Math.ceil(rate / frames)
  let phase = 0
  const step = (2 * Math.PI * 440) / rate
  let writeErrors = 0
  const t0 = Date.now()
  for (let b = 0; b < totalBlocks; b += 1) {
    for (let f = 0; f < frames; f += 1) {
      const s = Math.sin(phase) * 0.04
      phase += step
      for (let c = 0; c < channels; c += 1) block[f * channels + c] = s
    }
    const err = api.WriteStream(stream, block, frames)
    if (err !== 0) {
      writeErrors += 1
      if (writeErrors <= 3) console.log('Pa_WriteStream erro:', err, pa.errorText(err))
    }
  }
  const elapsed = Date.now() - t0
  console.log(`PASSO 7: escritos ${totalBlocks} blocos (${frames} frames) em ${elapsed}ms; erros = ${writeErrors}`)

  api.StopStream(stream)
  api.CloseStream(stream)
  api.Terminate()
  console.log(writeErrors === 0
    ? 'RESULTADO: ASIO FUNCIONA — abriu, escreveu e fechou a saída no driver ASIO por FFI.'
    : `RESULTADO: abriu mas ${writeErrors} blocos falharam na escrita.`)
}

main()