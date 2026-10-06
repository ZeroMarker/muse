// Realtime transport for the CLI: wall clock replaces the AudioContext.
//
//   hrtime ──► cycle position (Rust clock)
//          ──► 30 ms schedule tick → [cursor, now+250ms) → dsp_schedule
//          ──► 4 ms render tick    → dsp_process → sink

import { NCTL, type Pat, unpackEvents } from "../web/src/ir";
import type { WasmCore } from "../web/src/wasm";
import type { SampleData } from "../web/src/samples";
import type { Sink } from "./sink";

const LOOKAHEAD = 0.25;
const LEAD = 0.04;
const SCHEDULE_MS = 30;
const RENDER_MS = 4;
const CHUNK = 256;

export class Driver {
  private sched = 0;
  private dsp = 0;
  private ctlPtr = 0;
  private sndPtr = 0;
  private lPtr = 0;
  private rPtr = 0;

  private t0 = process.hrtime.bigint();
  private rendered = 0; // frames handed to the sink
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private pattern: Pat | null = null;
  private overloads = 0;
  private lastOverloadLog = -Infinity;

  cps = 2; // 120 bpm
  playing = false;
  scheduledTotal = 0;

  constructor(
    private readonly core: WasmCore,
    private readonly sink: Sink,
    private readonly log: (line: string) => void,
    private readonly samples: ReadonlyMap<string, SampleData> = new Map(),
  ) {}

  private get x() {
    return this.core.exports;
  }

  now(): number {
    return Number(process.hrtime.bigint() - this.t0) / 1e9;
  }

  cycle(): number {
    return this.sched ? this.x.sched_cycle_at(this.sched, this.now()) : 0;
  }

  start(): void {
    if (!this.dsp) {
      const x = this.x;
      try {
        this.sched = x.sched_new(this.cps);
        this.dsp = x.dsp_new(48000);
        for (const [name, sample] of this.samples) this.core.loadSample(this.dsp, name, sample.data, sample.rate);
        this.ctlPtr = this.core.allocBytes(NCTL * 8).ptr;
        this.sndPtr = this.core.allocBytes(128).ptr;
        this.lPtr = this.core.allocBytes(CHUNK * 4).ptr;
        this.rPtr = this.core.allocBytes(CHUNK * 4).ptr;
        if (this.pattern) this.install(this.pattern);
        this.renderLoop();
      } catch (error) { this.dispose(); throw error; }
    }
    if (!this.sched) return;
    this.rendered = Math.floor(this.now() * 48000);
    this.playing = true;
    this.x.sched_reset(this.sched, this.now() + LEAD);
    this.x.dsp_flush(this.dsp);
    if (this.scheduleTimer === null) {
      this.scheduleTimer = setInterval(() => this.scheduleTick(), SCHEDULE_MS);
    }
    this.scheduleTick();
  }

  stop(): void {
    this.playing = false;
    if (this.scheduleTimer !== null) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (this.dsp) this.x.dsp_flush(this.dsp);
  }

  setCps(cps: number): void {
    if (!Number.isFinite(cps) || cps <= 0) throw new Error("tempo must be finite and positive");
    this.cps = cps;
    if (this.sched) this.x.sched_set_cps(this.sched, cps, this.now());
    if (this.playing) this.reschedule();
  }

  /** Hot-swap the playing pattern (starts the engine on first use). */
  setPattern(pat: Pat): void {
    if (this.sched) this.install(pat);
    else {
      const handle = this.core.decodePattern(pat);
      this.core.releasePattern(handle);
    }
    this.pattern = pat;
    if (this.playing) this.reschedule();
  }

  private reschedule(): void {
    this.x.dsp_clear_pending(this.dsp);
    this.x.sched_reset(this.sched, this.now() + LEAD);
    this.scheduleTick();
  }

  private install(pat: Pat): void {
    const h = this.core.decodePattern(pat);
    try {
      if (!this.x.sched_set_pattern(this.sched, h)) {
        throw new Error("sched_set_pattern failed");
      }
    } finally {
      this.core.releasePattern(h);
    }
  }

