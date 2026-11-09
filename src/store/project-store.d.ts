/**
 * Project Store - Full Implementation with IndexedDB/OPFS
 * Handles project persistence, audio buffer storage, undo/redo, and serialization
 */
import type { Project, Channel, Clip, Marker, ProjectStore, SelectionState, UIState, Point, AutomationTarget } from '../types/daw-types';
export declare class ProjectStoreImpl implements ProjectStore {
    private _project;
    private _selection;
    private _uiState;
    private _listeners;
    private _audioContext;
    setAudioContext(ctx: AudioContext): void;
    get project(): Project | null;
    get selection(): SelectionState;
    get uiState(): UIState;
    subscribe(listener: () => void): () => void;
    private notify;
    newProject(name?: string): Promise<void>;
    loadProject(file: File | string): Promise<void>;
    saveProject(): Promise<void>;
    saveProjectAs(file: File): Promise<void>;
    exportProject(): Promise<Blob>;
    importProject(blob: Blob): Promise<void>;
    private serializeProject;
    private deserializeProject;
    private deserializeTrack;
    private deserializeBus;
    private deserializeClip;
    private saveProjectToDB;
    storeAudioBuffer(buffer: AudioBuffer, name: string): Promise<string>;
    getAudioBuffer(bufferId: string): Promise<AudioBuffer | null>;
    deleteAudioBuffer(bufferId: string): Promise<void>;
    addTrack(track: Omit<Channel, 'id'>): string;
    removeTrack(trackId: string): void;
    duplicateTrack(trackId: string): string;
    moveTrack(trackId: string, newIndex: number): void;
    updateTrack(trackId: string, updates: Partial<Channel>): void;
    addClip(trackId: string, clip: Omit<Clip, 'id'>): string;
    removeClip(trackId: string, clipId: string): void;
    updateClip(trackId: string, clipId: string, updates: Partial<Clip>): void;
    splitClip(trackId: string, clipId: string, beat: number): [string, string];
    addAutomationPoint(trackId: string, target: AutomationTarget, point: Point): void;
    removeAutomationPoint(trackId: string, target: AutomationTarget, pointIndex: number): void;
    setAutomationPoints(trackId: string, target: AutomationTarget, points: Point[]): void;
    setTempoAt(beat: number, bpm: number, shape?: 'step' | 'ramp'): void;
    setTimeSigAt(beat: number, numerator: number, denominator: number): void;
    addMarker(marker: Omit<Marker, 'id'>): string;
    removeMarker(markerId: string): void;
    updateMarker(markerId: string, updates: Partial<Marker>): void;
    private recordUndo;
    undo(): void;
    redo(): void;
    canUndo(): boolean;
    canRedo(): boolean;
    private applyAction;
    private applyInverse;
    setSelection(selection: SelectionState): void;
    setUIState(state: Partial<UIState>): void;
}
export declare const projectStore: ProjectStoreImpl;
export default projectStore;
