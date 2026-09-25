// AudioWorklet processor: hosts a *second* instance of muse-core.wasm and
// renders sample-accurate scheduled voices.
//
// Message protocol (main thread → worklet):
//   { type: 'init',  url }                    load the wasm module
//   { type: 'ev',    evs: [{t,d,c,s}] }       schedule notes
//                                             t = abs ctx sec, d = dur sec,
//                                             c = Float64Array(12), s = sound
//   { type: 'flush' }                         kill everything (stop)
//   { type: 'clear_pending' }                 cancel queued notes (pattern/tempo change)

/* eslint-env worker */

class MuseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.postMessage({ type: "hello" });
    this.x = null; // exports
    this.h = 0; // dsp handle
    this.ready = false;
    this.ctlPtr = 0;
    this.soundPtr = 0;
    this.lPtr = 0;
    this.rPtr = 0;
    this.queue = []; // messages arriving before init completes
    this.peak = 0;
    this.meterN = 0;
    this.noteCount = 0;
    this.lastN = -1;
    this.totalFrames = 0;
    this.rawPeak = 0;
    this.nanCount = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "init") {
        try {
          this.init(m.bytes);
        } catch (err) {
          this.port.postMessage({ type: "error", message: "init threw: " + err });
        }
        return;
      }
      if (!this.ready) {
        this.queue.push(m);
        return;
      }
      try {
        this.handle(m);
      } catch (err) {
        this.port.postMessage({
          type: "error",
          message: "handle(" + m.type + ") threw: " + (err && err.message),
        });
      }
    };
  }

  init(bytes) {
    // no fetch in AudioWorkletGlobalScope — bytes arrive over the port
    WebAssembly.instantiate(bytes, {})
      .then(({ instance }) => {
        this.x = instance.exports;
        this.h = this.x.dsp_new(sampleRate);
        this.ctlPtr = this.x.muse_alloc(12 * 8);
        this.soundPtr = this.x.muse_alloc(128);
        this.lPtr = this.x.muse_alloc(128 * 4);
        this.rPtr = this.x.muse_alloc(128 * 4);
        this.ready = true;
        const queued = this.queue.splice(0);
        for (const m of queued) this.handle(m);
        this.port.postMessage({ type: "ready" });
      })
      .catch((err) => this.port.postMessage({ type: "error", message: String(err) }));
  }

  handle(m) {
    switch (m.type) {
      case "ev": {
        this.noteCount += m.evs.length;
        for (const ev of m.evs) {
          const mem = this.x.memory.buffer;
          new Float64Array(mem, this.ctlPtr, 12).set(ev.c);
          // no TextEncoder in AudioWorkletGlobalScope — instrument names are
          // plain ASCII, so write the bytes directly
          const name = ev.s || "";
          const nlen = Math.min(name.length, 127);
          const view = new Uint8Array(mem, this.soundPtr, nlen);
          for (let i = 0; i < nlen; i++) view[i] = name.charCodeAt(i) & 0x7f;
          this.x.dsp_schedule(this.h, ev.t, ev.d, this.ctlPtr, this.soundPtr, nlen);
        }
        break;
      }
      case "flush":
        this.x.dsp_flush(this.h);
        break;
      case "clear_pending":
        this.x.dsp_clear_pending(this.h);
        break;
      default:
        break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const l = out[0];
    const r = out.length > 1 ? out[1] : l;
    if (!this.ready) return true;

    const n = Math.min(l.length, 128);
    this.lastN = n;
    this.x.dsp_process(this.h, this.lPtr, this.rPtr, n, currentFrame);
    this.totalFrames += n;
    const buf = this.x.memory.buffer;
    const rendered = new Float32Array(buf, this.lPtr, n);
    l.set(rendered);
    if (out.length > 1) r.set(new Float32Array(buf, this.rPtr, n));

    // output meter (~2 packets/s of max-peak reporting for the UI/tests)
    for (let i = 0; i < n; i++) {
      const smp = rendered[i];
      if (smp !== smp) this.nanCount++;
      const a = smp < 0 ? -smp : smp;
      if (a > this.peak) this.peak = a;
      if (a > this.rawPeak) this.rawPeak = a;
    }
    if (++this.meterN >= 64) {
      this.port.postMessage({
        type: "meter",
        peak: this.peak,
        notes: this.noteCount,
        lastN: this.lastN,
        totalFrames: this.totalFrames,
        rawPeak: this.rawPeak,
        nanCount: this.nanCount,
        stats: this.x.dsp_stats(this.h),
        frame: currentFrame,
        time: currentTime,
      });
      this.peak = 0;
      this.meterN = 0;
    }
    return true;
  }
}

registerProcessor("muse-processor", MuseProcessor);
