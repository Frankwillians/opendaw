/** Snap a value to the nearest step inside `min`..`max`, keeping the step's decimals. */
export declare function clampToStep(value: number, min: number, max: number, step: number): number;
interface KnobProps {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    display: string;
    accent?: string;
    /** SVG edge in px; smaller sizes are used in the mixer strips. */
    size?: number;
    /** Optional tooltip override; defaults to a label + hint string. */
    title?: string;
    onInput: (next: number) => void;
}
export default function Knob({ label, value, min, max, step, display, accent, size, title, onInput, }: KnobProps): import("react").JSX.Element;
export {};
