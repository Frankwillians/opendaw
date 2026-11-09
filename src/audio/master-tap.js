/**
 * O tap do master para o sink ASIO nativo.
 *
 * É um AudioWorklet transparente: copia a entrada para a saída sem mudar um
 * sample, e manda uma cópia interleaved para fora por uma MessagePort que a
 * página construiu. A outra ponta dessa porta vai parar no processo que escreve
 * no driver ASIO. O áudio, portanto, não sai do WebAudio para ser mixado de novo
 * — ele continua nascendo aqui; só uma cópia do master segue para a interface
 * pelo driver nativo.
 *
 * O código vai como string porque o motor carrega worklets por Blob URL (veja
 * ensureWorkletModule): funciona igual no navegador e no executável, sem
 * depender de um caminho de arquivo que o file:// recusaria.
 *
 * Lote: junta `batchFrames` frames antes de postar (padrão 256 = dois quanta de
 * 128), para não inundar a porta com uma mensagem a cada 2,9 ms. O buffer vai
 * por structured-clone, não por transferência: uma lista de transferência
 * (`[send.buffer]`) enviada de dentro do worklet para uma porta cross-process
 * não é entregue pelo Chromium — a outra ponta ouve só silêncio. Clonar um lote
 * de poucas centenas de floats é barato e atravessa a fronteira de processo.
 */
export const MASTER_TAP_NAME = 'master-tap';
export const MASTER_TAP_SOURCE = `
class MasterTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sink = null;
    this.batch = 256;
    this.acc = null;
    this.fill = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      // 'attachPort' present clears the sink when null (detach); a batch-only
      // message leaves the current port alone.
      if (data && 'attachPort' in data) {
        this.sink = data.attachPort;
        // A transferred MessagePort has to be started for its pipe to run — the
        // proven rt-bridge does the same. Without start() the worklet posts into
        // a dead pipe and the native sink hears only silence.
        if (this.sink && this.sink.start) this.sink.start();
      }
      if (data && typeof data.batchFrames === 'number' && data.batchFrames > 0) {
        this.batch = data.batchFrames;
        this.acc = null;
        this.fill = 0;
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channels = output.length;
    const frames = output[0].length;
    // Cópia transparente: o caminho WASAPI segue recebendo o mesmo sinal.
    for (let c = 0; c < channels; c += 1) {
      const out = output[c];
      const inp = (input && (input[c] || input[0])) || null;
      if (inp) out.set(inp);
      else out.fill(0);
    }
    if (this.sink) {
      const need = this.batch * channels;
      if (!this.acc || this.acc.length !== need) {
        this.acc = new Float32Array(need);
        this.fill = 0;
      }
      for (let f = 0; f < frames; f += 1) {
        const base = this.fill * channels;
        for (let c = 0; c < channels; c += 1) this.acc[base + c] = output[c][f];
        this.fill += 1;
        if (this.fill >= this.batch) {
          const send = this.acc;
          // Structured-clone (sem lista de transferência): a lista de
          // transferência do worklet não chega ao processo nativo — veja o
          // cabeçalho. O rt-bridge comprovado também posta sem transferir.
          try {
            this.sink.postMessage({ kind: 'pcm', samples: send });
          } catch (e) {
            // Port may be closed; detach to prevent repeated errors
            this.sink = null;
          }
          this.acc = new Float32Array(need);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('${MASTER_TAP_NAME}', MasterTapProcessor);
`;
