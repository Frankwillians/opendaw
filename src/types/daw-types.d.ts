/**
 * DAW Data Types - Complete Project Structure
 * Supports audio/MIDI clips, automation, buses, tempo map, and full project serialization
 */
export type ClipType = 'audio' | 'midi';
export type AutomationTarget = 'volume' | 'pan' | 'mute' | 'solo' | `fx:${string}:${string}` | `plugin:${string}:${string}`;
export interface Point {
    x: number;
    y: number;
    shape?: 'linear' | 'bezier' | 'step' | 'hold';
    tension?: number;
}
export interface BaseClip {
    id: string;
    type: ClipType;
    name: string;
    color: string;
    startBeat: number;
    durationBeats: number;
    gain: number;
    muted: boolean;
    solo: boolean;
    locked: boolean;
    fadeIn: number;
    fadeOut: number;
    loopEnabled: boolean;
    loopStart: number;
    loopEnd: number;
    reverse: boolean;
    timeStretch: number;
    pitchShift: number;
}
export interface AudioClip extends BaseClip {
    type: 'audio';
    audioBufferId: string;
    waveformPeaks: number[];
    channels: 1 | 2;
    sampleRate: number;
    originalDuration: number;
}
export interface MidiClip extends BaseClip {
    type: 'midi';
    notes: MidiNote[];
    controllerData: Map<string, ControllerEvent[]>;
    programChange?: number;
    channel: number;
}
export interface MidiNote {
    id: string;
    pitch: number;
    velocity: number;
    startBeat: number;
    durationBeats: number;
    channel: number;
    muted: boolean;
}
export interface ControllerEvent {
    beat: number;
    value: number;
}
export type Clip = AudioClip | MidiClip;
export declare function isAudioClip(clip: Clip): clip is AudioClip;
export declare function isMidiClip(clip: Clip): clip is MidiClip;
export interface TrackFxState {
    enabled: boolean;
    params: Record<string, number>;
}
export interface TrackPlugin {
    id: string;
    name: string;
    kind: 'ir' | 'worklet' | 'nam';
    enabled: boolean;
    params: Record<string, number>;
    irBufferId?: string;
    workletSource?: string;
    processorName?: string;
    namJson?: string;
    namSlim?: number;
}
export interface TrackSend {
    id: string;
    targetBusId: string;
    level: number;
    pan: number;
    preFader: boolean;
    enabled: boolean;
}
export interface TrackAutomation {
    target: AutomationTarget;
    points: Point[];
    visible: boolean;
    color: string;
}
export interface Channel {
    id: string;
    name: string;
    color: string;
    type: 'audio' | 'midi' | 'bus' | 'master';
    muted: boolean;
    solo: boolean;
    soloSafe: boolean;
    armForRecord: boolean;
    inputMonitor: boolean;
    volume: number;
    pan: number;
    width: number;
    clips: Clip[];
    fxChain: TrackPlugin[];
    fxRack: Record<string, TrackFxState>;
    sends: TrackSend[];
    automation: TrackAutomation[];
    inputDeviceId?: string;
    outputBusId: string;
    midiInputId?: string;
    midiChannel?: number;
    height: number;
    minimized: boolean;
    folderTrackId?: string;
    isFolder: boolean;
    folderExpanded: boolean;
}
export interface Bus {
    id: string;
    name: string;
    color: string;
    type: 'aux' | 'group' | 'vca' | 'master';
    volume: number;
    pan: number;
    muted: boolean;
    solo: boolean;
    fxChain: TrackPlugin[];
    fxRack: Record<string, TrackFxState>;
    sends: TrackSend[];
    inputChannelIds: string[];
    automation: TrackAutomation[];
}
export interface TempoPoint {
    beat: number;
    bpm: number;
    shape: 'step' | 'ramp';
}
export interface TimeSigPoint {
    beat: number;
    numerator: number;
    denominator: number;
}
export interface Marker {
    id: string;
    name: string;
    beat: number;
    color: string;
    isRegion: boolean;
    regionEndBeat?: number;
    locked: boolean;
    annotation?: string;
}
export interface ProjectMetadata {
    sampleRate: number;
    bitDepth: 16 | 24 | 32;
    format: 'wav' | 'flac' | 'ogg';
    version: number;
    created: number;
    modified: number;
    author?: string;
    description?: string;
    tags?: string[];
}
export interface ProjectSettings {
    masterVolume: number;
    masterMuted: boolean;
    loopEnabled: boolean;
    loopStartBeat: number;
    loopEndBeat: number;
    metronomeEnabled: boolean;
    metronomeSound: 'click' | 'beep' | 'wood' | 'custom';
    metronomeVolume: number;
    countInBars: number;
    recordFileFormat: 'wav' | 'flac';
    recordBitDepth: 16 | 24 | 32;
    autoCreateTakeFolders: boolean;
    snapEnabled: boolean;
    snapDivision: number;
    theme: 'dark' | 'light' | 'auto';
    showWaveforms: boolean;
    showMidiNotes: boolean;
    rulerFormat: 'beats' | 'time' | 'samples' | 'timecode';
}
export interface AudioBufferRef {
    id: string;
    name: string;
    duration: number;
    sampleRate: number;
    channels: number;
    peaks: number[];
}
export interface Project {
    id: string;
    name: string;
    metadata: ProjectMetadata;
    settings: ProjectSettings;
    tracks: Channel[];
    buses: Bus[];
    tempoMap: TempoPoint[];
    timeSigMap: TimeSigPoint[];
    markers: Marker[];
    audioBuffers: AudioBufferRef[];
    undoHistory: UndoAction[];
    undoIndex: number;
}
export interface UndoAction {
    id: string;
    type: string;
    timestamp: number;
    description: string;
    data: unknown;
    inverseData?: unknown;
}
export interface ProjectStore {
    project: Project | null;
    newProject: (name?: string, template?: string) => Promise<void>;
    loadProject: (file: File | string) => Promise<void>;
    saveProject: (path?: string) => Promise<void>;
    saveProjectAs: (file: File) => Promise<void>;
    exportProject: () => Promise<Blob>;
    importProject: (blob: Blob) => Promise<void>;
    addTrack: (track: Omit<Channel, 'id'>) => string;
    removeTrack: (trackId: string) => void;
    duplicateTrack: (trackId: string) => string;
    moveTrack: (trackId: string, newIndex: number) => void;
    updateTrack: (trackId: string, updates: Partial<Channel>) => void;
    addClip: (trackId: string, clip: Omit<Clip, 'id'>) => string;
    removeClip: (trackId: string, clipId: string) => void;
    updateClip: (trackId: string, clipId: string, updates: Partial<Clip>) => void;
    splitClip: (trackId: string, clipId: string, beat: number) => [string, string];
    addAutomationPoint: (trackId: string, target: AutomationTarget, point: Point) => void;
    removeAutomationPoint: (trackId: string, target: AutomationTarget, pointIndex: number) => void;
    setAutomationPoints: (trackId: string, target: AutomationTarget, points: Point[]) => void;
    setTempoAt: (beat: number, bpm: number, shape?: 'step' | 'ramp') => void;
    setTimeSigAt: (beat: number, numerator: number, denominator: number) => void;
    addMarker: (marker: Omit<Marker, 'id'>) => string;
    removeMarker: (markerId: string) => void;
    updateMarker: (markerId: string, updates: Partial<Marker>) => void;
    storeAudioBuffer: (buffer: AudioBuffer, name: string) => Promise<string>;
    getAudioBuffer: (bufferId: string) => Promise<AudioBuffer | null>;
    deleteAudioBuffer: (bufferId: string) => Promise<void>;
    undo: () => void;
    redo: () => void;
    canUndo: () => boolean;
    canRedo: () => boolean;
    selection: SelectionState;
    setSelection: (selection: SelectionState) => void;
    uiState: UIState;
    setUIState: (state: Partial<UIState>) => void;
}
export interface SelectionState {
    tracks: string[];
    clips: string[];
    automationPoints: string[];
    timeRange?: {
        startBeat: number;
        endBeat: number;
    };
}
export interface UIState {
    zoomLevel: number;
    scrollX: number;
    scrollY: number;
    showMixer: boolean;
    showBrowser: boolean;
    showInspector: boolean;
    showAutomation: boolean;
    activeTab: 'arrangement' | 'mixer' | 'browser' | 'inspector';
    trackHeights: Record<string, number>;
    playheadBeat: number;
    loopStartBeat: number;
    loopEndBeat: number;
}
