/**
 * OpenDAW native audio sink — PortAudio por FFI, com ASIO.
 *
 * O Chromium (e portanto o Electron) não tem backend ASIO: a saída do WebAudio
 * chega na placa por WASAPI shared. Este módulo é o "motor" que falta: carrega
 * um PortAudio pré-compilado COM suporte ASIO (vendor/libportaudio64bit-asio.dll,
 * o mesmo binário que o python-sounddevice distribui) e fala a API C plana do
 * PortAudio por koffi — sem compilador, do mesmo jeito que o host VST fala VST.
 *
 * O que ele faz de verdade: abre a SAÍDA no driver ASIO da interface, em acesso
 * exclusivo, na taxa e no buffer escolhidos, e recebe o PCM do master do
 * WebAudio por blocos (Pa_WriteStream, I/O bloqueante — sem callback em thread
 * nativa, que o koffi despacharia para o event loop e adicionaria jitter).
 *
 * O que ele NÃO faz (e a UI diz): o motor de mix continua sendo o WebAudio, e a
 * ENTRADA continua vindo do getUserMedia (WASAPI). Então a latência de monitor
 * ainda é limitada pelo caminho de entrada do Chromium — isto é uma saída ASIO
 * nativa, não um motor de áudio nativo de ponta a ponta. ASIO full-duplex de
 * verdade exigiria reescrever o motor inteiro fora do WebAudio.
 *
 * Layout da API e enums vêm de portaudio.h (PortAudio v19, MIT) e pa_asio.h.
 *   PaHostApiTypeId: paASIO = 3, paWASAPI = 13, paDirectSound = 1, paMME = 2.
 */
const koffi = require('koffi')
const path = require('node:path')
const fs = require('node:fs')

/**
 * Koffi faz LoadLibrary de verdade: um caminho dentro de app.asar não existe
 * para o Windows. Se o app for empacotado com asar, o vendor precisa estar em
 * app.asar.unpacked — e é de lá que o FFI tem de ler.
 */
function resolveDllPath() {
  const packed = path.join(__dirname, 'vendor', 'libportaudio64bit-asio.dll')
  if (!packed.includes('.asar')) return packed
  const unpacked = packed.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  return fs.existsSync(unpacked) ? unpacked : packed
}

const DLL_PATH = resolveDllPath()

/** PaHostApiTypeId (portaudio.h). */
const HostApiType = {
  InDevelopment: 0,
  DirectSound: 1,
  MME: 2,
  ASIO: 3,
  SoundManager: 4,
  CoreAudio: 5,
  OSS: 7,
  ALSA: 8,
  AL: 9,
  BeOS: 10,
  WDMKS: 11,
  JACK: 12,
  WASAPI: 13,
  AudioScienceHPI: 14,
}

const HOST_API_NAMES = {
  0: 'Em desenvolvimento',
  1: 'DirectSound',
  2: 'MME',
  3: 'ASIO',
  4: 'SoundManager',
  5: 'CoreAudio',
  7: 'OSS',
  8: 'ALSA',
  9: 'AL',
  10: 'BeOS',
  11: 'WDM-KS',
  12: 'JACK',
  13: 'WASAPI',
  14: 'AudioScience HPI',
}

/** PaSampleFormat (máscaras de bit). Usamos float32 interleaved. */
const SampleFormat = {
  Float32: 0x00000001,
  Int32: 0x00000002,
  Int16: 0x00000008,
  Int8: 0x00000010,
  UInt8: 0x00000020,
}

/** PaStreamFlags. */
const StreamFlags = {
  NoFlag: 0,
  ClipOff: 0x00000001,
  DitherOff: 0x00000002,
  PrimeOutputBuffersUsingStreamCallback: 0x00000008,
}

/** paFramesPerBufferUnspecified. */
const FRAMES_PER_BUFFER_UNSPECIFIED = 0

/**
 * Códigos de erro do PortAudio (portaudio.h), ditos em português para a UI. O
 * texto da DLL nem sempre decodifica por FFI, então a tabela local é a fonte
 * confiável; o código numérico vai junto para o log.
 */
