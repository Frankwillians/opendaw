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
export declare const MASTER_TAP_NAME = "master-tap";
export declare const MASTER_TAP_SOURCE = "\nclass MasterTapProcessor extends AudioWorkletProcessor {\n  constructor() {\n    super();\n    this.sink = null;\n    this.batch = 256;\n    this.acc = null;\n    this.fill = 0;\n    this.port.onmessage = (event) => {\n      const data = event.data;\n      // 'attachPort' present clears the sink when null (detach); a batch-only\n      // message leaves the current port alone.\n      if (data && 'attachPort' in data) {\n        this.sink = data.attachPort;\n        // A transferred MessagePort has to be started for its pipe to run \u2014 the\n        // proven rt-bridge does the same. Without start() the worklet posts into\n        // a dead pipe and the native sink hears only silence.\n        if (this.sink && this.sink.start) this.sink.start();\n      }\n      if (data && typeof data.batchFrames === 'number' && data.batchFrames > 0) {\n        this.batch = data.batchFrames;\n        this.acc = null;\n        this.fill = 0;\n      }\n    };\n  }\n  process(inputs, outputs) {\n    const input = inputs[0];\n    const output = outputs[0];\n    if (!output || output.length === 0) return true;\n    const channels = output.length;\n    const frames = output[0].length;\n    // C\u00F3pia transparente: o caminho WASAPI segue recebendo o mesmo sinal.\n    for (let c = 0; c < channels; c += 1) {\n      const out = output[c];\n      const inp = (input && (input[c] || input[0])) || null;\n      if (inp) out.set(inp);\n      else out.fill(0);\n    }\n    if (this.sink) {\n      const need = this.batch * channels;\n      if (!this.acc || this.acc.length !== need) {\n        this.acc = new Float32Array(need);\n        this.fill = 0;\n      }\n      for (let f = 0; f < frames; f += 1) {\n        const base = this.fill * channels;\n        for (let c = 0; c < channels; c += 1) this.acc[base + c] = output[c][f];\n        this.fill += 1;\n        if (this.fill >= this.batch) {\n          const send = this.acc;\n          // Structured-clone (sem lista de transfer\u00EAncia): a lista de\n          // transfer\u00EAncia do worklet n\u00E3o chega ao processo nativo \u2014 veja o\n          // cabe\u00E7alho. O rt-bridge comprovado tamb\u00E9m posta sem transferir.\n          try {\n            this.sink.postMessage({ kind: 'pcm', samples: send });\n          } catch (e) {\n            // Port may be closed; detach to prevent repeated errors\n            this.sink = null;\n          }\n          this.acc = new Float32Array(need);\n          this.fill = 0;\n        }\n      }\n    }\n    return true;\n  }\n}\nregisterProcessor('master-tap', MasterTapProcessor);\n";
