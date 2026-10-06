// Offline rendering: pattern → scheduled events → DSP → 16-bit PCM (stereo).

import type { WasmCore } from "./wasm";
import { NCTL, type Pat } from "./ir";

import { validateSampleBudget } from "./samples";

export const SAMPLE_RATE = 48000;

/** Render `seconds` of `pat` deterministically. Returns interleaved stereo s16. */
export function renderOffline(
  core: WasmCore,
  pat: Pat,
  seconds: number,
  cps: number,
  sampleRate = SAMPLE_RATE,
  samples: ReadonlyMap<string, { data: Float32Array; rate: number }> = new Map(),
  onProgress?: (percent: number) => void,
): Int16Array {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) throw new Error("duration must be 0–300 seconds");
  if (!Number.isFinite(cps) || cps <= 0) throw new Error("tempo must be positive");
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error("invalid sample rate");
  validateSampleBudget(samples);
  const x = core.exports;
  const sched = x.sched_new(cps);
  try {
    const ph = core.decodePattern(pat);
    try {
      x.sched_set_pattern(sched, ph);
    } finally {
      core.releasePattern(ph);
    }
    x.sched_reset(sched, 0);

    const h = x.dsp_new(sampleRate);
    try {
      for (const [name, sample] of samples) core.loadSample(h, name, sample.data, sample.rate);
      const allocations: { ptr: number; len: number }[] = [];
      const allocate = (len: number) => {
        const allocation = core.allocBytes(len);
        allocations.push(allocation);
        return allocation;
      };
      try {
        const ctlAlloc = allocate(NCTL * 8);
        const sndAlloc = allocate(128);
        let eventsTotal = 0;
        let lastPercent = -1;
        const totalFrames = Math.ceil(seconds * sampleRate);
        const out = new Int16Array(totalFrames * 2);
        const chunk = 256;
        const lPtr = allocate(chunk * 4);
        const rPtr = allocate(chunk * 4);
        for (let frame = 0; frame < totalFrames; frame += chunk) {
          const n = Math.min(chunk, totalFrames - frame);
          const horizon = x.sched_cycle_at(sched, (frame + n) / sampleRate);
          const events = core.queryScheduled(sched, horizon);
          eventsTotal += events.length;
          if (eventsTotal > 1_000_000) throw new Error("audio export supports at most 1,000,000 events");
          for (const ev of events) {
            new Float64Array(x.memory.buffer, ctlAlloc.ptr, NCTL).set(ev.ctl);
            const nlen = Math.min(ev.sound.length, 127);
            const sndView = new Uint8Array(x.memory.buffer, sndAlloc.ptr, nlen);
            for (let i = 0; i < nlen; i++) sndView[i] = ev.sound.charCodeAt(i) & 0x7f;
            x.dsp_schedule(
              h,
              x.sched_audio_at(sched, ev.onsetCycle),
              ev.durSec,
              ctlAlloc.ptr,
              sndAlloc.ptr,
              nlen,
            );
          }
          x.dsp_process(h, lPtr.ptr, rPtr.ptr, n, frame);
          if (x.dsp_overloads(h)) throw new Error("audio export overloaded: simplify the pattern (128 voices, 4096 pending notes)");
          const l = new Float32Array(x.memory.buffer, lPtr.ptr, n);
          const r = new Float32Array(x.memory.buffer, rPtr.ptr, n);
          for (let i = 0; i < n; i++) {
            out[(frame + i) * 2] = toI16(l[i]);
            out[(frame + i) * 2 + 1] = toI16(r[i]);
          }
          const percent = Math.floor((frame + n) * 100 / totalFrames);
          if (percent !== lastPercent) { lastPercent = percent; onProgress?.(percent); }
        }
        return out;
      } finally {
        for (const { ptr, len } of allocations.reverse()) core.free(ptr, len);
      }
    } finally {
      x.dsp_free(h);
    }
  } finally {
    x.sched_free(sched);
  }
}

function toI16(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const c = Math.max(-1, Math.min(1, v));
  return Math.round(c * 32767);
}

/** Portable little-endian PCM encoder, shared by browser and CLI. */
export function encodeWav(samples: Int16Array, sampleRate: number, channels: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, "RIFF"); text(8, "WAVE"); text(12, "fmt "); text(36, "data");
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}
