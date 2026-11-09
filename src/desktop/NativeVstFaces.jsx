/**
 * The plugin windows of one lane's chain.
 *
 * Each interface is the plugin's own code drawing in its own Win32 window: the
 * page only measures the rectangle it wants the face to live in and sends it
 * across, and the native side converts that into the screen. This module owns
 * those rectangles for *all* of the open faces at once, which is what lets a
 * producer have a drive, an amp and a cab on the screen together — REAPER's FX
 * window shows each row's own interface, and a chain that could only ever show
 * one of them at a time would send the producer back to the desktop for the
 * plugin's knobs.
 *
 * Two halves, kept apart on purpose:
 *
 * · `useNativeFaces` is the bookkeeping — which rows have a face up, which one is
 *   still building its toolkit, what the plugin said when it refused. It lives in
 *   the chain, because the rows live there.
 * · `NativeVstFaces` is the drawing — one pane per face, stacked in the FX window
 *   beside the chain column, each with its own bar and its own measuring box, and
 *   each keeping its own window glued to that box as the page scrolls, the window
 *   resizes and the panel is minimised.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pluginApi } from './native';
/**
 * A row's identity for everything outside React: its own session in the plugin
 * process, its window, the saved project. A chain from before rows had ids is
 * addressed by its file, exactly like the older host was.
 */
export const faceKeyOf = (slot) => slot.id ?? slot.path;
/** What the strip says when the process that owned the window is gone. */
const LOST_WINDOW = 'o processo do plugin caiu e a janela dele foi junto — os plugins foram recarregados e o projeto está intacto';
export function useNativeFaces() {
    const [faces, setFaces] = useState([]);
    const [errors, setErrors] = useState({});
    const patch = useCallback((key, next) => {
        setFaces((prev) => prev.map((face) => (face.key === key ? { ...face, ...next } : face)));
    }, []);
    const clearError = useCallback((key) => {
        setErrors((prev) => {
            if (!prev[key])
                return prev;
            const next = { ...prev };
            delete next[key];
            return next;
        });
    }, []);
    const refuse = useCallback((key, message) => {
        setFaces((prev) => prev.filter((face) => face.key !== key));
        setErrors((prev) => ({ ...prev, [key]: message }));
    }, []);
    const open = useCallback((slot) => {
        const key = faceKeyOf(slot);
        setErrors((prev) => {
            if (!prev[key])
                return prev;
            const next = { ...prev };
            delete next[key];
            return next;
        });
        setFaces((prev) => {
            const existing = prev.find((face) => face.key === key);
            if (existing) {
                // The same row pressing "open" again is a producer asking for the window
                // back after it was lost — so the row is re-armed, with the file it holds
                // now, not duplicated.
                return prev.map((face) => face.key === key
                    ? { ...face, path: slot.path, name: slot.name, phase: 'pending', width: 0, height: 0, values: [] }
                    : face);
            }
            return [
                ...prev,
                { key, path: slot.path, name: slot.name, phase: 'pending', width: 0, height: 0, values: [] },
            ];
        });
    }, []);
    const close = useCallback((key) => {
        setFaces((prev) => prev.filter((face) => face.key !== key));
        clearError(key);
    }, []);
    const closeAll = useCallback(() => {
        setFaces([]);
        setErrors({});
    }, []);
    const toggle = useCallback((slot) => {
        const key = faceKeyOf(slot);
        if (faces.some((face) => face.key === key))
            close(key);
        else
            open(slot);
    }, [faces, close, open]);
    const isOpen = useCallback((key) => faces.some((face) => face.key === key), [faces]);
    const face = useCallback((key) => faces.find((item) => item.key === key) ?? null, [faces]);
    const errorOf = useCallback((key) => errors[key] ?? '', [errors]);
    return { faces, open, close, closeAll, toggle, isOpen, face, errorOf, report: patch, refuse };
}
/**
 * Every open face of this lane, in one column next to the chain. The stack is
 * rendered inside the FX window element — wherever that is — because the plugin's
 * window is placed by the rectangle the page measures, and a pane squeezed between
 * knobs would give the interface a box it cannot fit in.
 */
