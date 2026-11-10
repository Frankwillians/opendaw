/**
 * Audio Engine - Web Audio API
 *
 * Per track signal path:
 *   input device ─┐
 *   recorded clip ─┼─> panner -> fxInput -> shaper -> filter -> [signal chain]
 *                  │    -> gain -> mono fold-down -> duck -> master or sub-group
 *
 * Master bus: every track (or sub-group) sums into `masterSum`, passes through
 * a full built-in FX rack (glue EQ / compressor / limiter live there), then the
 * master volume. Two shared send buses (reverb + delay) are fed by a tap on
 * each track and return into the same sum, so the master FX processes them.
 *
 * Sub-groups are a second, smaller version of the master: member tracks land on
 * the group's sum, and the group's fader, pan and mute sit between them and
 * `masterSum`. The duck that a sidechain source applies is computed by an
 * AudioWorklet on the audio thread, so it never depends on a JavaScript timer.
 *
 * Plugin chain supports:
 *   - IR / cabinet convolution (ConvolverNode)
 *   - external AudioWorklet plugins (.js files registering a processor)
 *   - Neural Amp Modeler models (.nam) running through the TONE3000 WASM engine
 *
 * NAM models are wired in parallel and summed back into the chain, so multiple
 * amps play at the same time and can be panned independently.
 *
 * The same chain can be rebuilt inside an OfflineAudioContext to export audio.
 */
import type { InstrumentKind, InstrumentNote } from './instruments';
import type { AutomationBreakpoint } from './mix-math';
import type { LoudnessReport } from './loudness';
import type { LiveLoudness } from './loudness-worklet';
export type { AutomationBreakpoint } from './mix-math';
export type { LoudnessReport } from './loudness';
export type { InstrumentKind, InstrumentNote };
export { DRUM_PIECES, PIANO_VOICES, DRUM_KITS, BASS_VOICES, INSTRUMENT_KINDS, defaultVoice, instrumentLabel, voicesFor, } from './instruments';
export type PluginKind = 'ir' | 'worklet' | 'nam';
export declare const BUILTIN_FX_IDS: readonly ['tuner', 'gate', 'sat', 'dist', 'eq', 'comp', 'deess', 'trem', 'chorus', 'delay', 'reverb', 'limiter'];
export type BuiltinFxId = (typeof BUILTIN_FX_IDS)[number];
export interface BuiltinFxParams {
    tunerRef: number;
    tunerMute: number;
    drive: number;
    tone: number;
    rate: number;
    depth: number;
    decay: number;
    time: number;
    feedback: number;
    eqLowFreq: number;
    eqLowGain: number;
    eqMidFreq: number;
    eqMidGain: number;
    eqMidQ: number;
    eqHighFreq: number;
    eqHighGain: number;
    compThreshold: number;
    compRatio: number;
    compAttack: number;
    compRelease: number;
    compKnee: number;
    compMakeup: number;
    gateThreshold: number;
    gateRange: number;
    satDrive: number;
    satTone: number;
    satTrim: number;
    tremRate: number;
    tremDepth: number;
    deessFreq: number;
    deessThreshold: number;
    deessRatio: number;
    deessAttack: number;
    deessRelease: number;
    limThreshold: number;
    limRelease: number;
    limCeiling: number;
}
export interface BuiltinFxUnit {
    enabled: boolean;
    mix: number;
    params: BuiltinFxParams;
}
export type BuiltinFxRack = Record<BuiltinFxId, BuiltinFxUnit>;
export declare function defaultBuiltinFx(): BuiltinFxRack;
export type PluginParamUnit = 'db' | 'hz' | 'pan' | 'percent' | 'ratio' | 'bool' | 'ms';
export interface PluginParamInfo {
    name: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    unit?: PluginParamUnit;
}
export interface PluginInfo {
    id: string;
    name: string;
    kind: PluginKind;
    params: PluginParamInfo[];
    detail?: string;
}
/**
 * A plugin restored from a saved project keeps the id its chain already names.
 * Without this, reload would create a new instance while the saved signal path
 * still pointed at the old id, which is how a NAM could be "loaded" and remain
 * outside the audio.
 */
export interface PluginRestoreInfo {
    id: string;
    enabled?: boolean;
    params?: PluginParamInfo[];
}
/** A clip on a track's timeline in the audio engine. */
interface EngineClip {
    id: string;
    buffer: AudioBuffer | null;
    bufferLabel: string;
    clipStart: number;
    clipDuration: number;
    fadeIn: number;
    fadeOut: number;
    takes: Array<{
        id: string;
        buffer: AudioBuffer;
    }>;
}
export interface SendConfig {
    rvDecay: number;
    dlTime: number;
    dlFeedback: number;
    rvReturn: number;
    dlReturn: number;
}
export declare function defaultSendConfig(): SendConfig;
/**
 * Which part of a device a lane owns. 0 takes the pair as it arrives — a stereo
 * source stays stereo. 1..N takes that single input of the device, which is what
 * an interface with more than two inputs needs: guitar in 1, vocal in 2, a synth
 * across 3 and 4. How many exist is the device's own answer, not ours.
 */
export type InputChannel = number;
/** The most channels any lane has needed from one interface. */
export declare const MAX_INPUT_CHANNELS = 8;
/**
 * A producer asked for the master to be selectable as a microphone — the way a
 * desk's "mix" jack patched back into a channel returns the whole show to tape.
 * It cannot be a real `MediaDeviceInfo`: the browser only lists what the machine
 * exposes, and an in-app loopback is not a sound card. So it is an id this engine
 * answers for, stereo, always at unity, and nothing else on the computer can see
 * it. A system-wide cable — the kind SALA or any other program could pick — needs
 * a driver nobody here installs, so the honest split is: inside this app the cable
 * is a device, outside it the producer picks a real one and this list shows it.
 */