const ERROR_NAMES = {
  0: 'sem erro',
  [-10000]: 'PortAudio não inicializado',
  [-9999]: 'erro inesperado do host',
  [-9998]: 'contagem de canais inválida',
  [-9997]: 'taxa de amostragem inválida',
  [-9996]: 'dispositivo inválido',
  [-9995]: 'flag inválida',
  [-9994]: 'formato de amostra não suportado',
  [-9993]: 'combinação de dispositivos inválida',
  [-9992]: 'memória insuficiente',
  [-9991]: 'buffer grande demais',
  [-9990]: 'buffer pequeno demais',
  [-9989]: 'callback nulo',
  [-9988]: 'ponteiro de stream inválido',
  [-9987]: 'tempo esgotado (underrun/xrun)',
  [-9986]: 'erro interno',
  [-9985]: 'dispositivo indisponível (em uso por outro app?)',
  [-9984]: 'dispositivo incompatível com o stream',
  [-9983]: 'stream parado',
  [-9982]: 'stream não parado',
  [-9981]: 'stream terminado',
  [-9980]: 'host API não encontrada',
  [-9979]: 'host API incompatível',
  [-9978]: 'dispositivo não encontrado',
  [-9977]: 'dispositivo não disponível',
  [-9976]: 'stream não suportado',
  [-9975]: 'dispositivo já em uso',
}

// ------------------------------------------------------------------ carregamento
let cached = null

/**
 * Carrega a DLL e monta a tabela de funções uma única vez por processo. Os
 * structs são registrados no koffi pelo nome; registrar de novo no mesmo
 * processo lança, por isso o cache.
 */
function load() {
  if (cached) return cached
  if (!fs.existsSync(DLL_PATH)) {
    throw new Error(`PortAudio não encontrado em ${DLL_PATH}. Reempacote o app (desktop/vendor).`)
  }
  const lib = koffi.load(DLL_PATH)

  // `unsigned long` no Windows (LLP64) tem 32 bits, mesmo em x64 — por isso
  // uint32_t para PaSampleFormat/PaStreamFlags/frames, não 'unsigned long'.
  const PaHostApiInfo = koffi.struct('PaHostApiInfo', {
    structVersion: 'int32_t',
    type: 'int32_t',
    name: 'char *',
    deviceCount: 'int32_t',
    defaultInputDevice: 'int32_t',
    defaultOutputDevice: 'int32_t',
  })
  const PaDeviceInfo = koffi.struct('PaDeviceInfo', {
    structVersion: 'int32_t',
    name: 'char *',
    hostApi: 'int32_t',
    maxInputChannels: 'int32_t',
    maxOutputChannels: 'int32_t',
    defaultLowInputLatency: 'double',
    defaultLowOutputLatency: 'double',
    defaultHighInputLatency: 'double',
    defaultHighOutputLatency: 'double',
    defaultSampleRate: 'double',
  })
  const PaStreamParameters = koffi.struct('PaStreamParameters', {
    device: 'int32_t',
    channelCount: 'int32_t',
    sampleFormat: 'uint32_t',
    suggestedLatency: 'double',
    hostApiSpecificStreamInfo: 'void *',
  })
  const PaStreamInfo = koffi.struct('PaStreamInfo', {
    structVersion: 'int32_t',
    inputLatency: 'double',
    outputLatency: 'double',
    sampleRate: 'double',
  })

  const api = {
    dllPath: DLL_PATH,
    PaHostApiInfo,
    PaDeviceInfo,
    PaStreamParameters,
    PaStreamInfo,
    Initialize: lib.func('int32_t Pa_Initialize()'),
    Terminate: lib.func('int32_t Pa_Terminate()'),
    GetHostApiCount: lib.func('int32_t Pa_GetHostApiCount()'),
    GetDefaultHostApi: lib.func('int32_t Pa_GetDefaultHostApi()'),
    GetHostApiInfo: lib.func('const PaHostApiInfo *Pa_GetHostApiInfo(int32_t hostApi)'),
    HostApiTypeIdToHostApiIndex: lib.func('int32_t Pa_HostApiTypeIdToHostApiIndex(int32_t type)'),
    GetDeviceCount: lib.func('int32_t Pa_GetDeviceCount()'),
    GetDefaultInputDevice: lib.func('int32_t Pa_GetDefaultInputDevice()'),
    GetDefaultOutputDevice: lib.func('int32_t Pa_GetDefaultOutputDevice()'),
    GetDeviceInfo: lib.func('const PaDeviceInfo *Pa_GetDeviceInfo(int32_t device)'),
    GetErrorText: lib.func('const char *Pa_GetErrorText(int32_t errorCode)'),
    OpenStream: lib.func(
      'int32_t Pa_OpenStream(void **stream, const PaStreamParameters *input, const PaStreamParameters *output, double sampleRate, uint32_t framesPerBuffer, uint32_t streamFlags, void *callback, void *userData)',
    ),
    CloseStream: lib.func('int32_t Pa_CloseStream(void *stream)'),
    StartStream: lib.func('int32_t Pa_StartStream(void *stream)'),
    StopStream: lib.func('int32_t Pa_StopStream(void *stream)'),
    AbortStream: lib.func('int32_t Pa_AbortStream(void *stream)'),
    IsStreamActive: lib.func('int32_t Pa_IsStreamActive(void *stream)'),
    WriteStream: lib.func('int32_t Pa_WriteStream(void *stream, const void *buffer, uint32_t frames)'),
    ReadStream: lib.func('int32_t Pa_ReadStream(void *stream, void *buffer, uint32_t frames)'),
    GetStreamInfo: lib.func('const PaStreamInfo *Pa_GetStreamInfo(void *stream)'),
    GetStreamTime: lib.func('double Pa_GetStreamTime(void *stream)'),
  }
  cached = api
  return api
}

