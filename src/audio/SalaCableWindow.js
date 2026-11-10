/**
 * Cabo virtual — a janela que liga a master da DAW a uma sala SALA.
 *
 * Mentalidade de mesa: o que a sala ouve é um envio saído do fader mestre, e o
 * que a sala devolve entra pelos alto-falantes depois desse ponto de envio
 * (mix-minus). Um console físico faz isso com um segundo barramento; aqui são
 * dois nós a mais no `AudioEngine` (`ensureCallCable` e `callReturn`).
 *
 * A mesma janela existe no navegador e no executável: ela só fala com o
 * `sala-sdk.js`, carregado por `import()` da origem informada, e com os nós do
 * engine. O que muda entre os dois é o transporte (CSP e certificado), tratado
 * em `desktop/server.cjs` e `desktop/main.cjs`, não aqui.
 */
import { useEffect, useRef, useState } from 'react';
const STORE_KEY = 'sala.cable';
function readStored() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        return {
            server: String(raw.server || ''),
            room: String(raw.room || ''),
            name: String(raw.name || ''),
            lanes: raw.lanes !== false,
        };
    }
    catch {
        return { server: '', room: '', name: '', lanes: true };
    }
}
const toDbText = (v) => (v <= -59 ? '-inf' : v.toFixed(1));
export function SalaCableWindow({ engine, hidden = false, onLiveChange, onClose, createLane, removeLane, notify, }) {
    const stored = useRef(readStored());
    // O formulário abre com a última conexão usada (localStorage 'sala.cable').
    const initialServer = stored.current.server || 'https://webteam-iota.vercel.app';
    const initialRoom = stored.current.room || 'geral';
    const initialName = stored.current.name || 'Minha DAW';
    const initialLanes = stored.current.lanes;
    const [server, setServer] = useState(initialServer);
    const [room, setRoom] = useState(initialRoom);
    const [pass, setPass] = useState('');
    const [name, setName] = useState(initialName);
    const [lanes, setLanes] = useState(initialLanes);
    const [micAlong, setMicAlong] = useState(false);
    const [hostOnly, setHostOnly] = useState(false);
    const [live, setLive] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [trimDb, setTrimDb] = useState(0);
    const [sendMuted, setSendMuted] = useState(false);
    const [limiter, setLimiter] = useState(false);
    const [sendPeak, setSendPeak] = useState(0);
    const [returnPeak, setReturnPeak] = useState(0);
    const [peers, setPeers] = useState([]);
    const [invite, setInvite] = useState('');
    const [privateRoom, setPrivateRoom] = useState(false);
    // Vídeo split-screen: canais com vídeo (cam ou screen) dos participantes
    const [videoChannels, setVideoChannels] = useState(new Map());
    const [showVideoGrid, setShowVideoGrid] = useState(false);
    // Dispositivos de áudio para as duas entradas
    const [micDeviceId, setMicDeviceId] = useState(null); // Microfone principal
    const [guestMicDeviceId, setGuestMicDeviceId] = useState(null); // Microfone do convidado
    const [useGuestMic, setUseGuestMic] = useState(false); // Ativar segunda entrada
    // Mudo individual por entrada
    const [micMuted, setMicMuted] = useState(false);
    const [guestMicMuted, setGuestMicMuted] = useState(false);
    // Identificadores dos canais de microfone criados pelo SDK (para controle individual)
    const micChannelIdRef = useRef(null);
    const guestMicChannelIdRef = useRef(null);
    const linkRef = useRef(null);
    /** canal -> faixa criada por ele, para soltar exatamente o que se patcheou. */
    const laneOfChannel = useRef(new Map());
    /**
     * O `lanes` vivo, lido por quem foi patcheado depois.
     *
     * Os ouvintes do SDK são registrados uma vez, no connect, e guardam a função
     * daquela renderização: se a flag fosse lida direto do closure, desligar "faixa
     * gravável" no meio da jam não faria efeito nos canais que chegassem em
     * seguida. Um ref é a única coisa que um listener de longa vida pode ler.
     */
    const lanesRef = useRef(lanes);
    lanesRef.current = lanes;
    const refreshPeers = () => {
        const link = linkRef.current;
        if (!link)
            return;
        setPeers(link.peerList().map((p) => ({ id: p.id, name: p.name, channels: p.channels })));
    };
    /** Guarda os unsubscribers dos eventos do SDK para limpeza correta. */
    const unsubRef = useRef([]);
    /** Um participante remoto vira faixa gravável + retorno monitorado fora do envio. */
    const patchChannel = (ch) => {
        if (!engine)
            return;
        const label = ch.kind === 'screen' ? `${ch.name} · tela` : ch.name;
        if (!lanesRef.current) {
            // sem faixa: só o retorno, pelos alto-falantes, sem voltar pelo cabo
            engine.connectCallReturn(ch.id, ch.stream);
        }
        else {
            try {
                const trackId = createLane(label, ch.id);
                // O convidado entra pelo canal da própria faixa (monitor ligado) e a
                // saída da faixa vai para depois do ponto de envio (setTrackPostSend).
                // Assim ele tem fader, mute, pan e FX dentro da DAW — dá pra mutar um
                // convidado — mas o som dele não volta pra sala (sem eco), porque não
                // entra no masterSum que alimenta o cabo de envio.
                engine.connectCallInput(trackId, ch.stream, true, label);
                engine.setTrackPostSend(trackId, true);
                laneOfChannel.current.set(ch.id, trackId);
                notify(`"${label}" virou faixa controlável (fader/mute/FX)`);
            }
            catch (err) {
                setError(err.message || 'não deu para patchear o canal');
                engine.connectCallReturn(ch.id, ch.stream);
            }
        }
        // Rastrear canais de vídeo para split-screen
        const videoTracks = ch.stream.getVideoTracks();
        if (videoTracks.length > 0) {
            setVideoChannels((prev) => {
                const next = new Map(prev);
                next.set(ch.id, { stream: ch.stream, name: ch.name, kind: ch.kind });
                return next;
            });
        }
    };
    const unpatchChannel = (ch) => {
        if (!engine)
            return;
        engine.disconnectCallReturn(ch.id);
        const trackId = laneOfChannel.current.get(ch.id);
        if (trackId) {
            laneOfChannel.current.delete(ch.id);
            engine.disconnectInput(trackId);
            removeLane(trackId);
        }
        // Remover do split-screen
        setVideoChannels((prev) => {
            const next = new Map(prev);
            next.delete(ch.id);
            return next;
        });
    };
    // Enumera dispositivos de entrada de áudio disponíveis
    const [audioInputs, setAudioInputs] = useState([]);
    useEffect(() => {
        const enumerate = async () => {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                setAudioInputs(devices.filter((d) => d.kind === 'audioinput'));
            }
            catch {
                /* sem permissão ou não suportado */
            }
        };
        enumerate();
    }, []);
    const disconnect = () => {
        // Limpa todos os listeners do SDK registrados
        for (const unsub of unsubRef.current) {
            try {
                unsub();
            }
            catch {
                /* ignora erros de limpeza */
            }
        }
        unsubRef.current = [];
        const link = linkRef.current;
        linkRef.current = null;
        try {
            link?.leave();
        }
        catch {
            /* já era */
        }
        if (engine) {
            for (const [id, trackId] of [...laneOfChannel.current]) {
                laneOfChannel.current.delete(id);
                try {
                    engine.disconnectInput(trackId);
                    removeLane(trackId);
                }
                catch {
                    /* a faixa pode já ter ido junto com o projeto */
                }
            }
            for (const id of [...engine.callReturnKeys()])
                engine.disconnectCallReturn(id);
            engine.releaseCallCable();
        }
        setLive(false);
        setPeers([]);
        setInvite('');
        setPrivateRoom(false);
        setVideoChannels(new Map());
        setShowVideoGrid(false);
        // Resetar IDs dos canais e estados de mudo
        micChannelIdRef.current = null;
        guestMicChannelIdRef.current = null;
        setMicMuted(false);
        setGuestMicMuted(false);
    };
    const connect = async () => {
        if (!engine) {
            setError('a engine de áudio ainda não existe nesta janela');
            return;
        }
        // Evita conectar duas vezes — se já estiver ligado, desconecta primeiro
        if (live) {
            disconnect();
            // Pequeno delay para garantir que a limpeza terminou
            await new Promise((r) => setTimeout(r, 100));
        }
        setBusy(true);
        setError('');
        setNotice('');
        const base = server.trim().replace(/\/+$/, '');
        try {
            const mod = (await import(/* @vite-ignore */ `${base}/js/sala-sdk.js`));
            const { send } = engine.ensureCallCable();
            const link = await mod.joinRoom({
                url: base,
                room: room.trim() || 'geral',
                name: name.trim() || 'Minha DAW',
                pass: pass.trim(),
                audioContext: engine.ctx,
                mode: 'jam',
                ice: hostOnly ? { hostOnly: true } : { stun: 'stun:stun.l.google.com:19302' },
            });
            linkRef.current = link;
            // o servidor sanitiza o nome (24 caracteres, sem símbolos de controle).
            // mostrar o que ele aceitou evita a janela dizer uma coisa e a sala outra.
            if (link.state?.name)
                setName(link.state.name);
            link.useNode(send, { kind: 'daw', trimDb });
            link.setLimiter(limiter);
            // o mudo do cabo mora no engine, não no SDK: os dois ganhos se multiplicam
            // e um deles tem que ser o botão visível da janela.
            engine.setCallSendMuted(sendMuted);
            engine.setCallSendDb(trimDb);
            setPrivateRoom(link.state.isPrivate === true);
            setInvite(link.state.isPrivate ? link.inviteLink() : '');
            if (micAlong) {
                try {
                    if (useGuestMic) {
                        // Entrada principal (microfone do host)
                        if (micDeviceId) {
                            await link.useMicrophone({ deviceId: micDeviceId });
                        }
                        else {
                            await link.useMicrophone();
                        }
                        // Capturar o canal do microfone principal para controle individual
                        const channelsAfterMain = link.channels;
                        for (const [id, ch] of channelsAfterMain) {
                            if (ch.kind === 'mic' && !micChannelIdRef.current) {
                                micChannelIdRef.current = id;
                                break;
                            }
                        }
                        // Entrada do convidado — roteia pelo master mas identificada separadamente
                        // Usar useNode com kind 'mic' e um label diferente para criar canal separado
                        if (guestMicDeviceId) {
                            // Criar uma MediaStream separada para o microfone do convidado
                            const guestStream = await navigator.mediaDevices.getUserMedia({
                                audio: { deviceId: { exact: guestMicDeviceId } }
                            });
                            // Usar useNode para adicionar como fonte separada identificada como 'guest'
                            // useNode espera um AudioNode: o MediaStream do convidado vira fonte
                            // no contexto do engine antes de entrar na sala.
                            const guestNode = engine.ctx.createMediaStreamSource(guestStream);
                            link.useNode(guestNode, { kind: 'mic', trimDb: 0 });
                            // O SDK deve criar um canal separado para esta fonte
                            // Capturar o ID do canal do convidado
                            const channelsAfterGuest = link.channels;
                            for (const [id, ch] of channelsAfterGuest) {
                                if (ch.kind === 'mic' && id !== micChannelIdRef.current && !guestMicChannelIdRef.current) {
                                    guestMicChannelIdRef.current = id;
                                    break;
                                }
                            }
                        }
                        else {
                            // Fallback: tentar useMicrophone padrão (pode pegar o mesmo dispositivo)
                            await link.useMicrophone();
                            const channelsAfterGuest = link.channels;
                            for (const [id, ch] of channelsAfterGuest) {
                                if (ch.kind === 'mic' && id !== micChannelIdRef.current && !guestMicChannelIdRef.current) {
                                    guestMicChannelIdRef.current = id;
                                    break;
                                }
                            }
                        }
                        setNotice('duas entradas ativas: principal + convidado (ambas somam ao envio da master)');
                    }
                    else {
                        // Modo simples: só microfone principal
                        if (micDeviceId) {
                            await link.useMicrophone({ deviceId: micDeviceId });
                        }
                        else {
                            await link.useMicrophone();
                        }
                        // Capturar o canal do microfone principal
                        const channelsAfterMain = link.channels;
                        for (const [id, ch] of channelsAfterMain) {
                            if (ch.kind === 'mic' && !micChannelIdRef.current) {
                                micChannelIdRef.current = id;
                                break;
                            }
                        }
                        setNotice('microfone somado ao envio — fale com a DAW tocando baixinho, senão vira microfonia');
                    }
                }
                catch (err) {
                    setNotice(`microfone negado (${err.name || err.message}) — seguindo só com a master`);
                }
            }
            link.on('channel', (event) => {
                patchChannel(event.detail);
                refreshPeers();
            });
            const unChannel = link.on('channel-lost', (event) => {
                unpatchChannel(event.detail);
                refreshPeers();
            });
            const unPeer = link.on('peer', refreshPeers);
            const unWelcome = link.on('welcome', refreshPeers);
            const unStatus = link.on('status', (event) => {
                const state = event.detail?.state;
                if (state === 'closed' || state === 'error')
                    setNotice('a sinalização caiu — o cabo continua montado, reconecte quando a rede voltar');
            });
            // Guarda os unsubscribers para limpeza correta no disconnect
            unsubRef.current = [unChannel, unPeer, unWelcome, unStatus];
            localStorage.setItem(STORE_KEY, JSON.stringify({ server: base, room, name, lanes }));
            setLive(true);
            refreshPeers();
        }
        catch (err) {
            const message = err?.message || 'falha ao conectar';
            // o erro mais comum é o certificado autoassinado ainda não aceito, e o
            // navegador diz apenas "Failed to fetch" — vale traduzir.
            setError(/fetch|import|network|certificate/i.test(message)
                ? `não deu para alcançar ${base} — abra essa URL em uma aba, aceite o aviso do certificado autoassinado e tente de novo (${message})`
                : message);
            disconnect();
        }
        finally {
            setBusy(false);
        }
    };
    // O app precisa saber se o cabo está no ar com a janela fechada — é a luz do
    // jack no master, e ela não pode piscar para uma chamada que já caiu.
    useEffect(() => {
        onLiveChange?.(live);
    }, [live, onLiveChange]);
    // medidores do cabo: ida e volta, no ritmo do desenho da tela. Para de ler
    // quando a janela some — analisar dois FFTs por quadro sem ninguém olhando é
    // custo de áudio-thread por nada.
    useEffect(() => {
        if (!live || !engine || hidden)
            return;
        let raf = 0;
        const tick = () => {
            setSendPeak(engine.getCallSendLevel());
            setReturnPeak(engine.getCallReturnLevel());
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [live, engine, hidden]);
    useEffect(() => () => disconnect(), []); // eslint-disable-line react-hooks/exhaustive-deps
    // Gerenciar mudanças dinâmicas de microfone enquanto conectado
    useEffect(() => {
        if (!live || !linkRef.current)
            return;
        const link = linkRef.current;
        // Função para configurar microfones
        const setupMicrophones = async () => {
            if (!micAlong)
                return;
            try {
                // Remover fontes de microfone existentes
                link.removeSource('mic', true);
                // Resetar IDs dos canais e estados de mudo
                micChannelIdRef.current = null;
                guestMicChannelIdRef.current = null;
                setMicMuted(false);
                setGuestMicMuted(false);
                if (useGuestMic) {
                    // Entrada principal (microfone do host)
                    if (micDeviceId) {
                        await link.useMicrophone({ deviceId: micDeviceId });
                    }
                    else {
                        await link.useMicrophone();
                    }
                    // Capturar o canal do microfone principal
                    const channelsAfterMain = link.channels;
                    for (const [id, ch] of channelsAfterMain) {
                        if (ch.kind === 'mic' && !micChannelIdRef.current) {
                            micChannelIdRef.current = id;
                            break;
                        }
                    }
                    // Entrada do convidado - criar stream separada
                    if (guestMicDeviceId && engine) {
                        const guestStream = await navigator.mediaDevices.getUserMedia({
                            audio: { deviceId: { exact: guestMicDeviceId } }
                        });
                        const guestNode = engine.ctx.createMediaStreamSource(guestStream);
                        link.useNode(guestNode, { kind: 'mic', trimDb: 0 });
                        // Capturar o ID do canal do convidado
                        const channelsAfterGuest = link.channels;
                        for (const [id, ch] of channelsAfterGuest) {
                            if (ch.kind === 'mic' && id !== micChannelIdRef.current && !guestMicChannelIdRef.current) {
                                guestMicChannelIdRef.current = id;
                                break;
                            }
                        }
                    }
                    else {
                        await link.useMicrophone();
                        const channelsAfterGuest = link.channels;
                        for (const [id, ch] of channelsAfterGuest) {
                            if (ch.kind === 'mic' && id !== micChannelIdRef.current && !guestMicChannelIdRef.current) {
                                guestMicChannelIdRef.current = id;
                                break;
                            }
                        }
                    }
                    setNotice('duas entradas ativas: principal + convidado (ambas somam ao envio da master)');
                }
                else {
                    // Modo simples: só microfone principal
                    if (micDeviceId) {
                        await link.useMicrophone({ deviceId: micDeviceId });
                    }
                    else {
                        await link.useMicrophone();
                    }
                    // Capturar o canal do microfone principal
                    const channelsAfterMain = link.channels;
                    for (const [id, ch] of channelsAfterMain) {
                        if (ch.kind === 'mic' && !micChannelIdRef.current) {
                            micChannelIdRef.current = id;
                            break;
                        }
                    }
                    setNotice('microfone somado ao envio — fale com a DAW tocando baixinho, senão vira microfonia');
                }
            }
            catch (err) {
                setNotice(`microfone negado (${err.name || err.message}) — seguindo só com a master`);
            }
        };
        setupMicrophones();
    }, [live, micAlong, useGuestMic, micDeviceId, guestMicDeviceId]);
    // Escondida: o estado, a assinatura do SDK e os nós do engine continuam onde
    // estavam. Só não se desenha nada.
    if (hidden)
        return null;
    const applyTrim = (value) => {
        setTrimDb(value);
        // um só lugar manda no nível: o ganho do cabo, no engine. Aplicar também o
        // trim do SDK seria um atenuador em série — dois -6 dB que somam -12.
        engine?.setCallSendDb(value);
    };
    const applyMute = () => {
        const next = !sendMuted;
        setSendMuted(next);
        engine?.setCallSendMuted(next);
        // a porta do SDK também fecha, e é ela que avisa os outros: sem isso você
        // ficaria mudo na sala sem nenhum ícone de mudo em lugar nenhum.
        linkRef.current?.muteSend(next);
    };
    const applyMicMute = () => {
        const next = !micMuted;
        setMicMuted(next);
        const link = linkRef.current;
        const channelId = micChannelIdRef.current;
        if (link && channelId) {
            const channel = link.channels.get(channelId);
            if (channel)
                channel.mute(next);
        }
    };
    const applyGuestMicMute = () => {
        const next = !guestMicMuted;
        setGuestMicMuted(next);
        const link = linkRef.current;
        const channelId = guestMicChannelIdRef.current;
        if (link && channelId) {
            const channel = link.channels.get(channelId);
            if (channel)
                channel.mute(next);
        }
    };
    const applyLimiter = () => {
        const next = !limiter;
        setLimiter(next);
        linkRef.current?.setLimiter(next);
    };
    const rename = (value) => {
        setName(value);
        linkRef.current?.setRoomName(value.trim() || 'Minha DAW');
    };
    return (<div className="modal-overlay" onClick={live ? undefined : onClose}>
      <div className="fx-window sala-window" onClick={(event) => event.stopPropagation()}>
        <div className="fx-header">
          <span>CABO VIRTUAL · MASTER → SALA</span>
          <button type="button" className="reaper-btn" onClick={onClose}>
            X
          </button>
        </div>

        <div className="sala-body">
          {live ? (<>
              <div className="sala-row sala-jack">
                <span className={`sala-led ${sendMuted ? 'off' : ''}`}/>
                <b>enviando a master</b>
                <span className="sala-hint">
                  {privateRoom ? `sala privada · ${room}` : `sala aberta · ${room}`}
                  {linkRef.current?.state.instance ? ` · instância ${linkRef.current.state.instance}` : ''}
                </span>
              </div>

              <div className="sala-meters">
                <label className="sala-meter">
                  <span>IDA (o que a sala ouve)</span>
                  <div className="sala-bar">
                    <i style={{ width: `${Math.min(100, sendPeak * 140)}%` }}/>
                  </div>
                </label>
                <label className="sala-meter">
                  <span>VOLTA (o que chega)</span>
                  <div className="sala-bar back">
                    <i style={{ width: `${Math.min(100, returnPeak * 140)}%` }}/>
                  </div>
                </label>
              </div>

              <div className="sala-row">
                <button type="button" className={`reaper-btn ${sendMuted ? 'active-toggle' : ''}`} onClick={applyMute}>
                  {sendMuted ? 'CABO FECHADO' : 'CABO ABERTO'}
                </button>
                <label className="sala-slider">
                  <span>envio {trimDb.toFixed(1)} dB</span>
                  <input type="range" min={-40} max={6} step={0.5} value={trimDb} onChange={(event) => applyTrim(Number(event.target.value))}/>
                </label>
                <button type="button" className={`reaper-btn ${limiter ? 'active-toggle' : ''}`} onClick={applyLimiter}>
                  LIMIT
                </button>
                <button type="button" className="reaper-btn" onClick={() => {
                const applied = linkRef.current?.autoCompensate() || [];
                setNotice(applied.length ? `atraso aplicado: ${applied.map((a) => `${a.ms}ms`).join(' · ')}` : 'sem RTT medido ainda');
            }}>
                  ALINHAR
                </button>
              </div>

              {/* Controles de áudio — rótulos claros e seletores de dispositivo */}
              <div className="sala-audio-controls">
                <div className="sala-audio-group">
                  <span className="sala-audio-label">ENTRADA MICROFONE</span>
                  {micAlong && audioInputs.length > 0 && (<>
                      <div className="sala-mic-control">
                        <label className="sala-device-select">
                          <span>Principal</span>
                          <select value={micDeviceId || ''} onChange={(e) => setMicDeviceId(e.target.value || null)}>
                            <option value="">(padrão do sistema)</option>
                            {audioInputs.map((d) => (<option key={d.deviceId} value={d.deviceId}>
                                {d.label || `Entrada ${d.deviceId.slice(0, 8)}…`}
                              </option>))}
                          </select>
                        </label>
                        <button type="button" className={`reaper-btn sala-mic-mute ${micMuted ? 'active-toggle' : ''}`} onClick={applyMicMute} title={micMuted ? 'Reativar microfone principal' : 'Mutar microfone principal'} aria-label={micMuted ? 'Reativar microfone principal' : 'Mutar microfone principal'}>
                          {micMuted ? '🔇 PRINCIPAL' : '🎤 PRINCIPAL'}
                        </button>
                        <span className="sala-mic-tag">[Você]</span>
                      </div>
                      <label className="sala-check sala-check-inline">
                        <input type="checkbox" checked={useGuestMic} onChange={(event) => setUseGuestMic(event.target.checked)}/>
                        <span>Adicionar entrada do convidado</span>
                      </label>
                      {useGuestMic && (<div className="sala-mic-control">
                          <label className="sala-device-select">
                            <span>Convidado</span>
                            <select value={guestMicDeviceId || ''} onChange={(e) => setGuestMicDeviceId(e.target.value || null)}>
                              <option value="">(padrão do sistema)</option>
                              {audioInputs.map((d) => (<option key={d.deviceId} value={d.deviceId}>
                                  {d.label || `Entrada ${d.deviceId.slice(0, 8)}…`}
                                </option>))}
                            </select>
                          </label>
                          <button type="button" className={`reaper-btn sala-mic-mute ${guestMicMuted ? 'active-toggle' : ''}`} onClick={applyGuestMicMute} title={guestMicMuted ? 'Reativar microfone do convidado' : 'Mutar microfone do convidado'} aria-label={guestMicMuted ? 'Reativar microfone do convidado' : 'Mutar microfone do convidado'}>
                            {guestMicMuted ? '🔇 CONVIDADO' : '🎤 CONVIDADO'}
                          </button>
                          <span className="sala-mic-tag">[Convidado]</span>
                        </div>)}
                    </>)}
                </div>
                <div className="sala-audio-group">
                  <span className="sala-audio-label">SAÍDA MASTER</span>
                  <span className="sala-hint">o fader mestre da DAW (o que você ouve)</span>
                </div>
                <div className="sala-audio-group">
                  <span className="sala-audio-label">CÂMERA</span>
                  <span className="sala-hint">vídeo opcional — não roteia áudio</span>
                </div>
              </div>

              <div className="sala-row">
                <input className="sala-name" value={name} onChange={(event) => rename(event.target.value)} placeholder="seu nome na sala" aria-label="nome na sala"/>
                {privateRoom && invite ? (<button type="button" className="reaper-btn" onClick={async () => {
                    try {
                        await navigator.clipboard.writeText(invite);
                        notify('link do convite copiado — a senha vai dentro');
                    }
                    catch {
                        notify('copie manualmente: ' + invite);
                    }
                }}>
                    COPIAR CONVITE
                  </button>) : null}
              </div>

              {privateRoom && invite ? <div className="sala-link">{invite}</div> : null}

              <div className="sala-peers">
                {peers.length === 0 ? (<span className="sala-hint">ninguém mais na sala — o cabo está mudo por falta do que mandar</span>) : (peers.map((p) => (<span key={p.id} className="sala-peer">
                      {p.name}
                      <em>
                        {p.channels.length} {p.channels.length === 1 ? 'canal' : 'canais'}
                      </em>
                    </span>)))}
              </div>

              {/* Split-screen toggle */}
              {videoChannels.size > 0 && (<div className="sala-row">
                  <button type="button" className={`reaper-btn ${showVideoGrid ? 'active-toggle' : ''}`} onClick={() => setShowVideoGrid(!showVideoGrid)}>
                    {showVideoGrid ? 'OCULTAR VÍDEOS' : `MOSTRAR VÍDEOS (${videoChannels.size})`}
                  </button>
                </div>)}

              {/* Grid de vídeo split-screen */}
              {showVideoGrid && videoChannels.size > 0 && (<div className="sala-video-grid" role="region" aria-label="Vídeos dos participantes">
                  {Array.from(videoChannels.entries()).map(([channelId, v]) => (<div key={channelId} className="sala-video-tile">
                      <video ref={(el) => {
                        if (el) {
                            el.srcObject = v.stream;
                            el.play().catch(() => { });
                        }
                    }} autoPlay playsInline muted={false}/>
                      <div className="sala-video-label">
                        <span>{v.name}</span>
                        <em>{v.kind === 'screen' ? 'tela' : 'cam'}</em>
                      </div>
                    </div>))}
                </div>)}

              <label className="sala-check">
                <input type="checkbox" checked={lanes} onChange={(event) => {
                const on = event.target.checked;
                setLanes(on);
                if (!on) {
                    // desligou: devolve as faixas criadas, o retorno segue pelos alto-falantes
                    for (const [id, trackId] of [...laneOfChannel.current]) {
                        laneOfChannel.current.delete(id);
                        engine?.disconnectInput(trackId);
                        removeLane(trackId);
                    }
                }
                else {
                    for (const ch of linkRef.current?.channels.values() || [])
                        patchChannel(ch);
                }
            }}/>
                <span>cada participante entra como faixa gravável (o monitor sai pela mixagem só na volta, sem eco)</span>
              </label>

              <div className="sala-row">
                <button type="button" className="reaper-btn danger" onClick={disconnect}>
                  DESCONECTAR
                </button>
                <span className="sala-hint">
                  {linkRef.current?.sendLevel ? `ida ${toDbText(linkRef.current.sendLevel().db)} dBFS` : ''}
                </span>
              </div>
            </>) : (<>
              <div className="sala-fields">
                <label>
                  <span>Servidor da sala</span>
                  <input value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://192.168.0.3:5250"/>
                </label>
                <label>
                  <span>Sala</span>
                  <input value={room} onChange={(event) => setRoom(event.target.value)} placeholder="jam"/>
                </label>
                <label>
                  <span>Senha do convite (se privada)</span>
                  <input type="password" value={pass} onChange={(event) => setPass(event.target.value)} placeholder="vazia = sala aberta" autoComplete="off"/>
                </label>
                <label>
                  <span>Nome na sala</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Minha DAW"/>
                </label>
              </div>

              <label className="sala-check">
                <input type="checkbox" checked={lanes} onChange={(event) => setLanes(event.target.checked)}/>
                <span>criar uma faixa gravável para cada participante</span>
              </label>
              <label className="sala-check">
                <input type="checkbox" checked={micAlong} onChange={(event) => setMicAlong(event.target.checked)}/>
                <span>mandar também o microfone junto com a master</span>
              </label>
              {micAlong && audioInputs.length > 0 && (<div className="sala-mic-select">
                  <div className="sala-mic-control">
                    <label>
                      <span>Microfone principal</span>
                      <select value={micDeviceId || ''} onChange={(e) => setMicDeviceId(e.target.value || null)}>
                        <option value="">(padrão do sistema)</option>
                        {audioInputs.map((d) => (<option key={d.deviceId} value={d.deviceId}>
                            {d.label || `Entrada ${d.deviceId.slice(0, 8)}…`}
                          </option>))}
                      </select>
                    </label>
                    <span className="sala-mic-tag">[Você]</span>
                  </div>
                  <label className="sala-check sala-check-inline">
                    <input type="checkbox" checked={useGuestMic} onChange={(event) => setUseGuestMic(event.target.checked)}/>
                    <span>adicionar entrada do convidado</span>
                  </label>
                  {useGuestMic && (<div className="sala-mic-control">
                      <label>
                        <span>Microfone do convidado</span>
                        <select value={guestMicDeviceId || ''} onChange={(e) => setGuestMicDeviceId(e.target.value || null)}>
                          <option value="">(padrão do sistema)</option>
                          {audioInputs.map((d) => (<option key={d.deviceId} value={d.deviceId}>
                              {d.label || `Entrada ${d.deviceId.slice(0, 8)}…`}
                            </option>))}
                        </select>
                      </label>
                      <span className="sala-mic-tag">[Convidado]</span>
                    </div>)}
                </div>)}
              <label className="sala-check">
                <input type="checkbox" checked={hostOnly} onChange={(event) => setHostOnly(event.target.checked)}/>
                <span>só na mesma máquina/rede (sem STUN — atalho de teste; não alcança a internet)</span>
              </label>

              <div className="sala-row">
                <button type="button" className="reaper-btn primary" onClick={connect} disabled={busy || !engine}>
                  {busy ? 'ligando…' : 'LIGAR O CABO'}
                </button>
                {!engine ? <span className="sala-hint">a engine ainda não existe nesta janela</span> : null}
              </div>

              <p className="sala-hint">
                O que sai é a master inteira, depois do fader e dos FX do barramento — o que a sala ouve é exatamente o
                que sai da sua caixa. O que volta entra <b>depois</b> do ponto de envio, então ninguém escuta a própria
                bateria atrasada.
              </p>
            </>)}

          {error ? <div className="sala-error">{error}</div> : null}
          {notice ? <div className="sala-notice">{notice}</div> : null}
        </div>
      </div>
    </div>);
}