export declare const MASTER_CABLE_ID = "opdaw:master-cable";
/** The label that cable carries on screen, in the producer's own words. */
export declare const MASTER_CABLE_LABEL = "Cabo virtual \u00B7 Master do OpenDAW";
/**
 * The room's return, offered the same way: an input any lane can patch.
 *
 * The master cable above carries what the desk sends out; this one carries what
 * the room sends back — every remote channel summed at unity, before the
 * listening gains, so a lane records what the musicians are actually playing
 * even when their monitor lamps are shut. It is silent while no room is
 * connected, and it does not dial anything: the producer opens the cable window
 * (Mix menu) when they want a room, exactly as before.
 */
export declare const SALA_CABLE_ID = "opdaw:sala-return";
/** The label the room return carries in the input list. */
export declare const SALA_CABLE_LABEL = "Cabo virtual \u00B7 Retorno da sala";
/**
 * The truth about a live input. The channel counts are read from the device
 * itself, not from what we asked for, because a stereo interface and a mono
 * webcam mic look identical in the browser UI until something is connected.
 */
export interface InputStatus {
    deviceId: string;
    label: string;
    /** Channels this lane actually carries: 2 for a stereo pair, 1 when a single input was patched in. */
    channels: number;
    /** Channels the device itself delivers, before the lane picked one. */
    sourceChannels: number;
    /** What the lane ended up with; 0 when a mono device left nothing to pick. */
    channel: InputChannel;
    sampleRate: number;
}
/**
 * The answer about where the mix goes out. `routed` says whether the chosen card
 * really took the audio; when it is false the mix is on the system default and
 * `error` carries the device's own refusal, so the producer reads why instead of
 * guessing from silence.
 */