export default function NativeVstFaces({ faces, host, sampleRate, onClose, report, refuse, }) {
    if (faces.length === 0)
        return null;
    const stack = (<div className="native-vst-faces">
      {faces.map((face) => (<NativeVstFaceStage key={face.key} face={face} sampleRate={sampleRate} onClose={onClose} report={report} refuse={refuse}/>))}
    </div>);
    return host ? createPortal(stack, host) : stack;
}
/**
 * One face: the press, the window and the keeping-in-place of it.
 *
 * `gui-open` is the call that loads the plugin's toolkit, so it runs once per
 * press and the answer decides what the bar says. After that, one cheap check per
 * fifth of a second notices the pane moving — the chain scrolls, the FX window is
 * dragged or resized, the panel is minimised — and the native window is only moved
 * when it really needs moving.
 */
function NativeVstFaceStage({ face, sampleRate, onClose, report, refuse }) {
    const [api] = useState(() => pluginApi());
    const canvasRef = useRef(null);
    const placed = useRef({ x: 0, y: 0, width: 0, height: 0 });
    /** Whether the native window is on the screen right now (see `gui-show`). */
    const shown = useRef(false);
    /** Which file this face already asked for a window for: the press answers once. */
    const askedFor = useRef('');
    /**
     * The box this plugin draws in, clipped to what the stack of faces really shows.
     *
     * Two interfaces stacked in a pane that is shorter than both means the lower one
     * is partly out of view, and a window placed by an unclipped rectangle would
     * paint over the pane's edge — or over the other plugin's face. So the rectangle
     * that goes out is the intersection, and a canvas scrolled completely away is not
     * visible at all, which is what puts its window away.
     */
    const visibleRect = () => {
        const box = canvasRef.current?.getBoundingClientRect();
        if (!box || box.width < 8 || box.height < 8)
            return null;
        const clip = canvasRef.current?.closest('.native-vst-faces')?.getBoundingClientRect();
        const left = Math.max(box.left, clip?.left ?? box.left);
        const top = Math.max(box.top, clip?.top ?? box.top);
        const right = Math.min(box.right, clip?.right ?? box.right);
        const bottom = Math.min(box.bottom, clip?.bottom ?? box.bottom);
        const width = Math.round(right - left);
        const height = Math.round(bottom - top);
        // A sliver of a plugin is not an interface: below this the window is put away
        // rather than squashed into someone else's corner.
        if (width < 8 || height < 48)
            return null;
        return { x: Math.round(left), y: Math.round(top), width, height };
    };
    const stageRect = () => visibleRect() ?? { x: 120, y: 120, width: 640, height: 360 };
    // The press and the answer: `gui-open` is the call that loads the toolkit, so it
    // runs once per face, and the answer decides what the bar says.
    useEffect(() => {
        if (face.phase !== 'pending')
            return;
        if (askedFor.current === face.path)
            return;
        if (!api?.guiOpen) {
            refuse(face.key, 'o executável não expõe janelas de plugin nesta máquina');
            return;
        }
        askedFor.current = face.path;
        const rect = stageRect();
        void api
            .guiOpen({ path: face.path, sessionId: face.key, sampleRate, rect })
            .then((result) => {
            if (!result.ok || result.state?.open !== true) {
                refuse(face.key, result.error ?? 'o plugin recusou abrir a interface dele');
                return;
            }
            placed.current = rect;
            shown.current = true;
            report(face.key, {
                phase: 'open',
                width: result.state.clientWidth ?? rect.width,
                height: result.state.clientHeight ?? rect.height,
                values: result.reported ?? [],
            });
        })
            .catch((error) => {
            refuse(face.key, error.message);
        });
        // The face's phase and its file are what re-arm a press: a row that is
        // re-opened after a refusal comes back through a fresh face.
    }, [face.phase, face.key, face.path, api, sampleRate, report, refuse]);
    // Keeping it there: one cheap check per fifth of a second notices the pane
    // moving — the chain scrolls, the FX window is dragged or resized, the panel is
    // minimised — and the native window is only moved when it really needs moving.
    useEffect(() => {
        if (face.phase !== 'open')
            return;
        const target = { path: face.path, sessionId: face.key };
        let alive = true;
        let ticks = 0;
        const timer = window.setInterval(() => {
            if (!alive)
                return;
            ticks += 1;
            const rect = visibleRect();
            const visible = rect !== null;
            if (visible !== shown.current) {
                shown.current = visible;
                void api
                    ?.guiShow?.({ ...target, visible })
                    .then((result) => {
                    if (!alive)
                        return;
                    if (result.noEditor === true)
                        refuse(face.key, LOST_WINDOW);
                    else if (result.ok && !visible)
                        report(face.key, { values: result.reported ?? [] });
                })
                    .catch(() => { });
                return;
            }
            if (!rect)
                return;
            const last = placed.current;
            const moved = Math.abs(rect.x - last.x) > 1 ||
                Math.abs(rect.y - last.y) > 1 ||
                Math.abs(rect.width - last.width) > 1 ||
                Math.abs(rect.height - last.height) > 1;
            if (moved && api?.guiPlace) {
                placed.current = rect;
                void api
                    .guiPlace({ ...target, rect })
                    .then((result) => {
                    if (!alive)
                        return;
                    if (result.noEditor === true)
                        refuse(face.key, LOST_WINDOW);
                    else if (!result.ok || result.state?.open === false)
                        refuse(face.key, 'a janela do plugin foi fechada');
                    else {
                        report(face.key, {
                            values: result.reported ?? [],
                            width: result.state?.clientWidth ?? face.width,
                            height: result.state?.clientHeight ?? face.height,
                        });
                    }
                })
                    .catch(() => { });
                return;
            }
            if (ticks % 5 === 0 && api?.guiState) {
                void api
                    .guiState(target)
                    .then((result) => {
                    if (!alive)
                        return;
                    if (result.noEditor === true)
                        refuse(face.key, LOST_WINDOW);
                    else if (result.ok && result.state?.open === false)
                        onClose(face.key);
                    else if (result.ok) {
                        report(face.key, {
                            values: result.reported ?? [],
                            width: result.state?.clientWidth ?? face.width,
                            height: result.state?.clientHeight ?? face.height,
                        });
                    }
                })
                    .catch(() => { });
            }
        }, 200);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [face.phase, face.key, face.path, face.width, face.height, api, report, refuse, onClose]);
    // A face the producer put away, a row that went away, an FX window that closed:
    // all of them end the same way, with the plugin's window taken down.
    useEffect(() => () => {
        void pluginApi()?.guiClose?.({ path: face.path, sessionId: face.key }).catch(() => undefined);
    }, [face.path, face.key]);
    // The pane says which row it belongs to: the chain column and the face column
    // are drawn apart, and "this window is that line's window" has to be readable
    // from the page rather than guessed at from the order they happen to come in.
    return (<div className={`native-vst-stage open${face.phase === 'pending' ? ' pending' : ''}`} data-face-key={face.key} data-face-path={face.path}>
      <div className="native-vst-stage-bar">
        {face.phase === 'pending' ? (<span>Abrindo a interface de {face.name.slice(0, 30)}…</span>) : (<>
            <strong className="native-vst-stage-name">{face.name.slice(0, 40)}</strong>
            {face.width > 0 ? (<span className="native-vst-stage-size">
                {face.width}×{face.height}
              </span>) : null}
            {face.values.length > 0 ? (<span className="plugin-live">{face.values.length} valores lidos do plugin</span>) : null}
            <span className="native-vst-stage-hint">
              a interface está sobre esta área — role ou mova o OpenDAW que a janela acompanha
            </span>
          </>)}
        <button type="button" className="mini-btn" title="Fechar a interface deste plugin" onClick={() => onClose(face.key)}>
          ✕
        </button>
      </div>
      {/* The rectangle the native window is placed by: the canvas, not the bar, so
            the plugin never paints over its own name. */}
      <div className="native-vst-stage-canvas" ref={canvasRef}/>
    </div>);
}
