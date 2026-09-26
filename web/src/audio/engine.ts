// Main-thread audio engine: owns the AudioContext, the clock/scheduler
// (wasm, main instance) and the tick loop that feeds the worklet.

import { EVENT_HEADER, type Pat, type SchedEvent, unpackEvents } from "../ir";
import { type CoreExports, WasmCore } from "../wasm";
import processorUrl from "./processor.js?url";

/** How far ahead we schedule, in audio seconds. */
const LOOKAHEAD = 0.3;
/** Ignore events starting sooner than this (they'd arrive too late). */
const LEAD = 0.04;
/** Tick period — must stay well under LOOKAHEAD. */
const TICK_MS = 60;
/** Cycles shown in the visualizer. */
export const VIS_CYCLES = 4;
/** Fixed peek buffer for the visualizer (~700 events). */
const PEEK_CAP = 128 * 1024;

export interface TickInfo {
  cycle: number;
  cps: number;
  playing: boolean;
  scheduled: number;
}

export interface EngineHooks {
  onTick?: (info: TickInfo) => void;
  onVisualize?: (evs: SchedEvent[], lo: number, hi: number, pos: number) => void;
  onLog?: (line: string, kind?: "info" | "error") => void;
}

export class Engine {
  core: WasmCore | null = null;
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private sched = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private transportVersion = 0;
  private initialized = false;
  private initializing: Promise<void> | null = null;

  readonly samples = new Map<string, { data: Float32Array; rate: number }>();

  cps = 1;
  playing = false;
  /** Latest output peak reported by the worklet meter. */
  peak = 0;
  /** Total events posted to the worklet since page load. */
  scheduledTotal = 0;
  /** Notes the worklet has actually handed to the DSP. */
  workletNotes = 0;
  /** Last raw meter payload from the worklet (debug/diagnostics). */
  workletDiag: Record<string, unknown> | null = null;
  hooks: EngineHooks = {};

  get audioReady(): boolean {
    return this.initialized;
  }

