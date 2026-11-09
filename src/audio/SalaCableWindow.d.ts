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
import type { AudioEngine } from './audio-engine';
export interface SalaCableProps {
    engine: AudioEngine | null;
    onClose: () => void;
    /**
     * Escondida, não desmontada: fechar a janela no meio de uma jam não pode derrubar
     * a chamada, então o app continua montando este componente e só tira a tela dele.
     */
    hidden?: boolean;
    /** Diz ao app se o cabo está no ar, para a luz do jack no master dizer a verdade. */
    onLiveChange?: (live: boolean) => void;
    /**
     * Cria a faixa gravável de um participante e devolve o id dela.
     * A `key` é o id do canal na sala: a faixa o guarda para que o botão IN dela
     * mexa no retorno certo, e para que o undo nunca a reliue sozinha.
     */
    createLane: (label: string, key: string) => string;
    removeLane: (trackId: string) => void;
    notify: (text: string) => void;
}
export declare function SalaCableWindow({ engine, hidden, onLiveChange, onClose, createLane, removeLane, notify, }: SalaCableProps): import("react").JSX.Element | null;
