/**
 * The renderer's view of the desktop executable.
 *
 * Everything here is optional: in the browser `window.OpenDAW` is undefined and
 * the DAW behaves exactly as it always has. In the executable the same calls go
 * through the operating system instead — real save and open dialogs, and the
 * native plugin process that hosts VST files.
 */
export function nativeApi() {
    return typeof window !== 'undefined' && window.OpenDAW?.native ? window.OpenDAW : null;
}
export function isNativeApp() {
    return nativeApi() !== null;
}
/** The app's own toast, so a native dialog can report where the file went. */
let toastHandler = null;
export function setNativeToastHandler(handler) {
    toastHandler = handler;
}
/** Say something through the app's own toast, for callers outside the component. */
export function nativeNotify(message) {
    toastHandler?.(message);
}
function kindForFile(filename) {
    if (/\.opdaw(chain)?$/i.test(filename))
        return filename.endsWith('chain') ? 'chain' : 'project';
    if (/\.wav$/i.test(filename))
        return 'audio';
    if (/\.midi?$/i.test(filename))
        return 'midi';
    if (/\.png$/i.test(filename))
        return 'image';
    return 'any';
}
/**
 * Write through the OS dialog. Resolves with the chosen path, or null when the
 * producer cancels. The browser path (an <a download> click) is kept in
 * `downloadBlob` for the web version.
 */
export async function nativeSaveBlob(blob, filename) {
    const api = nativeApi();
    if (!api)
        return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await api.saveFile({ kind: kindForFile(filename), defaultName: filename, data: bytes });
    if (result.error)
        throw new Error(result.error);
    if (result.canceled || !result.path)
        return null;
    toastHandler?.(`Salvo em ${result.path}`);
    return result.path;
}
/** Ask the OS for a file and hand back its text (projects and chain presets). */
export async function nativeOpenText(kind) {
    const api = nativeApi();
    if (!api)
        return null;
    const result = await api.openFile({ kind });
    if (result.canceled)
        return null;
    if (typeof result.text !== 'string')
        throw new Error('o arquivo não veio como texto');
    return result.text;
}
/** Ask the OS for an audio file and hand back the bytes for decodeAudioData. */
export async function nativeOpenAudio() {
    const api = nativeApi();
    if (!api)
        return null;
    const result = await api.openFile({ kind: 'audio' });
    if (result.canceled)
        return null;
    if (!result.data)
        throw new Error('o arquivo de áudio veio vazio');
    return { bytes: result.data, name: result.name ?? 'audio.wav' };
}
/** Ask the OS for a Standard MIDI File and hand back its raw bytes. */
export async function nativeOpenMidi() {
    const api = nativeApi();
    if (!api)
        return null;
    const result = await api.openFile({ kind: 'midi' });
    if (result.canceled)
        return null;
    if (!result.data)
        throw new Error('o arquivo MIDI veio vazio');
    return { bytes: result.data, name: result.name ?? 'midi.mid' };
}
export function onNativeMenu(handler) {
    return nativeApi()?.onMenu(handler) ?? (() => { });
}
const menuText = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
/**
 * Read the menu bar the page just drew.
 *
 * The executable and the browser must not drift apart, so the native bar is not
 * a second list of commands somebody has to remember to update: it is the page's
 * own DOM, serialized. Labels that change with state ("Desfazer (3)", "Snap
 * (on)") and rows that are disabled come along for free.
 */
export function serializeMenuBar(nav) {
    return Array.from(nav.querySelectorAll('.menu-item')).map((item) => ({
        label: menuText(item.querySelector(':scope > span')) || '—',
        items: Array.from(item.querySelectorAll(':scope > .dropdown > *')).map((node) => {
            const button = node;
            const isButton = node.tagName === 'BUTTON';
            return isButton
                ? { label: menuText(node), disabled: button.disabled === true }
                : { label: menuText(node) || '', separator: true };
        }),
    }));
}
/** Press the page's own button that the mirrored row belongs to. */
export function clickNativeMenuItem(nav, menu, item) {
    const group = nav.querySelectorAll('.menu-item')[menu];
    const node = group?.querySelectorAll(':scope > .dropdown > *')[item];
    if (!node || node.tagName !== 'BUTTON' || node.disabled)
        return false;
    node.click();
    return true;
}
/**
 * Keep the OS menu bar in step with the page's menu bar.
 *
 * React rewrites the labels as the project changes, so a MutationObserver on the
 * nav re-sends the structure (debounced: one project edit touches many nodes).
 * Returns the stop function.
 */
export function mirrorMenuBar(nav) {
    const api = nativeApi();
    if (!api?.setMenu)
        return () => { };
    let timer = null;
    const publish = () => {
        if (timer !== null)
            window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            timer = null;
            try {
                api.setMenu?.(serializeMenuBar(nav));
            }
            catch {
                // A menu that failed to sync stays as it was; the page still works.
            }
        }, 120);
    };
    const observer = new MutationObserver(publish);
    observer.observe(nav, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['disabled', 'class'],
    });
    publish();
    return () => {
        observer.disconnect();
        if (timer !== null)
            window.clearTimeout(timer);
    };
}
export const pluginApi = () => nativeApi()?.plugins ?? null;
export const audioSystemApi = () => nativeApi()?.audioSystem ?? null;
export const asioApi = () => nativeApi()?.asio ?? null;