  /** Idempotent; requires a user gesture to construct the AudioContext. */
  init(processorUrl: string, wasmUrl: string): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize(processorUrl, wasmUrl)
      .catch(async (error) => {
        this.node?.disconnect();
        if (this.node) this.node.port.close();
        if (this.sched && this.core) this.core.exports.sched_free(this.sched);
        this.sched = 0;
        await this.ctx?.close().catch(() => {});
        this.ctx = null;
        this.node = null;
        this.core = null;
        this.initialized = false;
        throw error;
      }).finally(() => { this.initializing = null; });
    return this.initializing;
  }

  private async initialize(processorUrl: string, wasmUrl: string): Promise<void> {
    this.hooks.onLog?.("loading pattern engine (wasm)…");
    // AudioWorkletGlobalScope has no `fetch` — the main thread downloads the
    // module once and transfers the bytes to the worklet over its port.
    const wasmBytes = await WasmCore.fetchBytes(wasmUrl);
    const { instance } = await WebAssembly.instantiate(wasmBytes.slice(0), {});
    this.core = new WasmCore(instance.exports as unknown as CoreExports);

    this.ctx = new AudioContext({ latencyHint: "interactive" });
    await this.ctx.audioWorklet.addModule(processorUrl);
    this.hooks.onLog?.("worklet module loaded…");
    this.node = new AudioWorkletNode(this.ctx, "muse-processor", {
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.addEventListener("processorerror", (ev) => {
      this.hooks.onLog?.(`worklet processorerror: ${(ev as ErrorEvent).message ?? ev.type}`, "error");
    });
    // The processor is only instantiated once the node joins the graph —
    // connect first, otherwise the init message below is queued forever.
    this.node.connect(this.ctx.destination);

    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("worklet init timeout")), 10_000);
      let settled = false;
      this.node!.port.onmessage = (e) => {
        if (e.data.type === "ready") {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (e.data.type === "error") {
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            reject(new Error(`worklet: ${e.data.message}`));
          } else {
            this.hooks.onLog?.(`worklet: ${e.data.message}`, "error");
          }
        } else if (e.data.type === "meter") {
          this.peak = e.data.peak;
          if (typeof e.data.notes === "number") this.workletNotes = e.data.notes;
          this.workletDiag = e.data;
        } else if (e.data.type === "hello") {
          this.hooks.onLog?.("worklet processor alive");
        }
      };
    });
    this.node.port.postMessage({ type: "init", bytes: wasmBytes }, [wasmBytes]);
    await ready;

    this.sched = this.core.exports.sched_new(this.cps);
    this.initialized = true;
    this.hooks.onLog?.(
      `engine ready (${this.ctx.sampleRate} Hz, ${(this.ctx.baseLatency * 1000).toFixed(1)} ms latency) — ctrl+enter to run`,
    );
  }

  async loadSample(name: string, file: ArrayBuffer): Promise<void> {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,126}$/.test(name)) throw new Error("sample name must start with a letter and contain only letters, numbers or underscores");
    await this.initIfNeeded();
    const decoded = await this.ctx!.decodeAudioData(file);
    if (decoded.duration > 30) throw new Error("samples must be at most 30 seconds");
    const data = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const source = decoded.getChannelData(channel);
      for (let i = 0; i < data.length; i++) data[i] += source[i] / decoded.numberOfChannels;
    }
    this.samples.set(name, { data, rate: decoded.sampleRate });
    this.node!.port.postMessage({ type: "sample", name, data, rate: decoded.sampleRate });
  }

  // --- transport -----------------------------------------------------------

  async play(): Promise<void> {
    const version = ++this.transportVersion;
    await this.initIfNeeded();
    if (version !== this.transportVersion) return;
    await this.ctx!.resume();
    if (version !== this.transportVersion) return;
    this.exports.sched_reset(this.sched, this.ctx!.currentTime + LEAD);
    this.node!.port.postMessage({ type: "flush" });
    this.playing = true;
    this.startTick();
  }

  stop(): void {
    this.transportVersion++;
    this.playing = false;
    this.stopTick();
    this.node?.port.postMessage({ type: "flush" });
    this.hooks.onTick?.({ cycle: this.cycleNow(), cps: this.cps, playing: false, scheduled: 0 });
  }

  setCps(cps: number): void {
    this.cps = cps;
    if (this.initialized && this.ctx) {
      this.exports.sched_set_cps(this.sched, cps, this.ctx.currentTime);
      if (this.playing) this.reschedule();
    }
  }

  cycleNow(): number {
    if (!this.initialized || !this.ctx) return 0;
    return this.exports.sched_cycle_at(this.sched, this.ctx.currentTime);
  }

  // --- pattern -------------------------------------------------------------

  /** Install a (newly evaluated) pattern; takes effect immediately. */
  setPattern(pat: Pat): void {
    if (!this.initialized) throw new Error("engine not initialized");
    const h = this.core!.decodePattern(pat);
    try {
      if (!this.exports.sched_set_pattern(this.sched, h)) {
        throw new Error("sched_set_pattern failed");
      }
    } finally {
      this.core!.releasePattern(h);
    }
    if (this.playing && this.ctx) {
      this.reschedule();
    }
  }

  clearPattern(): void {
    if (this.initialized) this.exports.sched_clear_pattern(this.sched);
  }

  // --- internals -----------------------------------------------------------

  private get exports() {
    if (!this.core) throw new Error("engine not initialized");
    return this.core.exports;
  }

  /** Replace previously queued future notes with events at the current tempo. */
  private reschedule(): void {
    if (!this.ctx || !this.node) return;
    this.node.port.postMessage({ type: "clear_pending" });
    this.exports.sched_reset(this.sched, this.ctx.currentTime + LEAD);
    this.tick();
  }

  /** Load wasm + AudioContext + worklet (needs a user gesture). Idempotent. */
  async initIfNeeded(): Promise<void> {
    if (!this.initialized) {
      // worklets have no document base — always hand them absolute URLs
      const wasmUrl = new URL("muse_core.wasm", document.baseURI).href;
      await this.init(processorUrl, wasmUrl);
    }
  }

  private startTick(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private stopTick(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (!this.playing || !this.initialized || !this.ctx) return;
    const x = this.exports;
    const now = this.ctx.currentTime;
    let scheduled = 0;

    try {
      const horizon = x.sched_cycle_at(this.sched, now + LOOKAHEAD);
      const n = x.sched_count(this.sched, horizon);
      if (n > 0) {
        const cap = Math.ceil(n * (EVENT_HEADER + 2 + 64)) + 64;
        const { ptr, len } = this.core!.allocBytes(cap);
        try {
          const written = x.sched_query(this.sched, horizon, ptr, len);
          if (written > 0) {
            const evs = unpackEvents(this.core!.readBytes(ptr, written));
            scheduled = evs.length;
            this.scheduledTotal += evs.length;
            this.node!.port.postMessage({
              type: "ev",
              evs: evs.map((e) => ({
                t: x.sched_audio_at(this.sched, e.onsetCycle),
                d: e.durSec,
                c: e.ctl,
                s: e.sound,
              })),
            });
          } else if (written < 0) {
            this.hooks.onLog?.(`sched_query failed (${written})`, "error");
          }
        } finally {
          this.core!.free(ptr, len);
        }
      }

      // visualizer: peek at the next few cycles (does not advance the cursor)
      const lo = x.sched_cycle_at(this.sched, now + LEAD);
      const hi = lo + VIS_CYCLES;
      const pos = x.sched_cycle_at(this.sched, now);
      const { ptr, len } = this.core!.allocBytes(PEEK_CAP);
      try {
        const written = x.sched_peek(this.sched, lo, hi, ptr, len);
        if (written >= 0) {
          this.hooks.onVisualize?.(unpackEvents(this.core!.readBytes(ptr, written)), lo, hi, pos);
        }
      } finally {
        this.core!.free(ptr, len);
      }
    } catch (e) {
      this.hooks.onLog?.(String(e), "error");
    }

    this.hooks.onTick?.({
      cycle: x.sched_cycle_at(this.sched, now),
      cps: this.cps,
      playing: this.playing,
      scheduled,
    });
  }
}

export const engine = new Engine();
