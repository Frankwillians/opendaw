/**
 * The native plugin in the live signal path.
 *
 * A .dll does not run in Web Audio: it runs in the app's own plugin process, on
 * the other side of an inter-process call. The audio thread cannot wait for that
 * call — it has 128 samples to answer in about 2.7 ms at 48 kHz, and a trip to
 * the plugin process costs roughly that much — so this bridge never makes it
 * wait. The worklet holds two rings: the input it has not sent yet, and the
 * processed audio that came back. Each round trip carries a batch of samples
 * (512 by default, about 10.7 ms of music) instead of one quantum, so the main
 * thread does a fraction of the work and the audio thread does none of the
 * waiting.
 *
 * What that costs is latency, and it is stated rather than hidden: a batch going
 * in, a batch coming out, and the trip between them. What it never costs is
 * sound — if the plugin is slow, faults, or was never opened, the worklet hands
 * over the dry input, so a producer with a dead plugin still hears the guitar.
 */
/** Registered name of the worklet below. */
export declare const NATIVE_LIVE_PROCESSOR_NAME = "webdaw-native-live";
/** Samples each way per round trip: 512 is ~10.7 ms at 48 kHz, ~11.6 at 44.1. */
export declare const DEFAULT_LIVE_BATCH = 512;
/** How many rings' worth of audio may pile up before the oldest is dropped. */
export declare const LIVE_QUEUE_LIMIT_BATCHES = 2;
/**
 * The batch a lane should use at this rate: always a whole number of 128-sample
 * quanta, and never so small that the process hop dominates the audio it carries.
 */
export declare function pickLiveBatch(sampleRate: number, targetMs?: number): number;
/** Milliseconds of audio one batch carries — the price of a late answer. */
export declare function audioMsPerBatch(sampleRate: number, batch: number): number;
/**
 * Added delay, in milliseconds, a live plugin puts between the string and the
 * speaker: one batch waiting to go, one batch waiting to be played, and the hop.
 * The panel shows this number instead of promising zero.
 */
export declare function liveLatencyMs(sampleRate: number, batch?: number, hopMs?: number): number;
/**
 * A block answer comes back as a Buffer (Electron) or as {type:'Buffer', data}
 * (a plain fork). Neither can be read as float32 in place — the revived Buffer
 * may sit at an offset that is not a multiple of four — so this copies, which is
 * also the only place the page pays for the conversion.
 */
export declare function toFloat32(payload: unknown): Float32Array | null;
/**
 * What the lane asks the plugin process for when it starts listening.
 *
 * `sessionId` is the row in the chain, not the file: a producer who put the same
 * distortion in slots 1 and 3 wants two sessions of one .dll, and the process has
 * to be able to tell them apart. It is deliberately not called `id` — the request
 * envelope already uses that for the call the answer has to be matched to. Older
 * hosts send only the path, so every bridge call keeps `path` and the worker falls
 * back to it when there is no session id.
 */
export interface LiveOpenRequest {
    path: string;
    sessionId?: string;
    sampleRate: number;
    block: number;
    params?: {
        index: number;
        value: number;
    }[];
}
/** The answers this bridge needs from the app. Every one of them may say no. */
export interface LiveOpenReply {
    ok: boolean;
    error?: string;
    geometry?: {
        block?: number;
        channels?: number;
        outputs?: number;
        sampleRate?: number;
    };
}
export interface LiveBlockReply {
    ok: boolean;
    error?: string;
    late?: boolean;
    left?: unknown;
    right?: unknown;
    peak?: number;
    bad?: number;
}
/**
 * The four calls the app's preload exposes; absent in a browser, by design.
 *
 * Every one of them after the open carries the same `sessionId` the open used, so
 * the process answers the row that asked and not whichever copy of the .dll it
 * happens to remember. The name matters: a body field called `id` would overwrite
 * the request id the supervisor matches the answer to.
 */
export interface LiveBridge {
    liveOpen?: (request: LiveOpenRequest) => Promise<LiveOpenReply>;
    liveBlock?: (request: {
        path: string;
        sessionId?: string;
        left: Float32Array;
        right: Float32Array;
    }) => Promise<LiveBlockReply>;
    liveParams?: (request: {
        path: string;
        sessionId?: string;
        params: {
            index: number;
            value: number;
        }[];
    }) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    liveClose?: (request: {
        path: string;
        sessionId?: string;
    }) => Promise<{
        ok: boolean;
        blocks?: number;
        error?: string;
    }>;
}
/** What the audio thread counted, handed up when the panel asks. */
export interface LiveStats {
    quanta: number;
    batches: number;
    answered: number;
    underruns: number;
    drops: number;
    late: number;
}
export declare const EMPTY_LIVE_STATS: LiveStats;
/** A merge, so a report that only carries some fields cannot lose the rest. */
export declare function mergeLiveStats(before: LiveStats, next: Partial<LiveStats> | null | undefined): LiveStats;
/**
 * When a live session stops being worth keeping. One late answer is a hiccup;
 * three in a row, or any reply that says the plugin is not there, means the
 * process faulted or the producer unloaded it — and the lane goes back to dry
 * instead of clicking at the edges of every buffer.
 */
