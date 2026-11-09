export interface NativeVstSlot {
    /**
     * Which slot this is, for as long as it stays in the lane: the chain reorders,
     * bypasses and re-knobs these rows, and a live session has to belong to one of
     * them rather than to a position that moves under it. Two copies of the same
     * .dll are two slots with two ids, the way REAPER counts them.
     */
    id?: string;
    /** Full path of the .dll or of the .vst3 bundle on this machine. */
    path: string;
    /** Name read from the plugin, for the clip label and the header. */
    name: string;
    /** 0..1 values. `index` is a VST2 slot number or a VST3 parameter id. */
    params: {
        index: number;
        value: number;
    }[];
    /** Switched off: the slot stays with its values but does not touch the clip. */
    bypass?: boolean;
}
/**
 * What the app reports about one lane's preview — the pass the plugin process
 * rendered from the clip, which is what plays and what the export writes while it
 * stands in the lane. `error` is the plugin's own answer, kept so the producer
 * can read it and try again instead of wondering why the lane is dry.
 */
export interface NativePreviewStatus {
    state: 'busy' | 'on' | 'error';
    name: string;
    peak: number;
    error: string;
}
/**
 * What the app knows about one slot's live session, in the lane's live signal.
 * Named because the chain lists it per row: the lane's monitor hears the whole
 * chain, and each plugin answers for itself.
 */
export interface NativeLiveRow {
    name: string;
    latencyMs: number;
    batches: number;
    answered: number;
    underruns: number;
    error: string;
}
interface Props {
    trackName: string;
    slot: NativeVstSlot | null;
    /** The project rate: a plugin is asked to describe itself at the rate it will run at. */
    sampleRate: number;
    /**
     * Replace, edit or clear this slot. Null is the lane letting go of it; the
     * chain decides whether that means removing a row.
     */
    onChange: (next: NativeVstSlot | null) => void;
    /**
     * What the lane's live session is doing, or null when the plugin is not in the
     * live signal at all — no clip lane, the monitor off, a bypassed slot, or a
     * .vst3, which this host has no session for yet.
     */
    liveState?: NativeLiveRow | null;
    /**
     * Whether this block is one row of a longer chain, and which row. The picker,
     * the knobs and the plugin's window are the same work either way; what the
     * producer must never lose is the sense of where in the series they are.
     */
    chainHint?: string;
    /**
     * This row's plugin window, held by the chain: a lane can have several faces up
     * at once, and the window belongs to the row rather than to whichever row this
     * panel happens to be editing.
     */
    faceOpen?: boolean;
    /** True while the plugin is still building its toolkit. */
    facePending?: boolean;
    /** The plugin's own refusal, when the last press did not end in a window. */
    faceError?: string;
    /** `{width}×{height}` of the open window, or '' before the plugin answers. */
    faceSize?: string;
    /** Values the plugin moved inside its own window, for these sliders to follow. */
    pluginValues?: {
        id: number;
        value: number;
    }[];
    /** Tell the chain what the plugin answered about its own values. */
    onPluginValues?: (values: {
        id: number;
        value: number;
    }[]) => void;
    /** Open this row's interface, or put it away if it is up. */
    onToggleFace?: () => void;
}
export default function NativeVstInsert({ trackName, slot, sampleRate, onChange, liveState, chainHint, faceOpen, facePending, faceError, faceSize, pluginValues, onPluginValues, onToggleFace, }: Props): React.JSX.Element;
export {};
