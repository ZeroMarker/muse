// Offline renderer tests — the CLI's `muse run` path.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { loadCore } from "../../cli/core";
import { Driver } from "../../cli/driver";
import { encodeWav, renderOffline, rms, SAMPLE_RATE } from "../../cli/wav";
import { mini } from "../src/mini";
import { fast, silence, sound, stack } from "../src/dsl";

const WASM_HINT = resolve(process.cwd(), "web/public/muse_core.wasm");

describe("cli offline render (muse run)", () => {
  it("renders audible stereo audio", async () => {
    expect(existsSync(WASM_HINT), "run npm run build:wasm first").toBe(true);
    const core = await loadCore();
    const pat = stack("bd . hh .", "sn . . sn").pat;
    const pcm = renderOffline(core, pat, 1.5, 2);

    expect(pcm.length).toBe(1.5 * SAMPLE_RATE * 2);
    expect(rms(pcm)).toBeGreaterThan(0.01);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]) / 32768);
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.1);
  });

  it("renders silence for silence", async () => {
    const core = await loadCore();
    const pcm = renderOffline(core, mini(""), 1, 2);
    expect(rms(pcm)).toBe(0);
  });

  it("pitched patterns produce sustained output", async () => {
    const core = await loadCore();
    const pcm = renderOffline(core, mini("c3 e3 g3"), 1, 2);
    expect(rms(pcm)).toBeGreaterThan(0.01);
  });

  it("encodes a valid wav header", async () => {
    const core = await loadCore();
    const pcm = renderOffline(core, mini("bd"), 0.5, 2);
    const wav = encodeWav(pcm, SAMPLE_RATE, 2);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.length).toBe(44 + pcm.length * 2);
    expect(wav.readUInt32LE(40)).toBe(pcm.length * 2);
  });

  it("is deterministic (same input → identical bytes)", async () => {
    const core = await loadCore();
    const pat = stack("bd . sn .", "hh/2").pat;
    const a = renderOffline(core, pat, 0.5, 2);
    const b = renderOffline(core, pat, 0.5, 2);
    expect(Buffer.from(a.buffer)).toEqual(Buffer.from(b.buffer));
  });

  it("keeps rendering after more than 4096 events", async () => {
    const core = await loadCore();
    const sampleRate = 8000;
    const pcm = renderOffline(core, fast(1000, "bd").pat, 3, 2, sampleRate);
    expect(rms(pcm.subarray(2.5 * sampleRate * 2))).toBeGreaterThan(0.01);
  });

  it("renders event data larger than the former 1 MiB buffer", async () => {
    const core = await loadCore();
    const pat = sound("x".repeat(3000), fast(200, "bd")).pat;
    const pcm = renderOffline(core, pat, 2, 2, 8000);
    expect(rms(pcm)).toBeGreaterThan(0.01);
  });

  it("skips paused wall-clock frames when restarting the CLI driver", async () => {
    const core = await loadCore();
    const sink = { label: "test", alive: true, write: () => {}, close: () => {} };
    const driver = new Driver(core, sink, () => {});
    let now = 0;
    driver.now = () => now;
    try {
      driver.start();
      driver.stop();
      now = 120;
      driver.start();
      expect((driver as unknown as { rendered: number }).rendered).toBe(120 * SAMPLE_RATE);
    } finally {
      driver.dispose();
    }
  });

  it("cancels queued old-pattern notes on a live swap", async () => {
    const core = await loadCore();
    const sink = { label: "test", alive: true, write: () => {}, close: () => {} };
    const driver = new Driver(core, sink, () => {});
    driver.now = () => 0;
    try {
      driver.setPattern(fast(10, "bd").pat);
      driver.start();
      const dsp = (driver as unknown as { dsp: number }).dsp;
      expect(core.exports.dsp_stats(dsp) & 0xffff).toBeGreaterThan(0);
      driver.setPattern(silence.pat);
      expect(core.exports.dsp_stats(dsp) & 0xffff).toBe(0);
    } finally {
      driver.dispose();
    }
  });
});