export declare function shouldGiveUp(failures: number, reply: LiveBlockReply | null): boolean;
/**
 * Whether a lane has anything to put in the live path at all: a VST2 or VST3 file
 * that is not bypassed. VST3 live support was added in the plugin worker.
 * When the caller does not name the engine, the extension decides — a .vst3 is a
 * bundle, everything else this host loads live is a .dll.
 */
export declare function canRunLive(slot: {
    path?: string;
    bypass?: boolean;
    kind?: string;
} | null): boolean;
/**
 * The worklet, as source text: the engine registers it from a blob so the same
 * module can exist in the live context and, if a bounce ever wants it, in an
 * OfflineAudioContext. Inside an offline render nobody answers the rings, and the
 * `live` flag is simply never raised — the pass goes through the plugin process
 * as a file instead, which is what a bounce should do.
 */
export declare const NATIVE_LIVE_WORKLET_SOURCE = "\nconst RING_FRAMES = 8192\n\n/** A single-channel ring: written by the audio thread, drained by both sides. */\nclass RingBuffer {\n  constructor(size) {\n    this.size = size\n    this.data = new Float32Array(size)\n    this.tail = 0\n    this.length = 0\n  }\n\n  space() {\n    return this.size - this.length\n  }\n\n  write(values) {\n    const count = Math.min(values.length, this.space())\n    if (count <= 0) return 0\n    const head = (this.tail + this.length) % this.size\n    const first = Math.min(count, this.size - head)\n    this.data.set(values.subarray(0, first), head)\n    if (count > first) this.data.set(values.subarray(first, count), 0)\n    this.length += count\n    return count\n  }\n\n  read(target) {\n    const count = Math.min(target.length, this.length)\n    if (count <= 0) return 0\n    const first = Math.min(count, this.size - this.tail)\n    target.set(this.data.subarray(this.tail, this.tail + first), 0)\n    if (count > first) target.set(this.data.subarray(0, count - first), first)\n    this.tail = (this.tail + count) % this.size\n    this.length -= count\n    return count\n  }\n\n  /** Throw away the oldest samples: fresh audio beats a queue that grew late. */\n  skip(count) {\n    const dropped = Math.min(count, this.length)\n    this.tail = (this.tail + dropped) % this.size\n    this.length -= dropped\n    return dropped\n  }\n\n  reset() {\n    this.tail = 0\n    this.length = 0\n  }\n}\n\nclass NativeLiveProcessor extends AudioWorkletProcessor {\n  constructor(options) {\n    super()\n    const asked = options && options.processorOptions ? options.processorOptions.batch : 512\n    // Always a whole number of quanta, so a batch is never split across blocks.\n    this.batch = Math.max(128, Math.min(RING_FRAMES, Math.round(asked / 128) * 128))\n    this.inL = new RingBuffer(RING_FRAMES)\n    this.inR = new RingBuffer(RING_FRAMES)\n    this.outL = new RingBuffer(RING_FRAMES)\n    this.outR = new RingBuffer(RING_FRAMES)\n    // Pre-allocated send buffers: the audio thread must not shop for garbage.\n    this.sendL = new Float32Array(this.batch)\n    this.sendR = new Float32Array(this.batch)\n    this.live = false\n    this.awaiting = false\n    this.seq = 0\n    this.pending = 0\n    this.stats = { quanta: 0, batches: 0, answered: 0, underruns: 0, drops: 0, late: 0 }\n    this.port.onmessage = (event) => {\n      const data = event.data || {}\n      if (data.kind === 'mode') {\n        const on = !!data.live\n        if (on !== this.live) {\n          this.live = on\n          this.awaiting = false\n          this.inL.reset(); this.inR.reset(); this.outL.reset(); this.outR.reset()\n        }\n        return\n      }\n      if (data.kind === 'audio') {\n        this.awaiting = false\n        // A reply for a batch that was already thrown away must not be played:\n        // it would land in the middle of audio the thread has since sent.\n        if (data.seq !== this.pending) {\n          this.stats.late += 1\n          return\n        }\n        const left = data.left\n        const right = data.right && data.right.length ? data.right : left\n        if (!left || !left.length) return\n        this.stats.answered += 1\n        this.outL.write(left)\n        this.outR.write(right)\n        return\n      }\n      if (data.kind === 'stats') this.report()\n    }\n  }\n\n  report() {\n    this.port.postMessage({ kind: 'stats', ...this.stats, batch: this.batch })\n  }\n\n  process(inputs, outputs) {\n    const stats = this.stats\n    stats.quanta += 1\n    const input = inputs[0]\n    const output = outputs[0]\n    if (!input || !input[0] || !output || !output[0]) return true\n    const inLeft = input[0]\n    const inRight = input[1] || inLeft\n    const size = output[0].length\n\n    if (!this.live) {\n      // Nothing is listening through the plugin: hand the lane exactly what it\n      // asked for. This is also the offline path \u2014 a bounce never raises the flag.\n      output[0].set(inLeft.subarray(0, size))\n      if (output[1]) output[1].set(inRight.subarray(0, size))\n      return true\n    }\n\n    this.inL.write(inLeft)\n    this.inR.write(inRight)\n    // The ring is a pipeline, not a queue: past two batches the oldest audio is\n    // already useless, and keeping it would only push the producer further away.\n    const limit = this.batch * 2\n    if (this.inL.length > limit) {\n      const overflow = this.inL.length - limit\n      this.inL.skip(overflow)\n      this.inR.skip(overflow)\n      stats.drops += 1\n    }\n\n    const taken = this.outL.read(output[0])\n    const rightTaken = output[1] ? this.outR.read(output[1]) : 0\n    // Whatever the plugin did not deliver in time is the dry input, not silence:\n    // a slow answer changes the tone for a moment, it never mutes the take.\n    if (taken < size) {\n      stats.underruns += 1\n      output[0].set(inLeft.subarray(0, size - taken), taken)\n    }\n    if (output[1] && rightTaken < size) {\n      output[1].set(inRight.subarray(0, size - rightTaken), rightTaken)\n    }\n\n    if (!this.awaiting && this.inL.length >= this.batch) {\n      this.inL.read(this.sendL)\n      this.inR.read(this.sendR)\n      this.pending = ++this.seq\n      this.awaiting = true\n      stats.batches += 1\n      this.port.postMessage({ kind: 'batch', seq: this.pending, left: this.sendL, right: this.sendR })\n    }\n\n    if (stats.quanta % 256 === 0) this.report()\n    return true\n  }\n}\n\nregisterProcessor('webdaw-native-live', NativeLiveProcessor)\n";
/**
 * The main-thread half: it owns one worklet node and one plugin path, answers the
 * batches the audio thread posts, and knows when to stop trying.
 *
 * One request in flight at a time is deliberate. The plugin process handles calls
 * in order, and two outstanding batches would come back in the order they were
 * processed rather than the order the thread filled them — the audio would be
 * reassembled out of turn. A busy link simply lets the worklet drop the samples
 * it could not send, which the report counts.
 */
