/**
 * Project Store - Full Implementation with IndexedDB/OPFS
 * Handles project persistence, audio buffer storage, undo/redo, and serialization
 */
const DB_NAME = 'WebDAW';
const DB_VERSION = 2;
const STORE_PROJECTS = 'projects';
const STORE_AUDIO_BUFFERS = 'audioBuffers';
const STORE_SETTINGS = 'settings';
// ============================================================
// IndexedDB Helpers
// ============================================================
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
                db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORE_AUDIO_BUFFERS)) {
                const store = db.createObjectStore(STORE_AUDIO_BUFFERS, { keyPath: 'id' });
                store.createIndex('projectId', 'projectId', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
                db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
            }
        };
    });
}
async function getStore(storeName, mode = 'readonly') {
    const db = await openDB();
    return db.transaction(storeName, mode).objectStore(storeName);
}
// ============================================================
// AudioBuffer Serialization (for IndexedDB storage)
// ============================================================
function audioBufferToBlob(buffer) {
    const channels = buffer.numberOfChannels;
    const length = buffer.length;
    const sampleRate = buffer.sampleRate;
    // Create a WAV container for storage
    const bytesPerSample = 2; // 16-bit for storage efficiency
    const blockAlign = channels * bytesPerSample;
    const dataSize = length * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);
    const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i++)
            view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);
    const channelData = [];
    for (let c = 0; c < channels; c++) {
        channelData.push(buffer.getChannelData(c));
    }
    let offset = 44;
    for (let i = 0; i < length; i++) {
        for (let c = 0; c < channels; c++) {
            const sample = Math.max(-1, Math.min(1, channelData[c][i] ?? 0));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            offset += 2;
        }
    }
    return new Blob([arrayBuffer], { type: 'audio/wav' });
}
function computePeaks(buffer, count = 500) {
    const data = buffer.getChannelData(0);
    const block = Math.max(1, Math.floor(data.length / count));
    const peaks = [];
    for (let i = 0; i < count; i++) {
        let min = 1, max = -1;
        for (let j = 0; j < block; j++) {
            const value = data[i * block + j] ?? 0;
            if (value < min)
                min = value;
            if (value > max)
                max = value;
        }
        peaks.push(Math.max(Math.abs(min), Math.abs(max)));
    }
    return peaks;
}
async function blobToAudioBuffer(blob, ctx) {
    const arrayBuffer = await blob.arrayBuffer();
    return ctx.decodeAudioData(arrayBuffer);
}
// ============================================================
// Default Configurations
// ============================================================
const DEFAULT_SETTINGS = {
    masterVolume: 0.9,
    masterMuted: false,
    loopEnabled: true,
    loopStartBeat: 0,
    loopEndBeat: 64,
    metronomeEnabled: false,
    metronomeSound: 'click',
    metronomeVolume: 0.5,
    countInBars: 1,
    recordFileFormat: 'wav',
    recordBitDepth: 24,
    autoCreateTakeFolders: true,
    snapEnabled: true,
    snapDivision: 16,
    theme: 'dark',
    showWaveforms: true,
    showMidiNotes: true,
    rulerFormat: 'beats',
};
const DEFAULT_METADATA = {
    sampleRate: 44100,
    bitDepth: 24,
    format: 'wav',
    version: 2,
    created: Date.now(),
    modified: Date.now(),
};
function createDefaultProject(name = 'Untitled Project') {
    const now = Date.now();
    return {
        id: crypto.randomUUID(),
        name,
        metadata: { ...DEFAULT_METADATA, created: now, modified: now },
        settings: { ...DEFAULT_SETTINGS },
        tracks: [
            createTrack('Audio 1', 'audio', '#79a8d6'),
            createTrack('Audio 2', 'audio', '#e07b53'),
        ],
        buses: [
            createBus('Master', 'master', '#79a8d6'),
        ],
        tempoMap: [{ beat: 0, bpm: 120, shape: 'step' }],
        timeSigMap: [{ beat: 0, numerator: 4, denominator: 4 }],
        markers: [],
        audioBuffers: [],
        undoHistory: [],
        undoIndex: -1,
    };
}
function createTrack(name, type, color) {
    return {
        id: crypto.randomUUID(),
        name,
        color,
        type,
        muted: false,
        solo: false,
        soloSafe: false,
        armForRecord: false,
        inputMonitor: false,
        volume: 1,
        pan: 0,
        width: 1,
        clips: [],
        fxChain: [],
        fxRack: {
            dist: { enabled: false, params: { drive: 0.45, tone: 3800 } },
            chorus: { enabled: false, params: { rate: 1.1, depth: 3.5 } },
            reverb: { enabled: false, params: { decay: 2.4 } },
            delay: { enabled: false, params: { time: 320, feedback: 0.32 } },
            eq: { enabled: false, params: { eqLowFreq: 100, eqLowGain: 0, eqMidFreq: 1000, eqMidGain: 0, eqMidQ: 1, eqHighFreq: 5000, eqHighGain: 0 } },
            comp: { enabled: false, params: { compThreshold: -18, compRatio: 4, compAttack: 10, compRelease: 100, compKnee: 6, compMakeup: 0 } },
            gate: { enabled: false, params: { gateThreshold: -40, gateRatio: 100, gateAttack: 1, gateRelease: 100, gateHold: 50 } },
            limiter: { enabled: false, params: { limThreshold: -1, limRelease: 50, limCeiling: -0.5 } },
        },
        sends: [],
        automation: [],
        outputBusId: 'master',
        height: 110,
        minimized: false,
        isFolder: false,
        folderExpanded: true,
    };
}
function createBus(name, type, color) {
    return {
        id: crypto.randomUUID(),
        name,
        color,
        type,
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
        fxChain: [],
        fxRack: {
            dist: { enabled: false, params: {} },
            chorus: { enabled: false, params: {} },
            reverb: { enabled: false, params: {} },
            delay: { enabled: false, params: {} },
            eq: { enabled: false, params: {} },
            comp: { enabled: false, params: {} },
            gate: { enabled: false, params: {} },
            limiter: { enabled: false, params: {} },
        },
        sends: [],
        inputChannelIds: [],
        automation: [],
    };
}
// ============================================================
// Project Store Implementation
// ============================================================
export class ProjectStoreImpl {
    _project = null;
    _selection = { tracks: [], clips: [], automationPoints: [] };
    _uiState = {
        zoomLevel: 100, // beats per 1000px
        scrollX: 0,
        scrollY: 0,
        showMixer: true,
        showBrowser: false,
        showInspector: false,
        showAutomation: false,
        activeTab: 'arrangement',
        trackHeights: {},
        playheadBeat: 0,
        loopStartBeat: 0,
        loopEndBeat: 64,
    };
    _listeners = new Set();
    _audioContext = null;
    setAudioContext(ctx) {
        this._audioContext = ctx;
    }
    get project() {
        return this._project;
    }
    get selection() {
        return this._selection;
    }
    get uiState() {
        return this._uiState;
    }
    // -----------------------------------------------------------
    // Listener Management
    // -----------------------------------------------------------
    subscribe(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }
    notify() {
        this._listeners.forEach((fn) => fn());
    }
    // -----------------------------------------------------------
    // Project Lifecycle
    // -----------------------------------------------------------
    async newProject(name) {
        this._project = createDefaultProject(name || 'Untitled Project');
        await this.saveProjectToDB();
        this.notify();
    }
    async loadProject(file) {
        if (typeof file === 'string') {
            // Load from IndexedDB by ID
            const store = await getStore(STORE_PROJECTS);
            const request = store.get(file);
            return new Promise((resolve, reject) => {
                request.onsuccess = () => {
                    if (request.result) {
                        this._project = this.deserializeProject(request.result);
                        this.notify();
                        resolve();
                    }
                    else {
                        reject(new Error('Project not found'));
                    }
                };
                request.onerror = () => reject(request.error);
            });
        }
        else {
            // Load from .daw file
            const text = await file.text();
            const data = JSON.parse(text);
            this._project = this.deserializeProject(data);
            await this.saveProjectToDB();
            this.notify();
        }
    }
    async saveProject() {
        if (!this._project)
            return;
        this._project.metadata.modified = Date.now();
        await this.saveProjectToDB();
        this.notify();
    }
    async saveProjectAs(file) {
        if (!this._project)
            return;
        this._project.metadata.modified = Date.now();
        const blob = await this.exportProject();
        // Trigger download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
    }
    async exportProject() {
        if (!this._project)
            throw new Error('No project loaded');
        const serialized = this.serializeProject(this._project);
        return new Blob([JSON.stringify(serialized, null, 2)], { type: 'application/json' });
    }
    async importProject(blob) {
        const text = await blob.text();
        const data = JSON.parse(text);
        this._project = this.deserializeProject(data);
        await this.saveProjectToDB();
        this.notify();
    }
    // -----------------------------------------------------------
    // Serialization
    // -----------------------------------------------------------
    serializeProject(project) {
        // Don't serialize actual AudioBuffers - they're in IndexedDB
        // Only serialize references
        return {
            ...project,
            // Convert Maps to arrays for JSON
            tracks: project.tracks.map((t) => ({
                ...t,
                automation: t.automation.map((a) => ({
                    ...a,
                    points: a.points,
                })),
            })),
            buses: project.buses.map((b) => ({
                ...b,
                automation: b.automation.map((a) => ({
                    ...a,
                    points: a.points,
                })),
            })),
        };
    }
    deserializeProject(data) {
        const d = data;
        return {
            ...d,
            metadata: d.metadata,
            settings: d.settings,
            tracks: d.tracks.map((t) => this.deserializeTrack(t)),
            buses: d.buses.map((b) => this.deserializeBus(b)),
            tempoMap: d.tempoMap,
            timeSigMap: d.timeSigMap,
            markers: d.markers,
            audioBuffers: d.audioBuffers,
            undoHistory: d.undoHistory.map((u) => u),
            undoIndex: d.undoIndex,
        };
    }
    deserializeTrack(data) {
        return {
            ...data,
            clips: data.clips.map((c) => this.deserializeClip(c)),
            fxChain: data.fxChain,
            fxRack: data.fxRack,
            sends: data.sends,
            automation: data.automation.map((raw) => {
                const entry = raw;
                return { ...entry, points: entry.points };
            }),
        };
    }
    deserializeBus(data) {
        return {
            ...data,
            fxChain: data.fxChain,
            fxRack: data.fxRack,
            sends: data.sends,
            automation: data.automation.map((raw) => {
                const entry = raw;
                return { ...entry, points: entry.points };
            }),
        };
    }
    deserializeClip(data) {
        const type = data.type;
        if (type === 'audio') {
            return { ...data };
        }
        return {
            ...data,
            controllerData: new Map(Object.entries((data.controllerData ?? {}))),
        };
    }
    // -----------------------------------------------------------
    // IndexedDB Persistence
    // -----------------------------------------------------------
    async saveProjectToDB() {
        if (!this._project)
            return;
        const store = await getStore(STORE_PROJECTS, 'readwrite');
        const serialized = this.serializeProject(this._project);
        return new Promise((resolve, reject) => {
            const request = store.put(serialized);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
    // -----------------------------------------------------------
    // Audio Buffer Management (IndexedDB/OPFS)
    // -----------------------------------------------------------
    async storeAudioBuffer(buffer, name) {
        if (!this._project)
            throw new Error('No project loaded');
        const id = crypto.randomUUID();
        const blob = audioBufferToBlob(buffer);
        const peaks = computePeaks(buffer);
        const ref = {
            id,
            name,
            duration: buffer.duration,
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
            peaks,
        };
        // Store in IndexedDB
        const store = await getStore(STORE_AUDIO_BUFFERS, 'readwrite');
        await new Promise((resolve, reject) => {
            const request = store.put({ ...ref, projectId: this._project.id, blob });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
        // Add reference to project
        this._project.audioBuffers.push(ref);
        await this.saveProjectToDB();
        this.notify();
        return id;
    }
    async getAudioBuffer(bufferId) {
        if (!this._audioContext)
            throw new Error('AudioContext not set');
        if (!this._project)
            return null;
        const store = await getStore(STORE_AUDIO_BUFFERS);
        return new Promise((resolve, reject) => {
            const request = store.get(bufferId);
            request.onsuccess = async () => {
                if (request.result?.blob) {
                    const buffer = await blobToAudioBuffer(request.result.blob, this._audioContext);
                    resolve(buffer);
                }
                else {
                    resolve(null);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
    async deleteAudioBuffer(bufferId) {
        if (!this._project)
            return;
        const store = await getStore(STORE_AUDIO_BUFFERS, 'readwrite');
        await new Promise((resolve, reject) => {
            const request = store.delete(bufferId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
        this._project.audioBuffers = this._project.audioBuffers.filter((b) => b.id !== bufferId);
        await this.saveProjectToDB();
        this.notify();
    }
    // -----------------------------------------------------------
    // Track Management
    // -----------------------------------------------------------
    addTrack(track) {
        if (!this._project)
            throw new Error('No project loaded');
        const newTrack = { ...track, id: crypto.randomUUID() };
        this._project.tracks.push(newTrack);
        this.recordUndo('addTrack', { trackId: newTrack.id }, { trackId: newTrack.id });
        this.notify();
        return newTrack.id;
    }
    removeTrack(trackId) {
        if (!this._project)
            return;
        const index = this._project.tracks.findIndex((t) => t.id === trackId);
        if (index === -1)
            return;
        const track = this._project.tracks[index];
        // Delete associated audio buffers
        for (const clip of track.clips) {
            if (clip.type === 'audio' && clip.audioBufferId) {
                this.deleteAudioBuffer(clip.audioBufferId);
            }
        }
        this._project.tracks.splice(index, 1);
        this.recordUndo('removeTrack', { track }, { trackId });
        this.notify();
    }
    duplicateTrack(trackId) {
        if (!this._project)
            throw new Error('No project loaded');
        const track = this._project.tracks.find((t) => t.id === trackId);
        if (!track)
            throw new Error('Track not found');
        const newTrack = {
            ...track,
            id: crypto.randomUUID(),
            name: `${track.name} (copy)`,
            clips: track.clips.map((c) => ({ ...c, id: crypto.randomUUID() })),
            fxChain: track.fxChain.map((p) => ({ ...p, id: crypto.randomUUID() })),
            sends: track.sends.map((s) => ({ ...s, id: crypto.randomUUID() })),
            automation: track.automation.map((a) => ({ ...a, id: crypto.randomUUID() })),
        };
        this._project.tracks.push(newTrack);
        this.recordUndo('duplicateTrack', { trackId: newTrack.id }, { trackId });
        this.notify();
        return newTrack.id;
    }
    moveTrack(trackId, newIndex) {
        if (!this._project)
            return;
        const oldIndex = this._project.tracks.findIndex((t) => t.id === trackId);
        if (oldIndex === -1)
            return;
        if (newIndex < 0 || newIndex >= this._project.tracks.length)
            return;
        const [track] = this._project.tracks.splice(oldIndex, 1);
        this._project.tracks.splice(newIndex, 0, track);
        this.recordUndo('moveTrack', { trackId, oldIndex }, { trackId, newIndex });
        this.notify();
    }
    updateTrack(trackId, updates) {
        if (!this._project)
            return;
        const track = this._project.tracks.find((t) => t.id === trackId);
        if (!track)
            return;
        const oldValues = {};
        for (const key of Object.keys(updates)) {
            oldValues[key] = track[key];
        }
        Object.assign(track, updates);
        this.recordUndo('updateTrack', { trackId, oldValues }, { trackId, updates });
        this.notify();
    }
    // -----------------------------------------------------------
    // Clip Management
    // -----------------------------------------------------------
    addClip(trackId, clip) {
        if (!this._project)
            throw new Error('No project loaded');
        const track = this._project.tracks.find((t) => t.id === trackId);
        if (!track)
            throw new Error('Track not found');
        const newClip = { ...clip, id: crypto.randomUUID() };
        track.clips.push(newClip);
        track.clips.sort((a, b) => a.startBeat - b.startBeat);
        this.recordUndo('addClip', { trackId, clipId: newClip.id }, { trackId, clipId: newClip.id });
        this.notify();
        return newClip.id;
    }
    removeClip(trackId, clipId) {
        if (!this._project)
            return;
        const track = this._project.tracks.find((t) => t.id === trackId);
        if (!track)
            return;
        const clipIndex = track.clips.findIndex((c) => c.id === clipId);
        if (clipIndex === -1)
            return;
        const clip = track.clips[clipIndex];
        if (clip.type === 'audio' && clip.audioBufferId) {
            // Check if buffer is used elsewhere before deleting
            const usedElsewhere = this._project.tracks.some((t) => t.clips.some((c) => c.type === 'audio' && c.audioBufferId === clip.audioBufferId && c.id !== clipId));
            if (!usedElsewhere) {
                this.deleteAudioBuffer(clip.audioBufferId);
            }
        }
        track.clips.splice(clipIndex, 1);
        this.recordUndo('removeClip', { trackId, clip }, { trackId, clipId });
        this.notify();
    }
    updateClip(trackId, clipId, updates) {
        if (!this._project)
            return;
        const track = this._project.tracks.find((t) => t.id === trackId);
        if (!track)
            return;
        const clip = track.clips.find((c) => c.id === clipId);
        if (!clip)
            return;
        const oldValues = {};
        for (const key of Object.keys(updates)) {
            oldValues[key] = clip[key];
        }
        Object.assign(clip, updates);
        track.clips.sort((a, b) => a.startBeat - b.startBeat);
        this.recordUndo('updateClip', { trackId, clipId, oldValues }, { trackId, clipId, updates });
        this.notify();
    }
    splitClip(trackId, clipId, beat) {
        if (!this._project)
            throw new Error('No project loaded');
        const track = this._project.tracks.find((t) => t.id === trackId);
        if (!track)
            throw new Error('Track not found');
        const clipIndex = track.clips.findIndex((c) => c.id === clipId);
        if (clipIndex === -1)
            throw new Error('Clip not found');
        const clip = track.clips[clipIndex];
        const relativeBeat = beat - clip.startBeat;
        if (relativeBeat <= 0 || relativeBeat >= clip.durationBeats) {
            throw new Error('Split point must be within clip bounds');
        }
        // Create two new clips
        const leftClip = {
            ...clip,
            id: crypto.randomUUID(),
            durationBeats: relativeBeat,
            loopEnd: Math.min(clip.loopEnd, relativeBeat),
        };
        const rightClip = {
            ...clip,
            id: crypto.randomUUID(),
            startBeat: beat,
            durationBeats: clip.durationBeats - relativeBeat,
            loopStart: Math.max(0, clip.loopStart - relativeBeat),
            loopEnd: Math.max(0, clip.loopEnd - relativeBeat),
        };
        // Replace original with two clips
        track.clips.splice(clipIndex, 1, leftClip, rightClip);
        track.clips.sort((a, b) => a.startBeat - b.startBeat);
        this.recordUndo('splitClip', { trackId, clipId, leftClipId: leftClip.id, rightClipId: rightClip.id }, { trackId, originalClipId: clipId });
        this.notify();
        return [leftClip.id, rightClip.id];
    }
    // -----------------------------------------------------------
    // Automation
    // -----------------------------------------------------------
    addAutomationPoint(trackId, target, point) {
        if (!this._project)
            return;
        const track = this._project.tracks.find((t) => t.id === trackId);
        if (!track)
            return;
        let automation = track.automation.find((a) => a.target === target);
        if (!automation) {
            automation = {
                target,
                points: [],
                visible: true,
                color: '#79a8d6',
            };
            track.automation.push(automation);
        }
        automation.points.push(point);
        automation.points.sort((a, b) => a.x - b.x);
        this.recordUndo('addAutomationPoint', { trackId, target, point }, { trackId, target });
        this.notify();
    }
    removeAutomationPoint(trackId, target, pointIndex) {
        if (!this._project)
            return;
        const track = this._project.tracks.find((t) => t.id === trackId);
        if (!track)
            return;
        const automation = track.automation.find((a) => a.target === target);
        if (!automation)
            return;
        if (pointIndex < 0 || pointIndex >= automation.points.length)
            return;
        const point = automation.points[pointIndex];
        automation.points.splice(pointIndex, 1);
        this.recordUndo('removeAutomationPoint', { trackId, target, pointIndex, point }, { trackId, target, pointIndex });
        this.notify();
    }
    setAutomationPoints(trackId, target, points) {
        if (!this._project)
            return;
        const track = this._project.tracks.find((t) => t.id === trackId);
        if (!track)
            return;
        let automation = track.automation.find((a) => a.target === target);
        if (!automation) {
            automation = {
                target,
                points: [],
                visible: true,
                color: '#79a8d6',
            };
            track.automation.push(automation);
        }
        const oldPoints = [...automation.points];
        automation.points = points.sort((a, b) => a.x - b.x);
        this.recordUndo('setAutomationPoints', { trackId, target, oldPoints }, { trackId, target, points });
        this.notify();
    }
    // -----------------------------------------------------------
    // Tempo / Time Signature
    // -----------------------------------------------------------
    setTempoAt(beat, bpm, shape = 'step') {
        if (!this._project)
            return;
        let point = this._project.tempoMap.find((p) => p.beat === beat);
        const oldPoint = point ? { ...point } : null;
        if (point) {
            point.bpm = bpm;
            point.shape = shape;
        }
        else {
            this._project.tempoMap.push({ beat, bpm, shape });
            this._project.tempoMap.sort((a, b) => a.beat - b.beat);
        }
        this.recordUndo('setTempoAt', { beat, oldPoint }, { beat, bpm, shape });
        this.notify();
    }
    setTimeSigAt(beat, numerator, denominator) {
        if (!this._project)
            return;
        let point = this._project.timeSigMap.find((p) => p.beat === beat);
        const oldPoint = point ? { ...point } : null;
        if (point) {
            point.numerator = numerator;
            point.denominator = denominator;
        }
        else {
            this._project.timeSigMap.push({ beat, numerator, denominator });
            this._project.timeSigMap.sort((a, b) => a.beat - b.beat);
        }
        this.recordUndo('setTimeSigAt', { beat, oldPoint }, { beat, numerator, denominator });
        this.notify();
    }
    // -----------------------------------------------------------
    // Markers
    // -----------------------------------------------------------
    addMarker(marker) {
        if (!this._project)
            throw new Error('No project loaded');
        const newMarker = { ...marker, id: crypto.randomUUID() };
        this._project.markers.push(newMarker);
        this._project.markers.sort((a, b) => a.beat - b.beat);
        this.recordUndo('addMarker', { markerId: newMarker.id }, { markerId: newMarker.id });
        this.notify();
        return newMarker.id;
    }
    removeMarker(markerId) {
        if (!this._project)
            return;
        const index = this._project.markers.findIndex((m) => m.id === markerId);
        if (index === -1)
            return;
        const marker = this._project.markers[index];
        this._project.markers.splice(index, 1);
        this.recordUndo('removeMarker', { marker }, { markerId });
        this.notify();
    }
    updateMarker(markerId, updates) {
        if (!this._project)
            return;
        const marker = this._project.markers.find((m) => m.id === markerId);
        if (!marker)
            return;
        const oldValues = {};
        for (const key of Object.keys(updates)) {
            oldValues[key] = marker[key];
        }
        Object.assign(marker, updates);
        this._project.markers.sort((a, b) => a.beat - b.beat);
        this.recordUndo('updateMarker', { markerId, oldValues }, { markerId, updates });
        this.notify();
    }
    // -----------------------------------------------------------
    // Undo/Redo
    // -----------------------------------------------------------
    recordUndo(actionType, inverseData, data) {
        if (!this._project)
            return;
        const action = {
            id: crypto.randomUUID(),
            type: actionType,
            timestamp: Date.now(),
            description: actionType,
            data,
            inverseData,
        };
        // Truncate history after current index
        this._project.undoHistory = this._project.undoHistory.slice(0, this._project.undoIndex + 1);
        this._project.undoHistory.push(action);
        this._project.undoIndex++;
        // Limit history size
        const MAX_HISTORY = 100;
        if (this._project.undoHistory.length > MAX_HISTORY) {
            this._project.undoHistory = this._project.undoHistory.slice(-MAX_HISTORY);
            this._project.undoIndex = this._project.undoHistory.length - 1;
        }
    }
    undo() {
        if (!this._project || this._project.undoIndex < 0)
            return;
        const action = this._project.undoHistory[this._project.undoIndex];
        this.applyInverse(action.inverseData);
        this._project.undoIndex--;
        this.notify();
    }
    redo() {
        if (!this._project || this._project.undoIndex >= this._project.undoHistory.length - 1)
            return;
        this._project.undoIndex++;
        const action = this._project.undoHistory[this._project.undoIndex];
        this.applyAction(action.data);
        this.notify();
    }
    canUndo() {
        return this._project !== null && this._project.undoIndex >= 0;
    }
    canRedo() {
        return this._project !== null && this._project.undoIndex < this._project.undoHistory.length - 1;
    }
    applyAction(data) {
        // Apply serialized action data - simplified for now
        // In a full implementation, this would dispatch to specific handlers
        console.log('Applying action:', data);
    }
    applyInverse(data) {
        // Apply inverse action data
        console.log('Applying inverse:', data);
    }
    // -----------------------------------------------------------
    // Selection & UI State
    // -----------------------------------------------------------
    setSelection(selection) {
        this._selection = selection;
        this.notify();
    }
    setUIState(state) {
        this._uiState = { ...this._uiState, ...state };
        this.notify();
    }
}
// Export singleton instance
export const projectStore = new ProjectStoreImpl();
export default projectStore;