  /** Events ahead of the cursor — used by the TUI (does not consume). */
  peek(cycles: number): ReturnType<typeof unpackEvents> {
    if (!this.sched) return [];
    const lo = this.cycle() + LEAD;
    const cap = 128 * 1024;
    const { ptr, len } = this.core.allocBytes(cap);
    try {
      const w = this.x.sched_peek(this.sched, lo, lo + cycles, ptr, len);
      if (w <= 0) return [];
      return unpackEvents(this.core.readBytes(ptr, w));
    } finally {
      this.core.free(ptr, len);
    }
  }

  private scheduleTick(): void {
    if (!this.playing || !this.sched) return;
    try {
      const horizon = this.x.sched_cycle_at(this.sched, this.now() + LOOKAHEAD);
      const evs = this.core.queryScheduled(this.sched, horizon);
      this.scheduledTotal += evs.length;
      for (const ev of evs) {
        new Float64Array(this.x.memory.buffer, this.ctlPtr, NCTL).set(ev.ctl);
        const nlen = Math.min(ev.sound.length, 127);
        const snd = new Uint8Array(this.x.memory.buffer, this.sndPtr, nlen);
        for (let i = 0; i < nlen; i++) snd[i] = ev.sound.charCodeAt(i) & 0x7f;
        this.x.dsp_schedule(this.dsp, this.x.sched_audio_at(this.sched, ev.onsetCycle),
          ev.durSec, this.ctlPtr, this.sndPtr, nlen);
      }
    } catch (e) {
      this.stop();
      this.log(`schedule error: ${String(e)}`);
    }
  }

  private renderLoop(): void {
    if (this.renderTimer !== null) return;
    const step = () => {
      this.renderTimer = setTimeout(step, RENDER_MS);
      if (!this.playing || !this.dsp) return;
      try {
        const target = Math.floor(this.now() * 48000);
        if (target <= this.rendered) return;
        if (!this.sink.alive) {
          // no device: keep the clock moving without producing samples
          this.rendered = target;
          return;
        }
        while (this.rendered < target) {
          const n = Math.min(CHUNK, target - this.rendered);
          this.x.dsp_process(this.dsp, this.lPtr, this.rPtr, n, this.rendered);
          const overloads = this.x.dsp_overloads(this.dsp);
          if (overloads > this.overloads && this.now() - this.lastOverloadLog >= 1) {
            this.log(`audio overloaded: ${overloads - this.overloads} notes dropped or voices replaced; simplify the pattern`);
            this.overloads = overloads;
            this.lastOverloadLog = this.now();
          }
          const l = new Float32Array(this.x.memory.buffer, this.lPtr, n);
          const r = new Float32Array(this.x.memory.buffer, this.rPtr, n);
          const pcm = new Int16Array(n * 2);
          for (let i = 0; i < n; i++) {
            pcm[i * 2] = i16(l[i]);
            pcm[i * 2 + 1] = i16(r[i]);
          }
          this.sink.write(pcm);
          this.rendered += n;
        }
      } catch (e) {
        this.stop();
        this.log(`render error: ${String(e)}`);
      }
    };
    this.renderTimer = setTimeout(step, RENDER_MS);
  }

  dispose(): void {
    this.stop();
    if (this.renderTimer !== null) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.dsp) {
      this.x.dsp_free(this.dsp);
      this.dsp = 0;
    }
    if (this.sched) {
      this.x.sched_free(this.sched);
      this.sched = 0;
    }
    if (this.ctlPtr) this.core.free(this.ctlPtr, NCTL * 8);
    if (this.sndPtr) this.core.free(this.sndPtr, 128);
    if (this.lPtr) this.core.free(this.lPtr, CHUNK * 4);
    if (this.rPtr) this.core.free(this.rPtr, CHUNK * 4);
    this.ctlPtr = this.sndPtr = this.lPtr = this.rPtr = 0;
    this.overloads = 0;
    this.lastOverloadLog = -Infinity;
  }
}

function i16(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.max(-1, Math.min(1, v)) * 32767);
}