export interface OutputRoute {
    deviceId: string;
    label: string;
    routed: boolean;
    error: string;
}
export interface RenderRequest {
    bpm: number;
    bars: number;
    /** When set, renders only this track instead of the full mix. */
    trackId?: string;
    /** When set, renders only the members of this sub-group. */
    groupId?: string;
    /**
     * Stems are rendered at the full arrangement length so they line up when the
     * producer drags them into another session, instead of ending wherever the
     * last clip stopped.
     */
    aligned?: boolean;
    /**
     * Export-of-selection: the first 16th step to render. Everything scheduled
     * earlier is shifted off the front of the offline context, so the file starts
     * on this step. Defaults to 0 (the whole arrangement).
     */
    startStep?: number;
    /** Last 16th step to render (the selection's `to`). Defaults to the arrangement end. */
    endStep?: number;
    masterVolume: number;
    masterMuted: boolean;
}
export interface RenderResult {
    buffer: AudioBuffer;
    warnings: string[];
    /** BS.1770 loudness of the bytes that were written, measured after any safety trim. */
    loudness: LoudnessReport;
}
interface BuiltinUnitNodes {
    input: GainNode;
    output: GainNode;
    dry: GainNode;
    wet: GainNode;
    /**
     * Every internal node of this unit, so tearing the track down is one loop
     * instead of a growing list of optional fields.
     */
    extra: AudioNode[];
    tunerAnalyser?: AnalyserNode;
    tunerMuteGain?: GainNode;
    shaper?: WaveShaperNode;
    tone?: BiquadFilterNode;
    lfo?: OscillatorNode;
    lfoDepth?: GainNode;
    delayNode?: DelayNode;
    convolver?: ConvolverNode;
    decay?: number;
    delay?: DelayNode;
    feedback?: GainNode;
    eqLow?: BiquadFilterNode;
    eqMid?: BiquadFilterNode;
    eqHigh?: BiquadFilterNode;
    compNode?: DynamicsCompressorNode;
    compMakeup?: GainNode;
    gateShaper?: WaveShaperNode;
    gateThreshold?: number;
    satShaper?: WaveShaperNode;
    satTone?: BiquadFilterNode;
    satTrim?: GainNode;
    tremGain?: GainNode;
    tremLfo?: OscillatorNode;
    tremLfoDepth?: GainNode;
    deessLow?: BiquadFilterNode;
    deessBandSum?: GainNode;
    deessComp?: DynamicsCompressorNode;
    deessOut?: GainNode;
    limNode?: DynamicsCompressorNode;
    limCeil?: GainNode;
}
export interface BuiltinChain {
    units: Record<BuiltinFxId, BuiltinUnitNodes>;
    input: GainNode;
    output: GainNode;
    state: BuiltinFxRack;
}
export declare function applyBuiltinUnit(nodes: BuiltinUnitNodes, unit: BuiltinFxUnit): void;
export declare class AudioEngine {
    readonly ctx: AudioContext;
    readonly masterGain: GainNode;
    private readonly masterSum;
    private readonly masterFx;
    private readonly reverbBus;
    private readonly delayBus;
    private readonly monitorBus;
    private readonly salaBus;
    /**
     * Alimenta só a segunda saída. Cada entrada ao vivo tem um `secondGain` com
     * porta invertida à do monitor: quando o monitor está DESLIGADO a entrada
     * chega aqui (e portanto à segunda saída); quando LIGADO ela já viaja no master,
     * e este caminho fecha para não somar duas vezes. Assim o monitor decide
     * apenas o que o produtor ouve na saída principal — a segunda saída recebe
     * a entrada sempre.
     */
    private readonly secondBus;
    private sendConfig;
    private readonly masterAnalyser;
    /**
     * The exit of the whole mix: the master analyser and the monitor bus both
     * feed it, and it is the only node that reaches the speakers or the output
     * stream. Keeping one exit is what makes Dummy Audio possible — the clock and
     * every meter keep running while the door to the card is closed.
     */
    private readonly outputGain;
    /**
     * A porta de saída que o ASIO nativo silencia. Fica depois do tap do master:
     * com o sink ASIO ativo, o tap continua recebendo o mix inteiro (e mandando
     * para o driver da interface) enquanto este ganho zera só o caminho WASAPI,
     * para o mix não sair duas vezes. Fora do modo ASIO vale 1 e nada muda.
     */
    private readonly speakerGain;
    /** O worklet que copia o master para o processo ASIO; null quando não anexado. */
    private masterTap;
    private nativeSinkActive;
    /** Worklet node for ASIO input (receives PCM from native worker). */
    private asioInputNode;
    /** MediaStream from ASIO input for use as track input. */
    private asioInputStream;
    /** Number of ASIO input channels when active. */
    private asioInputChannels;
    /** True while the producer chose Dummy Audio: silent, but still rolling. */
    private dummyAudio;
    /** Called when native sink is detached externally (e.g., worker crash). */
    onNativeSinkDetached: (() => void) | null;
    /**
     * The chosen playback device, when there is one. A Web Audio graph cannot name
     * a card, so the mix is handed to a stream and a hidden media element plays that
     * stream on the device the producer picked; `null` on both means the mix still
     * leaves through the context's own destination.
     */
    private outputSink;
    private outputElement;
    private outputDevice;
    /** Secondary output (e.g., virtual cable) — same pattern, independent device. */
    private outputSink2;
    private outputElement2;
    private outputDevice2;
    /**
     * The virtual cable to the call room, and the two nodes that make it a mix-minus.
     *
     * `callSend` hangs off the master fader and drains into a stream, so the fader
     * the producer rides really is the level the room gets. `callReturn` is where
     * the room comes back in: it joins the graph *after* that tap, on the way to the
     * speakers only. A hardware desk needs a second master bus to do this; here it
     * is one extra connect, and it is the reason a remote musician does not hear
     * their own drum kit come back a hundred milliseconds late.
     */
    private callSendNode;
    private callAnalyserNode;
    private callSinkNode;
    private callReturnNode;
    private callReturnAnalyser;
    /** Um por canal remoto: o retorno que entra pelos alto-falantes sem voltar pelo cabo. */
    private readonly callReturnFeeds;
    /**
     * O que o ganho do envio deveria ser, separado em duas causas. O fader do cabo
     * e o botão de mudo mexem no mesmo parâmetro do mesmo nó, e quem gravasse só um
     * deles esqueceria o outro ao mexer no primeiro — em uma mesa isso não acontece
     * porque o trim é um atenuador e o mudo é uma porta; aqui são dois campos e um
     * único `applyCallSendGain()` que os multiplica.
     */
    private callSendDb;
    private callSendMuted;
    /**
     * O cabo virtual do próprio app: a master saindo do fader e entrando de novo
     * por uma faixa, como um retorno de mesa que se patcheia no canal.
     *
     * São nós separados do cabo da sala de propósito: o envio para a sala tem trim
     * e mudo próprios, e um produtor que corta a ida da sala não pode perder o
     * retorno que está gravando na faixa. Este aqui é unity, sempre — o que entra
     * é exatamente o que os alto-falantes estão ouvindo naquele instante.
     */
    private masterCableAnalyser;
    private masterCableSink;
    /**
     * O cabo do retorno da sala, montado só quando uma faixa o patcheia.
     *
     * A soma é um barramento próprio, em unity, ligado direto às fontes dos
     * canais remotos — antes dos ganhos de escuta. Fechar a lâmpada IN de um
     * participante silencia o que o producer ouve, não o que a faixa grava: o
     * cabo é um dispositivo de entrada, e um dispositivo não sabe se alguém
     * está monitorando. O analyser alimenta a linha dele na janela de
     * Dispositivos, e o sink é o stream que a machinery de entrada já sabe
     * gravar sem nenhuma cópia nova.
     */
    private salaCableSum;
    private salaCableAnalyser;
    private salaCableSink;
    /**
   * Live BS.1770 meter on the master bus, attached when the app asks for it.
   * It runs on the audio thread and posts one reading per 100 ms window, so the
   * number on screen is the same measurement the exported file gets - not a
   * sample of a sample taken whenever a frame happened to arrive.
   */
    private loudnessNode;
    private loudnessSink;
    private loudnessReading;
    /**
     * Called with every reading the meter closes - ten times a second while the
     * audio thread runs. Message driven rather than polled, because a poll only
     * sees whatever was last posted, and a frame that arrived late in a hidden tab
     * would otherwise freeze the number on screen at a moment that already passed.
     */
    onLoudness: ((reading: LiveLoudness) => void) | null;
    /** One registration attempt at a time, shared by whoever asks first. */
    private loudnessPatch;
    private readonly tracks;
    /** Sub-group buses, keyed by group id. */
    private readonly groups;
    /** Producer-created aux send buses, keyed by aux id. */
    private readonly auxes;
    private readonly sources;
    private readonly voiceGates;
    private readonly inputs;
    /** Capture streams shared by every lane reading the same device. */
    private readonly sharedStreams;
    private readonly recorders;
    private readonly takePeaks;
    /** Called (throttled) while a take is running: peaks so far, seconds so far. */
    onTakeProgress: ((trackId: string, peaks: number[], seconds: number) => void) | null;
    /**
     * A worklet name is only registered inside the context it was added to, so the
     * set lives per context: a second export builds a fresh OfflineAudioContext and
     * has to run `addModule` again, or its plugin nodes would fail to be created.
     */
    private readonly loadedWorklets;
    /** In-flight `addModule` calls, so two tracks asking at once share one. */
    private readonly workletLoads;
    private namEnginePromise;
    /**
     * Context time of step 0 for the current playback pass, and the length of a
     * 16th. Automation is written in steps but scheduled in seconds, so the graph
     * needs this translation while the song rolls.
     */
    private songOriginTime;
    private songStepDuration;
    private masterVolume;
    private masterMuted;
    constructor(options?: {
        latencyHint?: AudioContextLatencyCategory;
        sampleRate?: number;
    });
    private createSendBus;
    /**
     * Ask the browser to start the clock.
     *
     * A page that has not seen a gesture yet can keep `resume()` waiting, and a
     * plugin restore that waits on it never builds its graph — the producer would
     * open the project and find no amps at all. So the wait is bounded: the nodes
     * are created either way, and the audio starts the moment the producer plays.
     */
    resume(): Promise<void>;
    setMasterVolume(value: number): void;
    setMasterMuted(muted: boolean): void;
    getMasterLevel(): number;
    /**
     * Build, once, the cable that carries the mix out to a call room.
     *
     * It is lazy because the nodes belong to this context and a producer who never
     * opens a call should not pay for a stream destination and a meter they will not
     * read. Everything hangs off `masterGain`, which is the master fader: pull it
     * down and the room gets quieter, exactly like unpluging a send cable halfway.
     */
    ensureCallCable(): {
        send: GainNode;
        stream: MediaStream;
    };
    /** O que sai pelo cabo, em pico 0..1 — o medidor do jack, não o do master. */
    getCallSendLevel(): number;
    /**
     * O cabo virtual do app, montado uma vez: a master depois do fader, entrando de
     * novo por uma faixa.
     *
     * Lazy como o cabo da sala — quem nunca patcheia o retorno não paga por um
     * `MediaStreamAudioDestinationNode`. Depois do `masterGain` é de propósito: o
     * que a faixa grava tem que ser o que sai da mesa, FX do master, limiter e
     * fader incluídos, senão o "cabo" seria uma segunda mixagem paralela. O medidor
     * separado existe para a janela de Dispositivos poder mostrar o que está
     * passando pelo plug, e não o que o master mostra — os dois são iguais enquanto
     * ninguém mexer no envio da sala, e deixam de ser se ela for cortada.
     */
    ensureMasterCable(): MediaStream;
    /** O que está passando pelo cabo agora, em pico 0..1 (0 enquanto ninguém abriu). */
    getMasterCableLevel(): number;
    /** Se este id de entrada é o cabo do próprio app, e não um hardware. */
    static isMasterCable(deviceId: string): boolean;
    /**
     * O retorno da sala como stream de entrada, montado uma vez.
     *
     * A soma nasce em unity e recebe as fontes dos canais remotos direto (sem o
     * ganho de escuta de cada um), então o que a faixa grava é o que a sala está
     * mandando, mesmo com todos os monitors fechados. Os feeds que já existiam
     * quando o cabo abre são ligados aqui; os que chegarem depois são ligados em
     * `connectCallReturn`. Sem sala ligada o barramento fica mudo — o cabo não
     * disca nada, não cria sala nenhuma, só espera o produtor ligar a janela.
     */
    ensureSalaCable(): MediaStream;
    /** O que a sala está mandando agora, em pico 0..1 (0 sem sala ou sem cabo aberto). */
    getSalaCableLevel(): number;
    /** Se este id de entrada é o retorno da sala, e não um hardware. */
    static isSalaCable(deviceId: string): boolean;
    /** Nível do que chega da sala (só existe enquanto houver retorno patcheado). */
    getCallReturnLevel(): number;
    setCallSendDb(value: number): void;
    get callSendTrimDb(): number;
    /**
     * Mudo do cabo: a sala deixa de ouvir a DAW, e a DAW continua ouvindo a sala.
     * É o botão "mix minus" de uma mesa, não o mute do canal — nada aqui toca o
     * master fader, então os alto-falantes seguem fazendo o que fazem.
     */
    setCallSendMuted(muted: boolean): void;
    get isCallSendMuted(): boolean;
    private applyCallSendGain;
    /**
     * O ponto de entrada do retorno da sala. Ele se liga ao `masterAnalyser`, que é
     * justamente o nó que a janela de saída já escolhe como caminho para a caixa de
     * som: assim o retorno obedece ao dispositivo roteado sem que o roteamento
     * precise saber que a chamada existe.
     */
    get callReturn(): GainNode;
    /**
     * Põe o retorno da sala no caminho dos alto-falantes sem voltar pelo cabo.
     *
     * A faixa gravável do participante já imprime o que chega (`connectCallInput`),
     * mas o monitor dele entra por aqui, depois do ponto de envio: é o que evita que
     * o outro músico escute a própria bateria atrasada. Um `key` por canal, para o
     * app poder desligar exatamente o que apagou.
     */
    connectCallReturn(key: string, stream: MediaStream, listen?: boolean): void;
    /**
     * O nível de escuta de um canal da sala — a lâmpada IN da faixa dele.
     *
     * Fica no retorno, e não na mixagem da faixa, por um motivo: o fader da faixa
     * alimenta o master, e o master é o que sai pelo cabo. Abrir a escuta por ali
     * faria o músico do outro lado ouvir a si mesmo com o atraso da rede, que é o
     * eco que quebra qualquer jam. Por aqui ele some dos seus alto-falantes sem
     * mudar nada do que a sala recebe.
     */
    setCallReturnGain(key: string, value: number): void;
    getCallReturnGain(key: string): number;
    /** As chaves de retorno ligadas agora, para quem desmonta o cabo por completo. */
    callReturnKeys(): string[];
    disconnectCallReturn(key: string): void;
    /** Solta o cabo de vez: a faixa do stream morre e os nós saem da cadeia. */
    releaseCallCable(): void;
    /**
     * How much the master compressor and limiter are squeezing, in dB of gain
     * reduction (0 means neither is working). `reduction` is the browser's own
     * audio-thread measurement, so the meter shows what the master is really doing
     * rather than what the knobs suggest it should do.
     */
    getMasterReduction(): number;
    /**
     * Attach the live loudness meter to the master bus.
     *
     * It taps the signal after the master fader and after the master FX, which is
     * the same place the export measures, and it is only ever created on the live
     * context: the offline render computes its own loudness from the bytes it
     * wrote, so it has no use for a meter and no reason to pay for one.
     */
    enableLoudnessMeter(): Promise<void>;
    private patchLoudnessMeter;
    /**
     * The last reading the master produced, or null when there is nothing honest
     * to show: the meter is not attached, the audio thread is paused - and a
     * number from before the pause describes a moment that is not happening - or
     * the first 400 ms window has not closed yet.
     */
    getMasterLoudness(): LiveLoudness | null;
    /**
     * Forget the window. A new project is not the tail of the one that was just
     * on screen, and a three second mean that still carries the old mix would be
     * the first dishonest number in the app.
     */
    resetLoudnessMeter(): void;
    /**
     * Create a sub-group bus. Members are tracks whose `groupId` names it; their
     * output lands on `input` and leaves through the group fader, so one move of
     * this fader moves every member - which is exactly what the export does too.
     */
    addGroup(id: string, volume?: number, pan?: number): void;
    hasGroup(id: string): boolean;
    listGroups(): string[];
    /** Every member is rewired to the master before the bus disappears. */
    removeGroup(id: string): void;
    /**
     * Route a track's post-fader output to a group ('' = straight to master).
     * Only that one edge moves: the buffer, plugins and sends of the track stay
     * exactly as they were.
     */
    setTrackGroup(trackId: string, groupId: string): void;
    /**
     * Marca a faixa como canal de convidado da Sala e move a saída do canal para
     * depois do ponto de envio. O convidado passa a obedecer ao fader, mute, pan e
     * FX da própria faixa dentro da DAW, mas o som dele não entra no `masterSum`
     * (que é o que volta pra sala) — entra só no caminho dos alto-falantes, depois
     * do envio, então o músico remoto não escuta a si mesmo atrasado.
     */
    setTrackPostSend(trackId: string, enabled: boolean): void;
    setGroupVolume(id: string, value: number): void;
    setGroupPan(id: string, value: number): void;
    setGroupMuted(id: string, muted: boolean): void;
    getGroupLevel(id: string): number;
    /** Set one built-in unit on a sub-group's rack, mirroring the master bus. */
    setGroupFx(id: string, fxId: BuiltinFxId, unit: BuiltinFxUnit): void;
    getGroupFx(id: string): BuiltinFxRack | null;
    applyGroupFxPreset(id: string, rack: BuiltinFxRack): void;
    /** Drawn volume envelope for the bus, in the same step/dB language as tracks. */
    setGroupAutomation(id: string, points: AutomationBreakpoint[]): void;
    getGroupAutomation(id: string): AutomationBreakpoint[];
    private scheduleGroupAutomation;
    private groupsGain;
    private groupInput;
    /**
     * Create a free aux bus. Every existing track gets a silent send tap into it,
     * so the producer can immediately dial sends from the mixer; the bus itself is
     * transparent (rack disabled) until something is enabled on it.
     */
    addAux(id: string, volume?: number): void;
    hasAux(id: string): boolean;
    listAuxes(): string[];
    /** Tear the bus down and pull every track's send tap out of it. */
    removeAux(id: string): void;
    setAuxVolume(id: string, value: number): void;
    setAuxMuted(id: string, muted: boolean): void;
    /** How much of one track feeds one aux (0..1-ish linear send gain). */
    setAuxSend(trackId: string, auxId: string, value: number): void;
    getAuxSend(trackId: string, auxId: string): number;
    getAuxLevel(id: string): number;
    setAuxFx(id: string, fxId: BuiltinFxId, unit: BuiltinFxUnit): void;
    getAuxFx(id: string): BuiltinFxRack | null;
    applyAuxFxPreset(id: string, rack: BuiltinFxRack): void;
    /**
     * Make one track duck whenever others speak - kick against bass, voice against
     * music, kick *and* snare against a rhythm guitar. `sourceIds` of [] removes
     * the duck.
     *
     * Every source lands on the same follower input, so their signals add before
     * the envelope is measured - the same summing amp an external compressor has.
     *
     * The envelope is followed on the audio thread by the shared worklet, and the
     * result drives `duckGain.gain` directly, so the same numbers run in the
     * offline render: what you hear ducked is what the file exports.
     */
    setSidechainDuck(trackId: string, sourceIds: string[], depth?: number): Promise<void>;
    /** Which tracks currently open this track's gate, in the order they were added. */
    getSidechainSources(trackId: string): string[];
    /**
     * The follower's output is connected to `duckGain.gain`, whose intrinsic value
     * must be 0: an AudioParam adds its own value to every connected input, so a
     * leftover 1 would put the whole duck back under the signal.
     *
     * Adding or removing a source keeps the existing follower: its envelope has
     * memory (attack and release), and throwing it away would make the duck hiccup
     * at the moment the producer is only trying to change who controls it.
     */
    private buildDuck;
    /** Tear the control path down and hand the fader back to the track. */
    private releaseDuck;
    /**
     * Register a worklet from source text once per context. Callers that arrive
     * together share one promise: two `addModule` calls racing on the same
     * processor name throw, and a duck turned on while the export runs would
     * otherwise be enough to trip it.
     */
    private ensureWorkletModule;
    private workletNamesFor;
    private workletLoadsFor;
    addTrack(id: string, volume?: number, pan?: number): void;
    /**
     * Whether the graph for `id` already exists. Callers that re-apply a full
     * track state must check this first: `addTrack` builds a brand new node
     * graph, so rebuilding a live track would drop its buffer and its loaded
     * NAM/IR plugins.
     */
    hasTrack(id: string): boolean;
    removeTrack(id: string): void;
    private rewire;
    setChainOrder(trackId: string, ids: string[]): void;
    /**
     * Put a plugin instance on the track and in its signal path.
     *
     * A plugin is only half back until the chain names it: an instance that sits
     * in the rack but not in the list is a card with knobs and no audio, which is
     * exactly how a restored NAM used to come back. `insertPluginIntoChain` is
     * idempotent, so a caller that will re-apply the saved order right after loses
     * nothing by the plugin landing at a provisional spot first.
     */
    private registerPlugin;
    private insertPluginIntoChain;
    setVolume(id: string, value: number): void;
    setPan(id: string, value: number): void;
    setBuiltinFx(id: string, fxId: BuiltinFxId, unit: BuiltinFxUnit): void;
    setMuted(id: string, muted: boolean): void;
    /**
     * Track fader = volume x trim x polarity. Folding trim/phase into the single
     * gain node keeps the live and offline graphs identical.
     */
    private applyTrackGain;
    setTrim(id: string, linear: number): void;
    setPhaseInvert(id: string, invert: boolean): void;
    setMono(id: string, mono: boolean): void;
    setTrackSend(id: string, kind: 'rv' | 'dl', value: number): void;
    setSendConfig(next: Partial<SendConfig>): void;
    getSendConfig(): SendConfig;
    getTrackTunerAnalyser(trackId: string): AnalyserNode | null;
    getMasterTunerAnalyser(): AnalyserNode | null;
    getAuxTunerAnalyser(auxId: string): AnalyserNode | null;
    setMasterFx(fxId: BuiltinFxId, unit: BuiltinFxUnit): void;
    getMasterFx(): BuiltinFxRack;
    applyMasterFxPreset(rack: BuiltinFxRack): void;
    getTrackStaging(id: string): {
        trim: number;
        phase: number;
        mono: boolean;
        rv: number;
        dl: number;
    } | null;
    getLevel(id: string): number;
    private findTrack;
    hasPlugin(trackId: string, pluginId: string): boolean;
    addIrPlugin(trackId: string, buffer: AudioBuffer, name: string, restore?: PluginRestoreInfo): PluginInfo;
    addWorkletPlugin(trackId: string, file: File, restore?: PluginRestoreInfo): Promise<PluginInfo>;
    private getNamEngine;
    addNamPlugin(trackId: string, file: File, restore?: PluginRestoreInfo): Promise<PluginInfo>;
    setPluginEnabled(trackId: string, pluginId: string, enabled: boolean): void;
    setPluginParam(trackId: string, pluginId: string, name: string, value: number): void;
    removePlugin(trackId: string, pluginId: string): void;
    setFxEnabled(id: string, enabled: boolean): void;
    setDrive(id: string, amount: number): void;
    setCabinet(id: string, frequency: number): void;
    listInputs(): Promise<MediaDeviceInfo[]>;
    /**
     * The same list without touching the microphone, so the app can auto-detect
     * an input on load without triggering the permission prompt. Labels stay
     * empty until the user has granted permission at least once, so the caller
     * must accept unnamed devices and prefer the ones that came back labelled.
     */
    listInputsQuietly(): Promise<MediaDeviceInfo[]>;
    /**
     * The first real input the browser exposes, system default first. Used when
     * a track is armed but no device was chosen — the producer should hear the
     * guitar the moment they plug it in, not after pressing a "detect" button.
     */
    detectInput(): Promise<string>;
    /**
     * Open a live input for a track. The saved project can hold a device id that
     * no longer exists (an interface unplugged, a browser that renamed it), and
     * `exact` then throws `OverconstrainedError` — which is what makes an entry
     * look dead in a DAW that remembers its routing. So ask for that device, and
     * if the browser cannot give it, fall back to the system default and report
     * which one actually opened.
     *
     * `channel` picks which part of the device this lane owns. A two-input
     * interface is one browser stream, so lane A takes channel 1 and lane B takes
     * channel 2 by splitting that shared stream — the way a real console patches
     * two mic cables into two channels.
     *
     * Special device ID `opdaw:asio-input` uses the native ASIO input stream
     * when ASIO is active with input channels.
     */
    connectInput(trackId: string, deviceId: string, monitor: boolean, channel?: InputChannel): Promise<InputStatus>;
    /** The live input of a track, or null when nothing is connected. */
    inputStatus(trackId: string): InputStatus | null;
    /**
     * Patches an external MediaStream — the call room — into a track.
     *
     * Same lane as a hardware input (`source -> out -> gain -> track.panner`, with
     * the recorder's tap on `out`), because that is what makes the monitor button, the
     * lane's meter and the recorder work without a second copy of any of them. The
     * `streamKey` deliberately is not a device id: `disconnectInput` only stops a
     * shared stream when the key exists in `sharedStreams`, and the call's stream
     * belongs to the SDK, not to this engine.
     */
    connectCallInput(trackId: string, stream: MediaStream, monitor?: boolean, label?: string): InputStatus;
    setInputMonitor(trackId: string, enabled: boolean): void;
    /**
     * Whether the live input of a lane is reaching the mix — that is, whether the
     * producer lit the monitor.
     */
    isInputLive(trackId: string): boolean;
    /**
     * One node in the live path: the common case of the chain below, kept because
     * every caller that has a single insert reads better with one argument.
     */
    setLiveInsert(trackId: string, node: AudioNode | null): boolean;
    /**
     * Puts a row of nodes between a lane's input and the monitor feed it already
     * has, or takes the whole row out again.
     *
     * `out -> 1 -> 2 -> … -> gain` keeps the promises the single insert made, only
     * longer: the monitor hears every plugin in the chain, while the recorder's tap
     * — which reads `out` further up — still gets the device exactly as it came.
     * Only the lane's own destination is unplugged, never the whole `out`, because
     * the recorder may be reading it.
     */
    setLiveInsertChain(trackId: string, nodes: AudioNode[]): boolean;
    /** The node a lane's input currently enters first, if any. */
    liveInsert(trackId: string): AudioNode | null;
    /** Every node of that path, in signal order — an empty list when the lane is dry. */
    liveInsertChain(trackId: string): AudioNode[];
    disconnectInput(trackId: string): void;
    hasInput(trackId: string): boolean;
    /** Frames per sample-tap callback; also the resolution of the live peaks. */
    private static readonly TAKE_CHUNK;
    /**
     * Tap each armed lane and start its take.
     *
     * The tap is the lane's patch cable: what lands on disk is the input exactly as
     * the device gave it, patched to the channel this lane owns. The lane's
     * effects stay behind the take — they run live while the producer plays and
     * again every time the clip is read back — so a performance is never married
     * to a sound, and a different amp tomorrow still fits the recording. That is
     * also why the file is stereo-safe: the recorder reads the patch, not the mix.
     *
     * Reading the samples ourselves, rather than through MediaRecorder, is what lets
     * a stereo interface really give a two-channel take and lets the lane redraw
     * while the take grows instead of only after the transport stops.
     */
    startRecording(trackIds: string[]): Promise<string[]>;
    /**
     * Live spectrum of a running take, in 0..255 per frequency bin, or null when
     * that lane is not recording. The caller owns the returned array.
     */
    takeSpectrum(trackId: string): Uint8Array | null;
    /** Bin resolution, so the caller can label the frequency axis honestly. */
    get takeSpectrumBinHz(): number;
    private recordPeak;
    /** Assemble each running tap into an AudioBuffer, channel for channel. */
    stopRecording(): Promise<Map<string, AudioBuffer>>;
    private stopTrackRecorder;
    isRecordingTrack(trackId: string): boolean;
    playClick(accent?: boolean, when?: number): void;
    setBuffer(id: string, buffer: AudioBuffer | null, label?: string): void;
    /**
     * Adds a new clip to the track's timeline (Reaper-style items).
     * Returns the clip ID.
     */
    addClip(id: string, clip: {
        buffer: AudioBuffer;
        bufferLabel: string;
        clipStart: number;
        clipDuration: number;
        fadeIn: number;
        fadeOut: number;
    }, clipId?: string): string;
    /**
     * Removes a clip from the track's timeline.
     */
    removeClip(id: string, clipId: string): void;
    /** The stored sample of a lane, dry, as the razor and the moves see it. */
    getBuffer(id: string): AudioBuffer | null;
    getClip(id: string, clipId: string): EngineClip | null;
    /**
     * Inserts or updates a clip keeping the caller's id — the project state is
     * the source of truth and the engine mirrors it. A null buffer keeps the
     * sample the clip already holds (rehydrate fills it in afterwards).
     */
    upsertClip(id: string, clip: {
        id: string;
        buffer: AudioBuffer | null;
        bufferLabel: string;
        clipStart: number;
        clipDuration: number;
        fadeIn: number;
        fadeOut: number;
    }): void;
    /** Moves one clip's start without touching the lane's other clips. */
    setClipStartFor(id: string, clipId: string, step: number): void;
    /** Trims one clip against its own sample, not the lane's legacy buffer. */
    setClipDurationFor(id: string, clipId: string, seconds: number): void;
    /** Copies a range of one clip's sample into a fresh buffer (same-lane razor). */
    sliceClipBuffer(id: string, clipId: string, from: number, to: number): AudioBuffer | null;
    /** Legacy fields follow the last clip so older paths keep seeing audio. */
    private mirrorLegacyFromClips;
    /**
     * Put a rendered pass in front of the speakers and the export without
     * touching the recorded clip. Passing null gives the dry take back.
     */
    setMonitorBuffer(id: string, buffer: AudioBuffer | null, key?: string): void;
    /** The key of the preview this lane is playing, or '' when it plays the take. */
    monitorKey(id: string): string;
    /** Which stored sample is currently loaded in this track, if any. */
    getBufferLabel(id: string): string;
    /**
     * Edge fades for the clip, in seconds. Tiny default ramps (5 ms) are always
     * present so a trimmed edge never clicks; the user can extend them.
     */
    setClipFade(id: string, fadeIn: number, fadeOut: number): void;
    getClipFade(id: string): {
        fadeIn: number;
        fadeOut: number;
    };
    /**
     * Volume automation for one track: breakpoints at 16th-note steps, levels in
     * dB relative to the fader. It runs on its own gain node, so drawing a lane
     * never moves the fader the user set and riding the fader never erases a lane.
     */
    setAutomation(id: string, points: AutomationBreakpoint[]): void;
    getAutomation(id: string): AutomationBreakpoint[];
    /**
     * Schedules one track's envelope onto its automation node. Ramps are
     * exponential between successive gains, which is what makes the param move in a
     * straight line in dB - the same line the lane draws and the same shape the
     * offline render builds.
     */
    private scheduleAutomation;
    /**
     * Clears every automation envelope. Called on stop so a parked playhead never
     * leaves a track sitting at the last drawn gain.
     */
    private resetAutomation;
    /**
     * Round-trip estimate in milliseconds (render quantum + output latency).
     * What you hear through the monitors arrives this late, so a take sung "in
     * time" lands behind the grid by roughly the same amount.
     */
    latencyMs(): number;
    /**
     * Which playback device the mix leaves through. Empty means the system
     * default, which is the only path a browser gives without asking.
     */
    get outputDeviceId(): string;
    /**
     * The second card the same mix is copied to, or '' when only the main output
     * is playing. Kept separate from `outputDeviceId` because it is an extra tap
     * on the master, not a replacement for the main route.
     */
    get secondOutputDeviceId(): string;
    /**
     * Send the whole mix — every lane, the sends, the metronome and the live
     * input — out of one chosen speaker instead of the default one.
     *
     * A Web Audio graph cannot name a device, but it can hand its output to a
     * media stream, and a media element can be told which playback device to use.
     * So the sum goes to a hidden stream and that stream plays on the chosen
     * card. It is a real gain: an interface with its own outputs for headphones
     * and monitors can be picked here. It costs a little latency, which is why
     * the number next to it is shown, and it is not ASIO: a browser and Electron
     * reach the card through the system mixer (WASAPI shared on Windows), so the
     * exclusive-driver path of a pro interface is not available to this program.
     */
    setOutputDevice(deviceId: string): Promise<OutputRoute>;
    /**
     * Define a segunda saída (ex.: cabo virtual VB-Cable/Voicemeeter).
     * O master toca em AMBAS as saídas simultaneamente.
     */
    setSecondOutputDevice(deviceId: string): Promise<OutputRoute>;
    /** Libera o stream da segunda saída. */
    private releaseSecondOutputStream;
    /** Whether the mix is leaving to nowhere on purpose (Dummy Audio). */
    get dummyAudioMode(): boolean;
    /**
     * Dummy Audio: the transport, the meters and every plugin keep working, but
     * the door to the sound card stays shut. It is the mode to edit on a laptop
     * with no interface attached, or to prove a session runs without making noise.
     */
    setDummyAudio(enabled: boolean): void;
    /**
     * Anexa o tap que alimenta o sink ASIO nativo. Insere um worklet transparente
     * entre a saída do mix e o ganho do alto-falante: outputGain -> tap ->
     * speakerGain. O tap copia o master para uma MessagePort cuja outra ponta a
     * página entrega ao processo que escreve no driver ASIO. Devolve essa ponta e
     * a taxa do contexto, para o host abrir o stream na mesma taxa (sem resample).
     *
     * Só o executável chama isto; no navegador não há processo nativo para receber
     * a porta, então o método nem é invocado.
     */
    attachNativeSink(batchFrames?: number): Promise<{
        sampleRate: number;
        port: MessagePort;
        batchFrames: number;
    }>;
    /**
     * Anexa a porta de entrada ASIO nativa. Cria um worklet que recebe o PCM da
     * interface ASIO e o disponibiliza como uma MediaStream para as tracks usarem
     * como entrada. Isso substitui o getUserMedia/WASAPI para latência real.
     *
     * Só o executável chama isto; no navegador não há processo nativo para receber
     * a porta, então o método nem é invocado.
     */
    attachNativeInput(batchFrames?: number, inputChannels?: number): Promise<{
        sampleRate: number;
        port: MessagePort;
        batchFrames: number;
        stream: MediaStream;
    }>;
    /**
     * Handle incoming ASIO input PCM data from the native worker.
     * This is called from the renderer when the input port receives data.
     */
    handleAsioInputPcm(samples: Float32Array): void;
    /**
     * Liga/desliga o caminho WASAPI enquanto o ASIO carrega o som. Com o sink
     * ativo, speakerGain zera (o alto-falante do sistema fica mudo) mas o tap, que
     * vem antes dele, continua mandando o mix inteiro para a interface. O grafo
     * segue renderizando porque speakerGain continua ligado ao destination.
     */
    setNativeSinkActive(active: boolean): void;
    get nativeSinkMode(): boolean;
    /** Remove o tap e devolve o caminho direto outputGain -> speakerGain. */
    detachNativeSink(): void;
    /** Internal detach - can be called externally (e.g., worker crash). */
    _detachNativeSinkInternal(): void;
    /** Called by external code (e.g., worker crash handler) to notify of external detach. */
    notifyNativeSinkDetached(): void;
    /** Remove the ASIO input worklet and clean up the stream. */
    detachNativeInput(): void;
    /** Store the ASIO input MediaStream for use by tracks. */
    setAsioInputStream(stream: MediaStream): void;
    /** Get the ASIO input MediaStream for use by tracks. */
    getAsioInputStream(): MediaStream | null;
    /** Everything the mix's exit looks like, for the device window. */
    describeOutput(): {
        deviceId: string;
        routed: boolean;
        latencyMs: number;
        inputLatencyMs: number;
    };
    /**
     * What the browser admits about the entry side. Chrome reports it on the
     * AudioContext when the input is a real device; a value of 0 means the
     * browser gave nothing, which is reported as 0 rather than guessed at.
     */
    inputLatencyMs(): number;
    private releaseOutputStream;
    setClipStart(id: string, step: number): void;
    /**
     * Trims the tail of a recorded clip without touching the stored sample, so
     * the edit stays reversible. `seconds` is clamped to the buffer length.
     */
    setClipDuration(id: string, seconds: number): void;
    getClipDuration(id: string): number;
    /** Full length of the stored sample, used to clamp timeline trims. */
    getBufferDuration(id: string): number;
    /**
     * Copies `from`..`to` seconds of a track's take into a fresh buffer. Used by
     * the razor: a lane holds one clip, so the second half becomes its own file
     * that another lane can carry.
     */
    sliceBuffer(id: string, from: number, to: number): AudioBuffer | null;
    private clipEnd;
    private clipEndForClip;
    hasBuffer(id: string): boolean;
    /**
     * Schedules every recorded clip relative to the song position.
     * `stepDuration` is the length of a 16th note in seconds.
     */
    startBuffersAt(when: number, stepDuration: number, fromStep: number): void;
    playBuffers(when?: number): void;
    /**
     * Stops every scheduled source. `keepAutomation` is for the loop wrap, where
     * a stop is only the other half of a restart: resetting the lanes there would
     * drop every track back to the fader for the few milliseconds between the two
     * calls, and that seam is audible.
     */
    stopBuffers(keepAutomation?: boolean): void;
    setInstrument(trackId: string, kind: InstrumentKind | null, voice?: string): void;
    setNotes(trackId: string, notes: InstrumentNote[], patternSteps?: number): void;
    /** Plays one synth voice through the track's full signal chain. */
    playNote(trackId: string, kind: InstrumentKind, pitch: number, velocity: number, when: number, duration: number): void;
    private voice;
    /** Stops a specific voice by trackId and pitch (for key release). Triggers release envelope. */
    stopNote(trackId: string, pitch: number): void;
    /** Silences every in-flight instrument voice (seek / stop / loop restart). */
    stopNotes(): void;
    /**
     * Rebuilds the track chain inside an OfflineAudioContext so the exported file
     * sounds like what you hear (plugins included).
     */
    private buildOfflinePlugin;
    render(request: RenderRequest): Promise<RenderResult>;
}
export declare function encodeWav(buffer: AudioBuffer): Blob;
