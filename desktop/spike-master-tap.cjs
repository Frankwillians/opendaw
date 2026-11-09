/**
 * Isolates the master-tap worklet: an oscillator feeds it, the tap copies to a
 * gain-0 node into the destination (exactly the ASIO topology), and the page
 * listens on the far end of the channel IN THE PAGE. The worklet is instrumented
 * to report back whether it received the port and whether process() runs, so a
 * silent sink can be told apart from a worklet that never renders.
 *
 *   ./node_modules/electron/dist/electron.exe spike-master-tap.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Count what arrives cross-process through the real preload handoff, exactly the
// path the app uses: worklet -> port1 -> port2 -> window -> preload -> main.
const cross = { pcm: 0, floats: 0, peak: 0, attached: false }
ipcMain.on('opdaw:asio:handoff', (event) => {
  const port = event.ports?.[0]
  if (!port) return
  cross.attached = true
  port.on('message', (message) => {
    const d = message.data
    if (d && d.kind === 'pcm' && d.samples) {
      cross.pcm += 1
      cross.floats += d.samples.length
      for (let i = 0; i < d.samples.length; i += 1) { const a = Math.abs(d.samples[i]); if (a > cross.peak) cross.peak = a }
    }
  })
  port.start()
})

// The production master-tap, instrumented: same copy + accumulate + post logic,
// plus diagnostics back to the node so we can see inside the audio thread.
const WORKLET = `
class MasterTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sink = null;
    this.batch = 256;
    this.acc = null;
    this.fill = 0;
    this.calls = 0;
    this.posts = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && 'attachPort' in data) {
        this.sink = data.attachPort;
        if (this.sink) this.sink.onmessage = () => {};
        if (this.sink && this.sink.start) this.sink.start();
        this.port.postMessage({ kind: 'diag', event: 'attached', hasSink: !!this.sink });
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
    this.calls += 1;
    if (this.calls % 100 === 1) {
      this.port.postMessage({ kind: 'diag', event: 'process', calls: this.calls, posts: this.posts, hasSink: !!this.sink, inLen: (input && input[0] && input[0].length) || 0 });
    }
    if (!output || output.length === 0) return true;
    const channels = output.length;
    const frames = output[0].length;
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
          this.sink.postMessage({ kind: 'pcm', samples: send });
          this.posts += 1;
          this.acc = new Float32Array(need);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('master-tap', MasterTapProcessor);
`

const tmp = os.tmpdir()
const page = path.join(tmp, 'opdaw-spike-master-tap.html')
fs.writeFileSync(
  page,
  `<!doctype html><meta charset="utf-8"><title>spike</title>
<script>
window.result = { done: false, log: [], diag: [], pcm: 0, pcmFloats: 0, peak: 0, error: '' };
const say = (l) => window.result.log.push(l);
const WORKLET = ${JSON.stringify(WORKLET)};
async function run() {
  try {
    const ctx = new AudioContext();
    await ctx.resume();
    say('contexto: ' + ctx.sampleRate + 'Hz ' + ctx.state);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    say('worklet carregado');
    const tap = new AudioWorkletNode(ctx, 'master-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const og = ctx.createGain();
    og.gain.value = 0.1;
    osc.connect(og);
    og.connect(tap);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    tap.connect(mute);
    mute.connect(ctx.destination);
    osc.start();
    tap.port.onmessage = (e) => { if (e.data && e.data.kind === 'diag') window.result.diag.push(e.data); };
    const channel = new MessageChannel();
    tap.port.postMessage({ attachPort: channel.port1, batchFrames: 256 }, [channel.port1]);
    say('porta transferida ao worklet');
    // Hand the far end out through the window, exactly like activateAsio does;
    // the preload carries it to the main process, which counts it there.
    window.postMessage({ opdawAsio: 'handoff' }, '*', [channel.port2]);
    say('porta entregue ao processo (cross-process)');
    setTimeout(() => { window.result.done = true; }, 2500);
  } catch (error) {
    window.result.error = String(error && error.message ? error.message : error);
    window.result.done = true;
  }
}
run();
</script>`,
)

async function main() {
  const win = new BrowserWindow({
    show: true,
    width: 420,
    height: 320,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  await win.loadFile(page)
  win.focus()
  for (let i = 0; i < 60; i += 1) {
    if (await win.webContents.executeJavaScript('window.result.done === true')) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const result = await win.webContents.executeJavaScript('JSON.stringify(window.result)')
  console.log('SPIKE ' + result)
  console.log('CROSS ' + JSON.stringify(cross))
  app.quit()
}

app.whenReady().then(main)