export declare class NativeLiveLink {
    readonly node: AudioWorkletNode;
    readonly path: string;
    /** The chain row this session belongs to; the path alone cannot tell two copies apart. */
    readonly sessionKey: string;
    readonly batch: number;
    readonly bridge: LiveBridge;
    private busy;
    private failures;
    private closed;
    private stats;
    private running;
    private lastError;
    private constructor();
    /** True while the audio thread is handing its input through the plugin. */
    get live(): boolean;
    get error(): string;
    get report(): LiveStats;
    /**
     * Open the session in the plugin process, then raise the flag in the worklet.
     * The order matters: enabling the node before the process is ready would have
     * the thread posting batches into a call that answers "no session open".
     *
     * Returns null when this page simply has no live path — no bridge, or no
     * AudioWorklet — and throws the plugin's own words when the plugin refused,
     * because "this .dll has no live session" is something the producer has to read
     * rather than a lane that quietly went back to dry.
     */
    static open(ctx: AudioContext, bridge: LiveBridge | undefined, options: {
        path: string;
        sessionId?: string;
        sampleRate: number;
        params?: {
            index: number;
            value: number;
        }[];
        batch?: number;
    }): Promise<NativeLiveLink | null>;
    /** Push panel values into the running session; the plugin answers with its own. */
    setParams(params: {
        index: number;
        value: number;
    }[]): Promise<void>;
    /**
     * Close for good: the thread goes back to dry first, so the producer never
     * hears the moment the session was taken away.
     */
    close(): Promise<void>;
    askForStats(): void;
    private onMessage;
    private onReply;
}
export declare function ensureNativeLiveModule(ctx: BaseAudioContext): Promise<boolean>;
