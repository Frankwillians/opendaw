import type { NativeVstSlot } from './NativeVstInsert';
/** Where a face is between the press and the plugin's own window. */
export type FacePhase = 'pending' | 'open';
export interface NativeFace {
    /** The row this face belongs to — also the id its live session uses. */
    key: string;
    path: string;
    name: string;
    phase: FacePhase;
    width: number;
    height: number;
    /** Values the plugin moved itself, read back while its window is up. */
    values: {
        id: number;
        value: number;
    }[];
}
/**
 * A row's identity for everything outside React: its own session in the plugin
 * process, its window, the saved project. A chain from before rows had ids is
 * addressed by its file, exactly like the older host was.
 */
export declare const faceKeyOf: (slot: NativeVstSlot) => string;
export declare function useNativeFaces(): {
    faces: NativeFace[];
    /** Ask for a row's interface. The plugin's own answer decides what happens. */
    open: (slot: NativeVstSlot) => void;
    /** Put one away, plugin included: a face the producer closed is closed. */
    close: (key: string) => void;
    /** One press to open, the next to put away — the row's knob button. */
    toggle: (slot: NativeVstSlot) => void;
    isOpen: (key: string) => boolean;
    /** A row's face, when it has one up. */
    face: (key: string) => NativeFace | null;
    /** The plugin's own refusal about a row, for the panel to read out. */
    errorOf: (key: string) => string;
    /** Report what the plugin answered about its window. */
    report: (key: string, patch: Partial<NativeFace>) => void;
    /** The window is gone and this is why: a refusal, or a process that fell over. */
    refuse: (key: string, message: string) => void;
    /** Every row that lost its window, so a chain can put those rows' faces away. */
    closeAll: () => void;
};
interface StackProps {
    faces: NativeFace[];
    /** The FX window element the panes are laid out in, or null to draw inline. */
    host: HTMLElement | null;
    sampleRate: number;
    onClose: (key: string) => void;
    report: (key: string, patch: Partial<NativeFace>) => void;
    refuse: (key: string, message: string) => void;
}
/**
 * Every open face of this lane, in one column next to the chain. The stack is
 * rendered inside the FX window element — wherever that is — because the plugin's
 * window is placed by the rectangle the page measures, and a pane squeezed between
 * knobs would give the interface a box it cannot fit in.
 */
export default function NativeVstFaces({ faces, host, sampleRate, onClose, report, refuse, }: StackProps): React.JSX.Element | null;
export {};
