import './App.css';
/** The names the Devices window offers, matching REAPER's own vocabulary. */
export type AudioSystemId = 'wasapi' | 'wasapi-exclusive' | 'waveout' | 'dummy' | 'asio' | 'directsound';
export type AudioLatencyProfile = 'interactive' | 'balanced' | 'playback';
export interface AudioSystemOption {
    id: AudioSystemId;
    name: string;
    hint: string;
    /** True when only the Windows executable can ask Chromium for it. */
    nativeOnly?: boolean;
    /** Why the platform cannot offer it at all; absent means it can. */
    reason?: string;
}
export interface AudioSettings {
    system: AudioSystemId;
    sampleRate: number;
    bufferSize: number;
    /** PortAudio index of the chosen ASIO output; -1 lets the driver pick its default. */
    asioDevice: number;
    /** PortAudio index of the chosen ASIO input; -1 lets the driver pick its default. */
    asioInputDevice: number;
    /** Number of input channels to open on the ASIO device. */
    asioInputChannels: number;
}
export default function App(): import("react").JSX.Element;
