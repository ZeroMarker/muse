// End-to-end boundary test: TS encoder → Rust decoder → query/scheduler →
// packed events → TS unpacker. Runs the actual wasm artifact in Node.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { EVENT_HEADER, NCTL, encode, unpackEvents } from "../src/ir";
import { mini } from "../src/mini";
import { fast, stack } from "../src/dsl";
import { WasmCore } from "../src/wasm";

const WASM_PATH = resolve(process.cwd(), "target/wasm32-unknown-unknown/release/muse_core.wasm");

async function loadCore(): Promise<WasmCore> {
  expect(existsSync(WASM_PATH), `missing ${WASM_PATH} — run npm run build:wasm first`).toBe(true);
  const bytes = readFileSync(WASM_PATH);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return new WasmCore(instance.exports as never);
}

describe("wasm boundary roundtrip", () => {
  it("decodes and releases a pattern", async () => {
    const core = await loadCore();
    const h = core.decodePattern(mini("bd [hh hh] <sn cp>"));
    expect(h).toBeGreaterThan(0);
    core.releasePattern(h);
  });

  it("reports decode errors from Rust", async () => {
    const core = await loadCore();
    const bad = new Uint8Array([1, 2, 3]);
    const { ptr, len } = core.allocBytes(bad);
    expect(core.exports.ir_decode(ptr, len)).toBe(0);
    expect(core.lastError()).toMatch(/magic|ir decode/);
    core.free(ptr, len);
  });

  it("schedules events from the query engine", async () => {
    const core = await loadCore();
    const sched = core.exports.sched_new(1.0);
    expect(sched).toBeGreaterThan(0);

    const pat = core.decodePattern(stack("bd . sn .", fast(2, "hh")).pat);
    expect(core.exports.sched_set_pattern(sched, pat)).toBe(1);
    core.releasePattern(pat);

    core.exports.sched_reset(sched, 0);
    expect(core.exports.sched_cycle_at(sched, 2.5)).toBe(2.5);

    // pack events for cycles [0, 4)
    const horizon = 4;
    const n = core.exports.sched_count(sched, horizon);
    expect(n).toBeGreaterThanOrEqual(8); // 4 bd/sn + 8 hh

    const cap = Math.ceil(n * (EVENT_HEADER + 2 + 64)) + 64;
    const { ptr, len } = core.allocBytes(cap);
    const written = core.exports.sched_query(sched, horizon, ptr, len);
    expect(written).toBeGreaterThan(0);
    const evs = unpackEvents(core.readBytes(ptr, written));
    core.free(ptr, len);

    expect(evs).toHaveLength(n);
    // defaults applied
    expect(evs.every((e) => e.ctl.length === NCTL)).toBe(true);
    expect(evs.every((e) => Number.isFinite(e.ctl[1]))).toBe(true); // gain
    // onsets strictly inside the window, sorted
    const onsets = evs.map((e) => e.onsetCycle);
    expect(onsets[0]).toBeGreaterThanOrEqual(0);
    expect(onsets.every((o, i) => i === 0 || o >= onsets[i - 1])).toBe(true);
    // second query with same horizon returns nothing (cursor advanced)
    expect(core.exports.sched_count(sched, horizon)).toBe(0);

    // audio_at inverts cycle_at
    const t = core.exports.sched_audio_at(sched, 2.0);
    expect(core.exports.sched_cycle_at(sched, t)).toBeCloseTo(2.0, 9);

    core.exports.sched_free(sched);
  });

  it("tempo changes rebase the clock", async () => {
    const core = await loadCore();
    const sched = core.exports.sched_new(1.0);
    core.exports.sched_reset(sched, 0);
    expect(core.exports.sched_cycle_at(sched, 4)).toBeCloseTo(4);
    core.exports.sched_set_cps(sched, 2.0, 4.0); // at t=4s we are at cycle 4
    expect(core.exports.sched_cycle_at(sched, 4)).toBeCloseTo(4);
    expect(core.exports.sched_cycle_at(sched, 6)).toBeCloseTo(8);
    core.exports.sched_free(sched);
  });

  it("peek does not advance the cursor", async () => {
    const core = await loadCore();
    const sched = core.exports.sched_new(1.0);
    const pat = core.decodePattern(mini("bd"));
    core.exports.sched_set_pattern(sched, pat);
    core.releasePattern(pat);
    core.exports.sched_reset(sched, 0);

    const cap = 64 * 1024;
    const { ptr, len } = core.allocBytes(cap);
    const w1 = core.exports.sched_peek(sched, 0, 4, ptr, len);
    expect(w1).toBeGreaterThan(0);
    expect(core.exports.sched_count(sched, 4)).toBe(4); // still all there
    core.free(ptr, len);
    core.exports.sched_free(sched);
  });

  it("encoder writes the MUSE magic + version", () => {
    const bytes = encode(mini("bd"));
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe("MUSE");
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(1);
  });

  it("renders scheduled audio through dsp_*", async () => {
    const core = await loadCore();
    const h = core.exports.dsp_new(48000);
    expect(h).toBeGreaterThan(0);

    const ctl = new Float64Array(NCTL);
    ctl.fill(NaN);
    ctl[1] = 1; // gain
    ctl[2] = 8000; // cutoff
    ctl[4] = 0.005;
    ctl[5] = 0.1;
    ctl[6] = 1;
    ctl[7] = 0.05;
    ctl[7] = 0.05;
    ctl[9] = 0.2;
    ctl[10] = 1;
    ctl[11] = 0;

    const ctlBytes = new Uint8Array(ctl.buffer);
    const ctlPtr = core.allocBytes(ctlBytes);
    const sound = new TextEncoder().encode("saw");
    const soundAlloc = core.allocBytes(sound);

    const frames = 128;
    const lPtr = core.allocBytes(frames * 4);
    const rPtr = core.allocBytes(frames * 4);

    core.exports.dsp_schedule(h, 0, 0.5, ctlPtr.ptr, soundAlloc.ptr, soundAlloc.len);

    let peak = 0;
    for (let q = 0; q < 60; q++) {
      core.exports.dsp_process(h, lPtr.ptr, rPtr.ptr, frames, q * frames);
      const l = new Float32Array(core.exports.memory.buffer, lPtr.ptr, frames);
      for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(l[i]));
    }
    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThanOrEqual(1);

    core.exports.dsp_free(h);
  });
});
