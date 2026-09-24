// Offline rendering: pattern → scheduled events → DSP → 16-bit PCM (stereo).

import type { WasmCore } from "../web/src/wasm";
import { NCTL, type Pat, unpackEvents } from "../web/src/ir";

export const SAMPLE_RATE = 48000;

/** Render `seconds` of `pat` deterministically. Returns interleaved stereo s16. */
export function renderOffline(
  core: WasmCore,
  pat: Pat,
  seconds: number,
  cps: number,
  sampleRate = SAMPLE_RATE,
): Int16Array {
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

    // collect every event in [0, seconds·cps) cycles (peek does not consume)
    const cap = 1024 * 1024;
    const { ptr, len } = core.allocBytes(cap);
    let evs;
    try {
      const written = x.sched_peek(sched, 0, seconds * cps, ptr, len);
      if (written < 0) throw new Error(`sched_peek failed (${written})`);
      evs = unpackEvents(core.readBytes(ptr, written));
    } finally {
      core.free(ptr, len);
    }

    const h = x.dsp_new(sampleRate);
    try {
      const ctlAlloc = core.allocBytes(NCTL * 8);
      const sndAlloc = core.allocBytes(128);
      try {
        const ctlView = new Float64Array(x.memory.buffer, ctlAlloc.ptr, NCTL);
        for (const ev of evs) {
          ctlView.set(ev.ctl);
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
      } finally {
        core.free(ctlAlloc.ptr, ctlAlloc.len);
        core.free(sndAlloc.ptr, sndAlloc.len);
      }

      const totalFrames = Math.ceil(seconds * sampleRate);
      const out = new Int16Array(totalFrames * 2);
      const chunk = 256;
      const lPtr = core.allocBytes(chunk * 4);
      const rPtr = core.allocBytes(chunk * 4);
      try {
        for (let frame = 0; frame < totalFrames; frame += chunk) {
          const n = Math.min(chunk, totalFrames - frame);
          x.dsp_process(h, lPtr.ptr, rPtr.ptr, n, frame);
          const l = new Float32Array(x.memory.buffer, lPtr.ptr, n);
          const r = new Float32Array(x.memory.buffer, rPtr.ptr, n);
          for (let i = 0; i < n; i++) {
            out[(frame + i) * 2] = toI16(l[i]);
            out[(frame + i) * 2 + 1] = toI16(r[i]);
          }
        }
      } finally {
        core.free(lPtr.ptr, lPtr.len);
        core.free(rPtr.ptr, rPtr.len);
      }
      return out;
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

/** Minimal 16-bit PCM WAV encoder. */
export function encodeWav(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}
