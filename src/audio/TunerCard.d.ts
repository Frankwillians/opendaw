import type { AudioEngine, BuiltinFxParams, BuiltinFxUnit } from './audio-engine';
interface TunerCardProps {
    unit: BuiltinFxUnit;
    engine: AudioEngine | null;
    /** Where the analyser comes from: a track lane, an aux bus or the master. */
    scope?: 'track' | 'aux' | 'master';
    trackId?: string;
    auxId?: string;
    onParamChange: (key: keyof BuiltinFxParams, value: number) => void;
}
export default function TunerCard({ unit, engine, scope, trackId, auxId, onParamChange, }: TunerCardProps): React.JSX.Element;
export {};