/** Traduz um código de erro do PortAudio em texto legível. */
function errorText(code) {
  const known = ERROR_NAMES[code]
  if (known) return `${known} (${code})`
  try {
    const api = load()
    const ptr = api.GetErrorText(code)
    const text = ptr ? koffi.decode(ptr, 'char *') : ''
    return text ? `${text} (${code})` : `erro PortAudio ${code}`
  } catch {
    return `erro PortAudio ${code}`
  }
}

/**
 * Lista as host APIs e os dispositivos, já decodificados. É o que a UI de
 * Devices consome para montar a lista de saídas ASIO reais desta máquina.
 */
function enumerate() {
  const api = load()
  const hostApis = []
  const hostCount = api.GetHostApiCount()
  for (let i = 0; i < hostCount; i += 1) {
    const ptr = api.GetHostApiInfo(i)
    if (!ptr) continue
    const info = koffi.decode(ptr, api.PaHostApiInfo)
    hostApis.push({
      index: i,
      type: info.type,
      typeName: HOST_API_NAMES[info.type] || `tipo ${info.type}`,
      name: info.name || '',
      deviceCount: info.deviceCount,
      defaultInputDevice: info.defaultInputDevice,
      defaultOutputDevice: info.defaultOutputDevice,
    })
  }
  const devices = []
  const deviceCount = api.GetDeviceCount()
  const defaultOutput = api.GetDefaultOutputDevice()
  for (let i = 0; i < deviceCount; i += 1) {
    const ptr = api.GetDeviceInfo(i)
    if (!ptr) continue
    const info = koffi.decode(ptr, api.PaDeviceInfo)
    const host = hostApis.find((h) => h.index === info.hostApi)
    devices.push({
      index: i,
      name: info.name || '',
      hostApi: info.hostApi,
      hostApiType: host ? host.type : -1,
      hostApiName: host ? host.typeName : '',
      maxInputChannels: info.maxInputChannels,
      maxOutputChannels: info.maxOutputChannels,
      defaultSampleRate: info.defaultSampleRate,
      defaultLowOutputLatency: info.defaultLowOutputLatency,
      defaultHighOutputLatency: info.defaultHighOutputLatency,
      isDefaultOutput: i === defaultOutput,
    })
  }
  return { hostApis, devices, defaultOutput }
}

module.exports = {
  DLL_PATH,
  HostApiType,
  HOST_API_NAMES,
  SampleFormat,
  StreamFlags,
  ERROR_NAMES,
  FRAMES_PER_BUFFER_UNSPECIFIED,
  load,
  errorText,
  enumerate,
}