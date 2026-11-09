import { type NativeLiveRow, type NativePreviewStatus, type NativeVstSlot } from './NativeVstInsert';
interface Props {
    trackName: string;
    /** The lane's plugins, in signal order. */
    chain: NativeVstSlot[];
    sampleRate: number;
    /** Whether the lane has a clip at all — without one there is nothing to process. */
    hasClip: boolean;
    busy: boolean;
    /** The chain's preview: the pass the engine holds for this lane, or null. */
    preview: NativePreviewStatus | null;
    /** Per-slot live state, by slot id. */
    liveStates?: Record<string, NativeLiveRow>;
    onChange: (next: NativeVstSlot[]) => void;
    onBounce: () => void;
    /** Ask for the pass again, after a plugin refused or faulted. */
    onPreviewRetry: () => void;
}
export default function NativeVstChain({ trackName, chain, sampleRate, hasClip, busy, preview, liveStates, onChange, onBounce, onPreviewRetry, }: Props): React.JSX.Element;
export {};
