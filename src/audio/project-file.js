/**
 * The `.opdaw` project file.
 *
 * localStorage autosave is a convenience for one browser on one machine; a file
 * is what lets the producer hand a session over, back it up, or open it on the
 * laptop at the studio. The audio travels inside it - a project JSON that opens
 * with silent clips is not the project - so every WAV the clips reference is
 * carried as base64 next to the metadata.
 *
 * Pure data in, data out: no engine, no DOM, so the round trip is testable with
 * `npm test`.
 *
 * The app used to be called WebDAW, and sessions saved back then say
 * `webdaw-project` inside them. Those files are read exactly as they are - a
 * rename of the product is not a reason to lose somebody's takes - but nothing
 * written from here on uses the old identity.
 */
export const PROJECT_FILE_KIND = 'opdaw-project';
/** Kinds accepted on read, from before the OpenDAW name. */
export const LEGACY_PROJECT_FILE_KINDS = ['webdaw-project'];
export const PROJECT_FILE_VERSION = 1;
export const PROJECT_FILE_EXTENSION = 'opdaw';
const BASE64_CHUNK = 0x8000;
export function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
    }
    return btoa(binary);
}
export function base64ToBytes(text) {
    const binary = atob(text.replace(/\s+/g, ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1)
        out[i] = binary.charCodeAt(i);
    return out;
}
/** Ids the project references, in track order, without duplicates. */
export function sampleIdsUsedBy(project) {
    const tracks = project?.tracks;
    if (!Array.isArray(tracks))
        return [];
    const ids = [];
    const remember = (id) => {
        if (typeof id === 'string' && id && !ids.includes(id))
            ids.push(id);
    };
    for (const track of tracks) {
        const item = track;
        remember(item.bufferId);
        // An unused take still has to travel with the project, or the singer
        // opens the file and the good pass is gone.
        if (Array.isArray(item.takes)) {
            for (const take of item.takes)
                remember(take?.id);
        }
        // NAM, IR and worklet sources are audio-adjacent assets: without their
        // bytes, the plugin metadata would reopen as an empty slot.
        if (Array.isArray(item.plugins)) {
            for (const plugin of item.plugins) {
                remember(plugin?.assetId);
            }
        }
    }
    return ids;
}
export async function buildProjectFile(project, samples) {
    const wanted = new Set(sampleIdsUsedBy(project));
    const carried = [];
    for (const sample of samples) {
        if (!wanted.has(sample.id))
            continue;
        const bytes = new Uint8Array(await sample.blob.arrayBuffer());
        carried.push({ id: sample.id, wav: bytesToBase64(bytes) });
    }
    return {
        kind: PROJECT_FILE_KIND,
        version: PROJECT_FILE_VERSION,
        savedAt: new Date().toISOString(),
        project,
        samples: carried,
    };
}
export function projectFileToText(file) {
    return JSON.stringify(file);
}
export function parseProjectFile(text) {
    let data;
    try {
        data = JSON.parse(text);
    }
    catch {
        throw new Error('não é um arquivo .opdaw válido');
    }
    const file = data;
    const kind = file?.kind;
    if (kind !== PROJECT_FILE_KIND && !LEGACY_PROJECT_FILE_KINDS.includes(kind)) {
        throw new Error('não é um arquivo .opdaw');
    }
    if (typeof file.version !== 'number' || file.version > PROJECT_FILE_VERSION) {
        throw new Error(`arquivo salvo por uma versão mais nova (v${file.version})`);
    }
    if (!file.project || typeof file.project !== 'object') {
        throw new Error('o arquivo não traz nenhum projeto');
    }
    const raw = Array.isArray(file.samples) ? file.samples : [];
    const samples = [];
    for (const entry of raw) {
        const id = entry?.id;
        const wav = entry?.wav;
        if (typeof id !== 'string' || !id || typeof wav !== 'string')
            continue;
        try {
            samples.push({ id, bytes: base64ToBytes(wav) });
        }
        catch {
            /* one broken clip must not lose the whole session */
        }
    }
    const carried = new Set(samples.map((sample) => sample.id));
    return {
        project: file.project,
        samples,
        missing: sampleIdsUsedBy(file.project).filter((id) => !carried.has(id)),
    };
}
// --------------------------------------------------------------- chain presets
export const CHAIN_FILE_KIND = 'opdaw-chain';
/** Chain presets saved under the old name still load. */
export const LEGACY_CHAIN_FILE_KINDS = ['webdaw-chain'];
export const CHAIN_FILE_EXTENSION = 'opdawchain';
export function buildChainFile(name, rack, order) {
    return {
        kind: CHAIN_FILE_KIND,
        version: 1,
        savedAt: new Date().toISOString(),
        name,
        rack,
        order: order.filter((entry) => typeof entry === 'string' && entry.startsWith('fx:')),
    };
}
export function parseChainFile(text) {
    let data;
    try {
        data = JSON.parse(text);
    }
    catch {
        throw new Error('não é um arquivo de cadeia válido');
    }
    const file = data;
    const chainKind = file?.kind;
    if (chainKind !== CHAIN_FILE_KIND && !LEGACY_CHAIN_FILE_KINDS.includes(chainKind)) {
        throw new Error('não é um preset de cadeia');
    }
    if (!file.rack || typeof file.rack !== 'object')
        throw new Error('a cadeia não traz efeitos');
    const order = Array.isArray(file.order)
        ? file.order.filter((entry) => typeof entry === 'string' && entry.startsWith('fx:'))
        : [];
    return { name: typeof file.name === 'string' ? file.name : 'Cadeia importada', rack: file.rack, order };
}
