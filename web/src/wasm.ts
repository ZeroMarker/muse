// Typed wrapper over the muse-core wasm module (see crates/muse-core/src/lib.rs).

import { type Pat, encode } from "./ir";

export interface CoreExports {
  memory: WebAssembly.Memory;
  muse_alloc(len: number): number;
  muse_free(ptr: number, len: number): void;
  err_len(): number;
  err_copy(out: number): number;
  ir_decode(ptr: number, len: number): number;
  ir_release(h: number): void;
  sched_new(cps: number): number;
  sched_set_pattern(sched: number, pat: number): number;
  sched_clear_pattern(sched: number): void;
  sched_set_cps(sched: number, cps: number, audioNow: number): void;
  sched_cycle_at(sched: number, audioNow: number): number;
  sched_audio_at(sched: number, cycle: number): number;
  sched_reset(sched: number, audioNow: number): void;
  sched_count(sched: number, horizon: number): number;
  sched_query(sched: number, horizon: number, out: number, cap: number): number;
  sched_peek(sched: number, lo: number, hi: number, out: number, cap: number): number;
  sched_free(sched: number): void;
  dsp_new(sampleRate: number): number;
  dsp_schedule(h: number, atSec: number, durSec: number, ctl: number, sound: number, soundLen: number): number;
  dsp_process(h: number, l: number, r: number, frames: number, baseFrame: number): void;
  dsp_flush(h: number): void;
  dsp_stats(h: number): number;
  dsp_free(h: number): void;
}

export class WasmError extends Error {}

export class WasmCore {
  constructor(readonly exports: CoreExports) {}

  /** Fetch wasm bytes (AudioWorkletGlobalScope has no `fetch`, so the main
   * thread downloads the module once and transfers the bytes to the worklet). */
  static async fetchBytes(url: string): Promise<ArrayBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new WasmError(`failed to fetch ${url}: ${res.status}`);
    return res.arrayBuffer();
  }

  /** Instantiate a core from bytes already in memory. */
  static async fromBytes(bytes: ArrayBuffer): Promise<WasmCore> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new WasmCore(instance.exports as unknown as CoreExports);
  }

  static async load(url: string): Promise<WasmCore> {
    return WasmCore.fromBytes(await WasmCore.fetchBytes(url));
  }

  /** Copy bytes into wasm memory; caller must `free()` the pointer. */
  allocBytes(bytes: Uint8Array | number): { ptr: number; len: number } {
    const len = typeof bytes === "number" ? bytes : bytes.length;
    const ptr = this.exports.muse_alloc(len);
    if (!ptr) throw new WasmError("muse_alloc failed");
    if (typeof bytes !== "number") {
      new Uint8Array(this.exports.memory.buffer, ptr, len).set(bytes);
    }
    return { ptr, len };
  }

  free(ptr: number, len: number): void {
    this.exports.muse_free(ptr, len);
  }

  readBytes(ptr: number, len: number): Uint8Array {
    // buffer may have grown since other views were made — re-view each time
    return new Uint8Array(this.exports.memory.buffer, ptr, len).slice();
  }

  lastError(): string {
    const n = this.exports.err_len();
    if (n === 0) return "";
    const ptr = this.exports.muse_alloc(n);
    try {
      const written = this.exports.err_copy(ptr);
      return new TextDecoder().decode(this.readBytes(ptr, written));
    } finally {
      this.exports.muse_free(ptr, n);
    }
  }

  /** Encode + decode a pattern across the boundary; returns a live handle. */
  decodePattern(pat: Pat): number {
    const bytes = encode(pat);
    const { ptr, len } = this.allocBytes(bytes);
    try {
      const h = this.exports.ir_decode(ptr, len);
      if (!h) throw new WasmError(this.lastError() || "pattern decode failed");
      return h;
    } finally {
      this.free(ptr, len);
    }
  }

  releasePattern(h: number): void {
    if (h) this.exports.ir_release(h);
  }
}
